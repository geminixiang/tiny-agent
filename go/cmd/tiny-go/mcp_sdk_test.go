package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestMCPMetabaseAuthAndIdentityDigest(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "catalog.json")
	if err := os.WriteFile(path, []byte(`{"servers":{"metabase":{"url":"https://private.example.test/mcp?tenant=hidden","auth":{"type":"metabaseApiKey","tokenEnv":"MB_TOKEN"}}}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	configs, err := loadMCPConfigs([]string{"metabase"}, map[string]string{"TINY_MCP_CONFIG": path, "MB_TOKEN": "SECRET-CANARY"})
	if err != nil || len(configs) != 1 || configs[0].AuthHeader != "X-API-Key" || configs[0].Token != "SECRET-CANARY" {
		t.Fatalf("config=%#v err=%v", configs, err)
	}
	for _, body := range []string{`{"servers":{"x":{"url":"https://x","tokenEnv":"A","auth":{"type":"metabaseApiKey","tokenEnv":"B"}}}}`, `{"servers":{"x":{"url":"https://x","auth":{"type":"bearer","tokenEnv":"A"}}}}`, `{"servers":{"x":{"url":"https://x","auth":{"type":"metabaseApiKey","token":"literal"}}}}`} {
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := loadMCPConfigs([]string{"x"}, map[string]string{"TINY_MCP_CONFIG": path, "A": "a", "B": "b"}); err == nil {
			t.Fatalf("accepted invalid catalog: %s", body)
		}
	}
	identity := digestMCPIdentity(map[string]any{"endpoint": digestMCPIdentity("https://private.example.test/mcp?tenant=hidden"), "auth": "X-API-Key", "protocol": "sdk-auto", "tool": "query"})
	if strings.Contains(identity, "private") || strings.Contains(identity, "SECRET") {
		t.Fatalf("identity leaked: %s", identity)
	}
}

func TestSDKAutoNegotiatesStatefulLegacyMCP(t *testing.T) {
	const legacy = "2025-03-26"
	var sessionID string
	calls := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     int            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if r.Method == http.MethodDelete {
			if r.Header.Get("Mcp-Session-Id") != sessionID {
				t.Errorf("close session=%q", r.Header.Get("Mcp-Session-Id"))
			}
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		calls = append(calls, request.Method)
		switch request.Method {
		case "server/discover":
			writeRPCError(w, request.ID, -32601, nil)
		case "initialize":
			sessionID = "legacy-session"
			w.Header().Set("Mcp-Session-Id", sessionID)
			writeRPC(w, request.ID, map[string]any{"protocolVersion": legacy, "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "fixture", "version": "1"}})
		case "notifications/initialized":
		case "tools/list":
			writeRPC(w, request.ID, map[string]any{"tools": []any{map[string]any{"name": "echo", "inputSchema": map[string]any{"type": "object"}}}})
		case "tools/call":
			writeRPC(w, request.ID, map[string]any{"content": []any{map[string]any{"type": "text", "text": "legacy"}}})
		default:
			t.Errorf("unexpected %q", request.Method)
		}
	}))
	defer server.Close()
	loaded, err := loadMCPTools(context.Background(), MCPConfig{Alias: "legacy", URL: server.URL}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	result, err := loaded.tools[0].Execute(context.Background(), map[string]any{})
	if err != nil || result != "legacy" {
		t.Fatalf("result=%q err=%v", result, err)
	}
	if err := loaded.Close(); err != nil {
		t.Fatal(err)
	}
	if strings.Join(calls, ",") != "server/discover,initialize,notifications/initialized,tools/list,tools/call" {
		t.Fatalf("calls=%v", calls)
	}
}

func TestMCPAuthHeaders(t *testing.T) {
	for _, test := range []struct{ name, catalog, header, token, envToken string }{
		{"bearer", `"tokenEnv":"TOKEN"`, "Authorization", "Bearer bearer-secret", "bearer-secret"},
		{"metabase", `"auth":{"type":"metabaseApiKey","tokenEnv":"TOKEN"}`, "X-Api-Key", "key-secret", "key-secret"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get(test.header) != test.token {
					t.Errorf("%s=%q", test.header, r.Header.Get(test.header))
				}
				var request struct {
					ID     int    `json:"id"`
					Method string `json:"method"`
				}
				_ = json.NewDecoder(r.Body).Decode(&request)
				switch request.Method {
				case "server/discover":
					writeRPC(w, request.ID, map[string]any{"supportedVersions": []string{modernMCPVersion}})
				case "tools/list":
					writeRPC(w, request.ID, map[string]any{"tools": []any{}})
				}
			}))
			defer server.Close()
			path := filepath.Join(t.TempDir(), "mcp.json")
			body := `{"servers":{"x":{"url":` + strconv.Quote(server.URL) + `,` + test.catalog + `}}}`
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			configs, err := loadMCPConfigs([]string{"x"}, map[string]string{"TINY_MCP_CONFIG": path, "TOKEN": test.envToken})
			if err != nil {
				t.Fatal(err)
			}
			loaded, err := loadMCPTools(context.Background(), configs[0], server.Client())
			if err != nil {
				t.Fatal(err)
			}
			defer loaded.Close()
		})
	}
}
