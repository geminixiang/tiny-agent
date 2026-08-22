package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func validUserTransaction(content string) []map[string]any {
	return []map[string]any{{
		"kind": "entry",
		"entry": map[string]any{
			"type":    "message",
			"message": map[string]any{"role": "user", "content": content},
		},
	}}
}

func TestSessionStoreCreateModeCollisionAndClose(t *testing.T) {
	inTempDir(t)
	now := time.Date(2026, 8, 3, 3, 55, 50, 62_000_000, time.UTC)
	id := uuid7(now)
	store, err := createSessionStoreWithID(now, id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := openSessionStore(id); err == nil || !strings.Contains(err.Error(), "already open") {
		t.Fatalf("second writer=%v", err)
	}
	info, err := os.Stat(store.Path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode=%v err=%v", info.Mode().Perm(), err)
	}
	if _, err := createSessionStoreWithID(now, id); !errors.Is(err, os.ErrExist) {
		t.Fatalf("collision=%v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if err := store.Commit(validUserTransaction("late")); err == nil {
		t.Fatal("closed store accepted commit")
	}
}

func TestSessionStoreCommitReopenAndTornRepair(t *testing.T) {
	inTempDir(t)
	store, err := createSessionStore(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Commit(validUserTransaction("hello")); err != nil {
		t.Fatal(err)
	}
	id, path := store.ID, store.Path
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.WriteString(`[{"kind":"entry"`)
	_ = file.Close()

	reopened, err := openSessionStore(id)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	data, _ := os.ReadFile(path)
	if len(data) == 0 || data[len(data)-1] != '\n' || string(data) != string(reopened.data) {
		t.Fatalf("tail was not repaired: %q", data)
	}
	if got := reopened.state.Transcript[0]["content"]; got != "hello" {
		t.Fatalf("transcript=%v", reopened.state.Transcript)
	}
}

func TestSessionStoreInvalidCommitIsAtomic(t *testing.T) {
	inTempDir(t)
	store, err := createSessionStore(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	before, _ := os.ReadFile(store.Path)
	invalid := validUserTransaction("bad")
	invalid[0]["entry"].(map[string]any)["message"].(map[string]any)["role"] = "invalid"
	if err := store.Commit(invalid); err == nil {
		t.Fatal("invalid commit succeeded")
	}
	after, _ := os.ReadFile(store.Path)
	if string(after) != string(before) {
		t.Fatal("invalid commit mutated file")
	}
	if len(store.state.Transcript) != 0 {
		t.Fatal("invalid commit mutated state")
	}
	if err := store.Commit(nil); err == nil {
		t.Fatal("empty commit succeeded")
	}
	if err := store.Commit(validUserTransaction("valid")); err != nil {
		t.Fatal(err)
	}
	if store.state.Transcript[0]["content"] != "valid" {
		t.Fatalf("sequence/state not reusable: %v", store.state.Transcript)
	}
}

func TestSessionStoreConcurrentCommitOrdering(t *testing.T) {
	inTempDir(t)
	store, err := createSessionStore(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	var wait sync.WaitGroup
	for index := 0; index < 20; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			if err := store.Commit(validUserTransaction(string(rune('a' + index)))); err != nil {
				t.Errorf("commit %d: %v", index, err)
			}
		}(index)
	}
	wait.Wait()
	data, _ := os.ReadFile(store.Path)
	state, err := reduceSession(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Transcript) != 20 {
		t.Fatalf("transcript=%d", len(state.Transcript))
	}
	lines := bytesLines(data)
	next := 1
	for _, raw := range lines[1:] {
		var transaction []map[string]any
		if err := json.Unmarshal(raw, &transaction); err != nil {
			t.Fatal(err)
		}
		for _, fact := range transaction {
			if int(fact["seq"].(float64)) != next {
				t.Fatalf("seq=%v want=%d", fact["seq"], next)
			}
			next++
		}
	}
}

func bytesLines(data []byte) [][]byte {
	lines := [][]byte{}
	start := 0
	for index, value := range data {
		if value == '\n' {
			lines = append(lines, data[start:index])
			start = index + 1
		}
	}
	return lines
}

func TestSessionStoreIdentityPermissionsSymlinkAndTrimmedEnvironment(t *testing.T) {
	dir := inTempDir(t)
	store, err := createSessionStore(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	id, path := store.ID, store.Path
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	var header map[string]any
	if err := json.Unmarshal(bytesLines(data)[0], &header); err != nil {
		t.Fatal(err)
	}
	header["id"] = uuid7(time.Now())
	bad, _ := json.Marshal(header)
	bad = append(bad, '\n')
	if err := os.WriteFile(path, bad, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := openSessionStore(id); err == nil || !strings.Contains(err.Error(), "filename does not match header") {
		t.Fatalf("identity=%v", err)
	}
	header["id"] = id
	good, _ := json.Marshal(header)
	good = append(good, '\n')
	if err := os.WriteFile(path, good, 0o666); err != nil {
		t.Fatal(err)
	}
	reopened, err := openSessionStore(id)
	if err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode=%v", info.Mode().Perm())
	}
	_ = reopened.Close()
	linkID := uuid7(time.Now().Add(time.Second))
	outside := filepath.Join(dir, "outside.jsonl")
	if err := os.WriteFile(outside, good, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, ".tiny-agent", "sessions", "only_"+linkID+".jsonl")); err != nil {
		t.Fatal(err)
	}
	if _, err := openSessionStore(linkID); err == nil || !strings.Contains(err.Error(), "Session not found") {
		t.Fatalf("symlink=%v", err)
	}
	t.Setenv("TINY_AGENT_ENVIRONMENT_IDENTITY", " job-123 ")
	if got, _ := environmentIdentity(); got != "job-123" {
		t.Fatalf("identity=%q", got)
	}
}

func TestEnvironmentIdentity(t *testing.T) {
	dir := inTempDir(t)
	t.Setenv("TINY_AGENT_ENVIRONMENT_IDENTITY", "job-123")
	if got, _ := environmentIdentity(); got != "job-123" {
		t.Fatalf("identity=%q", got)
	}
	t.Setenv("TINY_AGENT_ENVIRONMENT_IDENTITY", "")
	got, err := environmentIdentity()
	if err != nil {
		t.Fatal(err)
	}
	expected, _ := filepath.EvalSymlinks(dir)
	if got != expected {
		t.Fatalf("identity=%q want=%q", got, expected)
	}
}
