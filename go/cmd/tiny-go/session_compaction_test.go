package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func completedCompactionAgent(t *testing.T, turns int) (*Agent, *SessionStore, *int, func()) {
	t.Helper()
	requests := 0
	agent, session, close := durableAgent(t, func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}`))
	})
	for index := 0; index < turns; index++ {
		if _, err := agent.runAgentLoop("question"); err != nil {
			t.Fatal(err)
		}
	}
	return agent, session, &requests, close
}

func TestDurableCompactionPersistsCanonicalFacts(t *testing.T) {
	agent, session, _, close := completedCompactionAgent(t, 4)
	defer close()
	agent.Client = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return jsonResponse(`{"choices":[{"message":{"role":"assistant","content":"durable summary"},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":3}}`), nil
	})}
	answer, err := agent.compact()
	if err != nil || answer != "Compacted 2 messages (kept last 6)." {
		t.Fatalf("compact=%q err=%v", answer, err)
	}
	state := session.State()
	if state.Operation.Kind != "idle" || state.ActiveContext[0]["content"] != "[Compacted history]\ndurable summary" || len(state.ActiveContext) != 7 {
		t.Fatalf("state=%+v", state)
	}
	data, _ := os.ReadFile(session.Path)
	positions := []int{
		strings.LastIndex(string(data), `"type":"compactionStarted"`),
		strings.LastIndex(string(data), `"type":"stepAttempt"`),
		strings.LastIndex(string(data), `"kind":"usage"`),
		strings.LastIndex(string(data), `"type":"compaction"`),
		strings.LastIndex(string(data), `"type":"operationFinished"`),
	}
	for index := 1; index < len(positions); index++ {
		if positions[index-1] < 0 || positions[index] <= positions[index-1] {
			t.Fatalf("fact order=%v", positions)
		}
	}
}

func TestDurableCompactionAbort(t *testing.T) {
	agent, session, _, cleanup := completedCompactionAgent(t, 4)
	defer cleanup()
	started := make(chan struct{})
	persistedBeforeSignal := make(chan bool, 1)
	agent.Client = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		close(started)
		<-request.Context().Done()
		data, _ := os.ReadFile(session.Path)
		persistedBeforeSignal <- strings.Contains(string(data), `"type":"abortRequested"`)
		return nil, request.Context().Err()
	})}
	done := make(chan string, 1)
	go func() { answer, _ := agent.compact(); done <- answer }()
	<-started
	agent.abort()
	if answer := <-done; answer != "Compaction aborted." {
		t.Fatalf("answer=%q", answer)
	}
	if !<-persistedBeforeSignal {
		t.Fatal("cancellation was observed before abortRequested persisted")
	}
	if state := session.State(); state.Operation.Kind != "idle" {
		t.Fatalf("state=%+v", state)
	}
	data, _ := os.ReadFile(session.Path)
	if !strings.Contains(string(data), `"operationKind":"compaction","phase":"compact"`) || strings.Contains(string(data), `"type":"compaction","operationId"`) {
		t.Fatalf("facts=%s", data)
	}
}

func TestCompactionRecoveryOpenAttemptMismatchAndIdempotence(t *testing.T) {
	agent, session, _, close := completedCompactionAgent(t, 4)
	defer close()
	state := session.State()
	compacted, retained := state.messageFacts[:2], state.messageFacts[2:]
	compactedIDs, retainedIDs := make([]any, len(compacted)), make([]any, len(retained))
	for index, item := range compacted {
		compactedIDs[index] = item.ID
	}
	for index, item := range retained {
		retainedIDs[index] = item.ID
	}
	operationID, resultID := session.NewID(time.Now()), session.NewID(time.Now().Add(time.Nanosecond))
	if err := session.Commit([]map[string]any{{"kind": "record", "record": map[string]any{
		"type": "compactionStarted", "operationId": operationID, "operationKind": "compaction",
		"inputThroughEntryId": state.messageFacts[len(state.messageFacts)-1].ID, "resultEntryId": resultID,
		"compactedEntryIds": compactedIDs, "retainedEntryIds": retainedIDs, "sourceDigest": digestSourceFacts(state.messageFacts),
	}}}); err != nil {
		t.Fatal(err)
	}
	run := durableRun{OperationID: operationID, ContextEntryID: state.messageFacts[len(state.messageFacts)-1].ID, Attempt: 1}
	if err := agent.startAttempt(&run, "compaction", 1); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(session.Path)
	mismatch := newAgent(nil, session, "changed")
	if err := mismatch.restoreSession(); err == nil || !strings.Contains(err.Error(), "configuration_changed") {
		t.Fatalf("mismatch=%v", err)
	}
	after, _ := os.ReadFile(session.Path)
	if string(before) != string(after) {
		t.Fatal("mismatch appended facts")
	}

	recovered := newAgent(nil, session, "")
	recovered.Client = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return jsonResponse(`{"choices":[{"message":{"role":"assistant","content":"recovered summary"},"finish_reason":"stop"}],"usage":{}}`), nil
	})}
	if err := recovered.restoreSession(); err != nil {
		t.Fatal(err)
	}
	finished, _ := os.ReadFile(session.Path)
	if err := recovered.restoreSession(); err != nil {
		t.Fatal(err)
	}
	again, _ := os.ReadFile(session.Path)
	if string(finished) != string(again) || session.State().Operation.Kind != "idle" {
		t.Fatal("resume was not idempotent")
	}
}

func TestCompactionRecoveryFinishesPersistedEntry(t *testing.T) {
	agent, session, _, close := completedCompactionAgent(t, 4)
	defer close()
	agent.Client = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return jsonResponse(`{"choices":[{"message":{"role":"assistant","content":"persisted summary"},"finish_reason":"stop"}],"usage":{}}`), nil
	})}
	if _, err := agent.compact(); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(session.Path)
	lines := bytes.Split(data, []byte{'\n'})
	if len(lines) < 3 {
		t.Fatal("session too short")
	}
	prefix := bytes.Join(lines[:len(lines)-2], []byte{'\n'})
	prefix = append(prefix, '\n')
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(session.Path, prefix, 0o600); err != nil {
		t.Fatal(err)
	}
	reopened, err := openSessionStore(session.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	recovered := newAgent(nil, reopened, "")
	beforeCalls := 0
	recovered.Client = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		beforeCalls++
		return nil, errors.New("unexpected model call")
	})}
	if err := recovered.restoreSession(); err != nil {
		t.Fatal(err)
	}
	if beforeCalls != 0 || reopened.State().Operation.Kind != "idle" || reopened.State().ActiveContext[0]["content"] != "[Compacted history]\npersisted summary" {
		t.Fatalf("calls=%d state=%+v", beforeCalls, reopened.State())
	}
	finished, _ := os.ReadFile(reopened.Path)
	if err := recovered.restoreSession(); err != nil {
		t.Fatal(err)
	}
	again, _ := os.ReadFile(reopened.Path)
	if !bytes.Equal(finished, again) {
		t.Fatal("second resume appended")
	}
}
func TestCompactionRecoveryStartsMissingAttempt(t *testing.T) {
	_, session, _, close := completedCompactionAgent(t, 4)
	defer close()
	state := session.State()
	compacted, retained := state.messageFacts[:2], state.messageFacts[2:]
	compactedIDs, retainedIDs := make([]any, len(compacted)), make([]any, len(retained))
	for index, item := range compacted {
		compactedIDs[index] = item.ID
	}
	for index, item := range retained {
		retainedIDs[index] = item.ID
	}
	operationID, resultID := session.NewID(time.Now()), session.NewID(time.Now().Add(time.Nanosecond))
	if err := session.Commit([]map[string]any{{"kind": "record", "record": map[string]any{
		"type": "compactionStarted", "operationId": operationID, "operationKind": "compaction",
		"inputThroughEntryId": state.messageFacts[len(state.messageFacts)-1].ID, "resultEntryId": resultID,
		"compactedEntryIds": compactedIDs, "retainedEntryIds": retainedIDs, "sourceDigest": digestSourceFacts(state.messageFacts),
	}}}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	recovered := newAgent(nil, session, "")
	recovered.Client = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return jsonResponse(`{"choices":[{"message":{"role":"assistant","content":"attempt one"},"finish_reason":"stop"}],"usage":{}}`), nil
	})}
	if err := recovered.restoreSession(); err != nil {
		t.Fatal(err)
	}
	finished, _ := os.ReadFile(session.Path)
	if err := recovered.restoreSession(); err != nil {
		t.Fatal(err)
	}
	again, _ := os.ReadFile(session.Path)
	if calls != 1 || !bytes.Equal(finished, again) || session.State().Operation.Kind != "idle" {
		t.Fatalf("calls=%d state=%+v", calls, session.State())
	}
}

func TestCompactionRejectsNonStopSummary(t *testing.T) {
	agent, session, _, close := completedCompactionAgent(t, 4)
	defer close()
	agent.Client = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return jsonResponse(`{"choices":[{"message":{"role":"assistant","content":"partial"},"finish_reason":"length"}],"usage":{}}`), nil
	})}
	if _, err := agent.compact(); err == nil || !strings.Contains(err.Error(), "invalid compaction summary") {
		t.Fatalf("error=%v", err)
	}
	if session.State().Operation.Kind != "idle" {
		t.Fatalf("state=%+v", session.State())
	}
}

func TestRepeatedCompactionUsesBoundedActiveContext(t *testing.T) {
	agent, session, _, close := completedCompactionAgent(t, 4)
	defer close()
	summaries := []string{"first knowledge", "second knowledge including first knowledge"}
	sources := []string{}
	agent.Client = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		var body struct {
			Messages []Message `json:"messages"`
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		if len(body.Messages) == 2 && strings.Contains(value(body.Messages[0].Content), "Summarize") {
			sources = append(sources, value(body.Messages[1].Content))
			summary := summaries[len(sources)-1]
			return jsonResponse(`{"choices":[{"message":{"role":"assistant","content":` + mustJSON(summary) + `},"finish_reason":"stop"}],"usage":{}}`), nil
		}
		return jsonResponse(`{"choices":[{"message":{"role":"assistant","content":"new answer"},"finish_reason":"stop"}],"usage":{}}`), nil
	})}
	if _, err := agent.compact(); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 4; index++ {
		if _, err := agent.runAgentLoop("new question"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := agent.compact(); err != nil {
		t.Fatal(err)
	}
	if len(sources) != 2 || !strings.Contains(sources[1], "[Compacted history]\\nfirst knowledge") || !strings.Contains(session.State().ActiveContext[0]["content"].(string), "second knowledge") {
		t.Fatalf("sources=%v active=%v", sources, session.State().ActiveContext)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
func jsonResponse(body string) *http.Response {
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}
func mustJSON(value string) string { encoded, _ := json.Marshal(value); return string(encoded) }
