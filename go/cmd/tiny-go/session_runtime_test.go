package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func durableAgent(t *testing.T, handler http.HandlerFunc) (*Agent, *SessionStore, func()) {
	t.Helper()
	inTempDir(t)
	t.Setenv("OPENROUTER_API_KEY", "test")
	session, err := createSessionStore(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	agent := newAgent(nil, session, "")
	agent.Endpoint, agent.Client = server.URL, server.Client()
	return agent, session, func() { server.Close(); _ = session.Close() }
}

func TestDurableRunPersistsModelAttemptUsageAndCompletion(t *testing.T) {
	agent, session, close := durableAgent(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":25}}}`))
	})
	defer close()
	if answer, err := agent.runAgentLoop("inspect"); err != nil || answer != "done" {
		t.Fatalf("run: %q %v", answer, err)
	}
	state := session.State()
	if state.Operation.Kind != "idle" || len(state.Transcript) != 2 || state.Usage.Input != 75 || state.Usage.CacheRead != 25 || state.Usage.Output != 4 {
		t.Fatalf("state: %+v", state)
	}
}

func TestDurableRunPersistsProviderFailure(t *testing.T) {
	agent, session, close := durableAgent(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("provider down"))
	})
	defer close()
	if _, err := agent.runAgentLoop("inspect"); err == nil || !strings.Contains(err.Error(), "OpenRouter 500") {
		t.Fatalf("error: %v", err)
	}
	state := session.State()
	if state.Operation.Kind != "idle" || len(state.Transcript) != 1 {
		t.Fatalf("state: %+v", state)
	}
}

func TestDurableRunPersistsCanonicalToolResults(t *testing.T) {
	requests := 0
	agent, session, close := durableAgent(t, func(w http.ResponseWriter, _ *http.Request) {
		requests++
		if requests == 1 {
			_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"read","arguments":"{\"path\":\"missing.txt\"}"}}]},"finish_reason":"tool_calls"}],"usage":{}}`))
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}],"usage":{}}`))
	})
	defer close()
	calls := 0
	for index := range agent.Tools {
		if agent.Tools[index].Name != "read" {
			continue
		}
		agent.Tools[index].Execute = func(context.Context, map[string]any) (string, error) {
			calls++
			return "", errors.New("missing")
		}
	}
	answer, err := agent.runAgentLoop("inspect")
	if err != nil || answer != "done" || calls != 1 || requests != 2 {
		t.Fatalf("answer=%q err=%v calls=%d requests=%d", answer, err, calls, requests)
	}
	state := session.State()
	if state.Operation.Kind != "idle" || len(state.Transcript) != 4 || state.Transcript[2]["content"] != "Error: missing" {
		t.Fatalf("state: %+v", state)
	}
}

func TestDurableRunTruncationPersistsSyntheticWithoutEffect(t *testing.T) {
	calls := 0
	agent, session, close := durableAgent(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"write","arguments":"{\"path\":\"x.txt\",\"content\":\"x\"}"}}]},"finish_reason":"length"}],"usage":{}}`))
	})
	defer close()
	for index := range agent.Tools {
		original := agent.Tools[index].Execute
		agent.Tools[index].Execute = func(ctx context.Context, args map[string]any) (string, error) {
			calls++
			return original(ctx, args)
		}
	}
	if _, err := agent.runAgentLoop("inspect"); err == nil || !strings.Contains(err.Error(), "token limit") {
		t.Fatalf("error: %v", err)
	}
	state := session.State()
	if calls != 0 || state.Operation.Kind != "run" || state.Transcript[len(state.Transcript)-1]["content"] != syntheticContent["truncated"] {
		t.Fatalf("calls=%d state=%+v", calls, state)
	}
	restored := newAgent(nil, session, "")
	restored.Endpoint, restored.Client = agent.Endpoint, agent.Client
	if err := restored.restoreSession(); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if state := session.State(); state.Operation.Kind != "idle" {
		t.Fatalf("recovered state: %+v", state)
	}
}

func TestSyntheticOnlyCrashPrefixResumesIdempotently(t *testing.T) {
	for _, test := range []struct {
		name, tool, arguments, reason string
	}{
		{"unknown-tool", "missing", `{}`, "unknownTool"},
		{"invalid-arguments", "read", `{`, "invalidArguments"},
	} {
		t.Run(test.name, func(t *testing.T) {
			requests := 0
			agent, session, close := durableAgent(t, func(w http.ResponseWriter, _ *http.Request) {
				requests++
				_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}],"usage":{}}`))
			})
			defer close()
			run, err := agent.startDurableRun("inspect")
			if err != nil {
				t.Fatal(err)
			}
			if err := agent.startAttempt(&run, "assistant", 1); err != nil {
				t.Fatal(err)
			}
			call := ToolCall{ID: "call_1", Type: "function", Function: ToolFunction{Name: test.tool, Arguments: test.arguments}}
			response := ModelResponse{Message: Message{Role: "assistant", ToolCalls: []ToolCall{call}}, StopReason: "toolUse"}
			if _, err := agent.settleAssistant(&run, response, false); err != nil {
				t.Fatal(err)
			}
			if err := agent.appendSynthetic(&run, 0, call, test.reason); err != nil {
				t.Fatal(err)
			}
			restored := newAgent(nil, session, "")
			restored.Endpoint, restored.Client = agent.Endpoint, agent.Client
			if err := restored.restoreSession(); err != nil {
				t.Fatal(err)
			}
			finished, _ := os.ReadFile(session.Path)
			if err := restored.restoreSession(); err != nil {
				t.Fatal(err)
			}
			again, _ := os.ReadFile(session.Path)
			if requests != 1 || string(finished) != string(again) || session.State().Operation.Kind != "idle" {
				t.Fatalf("requests=%d state=%+v", requests, session.State())
			}
		})
	}
}

func TestUnstartedToolMismatchBlocksWithoutAppendOrEffect(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*Agent, *testing.T)
		reason string
	}{
		{"configuration", func(agent *Agent, _ *testing.T) { agent.Tools[0].Description += " changed" }, "configuration_changed"},
		{"implementation", func(agent *Agent, _ *testing.T) { agent.Tools[0].ReplayKey += ":v2" }, "configuration_changed"},
		{"environment", func(_ *Agent, t *testing.T) { t.Setenv("TINY_AGENT_ENVIRONMENT_IDENTITY", "changed-environment") }, "environment_changed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			effects := 0
			agent, session, close := durableAgent(t, func(http.ResponseWriter, *http.Request) {})
			defer close()
			run, err := agent.startDurableRun("inspect")
			if err != nil {
				t.Fatal(err)
			}
			if err := agent.startAttempt(&run, "assistant", 1); err != nil {
				t.Fatal(err)
			}
			call := ToolCall{ID: "call_1", Type: "function", Function: ToolFunction{Name: "read", Arguments: `{"path":"x"}`}}
			if _, err := agent.settleAssistant(&run, ModelResponse{Message: Message{Role: "assistant", ToolCalls: []ToolCall{call}}, StopReason: "toolUse"}, false); err != nil {
				t.Fatal(err)
			}
			before, _ := os.ReadFile(session.Path)
			restored := newAgent(nil, session, "")
			for index := range restored.Tools {
				restored.Tools[index].Execute = func(context.Context, map[string]any) (string, error) { effects++; return "effect", nil }
			}
			test.mutate(restored, t)
			if err := restored.restoreSession(); err == nil || !strings.Contains(err.Error(), test.reason) {
				t.Fatalf("error=%v", err)
			}
			after, _ := os.ReadFile(session.Path)
			if string(before) != string(after) || effects != 0 {
				t.Fatalf("appended=%v effects=%d", string(before) != string(after), effects)
			}
		})
	}
}

func TestInvalidTerminalModelResponsesFinishDurably(t *testing.T) {
	for _, test := range []struct{ name, content, finish, message string }{
		{"whitespace-stop", "   ", "stop", "empty response"},
		{"length-without-calls", "partial", "length", "token limit without tool calls"},
	} {
		t.Run(test.name, func(t *testing.T) {
			agent, session, close := durableAgent(t, func(w http.ResponseWriter, _ *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": test.content}, "finish_reason": test.finish}}, "usage": map[string]any{"prompt_tokens": 9, "completion_tokens": 2}})
			})
			defer close()
			if _, err := agent.runAgentLoop("inspect"); err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("error=%v", err)
			}
			state := session.State()
			if state.Operation.Kind != "idle" || state.Usage.Input != 9 || state.Usage.Output != 2 {
				t.Fatalf("state=%+v", state)
			}
			before, _ := os.ReadFile(session.Path)
			restored := newAgent(nil, session, "")
			if err := restored.restoreSession(); err != nil {
				t.Fatal(err)
			}
			after, _ := os.ReadFile(session.Path)
			if string(before) != string(after) {
				t.Fatal("idle resume appended")
			}
		})
	}
}

func TestStopWithToolCallsFailsWithoutInvalidAssistant(t *testing.T) {
	for _, content := range []any{nil, "unexpected"} {
		name := "empty"
		if content != nil {
			name = "nonempty"
		}
		t.Run(name, func(t *testing.T) {
			agent, session, close := durableAgent(t, func(w http.ResponseWriter, _ *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"choices": []any{map[string]any{
						"message": map[string]any{
							"role": "assistant", "content": content,
							"tool_calls": []any{map[string]any{
								"id": "call_1", "type": "function",
								"function": map[string]any{"name": "read", "arguments": `{}`},
							}},
						},
						"finish_reason": "stop",
					}},
					"usage": map[string]any{"prompt_tokens": 7, "completion_tokens": 3},
				})
			})
			defer close()
			if _, err := agent.runAgentLoop("inspect"); err == nil || !strings.Contains(err.Error(), "tool calls with finish_reason: stop") {
				t.Fatalf("error=%v", err)
			}
			state := session.State()
			if state.Operation.Kind != "idle" || len(state.Transcript) != 1 || state.Usage.Input != 7 || state.Usage.Output != 3 {
				t.Fatalf("state=%+v", state)
			}
			before, _ := os.ReadFile(session.Path)
			restored := newAgent(nil, session, "")
			if err := restored.restoreSession(); err != nil {
				t.Fatal(err)
			}
			after, _ := os.ReadFile(session.Path)
			if string(before) != string(after) {
				t.Fatal("idle resume appended")
			}
		})
	}
}

func TestRestoreExecutesNonIdleRecovery(t *testing.T) {
	agent, session, close := durableAgent(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"recovered"},"finish_reason":"stop"}],"usage":{}}`))
	})
	defer close()
	if _, err := agent.startDurableRun("inspect"); err != nil {
		t.Fatal(err)
	}
	restored := newAgent(nil, session, "")
	restored.Endpoint, restored.Client = agent.Endpoint, agent.Client
	if err := restored.restoreSession(); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if state := session.State(); state.Operation.Kind != "idle" || state.Transcript[len(state.Transcript)-1]["content"] != "recovered" {
		t.Fatalf("state: %+v", state)
	}
	if err := restored.restoreSession(); err != nil {
		t.Fatalf("idempotent restore: %v", err)
	}
}
