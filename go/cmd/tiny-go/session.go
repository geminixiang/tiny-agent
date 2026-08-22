package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// SessionStore owns canonical session framing and commits. Runtime integration
// supplies domain facts; the store supplies fact identity, sequence, and time.
type SessionStore struct {
	ID, Path string

	mu      sync.Mutex
	file    *os.File
	data    []byte
	state   sessionState
	nextSeq int
	closed  bool
}

func environmentIdentity() (string, error) {
	if identity := os.Getenv("TINY_AGENT_ENVIRONMENT_IDENTITY"); identity != "" {
		return identity, nil
	}
	absolute, err := filepath.Abs(cwd)
	if err != nil {
		return "", err
	}
	canonical, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	return canonical, nil
}

func createSessionStore(now time.Time) (*SessionStore, error) {
	return createSessionStoreWithID(now, uuid7(now))
}

func createSessionStoreWithID(now time.Time, id string) (*SessionStore, error) {
	identity, err := environmentIdentity()
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(cwd, ".tiny-agent", "sessions")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	stamp := now.UTC().Format("2006-01-02T15-04-05-000Z")
	path := filepath.Join(dir, stamp+"_"+id+".jsonl")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	header := map[string]any{
		"kind":                "header",
		"version":             2,
		"id":                  id,
		"createdAt":           now.UnixMilli(),
		"cwd":                 cwd,
		"provider":            "openrouter",
		"model":               model(),
		"environmentIdentity": identity,
	}
	encoded, err := json.Marshal(header)
	if err == nil {
		encoded = append(encoded, '\n')
		_, err = file.Write(encoded)
	}
	if err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return nil, err
	}
	state, err := reduceSession(encoded)
	if err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return nil, err
	}
	return &SessionStore{ID: id, Path: path, file: file, data: encoded, state: state, nextSeq: 1}, nil
}

func openSessionStore(id string) (*SessionStore, error) {
	if _, ok := sessionID(id); !ok {
		return nil, fmt.Errorf("Invalid session ID: %s", id)
	}
	matches, err := filepath.Glob(filepath.Join(cwd, ".tiny-agent", "sessions", "*_"+id+".jsonl"))
	if err != nil {
		return nil, err
	}
	if len(matches) == 0 {
		return nil, fmt.Errorf("Session not found: %s", id)
	}
	if len(matches) > 1 {
		return nil, fmt.Errorf("Duplicate session ID: %s", id)
	}
	file, err := os.OpenFile(matches[0], os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(file)
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	state, err := reduceSession(data)
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	if state.Header.ID != id {
		_ = file.Close()
		return nil, errors.New("session filename does not match header")
	}
	if state.RepairedLength != len(data) {
		if err := file.Truncate(int64(state.RepairedLength)); err != nil {
			_ = file.Close()
			return nil, err
		}
		data = data[:state.RepairedLength]
	}
	if _, err := file.Seek(0, 2); err != nil {
		_ = file.Close()
		return nil, err
	}
	return &SessionStore{ID: id, Path: matches[0], file: file, data: data, state: state, nextSeq: nextSessionSeq(data)}, nil
}

func (s *SessionStore) NewID(now time.Time) string { return uuid7(now) }

func (s *SessionStore) State() sessionState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

// Commit appends one atomic JSONL transaction. Facts may contain references to
// IDs allocated with NewID; missing top-level id/seq/timestamp fields are filled.
func (s *SessionStore) Commit(facts []map[string]any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("session is closed")
	}
	if len(facts) == 0 {
		return errors.New("session transaction must not be empty")
	}
	now := time.Now()
	transaction := make([]map[string]any, len(facts))
	for index, fact := range facts {
		copy := make(map[string]any, len(fact)+3)
		for key, value := range fact {
			copy[key] = value
		}
		if _, exists := copy["id"]; !exists {
			copy["id"] = uuid7(now.Add(time.Duration(index) * time.Nanosecond))
		}
		copy["seq"] = s.nextSeq + index
		if _, exists := copy["timestamp"]; !exists {
			copy["timestamp"] = now.UnixMilli()
		}
		transaction[index] = copy
	}
	encoded, err := json.Marshal(transaction)
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	candidate := append(append([]byte{}, s.data...), encoded...)
	state, err := reduceSession(candidate)
	if err != nil {
		return err
	}
	if _, err := s.file.Write(encoded); err != nil {
		return err
	}
	s.data, s.state, s.nextSeq = candidate, state, s.nextSeq+len(facts)
	return nil
}

func nextSessionSeq(data []byte) int {
	committed := data[:bytes.LastIndexByte(data, '\n')+1]
	lines := bytes.Split(committed[:len(committed)-1], []byte{'\n'})
	count := 0
	for _, line := range lines[1:] {
		value, err := sessionDecode(line)
		if err != nil {
			continue
		}
		if transaction, ok := value.([]any); ok {
			count += len(transaction)
		} else {
			count++
		}
	}
	return count + 1
}

func (s *SessionStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	return s.file.Close()
}
