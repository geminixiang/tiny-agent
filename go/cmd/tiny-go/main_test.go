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

func TestTerminalDisplayPosition(t *testing.T) {
	for _, test := range []struct {
		text        string
		width       int
		row, column int
	}{{"你a", 80, 0, 3}, {"abcdefg你", 8, 1, 2}, {"e\u0301你", 8, 0, 3}} {
		row, column := displayPosition([]rune(test.text), test.width)
		if row != test.row || column != test.column {
			t.Fatalf("%q: got %d,%d want %d,%d", test.text, row, column, test.row, test.column)
		}
	}
}

func TestTerminalLineEditingAndExit(t *testing.T) {
	out := &strings.Builder{}
	tty := &terminal{keys: make(chan keyEvent, 24), out: out, old: &term.State{}}
	for _, key := range []byte("你a") {
		tty.keys <- keyEvent{key: key}
	}
	for _, key := range []byte("\x1b[Db\x1b[C\x1b[A\x1b[B") {
		tty.keys <- keyEvent{key: key}
	}
	tty.keys <- keyEvent{key: 127}
	tty.keys <- keyEvent{key: '\r'}
	line, err := tty.readLine("› ")
	if err != nil || line != "你b" {
		t.Fatalf("line: %q %v", line, err)
	}
	tty.keys <- keyEvent{key: 3}
	if _, err := tty.readLine("› "); !errors.Is(err, errExit) {
		t.Fatalf("Ctrl+C: %v", err)
	}
}

func TestTerminalEscAbortsOperation(t *testing.T) {
	tty := &terminal{keys: make(chan keyEvent, 8), out: &strings.Builder{}, old: &term.State{}}
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
	for _, key := range []byte("\x1b[D") {
		tty.keys <- keyEvent{key: key}
	}
	select {
	case <-done:
		t.Fatal("arrow key aborted operation")
	case <-time.After(50 * time.Millisecond):
	}
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

func TestFilesystemToolsContainCanonicalPathsAndAllowInternalSymlinks(t *testing.T) {
	dir := inTempDir(t)
	outside := t.TempDir()
	prefixSibling := dir + "-sibling"
	if err := os.Mkdir(prefixSibling, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(prefixSibling, "secret.txt"), []byte("prefix"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := executeTool(context.Background(), "read", map[string]string{"path": filepath.Join(prefixSibling, "secret.txt")}); err == nil || !strings.Contains(err.Error(), "resolve inside cwd") {
		t.Fatalf("prefix sibling read: %v", err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "outside-link")); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := executeTool(ctx, "read", map[string]string{"path": "outside-link/secret.txt"}); err == nil || !strings.Contains(err.Error(), "resolve inside cwd") {
		t.Fatalf("outside read: %v", err)
	}
	if _, err := executeTool(ctx, "write", map[string]string{"path": "outside-link/new.txt", "content": "escaped"}); err == nil || !strings.Contains(err.Error(), "resolve inside cwd") {
		t.Fatalf("outside write: %v", err)
	}
	if _, err := executeTool(ctx, "edit", map[string]string{"path": "outside-link/secret.txt", "oldText": "outside", "newText": "escaped"}); err == nil || !strings.Contains(err.Error(), "resolve inside cwd") {
		t.Fatalf("outside edit: %v", err)
	}
	if b, err := os.ReadFile(filepath.Join(outside, "secret.txt")); err != nil || string(b) != "outside" {
		t.Fatalf("outside changed: %q %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(outside, "new.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("outside new file: %v", err)
	}

	inside := filepath.Join(dir, "inside")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inside, "file.txt"), []byte("inside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("inside", filepath.Join(dir, "inside-link")); err != nil {
		t.Fatal(err)
	}
	if got, err := executeTool(ctx, "read", map[string]string{"path": "inside-link/file.txt"}); err != nil || got != "inside" {
		t.Fatalf("inside read: %q %v", got, err)
	}
	if err := os.Symlink("inside/file.txt", filepath.Join(dir, "inside-file-link")); err != nil {
		t.Fatal(err)
	}
	if got, err := executeTool(ctx, "read", map[string]string{"path": "inside-file-link"}); err != nil || got != "inside" {
		t.Fatalf("inside leaf read: %q %v", got, err)
	}
	if got, err := executeTool(ctx, "write", map[string]string{"path": "inside-file-link", "content": "written"}); err != nil || got != "ok" {
		t.Fatalf("inside leaf write: %q %v", got, err)
	}
	if got, err := executeTool(ctx, "edit", map[string]string{"path": "inside-file-link", "oldText": "written", "newText": "edited"}); err != nil || got != "ok" {
		t.Fatalf("inside leaf edit: %q %v", got, err)
	}
	if b, err := os.ReadFile(filepath.Join(inside, "file.txt")); err != nil || string(b) != "edited" {
		t.Fatalf("inside leaf result: %q %v", b, err)
	}
	if got, err := executeTool(ctx, "write", map[string]string{"path": "inside-link/nested/new.txt", "content": "new"}); err != nil || got != "ok" {
		t.Fatalf("inside write: %q %v", got, err)
	}
	if b, err := os.ReadFile(filepath.Join(inside, "nested", "new.txt")); err != nil || string(b) != "new" {
		t.Fatalf("inside new file: %q %v", b, err)
	}
	if got, err := executeTool(ctx, "edit", map[string]string{"path": "inside-link/file.txt", "oldText": "edited", "newText": "finished"}); err != nil || got != "ok" {
		t.Fatalf("inside edit: %q %v", got, err)
	}
	if b, err := os.ReadFile(filepath.Join(inside, "file.txt")); err != nil || string(b) != "finished" {
		t.Fatalf("inside edit result: %q %v", b, err)
	}

	if _, err := executeTool(ctx, "write", map[string]string{"path": "normal/nested.txt", "content": "normal"}); err != nil {
		t.Fatal(err)
	}
	if got, err := executeTool(ctx, "read", map[string]string{"path": "normal/nested.txt"}); err != nil || got != "normal" {
		t.Fatalf("normal read: %q %v", got, err)
	}
}

func TestFilesystemToolsThroughSymlinkSpelledCwd(t *testing.T) {
	originalCwd, getwdErr := os.Getwd()
	if getwdErr != nil {
		t.Fatal(getwdErr)
	}
	originalRoot := cwd
	parent := t.TempDir()
	realRoot := filepath.Join(parent, "workspace")
	linkRoot := filepath.Join(parent, "workspace-link")
	outside := filepath.Join(parent, "outside")
	prefixSibling := realRoot + "-sibling"
	for _, path := range []string{realRoot, outside, prefixSibling} {
		if err := os.Mkdir(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(realRoot, linkRoot); err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(linkRoot); err != nil {
		t.Fatal(err)
	}
	cwd = linkRoot
	t.Cleanup(func() {
		cwd = originalRoot
		_ = os.Chdir(originalCwd)
	})

	ctx := context.Background()
	canonicalFile := filepath.Join(realRoot, "file.txt")
	if err := os.WriteFile(canonicalFile, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, err := executeTool(ctx, "read", map[string]string{"path": canonicalFile}); err != nil || got != "original" {
		t.Fatalf("canonical read: %q %v", got, err)
	}
	if got, err := executeTool(ctx, "write", map[string]string{"path": filepath.Join(realRoot, "new.txt"), "content": "new"}); err != nil || got != "ok" {
		t.Fatalf("canonical write: %q %v", got, err)
	}
	if got, err := executeTool(ctx, "edit", map[string]string{"path": canonicalFile, "oldText": "original", "newText": "edited"}); err != nil || got != "ok" {
		t.Fatalf("canonical edit: %q %v", got, err)
	}
	if content, err := os.ReadFile(canonicalFile); err != nil || string(content) != "edited" {
		t.Fatalf("canonical result: %q %v", content, err)
	}
	for _, path := range []string{filepath.Join(outside, "secret.txt"), filepath.Join(prefixSibling, "secret.txt")} {
		if err := os.WriteFile(path, []byte("secret"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := executeTool(ctx, "read", map[string]string{"path": path}); err == nil || !strings.Contains(err.Error(), "resolve inside cwd") {
			t.Fatalf("outside read %s: %v", path, err)
		}
		newPath := filepath.Join(filepath.Dir(path), "new.txt")
		if _, err := executeTool(ctx, "write", map[string]string{"path": newPath, "content": "escaped"}); err == nil || !strings.Contains(err.Error(), "resolve inside cwd") {
			t.Fatalf("outside write %s: %v", newPath, err)
		}
		if _, err := os.Stat(newPath); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("outside file created %s: %v", newPath, err)
		}
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
	if rate := *agent.Usage.CacheHitRate; rate != float64(60)/120*100 {
		t.Fatalf("cache rate: %v", rate)
	}
	b, _ := os.ReadFile(filepath.Join(cwd, "made.txt"))
	if string(b) != "yes" {
		t.Fatalf("tool output: %q", b)
	}
}

func TestSessionResumeIdleProjection(t *testing.T) {
	inTempDir(t)
	t.Setenv("OPENROUTER_API_KEY", "test")
	session, err := createSessionStore(time.Date(2026, 8, 3, 3, 55, 50, 62_000_000, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":2}}`))
	}))
	agent := newAgent(nil, session, "")
	agent.Endpoint, agent.Client = server.URL, server.Client()
	if answer, err := agent.runAgentLoop("hello"); err != nil || answer != "done" {
		t.Fatalf("run: %q %v", answer, err)
	}
	id := session.ID
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := openSessionStore(id)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	restored := newAgent(nil, reopened, "")
	if err := restored.restoreSession(); err != nil {
		t.Fatal(err)
	}
	if len(restored.Messages) != 3 || value(restored.Messages[1].Content) != "hello" || value(restored.Messages[2].Content) != "done" {
		t.Fatalf("restored: %#v", restored.Messages)
	}
	if restored.Usage.Input != 20 || restored.Usage.Output != 2 {
		t.Fatalf("usage: %+v", restored.Usage)
	}
}

func TestCompactRequiresDurableSession(t *testing.T) {
	agent := newAgent(nil, nil, "")
	if _, err := agent.compact(); err == nil || !strings.Contains(err.Error(), "durable session") {
		t.Fatalf("compact: %v", err)
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

func TestCancelModelPersistsAndReconcilesAbort(t *testing.T) {
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
	session, _ := createSessionStore(time.Now())
	defer session.Close()
	agent := newAgent(nil, session, "")
	agent.Endpoint, agent.Client = server.URL, server.Client()
	done := make(chan string)
	go func() { answer, _ := agent.runAgentLoop("wait"); done <- answer }()
	<-started
	agent.abort()
	if answer := <-done; answer != "Operation aborted." {
		t.Fatalf("answer: %q", answer)
	}
	state := session.State()
	if state.Operation.Kind != "idle" {
		t.Fatalf("operation: %+v", state.Operation)
	}
	data, err := os.ReadFile(session.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"type":"abortRequested"`) || !strings.Contains(string(data), `"outcome":"aborted"`) {
		t.Fatalf("abort facts missing: %s", data)
	}
}
