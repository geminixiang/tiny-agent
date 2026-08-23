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

type testRoundTripper func(*http.Request) (*http.Response, error)

func (f testRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func TestMCPPreflightNeverFallsBackOnOperationalFailures(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusBadGateway} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			calls := []string{}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var q struct {
					Method string `json:"method"`
				}
				_ = json.NewDecoder(r.Body).Decode(&q)
				calls = append(calls, q.Method)
				w.WriteHeader(status)
			}))
			defer server.Close()
			_, err := loadMCPTools(context.Background(), MCPConfig{Alias: "x", URL: server.URL}, server.Client())
			if err == nil || strings.Join(calls, ",") != "server/discover" {
				t.Fatalf("err=%v calls=%v", err, calls)
			}
		})
	}
	calls := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var q struct {
			Method string `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&q)
		calls <- q.Method
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := loadMCPTools(ctx, MCPConfig{Alias: "x", URL: server.URL}, server.Client())
	if !errors.Is(err, context.DeadlineExceeded) || <-calls != "server/discover" {
		t.Fatalf("err=%v", err)
	}
	transportCalls := []string{}
	client := &http.Client{Transport: testRoundTripper(func(r *http.Request) (*http.Response, error) {
		var q struct {
			Method string `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&q)
		transportCalls = append(transportCalls, q.Method)
		return nil, errors.New("fixture transport")
	})}
	_, err = loadMCPTools(context.Background(), MCPConfig{Alias: "x", URL: "http://127.0.0.1/mcp"}, client)
	if err == nil || strings.Join(transportCalls, ",") != "server/discover" {
		t.Fatalf("err=%v calls=%v", err, transportCalls)
	}
}

func TestMCPAllowlistPaginationAndGlobalCap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp.json")
	if err := os.WriteFile(path, []byte(`{"servers":{"x":{"url":"https://example.test/mcp","allowedTools":[]}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	configs, err := loadMCPConfigs([]string{"x"}, map[string]string{"TINY_MCP_CONFIG": path})
	if err != nil || !configs[0].AllowedToolsSet || len(configs[0].AllowedTools) != 0 {
		t.Fatalf("configs=%#v err=%v", configs, err)
	}
	for _, count := range []int{1, 33} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var q struct {
					ID     int            `json:"id"`
					Method string         `json:"method"`
					Params map[string]any `json:"params"`
				}
				_ = json.NewDecoder(r.Body).Decode(&q)
				switch q.Method {
				case "server/discover":
					writeRPC(w, q.ID, map[string]any{"supportedVersions": []string{modernMCPVersion}})
				case "tools/list":
					tools := make([]any, count)
					offset := 0
					if q.Params["cursor"] == "next" {
						offset = count
					}
					for i := range tools {
						tools[i] = map[string]any{"name": fmt.Sprintf("tool-%d", offset+i), "inputSchema": map[string]any{"type": "object"}}
					}
					if q.Params["cursor"] == "next" {
						writeRPC(w, q.ID, map[string]any{"tools": tools})
						return
					}
					writeRPC(w, q.ID, map[string]any{"tools": tools, "nextCursor": "next"})
				}
			}))
			defer server.Close()
			loaded, err := loadMCPTools(context.Background(), MCPConfig{Alias: "x", URL: server.URL}, server.Client())
			if count == 33 {
				if err == nil || !strings.Contains(err.Error(), "more than 64 tools") {
					t.Fatalf("err=%v", err)
				}
				return
			}
			if err != nil || len(loaded.tools) != 2 {
				t.Fatalf("tools=%d err=%v", len(loaded.tools), err)
			}
			loaded.Close()
			loaded, err = loadMCPTools(context.Background(), MCPConfig{Alias: "x", URL: server.URL, AllowedToolsSet: true}, server.Client())
			if err != nil || len(loaded.tools) != 0 {
				t.Fatalf("tools=%d err=%v", len(loaded.tools), err)
			}
			loaded.Close()
			_, err = loadMCPTools(context.Background(), MCPConfig{Alias: "x", URL: server.URL, AllowedToolsSet: true, AllowedTools: []string{"missing"}}, server.Client())
			if err == nil || !strings.Contains(err.Error(), "allowlisted tool is missing") {
				t.Fatalf("err=%v", err)
			}
		})
	}
}

func TestMCPBoundedListCallErrorAndDuplicates(t *testing.T) {
	for _, phase := range []string{"list", "call", "error", "duplicate"} {
		t.Run(phase, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var q struct {
					ID     int    `json:"id"`
					Method string `json:"method"`
				}
				_ = json.NewDecoder(r.Body).Decode(&q)
				if phase == "error" {
					w.WriteHeader(502)
					_, _ = w.Write([]byte(strings.Repeat("x", maxMCPHTTPBytes+1)))
					return
				}
				switch q.Method {
				case "server/discover":
					writeRPC(w, q.ID, map[string]any{"supportedVersions": []string{modernMCPVersion}})
				case "tools/list":
					if phase == "list" {
						w.Header().Set("Content-Type", "application/json")
						_, _ = w.Write([]byte(strings.Repeat("x", maxMCPHTTPBytes+1)))
						return
					}
					tools := []any{map[string]any{"name": "big", "inputSchema": map[string]any{"type": "object"}}}
					if phase == "duplicate" {
						tools = append(tools, tools[0])
					}
					writeRPC(w, q.ID, map[string]any{"tools": tools})
				case "tools/call":
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(strings.Repeat("x", maxMCPHTTPBytes+1)))
				}
			}))
			defer server.Close()
			loaded, err := loadMCPTools(context.Background(), MCPConfig{Alias: "x", URL: server.URL}, server.Client())
			if phase == "call" {
				if err != nil {
					t.Fatal(err)
				}
				defer loaded.Close()
				_, err = loaded.tools[0].Execute(context.Background(), map[string]any{})
			}
			match := "MCP response exceeds 10MB"
			if phase == "duplicate" {
				match = "duplicate MCP tool name"
			}
			if err == nil || !strings.Contains(err.Error(), match) {
				t.Fatalf("err=%v", err)
			}
		})
	}
}
