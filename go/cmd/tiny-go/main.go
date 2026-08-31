package main

import (
	"bytes"
	"cmp"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultModel    = "openai/gpt-5.6-luna"
	maxBashOutput   = 10 * 1024 * 1024
	maxToolOutput   = 50 * 1024
	bashTimeout     = 120 * time.Second
	defaultEndpoint = "https://openrouter.ai/api/v1"
)

var cwd, _ = os.Getwd()

type Message struct {
	Role       string     `json:"role"`
	Content    *string    `json:"content"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
}

type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function ToolFunction `json:"function"`
}

type ToolFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type Skill struct{ Name, Description, Path string }
type Usage struct {
	Input        int      `json:"input"`
	Output       int      `json:"output"`
	CacheRead    int      `json:"cacheRead"`
	CacheWrite   int      `json:"cacheWrite"`
	CacheHitRate *float64 `json:"cacheHitRate,omitempty"`
}
type ToolEvent struct {
	Phase, Name string
	Args        map[string]any
	Result      string
}

type RunEvent map[string]any

type Tool struct {
	Name        string
	Description string
	Parameters  map[string]any
	Replay      string
	ReplayKey   string
	Identity    string
	Execute     func(context.Context, map[string]any) (string, error)
}

type ModelResponse struct {
	Message    Message
	Usage      Usage
	StopReason string
}

func text(s string) *string { return &s }
func model() string         { return cmp.Or(os.Getenv("TINY_MODEL"), defaultModel) }
func endpoint() string      { return cmp.Or(os.Getenv("TINY_ENDPOINT"), defaultEndpoint) }

func chatCompletionsURL(endpoint string) string {
	trimmed := strings.TrimRight(endpoint, "/")
	if strings.HasSuffix(trimmed, "/chat/completions") {
		return trimmed
	}
	return trimmed + "/chat/completions"
}
func formatTokens(n int) string {
	if n < 1000 {
		return fmt.Sprint(n)
	}
	if n < 10000 {
		return fmt.Sprintf("%.1fk", float64(n)/1000)
	}
	if n < 1_000_000 {
		return fmt.Sprintf("%dk", n/1000)
	}
	if n < 10_000_000 {
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	}
	return fmt.Sprintf("%dM", n/1_000_000)
}
func formatUsage(u Usage) string {
	parts := []string{"↑" + formatTokens(u.Input), "↓" + formatTokens(u.Output)}
	if u.CacheRead > 0 {
		parts = append(parts, "R"+formatTokens(u.CacheRead))
	}
	if u.CacheWrite > 0 {
		parts = append(parts, "W"+formatTokens(u.CacheWrite))
	}
	if (u.CacheRead > 0 || u.CacheWrite > 0) && u.CacheHitRate != nil {
		parts = append(parts, fmt.Sprintf("CH%.1f%%", *u.CacheHitRate))
	}
	return strings.Join(parts, " ")
}

func formatToolEvent(e ToolEvent) string {
	if e.Phase == "end" {
		if strings.HasPrefix(e.Result, "Error:") || e.Result == "Operation aborted" || e.Result == "ok" || e.Result == "(no output)" {
			return "  └ " + e.Result
		}
		return fmt.Sprintf("  └ %d chars", len(e.Result))
	}
	stringArg := func(name string) string {
		value, _ := e.Args[name].(string)
		return value
	}
	target := stringArg("path")
	if e.Name == "bash" || e.Name == "bg" {
		target = cmp.Or(stringArg("command"), stringArg("id"))
	}
	if len(target) > 80 {
		target = target[:77] + "..."
	}
	suffix := ""
	if e.Name == "write" {
		suffix = fmt.Sprintf(" (%d chars)", len(stringArg("content")))
	}
	if e.Name == "edit" {
		edits, _ := e.Args["edits"].([]any)
		suffix = fmt.Sprintf(" (%d blocks)", len(edits))
	}
	if target != "" {
		target = " " + target
	}
	return "◆ " + e.Name + target + suffix
}

func loadProjectInstructions() string {
	b, _ := os.ReadFile(filepath.Join(cwd, "AGENTS.md"))
	return string(b)
}

func loadSkills(extra []string) ([]Skill, error) {
	files := append([]string{}, extra...)
	_ = filepath.WalkDir(filepath.Join(cwd, ".tiny-agent", "skills"), func(path string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && d.Name() == "SKILL.md" {
			files = append(files, path)
		}
		return nil
	})
	seen := map[string]bool{}
	skills := []Skill{}
	for _, path := range files {
		path, _ = filepath.Abs(path)
		if seen[path] {
			continue
		}
		seen[path] = true
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		name, description := frontmatter(string(b), "name"), frontmatter(string(b), "description")
		name = cmp.Or(name, filepath.Base(filepath.Dir(path)))
		skills = append(skills, Skill{name, description, path})
	}
	slices.SortFunc(skills, func(a, b Skill) int { return strings.Compare(a.Path, b.Path) })
	return skills, nil
}

func frontmatter(s, key string) string {
	body, ok := strings.CutPrefix(s, "---\n")
	if !ok {
		return ""
	}
	body, _, ok = strings.Cut(body, "\n---")
	if !ok {
		return ""
	}
	for line := range strings.SplitSeq(body, "\n") {
		if value, ok := strings.CutPrefix(line, key+":"); ok {
			return strings.Trim(strings.TrimSpace(value), `"'`)
		}
	}
	return ""
}

var toolDefinitions = []map[string]any{
	toolDefinition("bash", "Run a shell command in the working directory", map[string]any{"command": map[string]string{"type": "string"}}, []string{"command"}),
	toolDefinition("read", "Read a UTF-8 text file. Prefer this over cat or sed. Returns at most 2,000 complete lines or 50KB and includes an offset hint when more lines remain.", map[string]any{
		"path": map[string]string{"type": "string", "description": "Path to the UTF-8 text file."}, "offset": map[string]any{"type": "integer", "minimum": 1, "description": "1-indexed line number to start reading from."}, "limit": map[string]any{"type": "integer", "minimum": 1, "description": "Maximum number of lines to return."},
	}, []string{"path"}),
	toolDefinition("write", "Create a new UTF-8 text file or completely rewrite an existing file. Parent directories are created automatically. Use edit for partial changes.", map[string]any{"path": map[string]string{"type": "string", "description": "Path to create or completely rewrite."}, "content": map[string]string{"type": "string", "description": "Complete UTF-8 file content."}}, []string{"path", "content"}),
	toolDefinition("edit", "Make precise replacements in an existing UTF-8 text file. Every oldText must match exactly once in the original file, and edits must not overlap. All edits are validated before writing.", map[string]any{
		"path":  map[string]string{"type": "string", "description": "Path to the existing UTF-8 text file."},
		"edits": map[string]any{"type": "array", "minItems": 1, "description": "Atomic replacement blocks validated against the original file.", "items": map[string]any{"type": "object", "properties": map[string]any{"oldText": map[string]any{"type": "string", "minLength": 1, "description": "Exact text that must occur exactly once in the original file."}, "newText": map[string]string{"type": "string", "description": "Replacement text."}}, "required": []string{"oldText", "newText"}}},
	}, []string{"path", "edits"}),
	toolDefinition("bg", "Manage background processes in the working directory. The id is the process pid; metadata and logs live in .tiny-agent/bg/<pid>.json and .log. Use for servers and other long-running commands. List shows running processes by default; use status=all or a specific status to inspect history in the same cwd.", map[string]any{"action": map[string]any{"type": "string", "enum": []string{"start", "list", "status", "logs", "stop"}}, "command": map[string]string{"type": "string"}, "id": map[string]string{"type": "string"}, "tail": map[string]any{"type": "integer", "minimum": 1}, "status": map[string]any{"type": "string", "enum": []string{"running", "exited", "stopped", "stale", "all"}, "description": "Filter for action=list. Defaults to running."}}, []string{"action"}),
}

func toolDefinition(name, description string, properties map[string]any, required []string) map[string]any {
	return map[string]any{"type": "function", "function": map[string]any{"name": name, "description": description, "parameters": map[string]any{"type": "object", "properties": properties, "required": required}}}
}

func resolveToolPath(path string) (string, error) {
	full := filepath.Clean(path)
	if !filepath.IsAbs(full) {
		full = filepath.Join(cwd, full)
	}
	return filepath.Abs(full)
}

type bgMeta struct {
	ID               string `json:"id"`
	Command          string `json:"command"`
	CWD              string `json:"cwd"`
	PID              int    `json:"pid"`
	PGID             int    `json:"pgid"`
	OwnerPID         int    `json:"ownerPid"`
	Started          string `json:"startedAt"`
	ProcessStartedAt string `json:"processStartedAt"`
	Log              string `json:"log"`
	Status           string `json:"status"`
	ExitCode         *int   `json:"exitCode,omitempty"`
	Signal           string `json:"signal,omitempty"`
	Exited           string `json:"exitedAt,omitempty"`
}

var (
	bgMu        sync.Mutex
	bgProcesses = map[string]*exec.Cmd{}
)

func bgDir() string { return filepath.Join(cwd, ".tiny-agent", "bg") }

func bgPaths(id string) (string, string, string, error) {
	if _, err := strconv.Atoi(id); err != nil {
		return "", "", "", errors.New("id must be a pid")
	}
	dir := bgDir()
	return filepath.Join(dir, id+".json"), filepath.Join(dir, id+".log"), filepath.Join(".tiny-agent", "bg", id+".log"), nil
}

func processRunning(pid int) bool { return syscall.Kill(pid, 0) == nil }

func processStartedAt(pid int) string {
	if !processRunning(pid) {
		return ""
	}
	cmd := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "lstart=")
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func readBGMeta(id string) (bgMeta, error) {
	path, _, _, err := bgPaths(id)
	if err != nil {
		return bgMeta{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return bgMeta{}, err
	}
	var meta bgMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return bgMeta{}, err
	}
	if meta.CWD != cwd {
		return bgMeta{}, fmt.Errorf("bg %s belongs to a different cwd", id)
	}
	return meta, nil
}

func writeBGMeta(meta bgMeta) error {
	path, _, _, err := bgPaths(meta.ID)
	if err != nil {
		return err
	}
	data, _ := json.MarshalIndent(meta, "", "  ")
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

func currentBGStatus(meta bgMeta) string {
	if meta.Status != "running" {
		return meta.Status
	}
	started := processStartedAt(meta.PID)
	if started == "" {
		return "exited"
	}
	if started != meta.ProcessStartedAt {
		return "stale"
	}
	return "running"
}

func bgJSON(meta bgMeta) string {
	meta.Status = currentBGStatus(meta)
	data, _ := json.Marshal(meta)
	return string(data)
}

func tailFile(path string, lines int) string {
	if lines < 1 {
		lines = 80
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	parts := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	if len(parts) > 0 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	start := max(0, len(parts)-min(lines, 2000))
	return strings.Join(parts[start:], "\n")
}

func startBG(command string) (string, error) {
	if command == "" {
		return "", errors.New("command must be a nonempty string")
	}
	if err := os.MkdirAll(bgDir(), 0o755); err != nil {
		return "", err
	}
	tempLog := filepath.Join(bgDir(), uuid7(time.Now())+".log")
	log, err := os.OpenFile(tempLog, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return "", err
	}
	cmd := exec.Command("sh", "-c", command)
	cmd.Dir = cwd
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Start(); err != nil {
		_ = log.Close()
		return "", err
	}
	id := strconv.Itoa(cmd.Process.Pid)
	_, logPath, relativeLog, err := bgPaths(id)
	if err != nil {
		return "", err
	}
	_ = os.Rename(tempLog, logPath)
	started := time.Now().UTC().Format(time.RFC3339Nano)
	fmt.Fprintf(log, "$ %s\ncwd: %s\npid: %s\nstarted: %s\n\n", command, cwd, id, started)
	meta := bgMeta{ID: id, Command: command, CWD: cwd, PID: cmd.Process.Pid, PGID: cmd.Process.Pid, OwnerPID: os.Getpid(), Started: started, ProcessStartedAt: processStartedAt(cmd.Process.Pid), Log: relativeLog, Status: "running"}
	bgMu.Lock()
	bgProcesses[id] = cmd
	bgMu.Unlock()
	if err := writeBGMeta(meta); err != nil {
		return "", err
	}
	go func() {
		err := cmd.Wait()
		code := 0
		if err != nil {
			if exit, ok := err.(*exec.ExitError); ok {
				code = exit.ExitCode()
			}
		}
		bgMu.Lock()
		_, owned := bgProcesses[id]
		delete(bgProcesses, id)
		bgMu.Unlock()
		status := "exited"
		if !owned {
			status = "stopped"
		}
		exited := time.Now().UTC().Format(time.RFC3339Nano)
		fmt.Fprintf(log, "\nexited: %s\nexitCode: %d\nsignal: \n", exited, code)
		_ = log.Close()
		meta.Status, meta.ExitCode, meta.Exited = status, &code, exited
		_ = writeBGMeta(meta)
	}()
	time.Sleep(500 * time.Millisecond)
	if currentBGStatus(meta) != "running" {
		if settled, readErr := readBGMeta(id); readErr == nil {
			meta = settled
		}
		meta.Status = currentBGStatus(meta)
		return bgJSON(meta) + "\n" + tailFile(logPath, 80), nil
	}
	return bgJSON(meta), nil
}

func stopBG(meta bgMeta) (bgMeta, error) {
	if currentBGStatus(meta) != "running" {
		meta.Status = currentBGStatus(meta)
		return meta, nil
	}
	bgMu.Lock()
	delete(bgProcesses, meta.ID)
	bgMu.Unlock()
	_ = syscall.Kill(-meta.PGID, syscall.SIGTERM)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && processRunning(meta.PID) {
		time.Sleep(50 * time.Millisecond)
	}
	if processRunning(meta.PID) {
		_ = syscall.Kill(-meta.PGID, syscall.SIGKILL)
	}
	meta.Status, meta.Exited = "stopped", time.Now().UTC().Format(time.RFC3339Nano)
	return meta, writeBGMeta(meta)
}

func executeBG(ctx context.Context, args map[string]string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	switch args["action"] {
	case "start":
		return startBG(args["command"])
	case "list":
		status := cmp.Or(args["status"], "running")
		if !slices.Contains([]string{"running", "exited", "stopped", "stale", "all"}, status) {
			return "", fmt.Errorf("unknown bg status filter: %s", status)
		}
		entries, _ := os.ReadDir(bgDir())
		metas := []bgMeta{}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			meta, err := readBGMeta(strings.TrimSuffix(entry.Name(), ".json"))
			if err != nil {
				continue
			}
			meta.Status = currentBGStatus(meta)
			if status == "all" || meta.Status == status {
				metas = append(metas, meta)
			}
		}
		data, _ := json.Marshal(metas)
		return string(data), nil
	case "status", "logs", "stop":
		meta, err := readBGMeta(args["id"])
		if err != nil {
			return "", err
		}
		_, logPath, _, _ := bgPaths(args["id"])
		if args["action"] == "status" {
			lines, _ := strconv.Atoi(args["tail"])
			return bgJSON(meta) + "\n" + tailFile(logPath, cmp.Or(lines, 40)), nil
		}
		if args["action"] == "logs" {
			lines, _ := strconv.Atoi(args["tail"])
			text := tailFile(logPath, cmp.Or(lines, 80))
			if text == "" {
				return "(no output)", nil
			}
			return text, nil
		}
		stopped, err := stopBG(meta)
		if err != nil {
			return "", err
		}
		return bgJSON(stopped), nil
	default:
		return "", fmt.Errorf("unknown bg action: %s", args["action"])
	}
}

func closeBackgroundProcesses() {
	bgMu.Lock()
	ids := slices.Collect(maps.Keys(bgProcesses))
	bgMu.Unlock()
	for _, id := range ids {
		if meta, err := readBGMeta(id); err == nil {
			_, _ = stopBG(meta)
		}
	}
}

func requiredToolString(args map[string]any, name string) (string, error) {
	value, ok := args[name].(string)
	if !ok || value == "" {
		return "", fmt.Errorf("%s must be a nonempty string", name)
	}
	return value, nil
}

func optionalToolInteger(args map[string]any, name string, fallback int) (int, error) {
	value, ok := args[name]
	if !ok {
		return fallback, nil
	}
	var number int
	switch value := value.(type) {
	case int:
		number = value
	case float64:
		if value != float64(int(value)) {
			return 0, fmt.Errorf("%s must be an integer >= 1", name)
		}
		number = int(value)
	default:
		return 0, fmt.Errorf("%s must be an integer >= 1", name)
	}
	if number < 1 {
		return 0, fmt.Errorf("%s must be an integer >= 1", name)
	}
	return number, nil
}

func readToolLines(text string, offset, limit int) (string, error) {
	lines := []string{}
	if text != "" {
		lines = strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
		if lines[len(lines)-1] == "" {
			lines = lines[:len(lines)-1]
		}
	}
	if len(lines) == 0 {
		if offset == 1 {
			return "", nil
		}
		return "", fmt.Errorf("Offset %d is beyond end of file (0 lines total).", offset)
	}
	if offset > len(lines) {
		return "", fmt.Errorf("Offset %d is beyond end of file (%d lines total).", offset, len(lines))
	}
	selected := make([]string, 0, min(limit, 2000))
	for _, line := range lines[offset-1 : min(len(lines), offset-1+min(limit, 2000))] {
		next := line
		if len(selected) > 0 {
			next = strings.Join(selected, "\n") + "\n" + line
		}
		if len([]byte(next)) > maxToolOutput {
			break
		}
		selected = append(selected, line)
	}
	if len(selected) == 0 {
		return fmt.Sprintf("Line %d exceeds 50KB. Use bash with a byte-oriented command to inspect this line.", offset), nil
	}
	end := offset + len(selected) - 1
	result := strings.Join(selected, "\n")
	if end < len(lines) {
		result += fmt.Sprintf("\n\n[Showing lines %d-%d of %d. Use offset=%d to continue.]", offset, end, len(lines), end+1)
	}
	return result, nil
}

type textEdit struct {
	oldText, newText  string
	index, start, end int
}

func requiredToolEdits(value any) ([]textEdit, error) {
	raw, ok := value.([]any)
	if !ok || len(raw) == 0 {
		return nil, errors.New("edits must be a nonempty array")
	}
	edits := make([]textEdit, len(raw))
	for index, item := range raw {
		edit, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("edits[%d] must be an object", index)
		}
		oldText, ok := edit["oldText"].(string)
		if !ok {
			return nil, fmt.Errorf("edits[%d].oldText must be a string", index)
		}
		if oldText == "" {
			return nil, fmt.Errorf("edits[%d].oldText must not be empty", index)
		}
		newText, ok := edit["newText"].(string)
		if !ok {
			return nil, fmt.Errorf("edits[%d].newText must be a string", index)
		}
		edits[index] = textEdit{oldText: oldText, newText: newText, index: index}
	}
	return edits, nil
}

func normalizeEditText(text string) (string, []int) {
	normalized := strings.Builder{}
	positions := []int{0}
	for source := 0; source < len(text); {
		if strings.HasPrefix(text[source:], "\r\n") {
			normalized.WriteByte('\n')
			source += 2
		} else {
			normalized.WriteByte(text[source])
			source++
		}
		positions = append(positions, source)
	}
	return normalized.String(), positions
}

func executeTool[T any](ctx context.Context, name string, rawArgs map[string]T) (string, error) {
	args := make(map[string]any, len(rawArgs))
	for key, value := range rawArgs {
		args[key] = value
	}
	return executeToolArgs(ctx, name, args)
}

func executeToolArgs(ctx context.Context, name string, args map[string]any) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if name == "bash" || name == "bg" {
		stringsOnly := map[string]string{}
		for key, value := range args {
			if text, ok := value.(string); ok {
				stringsOnly[key] = text
			} else if number, ok := value.(float64); ok {
				stringsOnly[key] = strconv.Itoa(int(number))
			}
		}
		if name == "bash" {
			command, err := requiredToolString(args, "command")
			if err != nil {
				return "", err
			}
			return executeBash(ctx, command)
		}
		return executeBG(ctx, stringsOnly)
	}
	requestedPath, err := requiredToolString(args, "path")
	if err != nil {
		return "", err
	}
	path, err := resolveToolPath(requestedPath)
	if err != nil {
		return "", err
	}
	if name == "read" {
		offset, err := optionalToolInteger(args, "offset", 1)
		if err != nil {
			return "", err
		}
		limit, err := optionalToolInteger(args, "limit", 2000)
		if err != nil {
			return "", err
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
		return readToolLines(string(b), offset, limit)
	}
	if name == "write" {
		content, ok := args["content"].(string)
		if !ok {
			return "", errors.New("content must be a string")
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return "", err
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			return "", err
		}
		return fmt.Sprintf("Successfully wrote %d bytes to %s.", len([]byte(content)), requestedPath), nil
	}
	if name != "edit" {
		return "", fmt.Errorf("unknown tool: %s", name)
	}
	edits, err := requiredToolEdits(args["edits"])
	if err != nil {
		return "", err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	original := string(b)
	bom := strings.HasPrefix(original, "\ufeff")
	text := strings.TrimPrefix(original, "\ufeff")
	ending := "\n"
	if index := strings.Index(text, "\n"); index > 0 && text[index-1] == '\r' {
		ending = "\r\n"
	}
	normalized, positions := normalizeEditText(text)
	for index := range edits {
		oldText := strings.ReplaceAll(edits[index].oldText, "\r\n", "\n")
		start := strings.Index(normalized, oldText)
		second := -1
		if start >= 0 {
			second = strings.Index(normalized[start+1:], oldText)
		}
		if start < 0 {
			return "", fmt.Errorf("edits[%d].oldText was not found in %s.", index, requestedPath)
		}
		if second >= 0 {
			return "", fmt.Errorf("edits[%d].oldText occurs more than once in %s; add more context.", index, requestedPath)
		}
		edits[index].start = positions[start]
		edits[index].end = positions[start+len(oldText)]
		edits[index].newText = strings.ReplaceAll(strings.ReplaceAll(edits[index].newText, "\r\n", "\n"), "\n", ending)
	}
	sorted := slices.Clone(edits)
	slices.SortFunc(sorted, func(a, b textEdit) int { return cmp.Compare(a.start, b.start) })
	for index := 1; index < len(sorted); index++ {
		if sorted[index].start >= sorted[index-1].end {
			continue
		}
		return "", fmt.Errorf("edits[%d] and edits[%d] overlap in %s.", sorted[index-1].index, sorted[index].index, requestedPath)
	}
	slices.SortFunc(edits, func(a, b textEdit) int { return cmp.Compare(b.start, a.start) })
	edited := text
	for _, edit := range edits {
		edited = edited[:edit.start] + edit.newText + edited[edit.end:]
	}
	if bom {
		edited = "\ufeff" + edited
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(edited), 0o644); err != nil {
		return "", err
	}
	return fmt.Sprintf("Successfully replaced %d block(s) in %s.", len(edits), requestedPath), nil
}

type cappedWriter struct {
	buffer   bytes.Buffer
	exceeded chan struct{}
}

func newCappedWriter() *cappedWriter   { return &cappedWriter{exceeded: make(chan struct{}, 1)} }
func (w *cappedWriter) Len() int       { return w.buffer.Len() }
func (w *cappedWriter) Bytes() []byte  { return w.buffer.Bytes() }
func (w *cappedWriter) String() string { return w.buffer.String() }
func (w *cappedWriter) Write(p []byte) (int, error) {
	remaining := maxBashOutput - w.Len()
	if remaining > 0 {
		_, _ = w.buffer.Write(p[:min(len(p), remaining)])
	}
	if len(p) > remaining {
		select {
		case w.exceeded <- struct{}{}:
		default:
		}
	}
	return len(p), nil
}

func executeBash(ctx context.Context, command string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, bashTimeout)
	defer cancel()
	cmd := exec.Command("sh", "-c", command)
	cmd.Dir = cwd
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	output := newCappedWriter()
	cmd.Stdout, cmd.Stderr = output, output
	if err := cmd.Start(); err != nil {
		return "", err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var err error
	exceeded := false
	select {
	case err = <-done:
	case <-output.exceeded:
		exceeded = true
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
	case <-ctx.Done():
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
		err = ctx.Err()
	}
	if !exceeded {
		select {
		case <-output.exceeded:
			exceeded = true
		default:
		}
	}
	if exceeded {
		return output.String(), fmt.Errorf("bash output exceeded %dMB limit", maxBashOutput/(1024*1024))
	}
	if output.Len() == 0 {
		if err != nil {
			return "", err
		}
		return "(no output)", nil
	}
	if output.Len() <= maxToolOutput {
		return output.String(), err
	}
	dir := filepath.Join(cwd, ".tiny-agent", "tool-output")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, uuid7(time.Now())) + ".log"
	if err := os.WriteFile(path, output.Bytes(), 0o644); err != nil {
		return "", err
	}
	tail := output.Bytes()[output.Len()-maxToolOutput:]
	for len(tail) > 0 && tail[0]&0xc0 == 0x80 {
		tail = tail[1:]
	}
	return fmt.Sprintf("%s\n\n[Output truncated. Full output: %s]", tail, path), err
}

func uuid7(now time.Time) string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	millis := uint64(now.UnixMilli())
	binary.BigEndian.PutUint64(b[:8], millis<<16)
	b[6], b[8] = b[6]&0x0f|0x70, b[8]&0x3f|0x80
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

type Agent struct {
	Messages []Message
	Usage    Usage
	Skills   []Skill
	Session  *SessionStore
	Client   *http.Client
	Endpoint string
	OnTool   func(ToolEvent)
	OnEvent  func(RunEvent)
	Tools    []Tool
	mu       sync.Mutex
	cancel   context.CancelFunc
	active   *activeOperation
}

func newAgent(skills []Skill, session *SessionStore, instructions string) *Agent {
	list := "(none)"
	if len(skills) > 0 {
		items := make([]string, len(skills))
		for i, skill := range skills {
			items[i] = fmt.Sprintf("<skill>\n<name>%s</name>\n<description>%s</description>\n<location>%s</location>\n</skill>", skill.Name, skill.Description, skill.Path)
		}
		list = strings.Join(items, "\n")
	}
	project := ""
	if instructions != "" {
		project = fmt.Sprintf("\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path=\"%s\">\n%s\n</project_instructions>\n\n</project_context>", filepath.Join(cwd, "AGENTS.md"), instructions)
	}
	prompt := fmt.Sprintf("You are tiny-agent, a concise coding agent in %s. Use only the tools provided in this request. If the available tools cannot complete the task, explain the missing capability instead of calling an unavailable tool. Follow the project instructions below. When a task matches an available skill, use its location only when a provided tool can read it.\n\nFor implementation tasks, inspect only what is needed, then make the changes and run focused tests. Do not keep researching the same uncertainty when a mature dependency or direct implementation is available.\nUse the provided tool descriptions to choose the right capability. Not every run enables file access, shell access, or file modification.\nPrefer completing a small working implementation over exhaustively researching every option. If repeated experiments fail, reconsider the approach instead of making another similar attempt.%s\n\n<available_skills>\n%s\n</available_skills>", cwd, project, list)
	return &Agent{Messages: []Message{{Role: "system", Content: text(prompt)}}, Skills: skills, Session: session, Client: http.DefaultClient, Endpoint: chatCompletionsURL(endpoint()), OnTool: func(ToolEvent) {}, OnEvent: func(RunEvent) {}, Tools: localTools()}
}

func localTools(names ...string) []Tool {
	selected := map[string]bool{}
	for _, name := range names {
		selected[name] = true
	}
	tools := make([]Tool, 0, len(toolDefinitions))
	for _, definition := range toolDefinitions {
		function := definition["function"].(map[string]any)
		name := function["name"].(string)
		if len(selected) > 0 && !selected[name] {
			continue
		}
		description := function["description"].(string)
		parameters := function["parameters"].(map[string]any)
		toolName := name
		replay, replayKey := "never", "builtin:"+name+":v1"
		if name == "read" {
			replay = "safe"
		}
		tools = append(tools, Tool{Name: name, Description: description, Parameters: parameters, Replay: replay, ReplayKey: replayKey, Execute: func(ctx context.Context, args map[string]any) (string, error) {
			return executeTool(ctx, toolName, args)
		}})
	}
	return tools
}

func (a *Agent) toolDefinitions() []map[string]any {
	definitions := make([]map[string]any, 0, len(a.Tools))
	for _, tool := range a.Tools {
		definitions = append(definitions, map[string]any{"type": "function", "function": map[string]any{"name": tool.Name, "description": tool.Description, "parameters": tool.Parameters}})
	}
	return definitions
}

func (a *Agent) begin() context.Context { return a.beginOperation("", "", "", "") }
func (a *Agent) end()                   { a.endOperation(context.Background()) }

func (a *Agent) endOperation(ctx context.Context) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	aborted := errors.Is(ctx.Err(), context.Canceled)
	a.cancel, a.active = nil, nil
	return aborted
}
func value(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (a *Agent) addUsage(usage Usage) {
	a.Usage.Input += usage.Input
	a.Usage.Output += usage.Output
	a.Usage.CacheRead += usage.CacheRead
	a.Usage.CacheWrite += usage.CacheWrite
}

func (a *Agent) setLatestCacheHitRate(usage Usage) {
	prompt := usage.Input + usage.CacheRead + usage.CacheWrite
	if prompt > 0 {
		rate := float64(usage.CacheRead) / float64(prompt) * 100
		a.Usage.CacheHitRate = &rate
	}
}

func (a *Agent) callModel(ctx context.Context, messages []Message, tools any) (ModelResponse, error) {
	started := time.Now()
	key := os.Getenv("OPENROUTER_API_KEY")
	if key == "" {
		return ModelResponse{}, errors.New("Set OPENROUTER_API_KEY")
	}
	body := map[string]any{"model": model(), "messages": messages}
	if tools != nil {
		body["tools"] = tools
	}
	encoded, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.Endpoint, bytes.NewReader(encoded))
	if err != nil {
		return ModelResponse{}, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("HTTP-Referer", "https://github.com/geminixiang/tiny-agent")
	response, err := a.Client.Do(req)
	if err != nil {
		return ModelResponse{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		data, _ := io.ReadAll(response.Body)
		return ModelResponse{}, fmt.Errorf("OpenRouter %d: %s", response.StatusCode, data)
	}
	var data struct {
		Choices []struct {
			Message      Message `json:"message"`
			FinishReason string  `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			PromptTokens         int `json:"prompt_tokens"`
			CompletionTokens     int `json:"completion_tokens"`
			PromptCacheHitTokens int `json:"prompt_cache_hit_tokens"`
			PromptTokensDetails  struct {
				CachedTokens     int `json:"cached_tokens"`
				CacheWriteTokens int `json:"cache_write_tokens"`
			} `json:"prompt_tokens_details"`
		} `json:"usage"`
	}
	if err := json.NewDecoder(response.Body).Decode(&data); err != nil {
		return ModelResponse{}, err
	}
	if len(data.Choices) == 0 {
		return ModelResponse{}, errors.New("OpenRouter returned no choices")
	}
	cacheRead := data.Usage.PromptTokensDetails.CachedTokens
	if cacheRead == 0 {
		cacheRead = data.Usage.PromptCacheHitTokens
	}
	cacheWrite := data.Usage.PromptTokensDetails.CacheWriteTokens
	usage := Usage{Input: max(0, data.Usage.PromptTokens-cacheRead-cacheWrite), Output: data.Usage.CompletionTokens, CacheRead: cacheRead, CacheWrite: cacheWrite}
	prompt := usage.Input + usage.CacheRead + usage.CacheWrite
	if prompt > 0 {
		rate := float64(usage.CacheRead) / float64(prompt) * 100
		usage.CacheHitRate = &rate
	}
	a.addUsage(usage)
	a.OnEvent(RunEvent{"type": "model.completed", "timestamp": time.Now().UTC().Format(time.RFC3339Nano), "durationMs": float64(time.Since(started).Microseconds()) / 1000, "usage": usage})
	reason := data.Choices[0].FinishReason
	if reason == "" {
		if len(data.Choices[0].Message.ToolCalls) > 0 {
			reason = "tool_calls"
		} else {
			reason = "stop"
		}
	}
	return ModelResponse{Message: data.Choices[0].Message, Usage: usage, StopReason: reason}, nil
}

func (a *Agent) runAgentLoop(input string) (string, error) {
	user := Message{Role: "user", Content: text(input)}
	run, err := a.startDurableRun(input)
	if err != nil {
		return "", err
	}
	a.Messages = append(a.Messages, user)
	for {
		if err := a.startAttempt(&run, "assistant", 1); err != nil {
			return "", err
		}
		ctx := a.beginOperation(run.OperationID, "run", "model", "")
		response, err := a.callModel(ctx, a.Messages, a.toolDefinitions())
		aborted := a.endOperation(ctx)
		if aborted {
			if recoveryErr := a.reconcileAbort(); recoveryErr != nil && !errors.Is(recoveryErr, context.Canceled) {
				return "", recoveryErr
			}
			return "Operation aborted.", nil
		}
		if err != nil {
			return "", a.failAttempt(run, "model_error", err, true)
		}
		stop := response.StopReason
		if stop == "tool_calls" || stop == "function_call" {
			stop = "toolUse"
		}
		if stop != "stop" && stop != "toolUse" && stop != "length" {
			return "", a.failAttempt(run, "model_error", fmt.Errorf("unsupported finish_reason: %s", response.StopReason), true)
		}
		response.StopReason = stop
		answer := response.Message
		if stop == "stop" && len(answer.ToolCalls) != 0 {
			err := errors.New("Model returned tool calls with finish_reason: stop")
			return "", a.failModelResponse(run, response, err)
		}
		finish := stop == "stop" && strings.TrimSpace(value(answer.Content)) != ""
		if stop == "stop" && !finish {
			err := errors.New("Model returned an empty response (finish_reason: stop)")
			return "", a.settleFailedAssistant(&run, response, err)
		}
		if stop == "length" && len(answer.ToolCalls) == 0 {
			err := errors.New("Model response reached the token limit without tool calls")
			return "", a.settleFailedAssistant(&run, response, err)
		}
		if _, err := a.settleAssistant(&run, response, finish); err != nil {
			return "", err
		}
		a.Messages = append(a.Messages, answer)
		if finish {
			return value(answer.Content), nil
		}
		if stop == "length" {
			for index, call := range answer.ToolCalls {
				if err := a.appendSynthetic(&run, index, call, "truncated"); err != nil {
					return "", err
				}
			}
			return "", errors.New("Model response reached the token limit")
		}
		if stop == "stop" {
			return "", errors.New("invalid empty stop response")
		}
		for index, call := range answer.ToolCalls {
			args, err := decodeToolArguments(call.Function.Arguments)
			if err != nil {
				if err := a.appendSynthetic(&run, index, call, "invalidArguments"); err != nil {
					return "", err
				}
				continue
			}
			selected := findTool(a.Tools, call.Function.Name)
			if selected == nil {
				if err := a.appendSynthetic(&run, index, call, "unknownTool"); err != nil {
					return "", err
				}
				continue
			}
			if err := a.executeDurableTool(&run, index, call, selected, args, nil); err != nil {
				if errors.Is(err, context.Canceled) {
					return "Operation aborted.", nil
				}
				return "", err
			}
		}
	}
}

func (a *Agent) compact() (string, error) {
	if a.Session == nil {
		return "", errors.New("Compaction requires a durable session")
	}
	state := a.Session.State()
	if state.Operation.Kind != "idle" {
		return "", errors.New("session operation is active")
	}
	const retain = 6
	if len(state.messageFacts) <= retain {
		return "Nothing to compact.", nil
	}
	cut := len(state.messageFacts) - retain
	for cut > 0 && state.messageFacts[cut].Message["role"] != "user" {
		cut--
	}
	if cut == 0 {
		return "Nothing to compact.", nil
	}
	compacted := state.messageFacts[:cut]
	retained := state.messageFacts[cut:]
	compactedIDs, retainedIDs := make([]any, len(compacted)), make([]any, len(retained))
	for index, item := range compacted {
		compactedIDs[index] = item.ID
	}
	for index, item := range retained {
		retainedIDs[index] = item.ID
	}
	inputID := state.messageFacts[len(state.messageFacts)-1].ID
	operationID := a.Session.NewID(time.Now())
	resultID := a.Session.NewID(time.Now().Add(time.Nanosecond))
	record := map[string]any{
		"type": "compactionStarted", "operationId": operationID, "operationKind": "compaction",
		"inputThroughEntryId": inputID, "resultEntryId": resultID,
		"compactedEntryIds": compactedIDs, "retainedEntryIds": retainedIDs,
		"sourceDigest": digestSourceFacts(state.messageFacts),
	}
	if err := a.Session.Commit([]map[string]any{recordFact(record)}); err != nil {
		return "", err
	}
	run := durableRun{OperationID: operationID, ContextEntryID: inputID, Attempt: 1}
	if err := a.startAttempt(&run, "compaction", 1); err != nil {
		return "", err
	}
	if err := a.executeCompaction(run); err != nil {
		if errors.Is(err, context.Canceled) {
			return "Compaction aborted.", nil
		}
		return "", err
	}
	if err := a.projectSession(); err != nil {
		return "", err
	}
	return fmt.Sprintf("Compacted %d messages (kept last %d).", len(compacted), len(retained)), nil
}

func digestSourceFacts(source []sessionMessageFact) string {
	values := make([]any, len(source))
	for index, item := range source {
		values[index] = map[string]any{"sourceEntryId": item.ID, "message": item.Message}
	}
	return digestValue(values)
}

func parseArgs(args []string) (sessionID, workingDirectory string, extras, plugins, mcp []string, prompt string, err error) {
	words := []string{}
	for i := 0; i < len(args); i++ {
		if args[i] != "--session" && args[i] != "--cwd" && args[i] != "--skill" && args[i] != "--plugin" && args[i] != "--mcp" {
			words = append(words, args[i])
			continue
		}
		if i+1 == len(args) {
			return "", "", nil, nil, nil, "", fmt.Errorf("%s requires a value", args[i])
		}
		if args[i] == "--session" {
			sessionID = args[i+1]
		} else if args[i] == "--cwd" {
			workingDirectory = args[i+1]
		} else if args[i] == "--skill" {
			extras = append(extras, args[i+1])
		} else if args[i] == "--plugin" {
			plugins = append(plugins, args[i+1])
		} else {
			mcp = append(mcp, args[i+1])
		}
		i++
	}
	return sessionID, workingDirectory, extras, splitList(plugins), splitList(mcp), strings.Join(words, " "), nil
}

type silentCLIError struct{}

func (silentCLIError) Error() string { return "" }

func emitJSON(event any) { _ = json.NewEncoder(os.Stdout).Encode(event) }

func runCLI(args []string) error {
	jsonMode := slices.Contains(args, "--json")
	if jsonMode {
		filtered := args[:0]
		for _, arg := range args {
			if arg != "--json" {
				filtered = append(filtered, arg)
			}
		}
		args = filtered
	}
	sessionID, workingDirectory, extras, plugins, mcpAliases, oneShot, err := parseArgs(args)
	if err != nil {
		return err
	}
	if jsonMode && oneShot == "" {
		return errors.New("--json requires a one-shot prompt.")
	}
	if workingDirectory != "" {
		path, resolveErr := filepath.Abs(workingDirectory)
		if resolveErr != nil {
			return resolveErr
		}
		info, statErr := os.Stat(path)
		if statErr != nil {
			return statErr
		}
		if !info.IsDir() {
			return fmt.Errorf("--cwd must be a directory: %s", workingDirectory)
		}
		if chdirErr := os.Chdir(path); chdirErr != nil {
			return chdirErr
		}
		cwd = path
	}
	selectedPlugins := plugins
	if len(selectedPlugins) == 0 {
		selectedPlugins = []string{"bash", "read", "write", "edit", "bg"}
	}
	for _, plugin := range selectedPlugins {
		if !slices.Contains([]string{"bash", "read", "write", "edit", "bg"}, plugin) {
			return fmt.Errorf("Unknown plugin: %s. Available plugins: bash, read, write, edit, bg", plugin)
		}
	}
	configs, err := loadMCPConfigs(mcpAliases, currentEnvironment())
	if err != nil {
		return err
	}
	skills, err := loadSkills(extras)
	if err != nil {
		return err
	}
	var session *SessionStore
	if sessionID == "" {
		session, err = createSessionStore(time.Now())
	} else {
		session, err = openSessionStore(sessionID)
	}
	if err != nil {
		return err
	}
	defer session.Close()
	defer closeBackgroundProcesses()
	runStarted := time.Now()
	if jsonMode {
		emitJSON(RunEvent{"type": "run.started", "timestamp": runStarted.UTC().Format(time.RFC3339Nano), "sessionId": session.ID, "model": model(), "endpoint": endpoint(), "plugins": selectedPlugins, "mcp": mcpAliases})
	}
	agent := newAgent(skills, session, loadProjectInstructions())
	agent.Tools = localTools(selectedPlugins...)
	loadedMCP := []*MCPClient{}
	defer func() {
		for i := len(loadedMCP) - 1; i >= 0; i-- {
			_ = loadedMCP[i].Close()
		}
	}()
	for _, config := range configs {
		connectionStarted := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		loaded, loadErr := loadMCPTools(ctx, config, http.DefaultClient)
		cancel()
		if loadErr != nil {
			if jsonMode {
				emitJSON(RunEvent{"type": "mcp.failed", "timestamp": time.Now().UTC().Format(time.RFC3339Nano), "server": config.Alias, "stage": "connect", "cause": "connection_failed"})
				emitJSON(RunEvent{"type": "run.completed", "timestamp": time.Now().UTC().Format(time.RFC3339Nano), "durationMs": float64(time.Since(runStarted).Microseconds()) / 1000, "result": map[string]any{"status": "failed", "cause": "mcp_setup_error", "message": fmt.Sprintf("MCP %s failed: connection_failed", config.Alias), "sessionId": session.ID, "usage": Usage{}}})
				return silentCLIError{}
			}
			return fmt.Errorf("MCP %s failed: %w", config.Alias, loadErr)
		}
		loadedMCP = append(loadedMCP, loaded)
		agent.Tools = append(agent.Tools, loaded.tools...)
		if jsonMode {
			emitJSON(RunEvent{"type": "mcp.connected", "timestamp": time.Now().UTC().Format(time.RFC3339Nano), "server": config.Alias, "protocolVersion": loaded.protocolVersion, "toolCount": len(loaded.tools), "durationMs": float64(time.Since(connectionStarted).Microseconds()) / 1000})
		} else {
			fmt.Printf("MCP %s: connected (%s, %d tools)\n", config.Alias, loaded.protocolVersion, len(loaded.tools))
		}
	}
	out := io.Writer(os.Stdout)
	if jsonMode {
		agent.OnEvent = func(event RunEvent) { emitJSON(event) }
	}
	agent.OnTool = func(event ToolEvent) {
		if jsonMode {
			return
		}
		color := "\x1b[2m"
		if event.Phase == "start" {
			color = "\x1b[33m"
		}
		fmt.Fprintln(out, color+formatToolEvent(ToolEvent{Phase: event.Phase, Name: displayToolName(event.Name), Args: event.Args, Result: event.Result})+"\x1b[0m")
	}
	if sessionID != "" {
		if err := agent.restoreSession(); err != nil {
			return err
		}
	}
	if jsonMode {
		answer, runErr := agent.runAgentLoop(oneShot)
		result := map[string]any{"sessionId": session.ID, "usage": agent.Usage}
		if runErr != nil {
			result["status"], result["cause"], result["message"] = "failed", "agent_error", runErr.Error()
		} else {
			result["status"], result["answer"] = "succeeded", answer
			if answer == "Operation aborted." {
				result["status"] = "cancelled"
			}
		}
		emitJSON(RunEvent{"type": "run.completed", "timestamp": time.Now().UTC().Format(time.RFC3339Nano), "durationMs": float64(time.Since(runStarted).Microseconds()) / 1000, "result": result})
		if runErr != nil {
			return silentCLIError{}
		}
		return nil
	}
	resume := func() { fmt.Fprintf(out, "\nResume: tiny-go --session %s\n", session.ID) }
	fmt.Printf("\x1b[36mtiny-agent\x1b[0m\nprovider: openrouter\nendpoint: %s\nmodel: %s\nsession: %s\npath: %s\ntools: %s\nmcp: %s", endpoint(), model(), session.ID, session.Path, displayToolList(agent.Tools), emptyList(mcpAliases))
	if sessionID != "" {
		fmt.Print("\nrestored: yes")
	}
	fmt.Println()
	tty, err := newTerminal(os.Stdin, os.Stdout)
	if err != nil {
		return err
	}
	defer tty.close()
	out = tty.out
	if oneShot != "" {
		answer, err := tty.run(agent, func() (string, error) { return agent.runAgentLoop(oneShot) })
		if errors.Is(err, errExit) {
			resume()
			return nil
		}
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "\n%s\n\x1b[2m%s\x1b[0m\n", answer, formatUsage(agent.Usage))
		resume()
		return nil
	}
	fmt.Fprintln(out, "Esc aborts the active operation; Ctrl+C exits.\n/compact  /skill:name  /exit")
	for {
		input, err := tty.readLine("\x1b[32m›\x1b[0m ")
		if errors.Is(err, io.EOF) || errors.Is(err, errExit) {
			resume()
			return nil
		}
		if err != nil {
			return err
		}
		if input == "" {
			continue
		}
		if input == "/exit" {
			resume()
			return nil
		}
		var answer string
		if input == "/compact" {
			answer, err = tty.run(agent, agent.compact)
		} else if strings.HasPrefix(input, "/skill:") {
			answer, err = runSkill(tty, agent, input)
		} else {
			answer, err = tty.run(agent, func() (string, error) { return agent.runAgentLoop(input) })
		}
		if errors.Is(err, errExit) {
			resume()
			return nil
		}
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "\x1b[36m%s\x1b[0m\n\x1b[2m%s\x1b[0m\n", answer, formatUsage(agent.Usage))
	}
}

func displayToolList(tools []Tool) string {
	names := make([]string, len(tools))
	for i, tool := range tools {
		names[i] = displayToolName(tool.Name)
	}
	return emptyList(names)
}

func emptyList(values []string) string {
	if len(values) == 0 {
		return "(none)"
	}
	return strings.Join(values, ", ")
}

func runSkill(tty *terminal, agent *Agent, input string) (string, error) {
	fields := strings.SplitN(strings.TrimPrefix(input, "/skill:"), " ", 2)
	for _, skill := range agent.Skills {
		if skill.Name != fields[0] {
			continue
		}
		b, err := os.ReadFile(skill.Path)
		if err != nil {
			return "", err
		}
		request := string(b) + "\n\nUser: "
		if len(fields) > 1 {
			request += fields[1]
		}
		return tty.run(agent, func() (string, error) { return agent.runAgentLoop(request) })
	}
	return "Unknown skill: " + fields[0], nil
}

func main() {
	if err := runCLI(os.Args[1:]); err != nil {
		if _, silent := err.(silentCLIError); !silent {
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
}
