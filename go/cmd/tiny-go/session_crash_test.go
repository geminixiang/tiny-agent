package main

// These tests exercise real OS-level crash recovery: a genuine child process is
// started, allowed to durably commit a toolStarted intent, then SIGKILLed via
// os.Process.Kill() (not a graceful exit) while the tool effect is still running.
// The parent process then reopens the session and drives recovery for real.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestCrashHelperProcess is invoked as a subprocess (via `-test.run` +
// TINY_GO_CRASH_MODE) to perform the actual crash-inducing or recovery work in a
// real OS process. It is a no-op under the normal test run.
func TestCrashHelperProcess(t *testing.T) {
	mode := os.Getenv("TINY_GO_CRASH_MODE")
	if mode == "" {
		return
	}
	dir := os.Getenv("TINY_GO_DIR")
	if err := os.Chdir(dir); err != nil {
		fmt.Println("FATAL:" + err.Error())
		return
	}
	cwd = dir

	switch mode {
	case "crash-bash":
		marker := os.Getenv("TINY_GO_MARKER")
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			body := fmt.Sprintf(`{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"bash","arguments":%q}}]},"finish_reason":"tool_calls"}],"usage":{}}`,
				fmt.Sprintf(`{"command":"sleep 5 && touch %s"}`, marker))
			_, _ = w.Write([]byte(body))
		}))
		defer server.Close()
		session, err := createSessionStore(time.Now())
		if err != nil {
			fmt.Println("FATAL:" + err.Error())
			return
		}
		agent := newAgent(nil, session, "")
		agent.Endpoint, agent.Client = server.URL, server.Client()
		fmt.Println("SESSION_PATH:" + session.Path)
		_, _ = agent.runAgentLoop("go")

	case "crash-read-delayed":
		delayFile := os.Getenv("TINY_GO_READ_TARGET")
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			body := fmt.Sprintf(`{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"read","arguments":%q}}]},"finish_reason":"tool_calls"}],"usage":{}}`,
				fmt.Sprintf(`{"path":%q}`, delayFile))
			_, _ = w.Write([]byte(body))
		}))
		defer server.Close()
		session, err := createSessionStore(time.Now())
		if err != nil {
			fmt.Println("FATAL:" + err.Error())
			return
		}
		agent := newAgent(nil, session, "")
		agent.Endpoint, agent.Client = server.URL, server.Client()
		for index := range agent.Tools {
			if agent.Tools[index].Name != "read" {
				continue
			}
			original := agent.Tools[index].Execute
			agent.Tools[index].Execute = func(ctx context.Context, args map[string]any) (string, error) {
				select {
				case <-time.After(5 * time.Second):
				case <-ctx.Done():
				}
				return original(ctx, args)
			}
		}
		fmt.Println("SESSION_PATH:" + session.Path)
		_, _ = agent.runAgentLoop("go")

	case "recover-blocked-model":
		// The FIRST recovery action for a never-replay tool must be a synthetic
		// "interrupted" result written without touching the model or re-running
		// the tool. The model is legitimately called afterwards, for the *next*
		// assistant turn that follows the interrupted tool result - so we record
		// how many entries existed at the moment the model was first invoked.
		sessionID := os.Getenv("TINY_GO_SESSION_ID")
		calledFlag := os.Getenv("TINY_GO_CALLED_FLAG")
		var session *SessionStore
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			logAtCallTime, _ := os.ReadFile(session.Path)
			_ = os.WriteFile(calledFlag, logAtCallTime, 0o600)
			_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"acknowledged the interruption"},"finish_reason":"stop"}],"usage":{}}`))
		}))
		defer server.Close()
		var err error
		session, err = openSessionStore(sessionID)
		if err != nil {
			fmt.Println("FATAL:" + err.Error())
			return
		}
		defer session.Close()
		agent := newAgent(nil, session, "")
		agent.Endpoint, agent.Client = server.URL, server.Client()
		err = agent.restoreSession()
		if err != nil {
			fmt.Println("RESTORE_ERROR:" + err.Error())
		} else {
			fmt.Println("RESTORE_ERROR:none")
		}
		state := session.State()
		fmt.Println("OPERATION_KIND:" + state.Operation.Kind)

	case "recover-replay-then-stop":
		sessionID := os.Getenv("TINY_GO_SESSION_ID")
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"final answer after replay"},"finish_reason":"stop"}],"usage":{}}`))
		}))
		defer server.Close()
		session, err := openSessionStore(sessionID)
		if err != nil {
			fmt.Println("FATAL:" + err.Error())
			return
		}
		defer session.Close()
		agent := newAgent(nil, session, "")
		agent.Endpoint, agent.Client = server.URL, server.Client()
		err = agent.restoreSession()
		if err != nil {
			fmt.Println("RESTORE_ERROR:" + err.Error())
		} else {
			fmt.Println("RESTORE_ERROR:none")
		}
		state := session.State()
		fmt.Println("OPERATION_KIND:" + state.Operation.Kind)
		encoded, _ := json.Marshal(state.Transcript)
		fmt.Println("TRANSCRIPT:" + string(encoded))
	}
}

func spawnCrashHelper(t *testing.T, testName string, env []string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^"+testName+"$")
	cmd.Env = append(os.Environ(), env...)
	cmd.Stdout = nil
	return cmd
}

func waitForSubstring(t *testing.T, path, substring string, timeout time.Duration) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		if err == nil && strings.Contains(string(data), substring) {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

// Scenario 1: never-replay tool (bash) crash mid-effect.
func TestCrash_NeverReplayToolIsNotReExecutedAfterSigkill(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".tiny-agent", "sessions"), 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dir, "should-not-exist.txt")

	stdout, err := os.CreateTemp(dir, "stdout-*.log")
	if err != nil {
		t.Fatal(err)
	}
	defer stdout.Close()

	cmd := spawnCrashHelper(t, "TestCrashHelperProcess", []string{
		"TINY_GO_CRASH_MODE=crash-bash",
		"TINY_GO_DIR=" + dir,
		"TINY_GO_MARKER=" + marker,
	})
	cmd.Stdout = stdout
	cmd.Stderr = stdout
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}

	sessionsDir := filepath.Join(dir, ".tiny-agent", "sessions")
	var sessionPath string
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		entries, _ := os.ReadDir(sessionsDir)
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".jsonl") {
				sessionPath = filepath.Join(sessionsDir, entry.Name())
			}
		}
		if sessionPath != "" && waitForSubstring(t, sessionPath, "toolStarted", 3*time.Second) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if sessionPath == "" {
		out, _ := os.ReadFile(stdout.Name())
		t.Fatalf("session file never appeared; child output: %s", out)
	}
	if !waitForSubstring(t, sessionPath, "toolStarted", 3*time.Second) {
		out, _ := os.ReadFile(stdout.Name())
		t.Fatalf("toolStarted record never committed; child output: %s", out)
	}
	if strings.Contains(readFile(t, sessionPath), `"message"`) && strings.Count(readFile(t, sessionPath), "toolStarted") > 0 {
		// still fine; toolStarted present. Ensure no result entry referencing it yet.
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatalf("kill: %v", err)
	}
	_ = cmd.Wait()

	if _, err := os.Stat(marker); err == nil {
		t.Fatalf("effect ran despite SIGKILL: marker file exists at %s", marker)
	}

	logContent := readFile(t, sessionPath)
	if !strings.Contains(logContent, "toolStarted") {
		t.Fatalf("expected toolStarted record in log: %s", logContent)
	}
	if strings.Contains(logContent, `"toolStartedId"`) {
		t.Fatalf("did not expect a tool result record referencing toolStartedId before recovery: %s", logContent)
	}

	sessionID := sessionIDFromPath(sessionPath)
	calledFlag := filepath.Join(dir, "model-called.flag")
	recoverStdout, err := os.CreateTemp(dir, "recover-stdout-*.log")
	if err != nil {
		t.Fatal(err)
	}
	defer recoverStdout.Close()
	recoverCmd := spawnCrashHelper(t, "TestCrashHelperProcess", []string{
		"TINY_GO_CRASH_MODE=recover-blocked-model",
		"TINY_GO_DIR=" + dir,
		"TINY_GO_SESSION_ID=" + sessionID,
		"TINY_GO_CALLED_FLAG=" + calledFlag,
	})
	recoverCmd.Stdout = recoverStdout
	recoverCmd.Stderr = recoverStdout
	if err := recoverCmd.Run(); err != nil {
		out, _ := os.ReadFile(recoverStdout.Name())
		t.Fatalf("recovery process failed: %v; output: %s", err, out)
	}
	recoverOutput := readFile(t, recoverStdout.Name())
	if !strings.Contains(recoverOutput, "RESTORE_ERROR:none") {
		t.Fatalf("recovery reported an error: %s", recoverOutput)
	}
	if !strings.Contains(recoverOutput, "OPERATION_KIND:idle") {
		t.Fatalf("recovery did not settle to idle: %s", recoverOutput)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatalf("tool effect ran again during recovery")
	}
	finalLog := readFile(t, sessionPath)
	if !strings.Contains(finalLog, `"reason":"interrupted"`) {
		t.Fatalf("expected a synthetic interrupted result in the recovered log: %s", finalLog)
	}
	// The model must only be called AFTER the synthetic interrupted result was
	// durably committed - never before, and never to re-run the tool itself.
	logAtFirstModelCall, err := os.ReadFile(calledFlag)
	if err != nil {
		t.Fatalf("model was never called to continue after the interrupted tool result: %v", err)
	}
	if !strings.Contains(string(logAtFirstModelCall), `"reason":"interrupted"`) {
		t.Fatalf("model was called BEFORE the interrupted synthetic result was committed:\n%s", logAtFirstModelCall)
	}
	if !strings.Contains(finalLog, "acknowledged the interruption") {
		t.Fatalf("expected the post-recovery model turn to land in the transcript: %s", finalLog)
	}
}

// Scenario 2: safe-replay tool (read) crash mid-effect, then recovery re-executes it.
func TestCrash_SafeReplayToolIsReExecutedAfterSigkill(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".tiny-agent", "sessions"), 0o700); err != nil {
		t.Fatal(err)
	}
	targetFile := filepath.Join(dir, "target.txt")
	if err := os.WriteFile(targetFile, []byte("real file contents"), 0o600); err != nil {
		t.Fatal(err)
	}

	stdout, err := os.CreateTemp(dir, "stdout-*.log")
	if err != nil {
		t.Fatal(err)
	}
	defer stdout.Close()
	cmd := spawnCrashHelper(t, "TestCrashHelperProcess", []string{
		"TINY_GO_CRASH_MODE=crash-read-delayed",
		"TINY_GO_DIR=" + dir,
		"TINY_GO_READ_TARGET=" + targetFile,
	})
	cmd.Stdout, cmd.Stderr = stdout, stdout
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}

	sessionsDir := filepath.Join(dir, ".tiny-agent", "sessions")
	var sessionPath string
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		entries, _ := os.ReadDir(sessionsDir)
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".jsonl") {
				sessionPath = filepath.Join(sessionsDir, entry.Name())
			}
		}
		if sessionPath != "" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if sessionPath == "" || !waitForSubstring(t, sessionPath, "toolStarted", 5*time.Second) {
		out, _ := os.ReadFile(stdout.Name())
		t.Fatalf("toolStarted record never committed; child output: %s", out)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatalf("kill: %v", err)
	}
	_ = cmd.Wait()

	sessionID := sessionIDFromPath(sessionPath)
	recoverStdout, err := os.CreateTemp(dir, "recover-stdout-*.log")
	if err != nil {
		t.Fatal(err)
	}
	defer recoverStdout.Close()
	recoverCmd := spawnCrashHelper(t, "TestCrashHelperProcess", []string{
		"TINY_GO_CRASH_MODE=recover-replay-then-stop",
		"TINY_GO_DIR=" + dir,
		"TINY_GO_SESSION_ID=" + sessionID,
	})
	recoverCmd.Stdout, recoverCmd.Stderr = recoverStdout, recoverStdout
	runErr := recoverCmd.Run()
	recoverOutput := readFile(t, recoverStdout.Name())

	if strings.Contains(recoverOutput, "INVALID_TRANSITION") {
		t.Fatalf("REGRESSION REPRODUCED: recovery corrupted the session with INVALID_TRANSITION after safe replay + stop.\nlog:\n%s\nrecovery output:\n%s", readFile(t, sessionPath), recoverOutput)
	}
	if runErr != nil {
		t.Fatalf("recovery process failed: %v; output: %s", runErr, recoverOutput)
	}
	if !strings.Contains(recoverOutput, "RESTORE_ERROR:none") {
		t.Fatalf("recovery reported an error: %s", recoverOutput)
	}
	if !strings.Contains(recoverOutput, "real file contents") {
		t.Fatalf("expected the replayed read to surface the real file contents in the transcript: %s", recoverOutput)
	}
	if !strings.Contains(recoverOutput, "final answer after replay") {
		t.Fatalf("expected recovery to continue to a final model answer: %s", recoverOutput)
	}
	if !strings.Contains(recoverOutput, "OPERATION_KIND:idle") {
		t.Fatalf("recovery did not settle to idle: %s", recoverOutput)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func sessionIDFromPath(path string) string {
	base := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	parts := strings.SplitN(base, "_", 2)
	if len(parts) != 2 {
		return base
	}
	return parts[1]
}
