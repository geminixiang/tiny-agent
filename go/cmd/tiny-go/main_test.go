package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"golang.org/x/term"
)

func inTempDir(t *testing.T) string {
	t.Helper()
	old := cwd
	cwd = t.TempDir()
	t.Cleanup(func() { cwd = old })
	return cwd
}

func TestCRLFWriter(t *testing.T) {
	out := &strings.Builder{}
	input := []byte("a\nb\r\n")
	n, err := (crlfWriter{out}).Write(input)
	if err != nil || n != len(input) || out.String() != "a\r\nb\r\n" {
		t.Fatalf("n=%d output=%q err=%v", n, out.String(), err)
	}
}

func TestTerminalLineEditingAndExit(t *testing.T) {
	out := &strings.Builder{}
	tty := &terminal{keys: make(chan keyEvent, 8), out: out, old: &term.State{}}
	for _, key := range []byte("你a") {
		tty.keys <- keyEvent{key: key}
	}
	tty.keys <- keyEvent{key: 127}
	tty.keys <- keyEvent{key: '\r'}
	line, err := tty.readLine("› ")
	if err != nil || line != "你" {
		t.Fatalf("line: %q %v", line, err)
	}
	tty.keys <- keyEvent{key: 3}
	if _, err := tty.readLine("› "); !errors.Is(err, errExit) {
		t.Fatalf("Ctrl+C: %v", err)
	}
}

func TestTerminalEscAbortsOperation(t *testing.T) {
	tty := &terminal{keys: make(chan keyEvent, 1), out: &strings.Builder{}, old: &term.State{}}
	agent := newAgent(nil, nil, "")
	started := make(chan struct{})
	done := make(chan error)
	go func() {
		_, err := tty.run(agent, func() (string, error) {
			ctx := agent.begin()
			close(started)
			<-ctx.Done()
			agent.end()
			return "Operation aborted.", nil
		})
		done <- err
	}()
	<-started
	tty.keys <- keyEvent{key: 27}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestTerminalCtrlCAbortsAndExits(t *testing.T) {
	tty := &terminal{keys: make(chan keyEvent, 1), out: &strings.Builder{}, old: &term.State{}}
	agent := newAgent(nil, nil, "")
	started := make(chan struct{})
	done := make(chan error)
	go func() {
		_, err := tty.run(agent, func() (string, error) {
			ctx := agent.begin()
			close(started)
			<-ctx.Done()
			agent.end()
			return "", nil
		})
		done <- err
	}()
	<-started
	tty.keys <- keyEvent{key: 3}
	if err := <-done; !errors.Is(err, errExit) {
		t.Fatalf("Ctrl+C: %v", err)
	}
}

func TestBashErrorPreservesOutput(t *testing.T) {
	inTempDir(t)
	result, err := executeBash(context.Background(), "printf captured; exit 7")
	if err == nil || result != "captured" {
		t.Fatalf("result=%q err=%v", result, err)
	}
}

func TestBashOutputLimit(t *testing.T) {
	inTempDir(t)
	result, err := executeBash(context.Background(), "yes x | head -n 5242881")
	if err == nil || !strings.Contains(err.Error(), "10MB limit") {
		t.Fatalf("result bytes=%d err=%v", len(result), err)
	}
	if len(result) > maxBashOutput {
		t.Fatalf("buffered %d bytes", len(result))
	}
}

func TestBashCancellationKillsBackgroundChildren(t *testing.T) {
	inTempDir(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := executeBash(ctx, "sleep 30 & wait"); done <- err }()
	time.Sleep(100 * time.Millisecond)
	started := time.Now()
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err=%v", err)
		}
		if time.Since(started) > time.Second {
			t.Fatalf("cancellation took %v", time.Since(started))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("background child delayed cancellation")
	}
}

func TestResumeDoesNotCreateSession(t *testing.T) {
	dir := inTempDir(t)
	if err := runCLI([]string{"--session", "invalid"}); err == nil {
		t.Fatal("invalid session accepted")
	}
	matches, err := filepath.Glob(filepath.Join(dir, ".tiny-agent", "sessions", "*.jsonl"))
	if err != nil || len(matches) != 0 {
		t.Fatalf("sessions=%v err=%v", matches, err)
	}
}

func TestToolsAndPathGuard(t *testing.T) {
	inTempDir(t)
	ctx := context.Background()
	if got, err := executeTool(ctx, "write", map[string]string{"path": "a.txt", "content": "hello"}); err != nil || got != "ok" {
		t.Fatalf("write: %q %v", got, err)
	}
	if got, _ := executeTool(ctx, "read", map[string]string{"path": "a.txt"}); got != "hello" {
		t.Fatalf("read: %q", got)
	}
	if got, err := executeTool(ctx, "edit", map[string]string{"path": "a.txt", "oldText": "hello", "newText": "hi"}); err != nil || got != "ok" {
		t.Fatalf("edit: %q %v", got, err)
	}
	if _, err := executeTool(ctx, "edit", map[string]string{"path": "a.txt", "oldText": "missing", "newText": "x"}); err == nil {
		t.Fatal("edit accepted a non-unique match")
	}
	if got, _ := executeTool(ctx, "read", map[string]string{"path": filepath.Join(cwd, "a.txt")}); got != "hi" {
		t.Fatalf("absolute read: %q", got)
	}
	if _, err := executeTool(ctx, "read", map[string]string{"path": "../secret"}); err == nil {
		t.Fatal("path escaped cwd")
	}
}

func TestSkillsAndProjectInstructions(t *testing.T) {
	dir := inTempDir(t)
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("Always be brief."), 0o644); err != nil {
		t.Fatal(err)
	}
	skill := filepath.Join(dir, ".tiny-agent", "skills", "hello", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(skill), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(skill, []byte("---\nname: hello\ndescription: Greets users.\n---\nSECRET"), 0o644); err != nil {
		t.Fatal(err)
	}
	skills, err := loadSkills(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(skills) != 1 || skills[0].Name != "hello" || skills[0].Description != "Greets users." {
		t.Fatalf("skills: %#v", skills)
	}
	system := value(newAgent(skills, nil, loadProjectInstructions()).Messages[0].Content)
	if !strings.Contains(system, "Always be brief.") || !strings.Contains(system, skill) || strings.Contains(system, "SECRET") {
		t.Fatalf("system prompt: %s", system)
	}
}

func TestModelToolLoopAndCache(t *testing.T) {
	inTempDir(t)
	t.Setenv("OPENROUTER_API_KEY", "test")
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["model"] != model() || body["tools"] == nil {
			t.Errorf("request: %#v", body)
		}
		if calls == 1 {
			_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"1","type":"function","function":{"name":"write","arguments":"{\"path\":\"made.txt\",\"content\":\"yes\"}"}}]}}],"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":25}}}`))
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"done"}}],"usage":{"prompt_tokens":120,"completion_tokens":5,"prompt_cache_hit_tokens":60}}`))
	}))
	defer server.Close()
	agent := newAgent(nil, nil, "")
	agent.Endpoint, agent.Client = server.URL, server.Client()
	answer, err := agent.runAgentLoop("make it")
	if err != nil || answer != "done" {
		t.Fatalf("answer: %q %v", answer, err)
	}
	if calls != 2 || agent.Usage.Input != 135 || agent.Usage.CacheRead != 85 || agent.Usage.Output != 15 {
		t.Fatalf("calls=%d usage=%+v", calls, agent.Usage)
	}
	if rate := *agent.Usage.CacheHitRate; rate != 50 {
		t.Fatalf("cache rate: %v", rate)
	}
	b, _ := os.ReadFile(filepath.Join(cwd, "made.txt"))
	if string(b) != "yes" {
		t.Fatalf("tool output: %q", b)
	}
}

func TestSessionResumeAndCompactBoundary(t *testing.T) {
	inTempDir(t)
	t.Setenv("OPENROUTER_API_KEY", "test")
	session, err := createSession(time.Date(2026, 8, 3, 3, 55, 50, 62_000_000, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(filepath.Base(session.Path), "2026-08-03T03-55-50-062Z_") || !strings.HasSuffix(session.Path, ".jsonl") {
		t.Fatalf("path: %s", session.Path)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if _, ok := body["tools"]; ok {
			t.Error("compact request included tools")
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"summary"}}],"usage":{"prompt_tokens":20,"completion_tokens":2}}`))
	}))
	defer server.Close()
	agent := newAgent(nil, session, "")
	agent.Endpoint, agent.Client = server.URL, server.Client()
	messages := []Message{
		{Role: "user", Content: text("old")}, {Role: "assistant", Content: text("old answer")},
		{Role: "user", Content: text("run")},
		{Role: "assistant", Content: nil, ToolCalls: []ToolCall{{ID: "1", Type: "function", Function: ToolFunction{Name: "read", Arguments: `{"path":"a"}`}}}},
		{Role: "tool", Content: text("data"), ToolCallID: "1"}, {Role: "assistant", Content: text("done")},
		{Role: "user", Content: text("next")}, {Role: "assistant", Content: text("answer")},
	}
	for i := range messages {
		agent.Messages = append(agent.Messages, messages[i])
		if err := session.append(SessionRecord{Type: "message", Message: &messages[i]}); err != nil {
			t.Fatal(err)
		}
	}
	result, err := agent.compact()
	if err != nil || result != "Compacted 2 messages (kept last 6)." {
		t.Fatalf("compact: %q %v", result, err)
	}
	records, _ := session.records()
	compact := records[len(records)-1]
	if compact.KeptMessages != 6 || compact.CompactedMessages != 2 {
		t.Fatalf("compact record: %+v", compact)
	}
	restored := newAgent(nil, session, "")
	if err := restored.resumeSession(); err != nil {
		t.Fatal(err)
	}
	if len(restored.Messages) != len(agent.Messages) || restored.Messages[2].Role != "user" || value(restored.Messages[2].Content) != "run" {
		t.Fatalf("restored: %#v", restored.Messages)
	}
	if restored.Messages[4].ToolCallID != "1" {
		t.Fatal("tool result separated from call")
	}
}

func TestCompactRecordsActualRetainedMessages(t *testing.T) {
	inTempDir(t)
	t.Setenv("OPENROUTER_API_KEY", "test")
	session, _ := createSession(time.Now())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"summary"}}],"usage":{}}`))
	}))
	defer server.Close()
	agent := newAgent(nil, session, "")
	agent.Endpoint, agent.Client = server.URL, server.Client()
	agent.Messages = append(agent.Messages,
		Message{Role: "user", Content: text("old")}, Message{Role: "assistant", Content: text("old answer")},
		Message{Role: "user", Content: text("keep")}, Message{Role: "assistant", Content: text("1")}, Message{Role: "assistant", Content: text("2")},
		Message{Role: "assistant", Content: text("3")}, Message{Role: "assistant", Content: text("4")}, Message{Role: "assistant", Content: text("5")}, Message{Role: "assistant", Content: text("6")},
	)
	result, err := agent.compact()
	if err != nil || !strings.Contains(result, "kept last 7") {
		t.Fatalf("compact: %q %v", result, err)
	}
	records, _ := session.records()
	if records[len(records)-1].KeptMessages != 7 {
		t.Fatalf("record: %+v", records[len(records)-1])
	}
}

func TestLargeBashOutputStoresFullLog(t *testing.T) {
	inTempDir(t)
	result, err := executeTool(context.Background(), "bash", map[string]string{"command": "printf begin; yes x | head -n 30000; printf end"})
	if err != nil {
		t.Fatal(err)
	}
	match := regexp.MustCompile(`Full output: (.*\.log)\]`).FindStringSubmatch(result)
	if len(match) != 2 {
		t.Fatalf("result: %s", result)
	}
	full, err := os.ReadFile(match[1])
	if err != nil || !strings.HasPrefix(string(full), "begin") || !strings.HasSuffix(string(full), "end") {
		t.Fatalf("full output: %v %q", err, full)
	}
	if len(result) >= len(full) {
		t.Fatal("result was not truncated")
	}
}

func TestCancelModelPersistsInterruption(t *testing.T) {
	inTempDir(t)
	t.Setenv("OPENROUTER_API_KEY", "test")
	started, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer server.Close()
	defer close(release)
	session, _ := createSession(time.Now())
	agent := newAgent(nil, session, "")
	agent.Endpoint, agent.Client = server.URL, server.Client()
	done := make(chan string)
	go func() { answer, _ := agent.runAgentLoop("wait"); done <- answer }()
	<-started
	agent.abort()
	if answer := <-done; answer != "Operation aborted." {
		t.Fatalf("answer: %q", answer)
	}
	records, _ := session.records()
	last := records[len(records)-1]
	if last.Type != "interruption" || last.Phase != "model" {
		t.Fatalf("last record: %+v", last)
	}
}
