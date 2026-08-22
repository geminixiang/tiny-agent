package main

import (
	"context"
	"errors"
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
