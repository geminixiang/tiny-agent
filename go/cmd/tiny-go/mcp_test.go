package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
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
	configs, err := loadMCPConfigs([]string{"fixture", "public"}, map[string]string{"TINY_MCP_CONFIG": path, "FIXTURE_TOKEN": "secret"})
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
		{`{"servers":{"fixture":{"url":"https://x","allowedTools":["x","x"]}}}`, "allowedTools must contain nonempty, unique strings"},
		{catalog, "environment variable is not set"},
	} {
		if err := os.WriteFile(path, []byte(test.body), 0o644); err != nil {
			t.Fatal(err)
		}
		_, err := loadMCPConfigs([]string{"fixture"}, map[string]string{"TINY_MCP_CONFIG": path})
		if err == nil || !strings.Contains(err.Error(), test.match) {
			t.Fatalf("body=%s err=%v", test.body, err)
		}
	}
}

func TestLoadMCPConfigsRequiresExplicitCatalogPath(t *testing.T) {
	if _, err := loadMCPConfigs([]string{"fixture"}, map[string]string{}); err == nil ||
		!strings.Contains(err.Error(), "TINY_MCP_CONFIG must be set to use --mcp") {
		t.Fatalf("error: %v", err)
	}
	if configs, err := loadMCPConfigs(nil, map[string]string{}); err != nil || configs != nil {
		t.Fatalf("no aliases should short-circuit without requiring TINY_MCP_CONFIG: configs=%v err=%v", configs, err)
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
		if r.Header.Get("Mcp-Protocol-Version") != modernMCPVersion || r.Header.Get("Mcp-Session-Id") != "" {
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
			if r.Header.Get("Mcp-Name") != "你好" {
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
	if err != nil || result != "modern" || loaded.protocolVersion != modernMCPVersion {
		t.Fatalf("result=%q version=%s err=%v", result, loaded.protocolVersion, err)
	}
	if strings.Join(calls, ",") != "server/discover,tools/list,tools/call" {
		t.Fatalf("calls: %v", calls)
	}
}

func TestModernCorrectiveRetry(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		calls++
		if calls == 1 {
			writeRPCError(w, request.ID, -32022, map[string]any{"supported": []string{modernMCPVersion}})
			return
		}
		if request.Method == "server/discover" {
			writeRPC(w, request.ID, map[string]any{"supportedVersions": []string{modernMCPVersion}, "capabilities": map[string]any{}})
			return
		}
		writeRPC(w, request.ID, map[string]any{"tools": []any{}})
	}))
	defer server.Close()
	loaded, err := loadMCPTools(context.Background(), MCPConfig{Alias: "fixture", URL: server.URL}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	defer loaded.Close()
	if calls != 3 {
		t.Fatalf("calls: %d", calls)
	}
}

func TestSDKRejectsUnsupportedLegacyMCP(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID int `json:"id"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		writeRPCError(w, request.ID, -32022, map[string]any{"supported": []string{"2025-03-26"}})
	}))
	defer server.Close()
	if _, err := loadMCPTools(context.Background(), MCPConfig{Alias: "fixture", URL: server.URL}, server.Client()); err == nil {
		t.Fatal("expected unsupported legacy MCP to fail")
	}
}

func TestMCPSDKTransportErrorsAreSanitized(t *testing.T) {
	secret := "SECRET-CANARY-DO-NOT-LEAK"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = fmt.Fprint(w, secret)
	}))
	defer server.Close()
	_, err := loadMCPTools(context.Background(), MCPConfig{Alias: "x", URL: server.URL}, server.Client())
	if err == nil || !strings.Contains(err.Error(), "Bad Gateway") || strings.Contains(err.Error(), secret) {
		t.Fatalf("error: %v", err)
	}
}

func TestMCPSharedSchemaSubset(t *testing.T) {
	valid := map[string]any{"type": "object", "properties": map[string]any{
		"items": map[string]any{"type": "array", "items": map[string]any{"oneOf": []any{map[string]any{"type": "string"}, map[string]any{"type": "integer", "minimum": float64(0)}}}},
	}, "required": []any{"items"}, "additionalProperties": false}
	if err := validateMCPToolSchema(valid, "valid"); err != nil {
		t.Fatalf("valid schema: %v", err)
	}
	for _, test := range []struct {
		name   string
		schema map[string]any
		match  string
	}{
		{"unsupported", map[string]any{"type": "object", "properties": map[string]any{"x": map[string]any{"type": "string", "anyOf": []any{}}}}, "anyOf"},
		{"malformed-required", map[string]any{"type": "object", "required": "x"}, "required"},
		{"malformed-items", map[string]any{"type": "array", "items": true}, "items"},
		{"malformed-bound", map[string]any{"type": "string", "minLength": "1"}, "minLength"},
		{"malformed-one-of", map[string]any{"type": "object", "oneOf": []any{"bad"}}, "oneOf"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := validateMCPToolSchema(test.schema, "bad"); err == nil || !strings.Contains(err.Error(), test.match) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestMCPEndpointIdentityBlocksPendingEffect(t *testing.T) {
	inTempDir(t)
	t.Setenv("OPENROUTER_API_KEY", "test")
	makeTool := func(endpoint string, effects *int) Tool {
		mapped, _ := mapMCPToolName("same", "read")
		return Tool{Name: mapped, Description: "same", Parameters: map[string]any{"type": "object"}, Replay: "never", ReplayKey: "mcp:same:" + endpoint + ":read:v1", Execute: func(context.Context, map[string]any) (string, error) {
			*effects = *effects + 1
			return "effect", nil
		}}
	}
	effects := 0
	session, err := createSessionStore(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	agent := newAgent(nil, session, "")
	agent.Tools = []Tool{makeTool("https://a.example/mcp", &effects)}
	run, err := agent.startDurableRun("inspect")
	if err != nil {
		t.Fatal(err)
	}
	if err := agent.startAttempt(&run, "assistant", 1); err != nil {
		t.Fatal(err)
	}
	call := ToolCall{ID: "call_1", Type: "function", Function: ToolFunction{Name: agent.Tools[0].Name, Arguments: `{}`}}
	if _, err := agent.settleAssistant(&run, ModelResponse{Message: Message{Role: "assistant", ToolCalls: []ToolCall{call}}, StopReason: "toolUse"}, false); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(session.Path)
	restored := newAgent(nil, session, "")
	restored.Tools = []Tool{makeTool("https://b.example/mcp", &effects)}
	if err := restored.restoreSession(); err == nil || !strings.Contains(err.Error(), "configuration_changed") {
		t.Fatalf("error=%v", err)
	}
	after, _ := os.ReadFile(session.Path)
	if !bytes.Equal(before, after) || effects != 0 {
		t.Fatalf("appended=%v effects=%d", !bytes.Equal(before, after), effects)
	}
}

func TestMCPReplayKeyUsesCanonicalCredentialFreeEndpoint(t *testing.T) {
	parsed, _ := url.Parse("HTTPS://Example.COM:443/mcp?tenant=x")
	endpoint, err := canonicalMCPEndpoint(parsed)
	if err != nil || endpoint != "https://example.com/mcp?tenant=x" {
		t.Fatalf("endpoint=%q err=%v", endpoint, err)
	}
	if strings.Contains(endpoint, "token") || strings.Contains(endpoint, "Bearer") {
		t.Fatalf("credential leaked: %s", endpoint)
	}
}

func TestMCPTextResourceAndBinaryResource(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     int            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		switch request.Method {
		case "server/discover":
			writeRPC(w, request.ID, map[string]any{"supportedVersions": []string{modernMCPVersion}, "capabilities": map[string]any{"tools": map[string]any{}}})
		case "tools/list":
			tools := []any{}
			for _, name := range []string{"resource", "blob", "large"} {
				tools = append(tools, map[string]any{"name": name, "inputSchema": map[string]any{"type": "object"}})
			}
			writeRPC(w, request.ID, map[string]any{"tools": tools})
		case "tools/call":
			switch request.Params["name"] {
			case "resource":
				writeRPC(w, request.ID, map[string]any{"content": []any{map[string]any{"type": "resource", "resource": map[string]any{"uri": "repo://README.md", "mimeType": "text/markdown", "text": "hello"}}}})
			case "blob":
				writeRPC(w, request.ID, map[string]any{"content": []any{map[string]any{"type": "resource", "resource": map[string]any{"uri": "repo://image.png", "blob": "aGVsbG8="}}}})
			case "large":
				writeRPC(w, request.ID, map[string]any{"content": []any{map[string]any{"type": "resource", "resource": map[string]any{"uri": "repo://large.txt", "text": strings.Repeat("你", maxMCPResultBytes)}}}})
			}
		}
	}))
	defer server.Close()
	loaded, err := loadMCPTools(context.Background(), MCPConfig{Alias: "fixture", URL: server.URL}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	defer loaded.Close()
	result, err := loaded.tools[0].Execute(context.Background(), map[string]any{})
	if err != nil || result != "Resource: repo://README.md\nhello" {
		t.Fatalf("resource=%q err=%v", result, err)
	}
	if _, err := loaded.tools[1].Execute(context.Background(), map[string]any{}); err == nil || !strings.Contains(err.Error(), "Unsupported MCP content type: resource") {
		t.Fatalf("blob error: %v", err)
	}
	result, err = loaded.tools[2].Execute(context.Background(), map[string]any{})
	if err != nil || len([]byte(result)) > maxMCPResultBytes || !strings.HasSuffix(result, "[MCP result truncated to 50KB]") || !utf8.ValidString(result) {
		t.Fatalf("large bytes=%d valid=%v err=%v", len([]byte(result)), utf8.ValidString(result), err)
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
			writeRPC(w, request.ID, map[string]any{"supportedVersions": []string{modernMCPVersion}, "capabilities": map[string]any{"tools": map[string]any{}}})
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
