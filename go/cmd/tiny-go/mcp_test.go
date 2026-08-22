package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSplitListsPluginSelectionAndDisplayName(t *testing.T) {
	got := splitList([]string{" first, second ", "first", "third,"})
	if strings.Join(got, ",") != "first,second,third" {
		t.Fatalf("split: %#v", got)
	}
	_, _, plugins, aliases, prompt, err := parseArgs([]string{"--plugin", "read, edit", "--plugin", "read", "--mcp", "one, two", "--mcp", "one", "hello"})
	if err != nil || strings.Join(plugins, ",") != "read,edit" || strings.Join(aliases, ",") != "one,two" || prompt != "hello" {
		t.Fatalf("plugins=%v aliases=%v prompt=%q err=%v", plugins, aliases, prompt, err)
	}
	tools := localTools(plugins...)
	if len(tools) != 2 || tools[0].Name != "read" || tools[1].Name != "edit" {
		t.Fatalf("tools: %#v", tools)
	}
	name, err := mapMCPToolName("complex", "analyze_data")
	if err != nil || displayToolName(name) != "mcp:complex/analyze_data" || len(name) > 64 {
		t.Fatalf("name=%q display=%q err=%v", name, displayToolName(name), err)
	}
}

func TestUnknownPluginRejectedBeforeSession(t *testing.T) {
	inTempDir(t)
	err := runCLI([]string{"--plugin", "missing", "hello"})
	if err == nil || !strings.Contains(err.Error(), "Unknown plugin: missing") {
		t.Fatalf("error: %v", err)
	}
	if _, err := os.Stat(filepath.Join(cwd, ".tiny-agent")); !os.IsNotExist(err) {
		t.Fatalf("session directory created: %v", err)
	}
}

func TestLoadMCPConfigsStrictCatalogAndToken(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "catalog.json")
	catalog := `{"servers":{"fixture":{"url":"https://example.test/mcp","tokenEnv":"FIXTURE_TOKEN","allowedTools":["echo"],"callTimeoutMs":1200},"public":{"url":"https://example.test/public"}}}`
	if err := os.WriteFile(path, []byte(catalog), 0o644); err != nil {
		t.Fatal(err)
	}
	configs, err := loadMCPConfigs([]string{"fixture", "public"}, map[string]string{"TINY_MCP_CONFIG": path, "FIXTURE_TOKEN": "secret"}, dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(configs) != 2 || configs[0].Token != "secret" || configs[0].CallTimeout != 1200*time.Millisecond {
		t.Fatalf("configs: %#v", configs)
	}
	for _, test := range []struct{ body, match string }{
		{`{"servers":{},"extra":true}`, "Unknown MCP catalog field"},
		{`{"servers":{"fixture":{"url":"https://x","header":"secret"}}}`, "Unknown MCP server fixture field"},
		{`{"servers":{"fixture":{"url":"https://x","allowedTools":null}}}`, "allowedTools must contain nonempty strings"},
		{`{"servers":{"fixture":{"url":"https://x","allowedTools":["x","x"]}}}`, "must not contain duplicates"},
		{catalog, "environment variable is not set"},
	} {
		if err := os.WriteFile(path, []byte(test.body), 0o644); err != nil {
			t.Fatal(err)
		}
		_, err := loadMCPConfigs([]string{"fixture"}, map[string]string{"TINY_MCP_CONFIG": path}, dir)
		if err == nil || !strings.Contains(err.Error(), test.match) {
			t.Fatalf("body=%s err=%v", test.body, err)
		}
	}
}

func TestModernStatelessMCPNegotiation(t *testing.T) {
	calls := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     int            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		calls = append(calls, request.Method)
		if r.Header.Get("Mcp-Protocol-Version") != modernMCPVersion || r.Header.Get("Mcp-Method") != request.Method || r.Header.Get("Mcp-Session-Id") != "" {
			t.Errorf("modern headers: %#v", r.Header)
		}
		meta, _ := request.Params["_meta"].(map[string]any)
		clientInfo, _ := meta["io.modelcontextprotocol/clientInfo"].(map[string]any)
		capabilities, capabilitiesOK := meta["io.modelcontextprotocol/clientCapabilities"].(map[string]any)
		if meta["io.modelcontextprotocol/protocolVersion"] != modernMCPVersion || clientInfo["name"] != "tiny-agent" || clientInfo["version"] != "0.1.0" || !capabilitiesOK || capabilities == nil {
			t.Errorf("modern meta: %#v", meta)
		}
		switch request.Method {
		case "server/discover":
			writeRPC(w, request.ID, map[string]any{"supportedVersions": []string{modernMCPVersion}, "capabilities": map[string]any{"tools": map[string]any{}}})
		case "tools/list":
			writeRPC(w, request.ID, map[string]any{"tools": []any{map[string]any{"name": "你好", "inputSchema": map[string]any{"type": "object"}}}, "ttlMs": 1000, "cacheScope": "private"})
		case "tools/call":
			if r.Header.Get("Mcp-Name") != "=?base64?5L2g5aW9?=" {
				t.Errorf("Mcp-Name: %q", r.Header.Get("Mcp-Name"))
			}
			writeRPC(w, request.ID, map[string]any{"content": []map[string]string{{"type": "text", "text": "modern"}}})
		default:
			t.Errorf("unexpected modern method: %s", request.Method)
		}
	}))
	defer server.Close()
	loaded, err := loadMCPTools(context.Background(), MCPConfig{Alias: "fixture", URL: server.URL}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	defer loaded.Close()
	result, err := loaded.tools[0].Execute(context.Background(), map[string]any{})
	if err != nil || result != "modern" || loaded.protocolEra != "modern" || loaded.protocolVersion != modernMCPVersion {
		t.Fatalf("result=%q era=%s version=%s err=%v", result, loaded.protocolEra, loaded.protocolVersion, err)
	}
	if strings.Join(calls, ",") != "server/discover,tools/list,tools/call" {
		t.Fatalf("calls: %v", calls)
	}
}

func TestStrictLegacyMCPFallback(t *testing.T) {
	calls := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var request struct {
			ID     int            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		calls = append(calls, request.Method)
		switch request.Method {
		case "server/discover":
			writeRPCError(w, request.ID, -32022, map[string]any{"supported": []string{legacyMCPVersion}})
		case "initialize":
			if request.ID != 1 || request.Params["protocolVersion"] != legacyMCPVersion || request.Params["_meta"] != nil || r.Header.Get("Mcp-Protocol-Version") != "" || r.Header.Get("Mcp-Method") != "" {
				t.Errorf("legacy initialize: params=%#v headers=%#v", request.Params, r.Header)
			}
			w.Header().Set("Mcp-Session-Id", "legacy-session")
			writeRPC(w, request.ID, map[string]any{"protocolVersion": legacyMCPVersion})
		case "notifications/initialized":
			if r.Header.Get("Mcp-Session-Id") != "legacy-session" || r.Header.Get("Mcp-Protocol-Version") != legacyMCPVersion {
				t.Errorf("legacy notification headers: %#v", r.Header)
			}
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			if r.Header.Get("Mcp-Session-Id") != "legacy-session" || r.Header.Get("Mcp-Protocol-Version") != legacyMCPVersion {
				t.Errorf("legacy list headers: %#v", r.Header)
			}
			writeRPC(w, request.ID, map[string]any{"tools": []any{map[string]any{"name": "echo", "inputSchema": map[string]any{"type": "object"}}}})
		default:
			t.Errorf("unexpected legacy method: %s", request.Method)
		}
	}))
	defer server.Close()
	loaded, err := loadMCPTools(context.Background(), MCPConfig{Alias: "fixture", URL: server.URL}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	defer loaded.Close()
	if loaded.protocolEra != "legacy" || loaded.protocolVersion != legacyMCPVersion || strings.Join(calls, ",") != "server/discover,initialize,notifications/initialized,tools/list" {
		t.Fatalf("era=%s version=%s calls=%v", loaded.protocolEra, loaded.protocolVersion, calls)
	}
}

func TestMCPResponseBoundAndSanitizedErrors(t *testing.T) {
	secret := "SECRET-CANARY-DO-NOT-LEAK"
	for _, test := range []struct {
		name    string
		handler http.HandlerFunc
		match   string
	}{
		{"status", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = fmt.Fprint(w, secret)
		}, "MCP HTTP 502 (server error)"},
		{"chunked", func(w http.ResponseWriter, r *http.Request) {
			w.(http.Flusher).Flush()
			chunk := strings.Repeat("x", 64*1024)
			for written := 0; written <= maxMCPHTTPBytes; written += len(chunk) {
				_, _ = fmt.Fprint(w, chunk)
			}
		}, "MCP response exceeds 10MB"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(test.handler)
			defer server.Close()
			_, err := loadMCPTools(context.Background(), MCPConfig{Alias: "x", URL: server.URL}, server.Client())
			if err == nil || !strings.Contains(err.Error(), test.match) || strings.Contains(err.Error(), secret) {
				t.Fatalf("error: %v", err)
			}
		})
	}
}

func TestMCPValidationTimeoutAndUnsupportedContent(t *testing.T) {
	if _, err := loadMCPTools(context.Background(), MCPConfig{Alias: "x", URL: "http://example.com/mcp"}, nil); err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("insecure URL: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     int            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		switch request.Method {
		case "server/discover":
			writeRPCError(w, request.ID, -32601, nil)
		case "initialize":
			writeRPC(w, request.ID, map[string]any{"protocolVersion": legacyMCPVersion})
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			writeRPC(w, request.ID, map[string]any{"tools": []any{map[string]any{"name": "image", "inputSchema": map[string]any{"type": "object"}}, map[string]any{"name": "slow", "inputSchema": map[string]any{"type": "object"}}}})
		case "tools/call":
			if request.Params["name"] == "slow" {
				<-r.Context().Done()
				return
			}
			writeRPC(w, request.ID, map[string]any{"content": []map[string]string{{"type": "image"}}})
		}
	}))
	defer server.Close()
	loaded, err := loadMCPTools(context.Background(), MCPConfig{Alias: "x", URL: server.URL, CallTimeout: 20 * time.Millisecond}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	defer loaded.Close()
	if _, err := loaded.tools[0].Execute(context.Background(), map[string]any{}); err == nil || !strings.Contains(err.Error(), "Unsupported MCP content type") {
		t.Fatalf("unsupported: %v", err)
	}
	if _, err := loaded.tools[1].Execute(context.Background(), map[string]any{}); err == nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timeout: %v", err)
	}
}

func writeRPC(w http.ResponseWriter, id int, result any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func writeRPCError(w http.ResponseWriter, id, code int, data any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": "sanitized fixture error", "data": data}})
}
