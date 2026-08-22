package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

func TestDurableRunLengthAndToolUseNeverExecuteEffects(t *testing.T) {
	for _, test := range []struct {
		name, finish string
	}{{"length", "length"}, {"tool", "tool_calls"}} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			agent, session, close := durableAgent(t, func(w http.ResponseWriter, _ *http.Request) {
				message := map[string]any{"role": "assistant", "content": "truncated"}
				if test.finish == "tool_calls" {
					message = map[string]any{"role": "assistant", "content": nil, "tool_calls": []any{map[string]any{"id": "call_1", "type": "function", "function": map[string]any{"name": "write", "arguments": `{"path":"x.txt","content":"x"}`}}}}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": message, "finish_reason": test.finish}}, "usage": map[string]any{}})
			})
			defer close()
			for index := range agent.Tools {
				original := agent.Tools[index].Execute
				agent.Tools[index].Execute = func(ctx context.Context, args map[string]any) (string, error) {
					calls++
					return original(ctx, args)
				}
			}
			if _, err := agent.runAgentLoop("inspect"); err == nil {
				t.Fatal("expected phase barrier error")
			}
			if calls != 0 {
				t.Fatalf("executed %d effects", calls)
			}
			if session.State().Operation.Kind != "run" {
				t.Fatalf("operation: %+v", session.State().Operation)
			}
		})
	}
}

func TestRestoreRejectsNonIdleSessionWithRecoveryPlan(t *testing.T) {
	agent, session, close := durableAgent(t, func(http.ResponseWriter, *http.Request) {})
	defer close()
	if _, err := agent.startDurableRun("inspect"); err != nil {
		t.Fatal(err)
	}
	restored := newAgent(nil, session, "")
	if err := restored.restoreSession(); err == nil || !strings.Contains(err.Error(), "Session recovery required") {
		t.Fatalf("restore: %v", err)
	}
}
