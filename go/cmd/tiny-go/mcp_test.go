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

func TestSplitMCPListAndDisplayName(t *testing.T) {
	got := splitList([]string{" first, second ", "first", "third,"})
	if strings.Join(got, ",") != "first,second,third" {
		t.Fatalf("split: %#v", got)
	}
	name, err := mapMCPToolName("complex", "analyze_data")
	if err != nil || displayToolName(name) != "mcp:complex/analyze_data" || len(name) > 64 {
		t.Fatalf("name=%q display=%q err=%v", name, displayToolName(name), err)
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
	for _, test := range []struct {
		body, match string
	}{
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

func TestMCPStreamableHTTPListsCallsAndNormalizes(t *testing.T) {
	var auth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		auth = r.Header.Get("Authorization")
		var request struct {
			ID     int            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		w.Header().Set("Mcp-Session-Id", "fixture-session")
		switch request.Method {
		case "initialize":
			writeRPC(w, request.ID, map[string]any{"protocolVersion": "2025-03-26", "capabilities": map[string]any{}, "serverInfo": map[string]string{"name": "fixture", "version": "1"}})
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n")
			fmt.Fprintf(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":%d,\"result\":{\"tools\":[{\"name\":\"echo\",\"description\":\"Echo\",\"inputSchema\":{\"type\":\"object\"}},{\"name\":\"fail\",\"inputSchema\":{\"type\":\"object\"}}]}}\n\n", request.ID)
		case "tools/call":
			name, _ := request.Params["name"].(string)
			if name == "fail" {
				writeRPC(w, request.ID, map[string]any{"content": []map[string]string{{"type": "text", "text": "nope"}}, "isError": true})
				return
			}
			writeRPC(w, request.ID, map[string]any{"content": []map[string]string{{"type": "text", "text": "hello"}}, "structuredContent": map[string]any{"count": 2}})
		default:
			t.Errorf("unexpected method %q", request.Method)
		}
	}))
	defer server.Close()
	loaded, err := loadMCPTools(context.Background(), MCPConfig{Alias: "fixture", URL: server.URL, Token: "secret", CallTimeout: time.Second}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	defer loaded.Close()
	if auth != "Bearer secret" || loaded.protocolVersion != "2025-03-26" || len(loaded.tools) != 2 {
		t.Fatalf("auth=%q version=%q tools=%d", auth, loaded.protocolVersion, len(loaded.tools))
	}
	if _, err := loaded.tools[0].Execute(context.Background(), nil); err == nil || !strings.Contains(err.Error(), "arguments must be a JSON object") {
		t.Fatalf("null arguments: %v", err)
	}
	result, err := loaded.tools[0].Execute(context.Background(), map[string]any{"message": "hello"})
	if err != nil || result != "hello\n\nStructured content:\n{\"count\":2}" {
		t.Fatalf("result=%q err=%v", result, err)
	}
	if _, err := loaded.tools[1].Execute(context.Background(), map[string]any{}); err == nil || !strings.Contains(err.Error(), "MCP tool error: nope") {
		t.Fatalf("failure: %v", err)
	}
}

func TestMCPValidationTimeoutAndUnsupportedContent(t *testing.T) {
	if _, err := loadMCPTools(context.Background(), MCPConfig{Alias: "x", URL: "http://example.com/mcp"}, nil); err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("insecure URL: %v", err)
	}
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
		_ = json.NewDecoder(r.Body).Decode(&request)
		switch request.Method {
		case "initialize":
			writeRPC(w, request.ID, map[string]any{"protocolVersion": "2025-03-26"})
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
