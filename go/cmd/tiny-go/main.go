package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/term"
)

const (
	defaultModel  = "deepseek/deepseek-v4-flash-0731"
	maxBashOutput = 10 * 1024 * 1024
	maxToolOutput = 50 * 1024
	bashTimeout   = 120 * time.Second
	openRouterURL = "https://openrouter.ai/api/v1/chat/completions"
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
	Input, Output, CacheRead, CacheWrite int
	CacheHitRate                         *float64
}
type ToolEvent struct {
	Phase, Name string
	Args        map[string]string
	Result      string
}
type ModelResponse struct {
	Message Message
	Usage   Usage
}

type SessionRecord struct {
	Type              string     `json:"type"`
	Version           int        `json:"version,omitempty"`
	ID                string     `json:"id,omitempty"`
	CreatedAt         string     `json:"createdAt,omitempty"`
	Timestamp         string     `json:"timestamp"`
	Cwd               string     `json:"cwd,omitempty"`
	Provider          string     `json:"provider,omitempty"`
	Model             string     `json:"model,omitempty"`
	Message           *Message   `json:"message,omitempty"`
	Usage             *UsageJSON `json:"usage,omitempty"`
	ToolName          string     `json:"toolName,omitempty"`
	Summary           *string    `json:"summary,omitempty"`
	CompactedMessages int        `json:"compactedMessages,omitempty"`
	KeptMessages      int        `json:"keptMessages,omitempty"`
	Phase             string     `json:"phase,omitempty"`
	Reason            string     `json:"reason,omitempty"`
	ToolCallID        string     `json:"toolCallId,omitempty"`
}

type UsageJSON struct {
	Input      int `json:"input"`
	Output     int `json:"output"`
	CacheRead  int `json:"cacheRead"`
	CacheWrite int `json:"cacheWrite"`
}

func text(s string) *string { return &s }
func model() string {
	if v := os.Getenv("TINY_MODEL"); v != "" {
		return v
	}
	return defaultModel
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
		if e.Result == "ok" || e.Result == "(no output)" {
			return "  └ " + e.Result
		}
		return fmt.Sprintf("  └ %d chars", len(e.Result))
	}
	target := e.Args["path"]
	if e.Name == "bash" {
		target = e.Args["command"]
	}
	if len(target) > 80 {
		target = target[:77] + "..."
	}
	suffix := ""
	if e.Name == "write" {
		suffix = fmt.Sprintf(" (%d chars)", len(e.Args["content"]))
	}
	if e.Name == "edit" {
		suffix = fmt.Sprintf(" (%d→%d chars)", len(e.Args["oldText"]), len(e.Args["newText"]))
	}
	if target != "" {
		target = " " + target
	}
	return "◆ " + e.Name + target + suffix
}

func loadProjectInstructions() string {
	b, err := os.ReadFile(filepath.Join(cwd, "AGENTS.md"))
	if err != nil {
		return ""
	}
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
		if name == "" {
			name = filepath.Base(filepath.Dir(path))
		}
		skills = append(skills, Skill{name, description, path})
	}
	sort.Slice(skills, func(i, j int) bool { return skills[i].Path < skills[j].Path })
	return skills, nil
}

func frontmatter(s, key string) string {
	if !strings.HasPrefix(s, "---\n") {
		return ""
	}
	end := strings.Index(s[4:], "\n---")
	if end < 0 {
		return ""
	}
	prefix := key + ":"
	for _, line := range strings.Split(s[4:4+end], "\n") {
		if strings.HasPrefix(line, prefix) {
			return strings.Trim(strings.TrimSpace(strings.TrimPrefix(line, prefix)), `"'`)
		}
	}
	return ""
}

var toolDefinitions = []map[string]any{
	toolDefinition("bash", "Run a shell command in the working directory", map[string]any{"command": map[string]string{"type": "string"}}),
	toolDefinition("read", "Read a UTF-8 text file", map[string]any{"path": map[string]string{"type": "string"}}),
	toolDefinition("write", "Create or overwrite a UTF-8 text file", map[string]any{"path": map[string]string{"type": "string"}, "content": map[string]string{"type": "string"}}),
	toolDefinition("edit", "Replace one unique exact string in a UTF-8 text file", map[string]any{"path": map[string]string{"type": "string"}, "oldText": map[string]string{"type": "string"}, "newText": map[string]string{"type": "string"}}),
}

func toolDefinition(name, description string, properties map[string]any) map[string]any {
	required := make([]string, 0, len(properties))
	for key := range properties {
		required = append(required, key)
	}
	sort.Strings(required)
	return map[string]any{"type": "function", "function": map[string]any{"name": name, "description": description, "parameters": map[string]any{"type": "object", "properties": properties, "required": required}}}
}

func pathInRoot(path string) (string, error) {
	full := filepath.Clean(path)
	if !filepath.IsAbs(full) {
		full = filepath.Join(cwd, full)
	}
	full, err := filepath.Abs(full)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(cwd, full)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("path must stay inside cwd")
	}
	return full, nil
}

func executeTool(ctx context.Context, name string, args map[string]string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if name == "bash" {
		return executeBash(ctx, args["command"])
	}
	path, err := pathInRoot(args["path"])
	if err != nil {
		return "", err
	}
	if name == "read" {
		b, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if len(b) > 100_000 {
			b = b[:100_000]
			for !utf8.Valid(b) {
				b = b[:len(b)-1]
			}
		}
		return string(b), nil
	}
	if name == "write" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return "", err
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if err := os.WriteFile(path, []byte(args["content"]), 0o644); err != nil {
			return "", err
		}
		return "ok", nil
	}
	if name == "edit" {
		b, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		count := strings.Count(string(b), args["oldText"])
		if count != 1 {
			return "", fmt.Errorf("oldText must occur exactly once (found %d)", count)
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if err := os.WriteFile(path, []byte(strings.Replace(string(b), args["oldText"], args["newText"], 1)), 0o644); err != nil {
			return "", err
		}
		return "ok", nil
	}
	return "", fmt.Errorf("unknown tool: %s", name)
}

type cappedWriter struct {
	buffer   bytes.Buffer
	exceeded chan struct{}
}

func newCappedWriter() *cappedWriter { return &cappedWriter{exceeded: make(chan struct{}, 1)} }
func (w *cappedWriter) Len() int     { return w.buffer.Len() }
func (w *cappedWriter) Bytes() []byte {
	return w.buffer.Bytes()
}
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

type Session struct {
	ID, Path string
	mu       sync.Mutex
}

func createSession(now time.Time) (*Session, error) {
	id := uuid7(now)
	dir := filepath.Join(cwd, ".tiny-agent", "sessions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	createdAt := now.UTC().Format("2006-01-02T15:04:05.000Z")
	stamp := strings.NewReplacer(":", "-", ".", "-").Replace(createdAt)
	session := &Session{ID: id, Path: filepath.Join(dir, stamp+"_"+id+".jsonl")}
	err := session.append(SessionRecord{Type: "session", Version: 1, ID: id, CreatedAt: createdAt, Cwd: cwd, Provider: "openrouter", Model: model()})
	return session, err
}

func openSession(id string) (*Session, error) {
	valid := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(id)
	if !valid {
		return nil, fmt.Errorf("Invalid session ID: %s", id)
	}
	matches, _ := filepath.Glob(filepath.Join(cwd, ".tiny-agent", "sessions", "*_"+id+".jsonl"))
	if len(matches) == 0 {
		return nil, fmt.Errorf("Session not found: %s", id)
	}
	if len(matches) > 1 {
		return nil, fmt.Errorf("Duplicate session ID: %s", id)
	}
	return &Session{ID: id, Path: matches[0]}, nil
}

func (s *Session) append(record SessionRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	record.Timestamp = time.Now().UTC().Format(time.RFC3339Nano)
	b, err := json.Marshal(record)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(s.Path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(b, '\n'))
	return err
}

func (s *Session) records() ([]SessionRecord, error) {
	f, err := os.Open(s.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	records := []SessionRecord{}
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 12*1024*1024)
	for scanner.Scan() {
		var record SessionRecord
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, scanner.Err()
}

type Agent struct {
	Messages []Message
	Usage    Usage
	Skills   []Skill
	Session  *Session
	Client   *http.Client
	Endpoint string
	OnTool   func(ToolEvent)
	Tools    []Tool
	mu       sync.Mutex
	cancel   context.CancelFunc
}

func newAgent(skills []Skill, session *Session, instructions string) *Agent {
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
	prompt := fmt.Sprintf("You are tiny-agent, a concise coding agent in %s. Use tools to inspect and change files. Follow the project instructions below. When a task matches an available skill, use read on its location before following it.%s\n\n<available_skills>\n%s\n</available_skills>", cwd, project, list)
	return &Agent{Messages: []Message{{Role: "system", Content: text(prompt)}}, Skills: skills, Session: session, Client: http.DefaultClient, Endpoint: openRouterURL, OnTool: func(ToolEvent) {}, Tools: localTools()}
}

func localTools() []Tool {
	tools := make([]Tool, 0, len(toolDefinitions))
	for _, definition := range toolDefinitions {
		function := definition["function"].(map[string]any)
		name := function["name"].(string)
		description := function["description"].(string)
		parameters := function["parameters"].(map[string]any)
		toolName := name
		tools = append(tools, Tool{Name: name, Description: description, Parameters: parameters, Execute: func(ctx context.Context, args map[string]any) (string, error) {
			stringsOnly := map[string]string{}
			for key, value := range args {
				text, ok := value.(string)
				if !ok {
					return "", fmt.Errorf("tool argument %s must be a string", key)
				}
				stringsOnly[key] = text
			}
			return executeTool(ctx, toolName, stringsOnly)
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

func (a *Agent) abort() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cancel != nil {
		a.cancel()
	}
}
func (a *Agent) begin() context.Context {
	a.mu.Lock()
	defer a.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel
	return ctx
}
func (a *Agent) end() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cancel = nil
}
func usageJSON(u Usage) *UsageJSON { return &UsageJSON{u.Input, u.Output, u.CacheRead, u.CacheWrite} }

func (a *Agent) interrupt(phase, toolCallID string) error {
	if a.Session == nil {
		return nil
	}
	return a.Session.append(SessionRecord{Type: "interruption", Phase: phase, ToolCallID: toolCallID, Reason: "escape"})
}

func (a *Agent) resumeSession() error {
	if a.Session == nil {
		return nil
	}
	records, err := a.Session.records()
	if err != nil {
		return err
	}
	for _, record := range records[1:] {
		if record.Type == "message" {
			a.Messages = append(a.Messages, *record.Message)
			if record.Usage != nil {
				a.addUsage(*record.Usage, true)
			}
			continue
		}
		if record.Type != "compaction" {
			continue
		}
		recent := append([]Message{}, a.Messages[max(1, len(a.Messages)-record.KeptMessages):]...)
		a.Messages = append([]Message{a.Messages[0], {Role: "user", Content: text("[Compacted history]\n" + value(record.Summary))}}, recent...)
		if record.Usage != nil {
			a.addUsage(*record.Usage, false)
		}
	}
	return nil
}

func value(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
func (a *Agent) addUsage(u UsageJSON, cacheRate bool) {
	a.Usage.Input += u.Input
	a.Usage.Output += u.Output
	a.Usage.CacheRead += u.CacheRead
	a.Usage.CacheWrite += u.CacheWrite
	prompt := u.Input + u.CacheRead + u.CacheWrite
	if cacheRate && prompt > 0 {
		rate := float64(u.CacheRead) / float64(prompt) * 100
		a.Usage.CacheHitRate = &rate
	}
}

func (a *Agent) callModel(ctx context.Context, messages []Message, tools any, updateCacheRate bool) (ModelResponse, error) {
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
		b, _ := io.ReadAll(response.Body)
		return ModelResponse{}, fmt.Errorf("OpenRouter %d: %s", response.StatusCode, b)
	}
	var data struct {
		Choices []struct {
			Message Message `json:"message"`
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
	usage := UsageJSON{max(0, data.Usage.PromptTokens-cacheRead-cacheWrite), data.Usage.CompletionTokens, cacheRead, cacheWrite}
	a.addUsage(usage, updateCacheRate)
	return ModelResponse{data.Choices[0].Message, Usage{Input: usage.Input, Output: usage.Output, CacheRead: usage.CacheRead, CacheWrite: usage.CacheWrite}}, nil
}

func (a *Agent) modelRequest(messages []Message, tools any, phase string, updateCacheRate bool) (*ModelResponse, error) {
	ctx := a.begin()
	response, err := a.callModel(ctx, messages, tools, updateCacheRate)
	aborted := errors.Is(ctx.Err(), context.Canceled)
	a.end()
	if err == nil {
		return &response, nil
	}
	if !aborted {
		return nil, err
	}
	return nil, a.interrupt(phase, "")
}

func (a *Agent) runAgentLoop(input string) (string, error) {
	user := Message{Role: "user", Content: text(input)}
	a.Messages = append(a.Messages, user)
	if a.Session != nil {
		if err := a.Session.append(SessionRecord{Type: "message", Message: &user}); err != nil {
			return "", err
		}
	}
	for {
		response, err := a.modelRequest(a.Messages, a.toolDefinitions(), "model", true)
		if err != nil {
			return "", err
		}
		if response == nil {
			return "Operation aborted.", nil
		}
		answer := response.Message
		a.Messages = append(a.Messages, answer)
		if a.Session != nil {
			if err := a.Session.append(SessionRecord{Type: "message", Message: &answer, Usage: usageJSON(response.Usage)}); err != nil {
				return "", err
			}
		}
		if len(answer.ToolCalls) == 0 {
			return value(answer.Content), nil
		}
		for i, call := range answer.ToolCalls {
			args := map[string]any{}
			err := json.Unmarshal([]byte(call.Function.Arguments), &args)
			displayArgs := map[string]string{}
			for key, value := range args {
				if text, ok := value.(string); ok {
					displayArgs[key] = text
				}
			}
			a.OnTool(ToolEvent{Phase: "start", Name: call.Function.Name, Args: displayArgs})
			ctx := a.begin()
			result := ""
			if err == nil {
				toolFound := false
				for _, tool := range a.Tools {
					if tool.Name == call.Function.Name {
						toolFound = true
						result, err = tool.Execute(ctx, args)
						break
					}
				}
				if !toolFound {
					err = fmt.Errorf("unknown tool: %s", call.Function.Name)
				}
			}
			aborted := errors.Is(ctx.Err(), context.Canceled)
			a.end()
			if err != nil {
				if aborted {
					result = "Operation aborted"
				} else if result == "" {
					result = "Error: " + err.Error()
				} else {
					result += "\nError: " + err.Error()
				}
			}
			a.OnTool(ToolEvent{Phase: "end", Name: call.Function.Name, Args: displayArgs, Result: result})
			tool := Message{Role: "tool", Content: text(result), ToolCallID: call.ID}
			a.Messages = append(a.Messages, tool)
			if a.Session != nil {
				if err := a.Session.append(SessionRecord{Type: "message", Message: &tool, ToolName: call.Function.Name}); err != nil {
					return "", err
				}
			}
			if !aborted {
				continue
			}
			for _, pending := range answer.ToolCalls[i+1:] {
				skipped := Message{Role: "tool", Content: text("Operation aborted before execution"), ToolCallID: pending.ID}
				a.Messages = append(a.Messages, skipped)
				if a.Session != nil {
					if err := a.Session.append(SessionRecord{Type: "message", Message: &skipped, ToolName: pending.Function.Name}); err != nil {
						return "", err
					}
				}
			}
			if err := a.interrupt("tool", call.ID); err != nil {
				return "", err
			}
			return "Operation aborted.", nil
		}
	}
}

func (a *Agent) compact() (string, error) {
	if len(a.Messages) <= 1 {
		return "Nothing to compact.", nil
	}
	cut := max(len(a.Messages)-6, 1)
	for cut > 1 && a.Messages[cut].Role != "user" {
		cut--
	}
	recent, old := append([]Message{}, a.Messages[cut:]...), a.Messages[1:cut]
	if len(old) == 0 {
		return "Nothing to compact.", nil
	}
	encoded, _ := json.Marshal(old)
	prompt := []Message{{Role: "system", Content: text("Summarize this coding session compactly. Preserve decisions, changed files, errors, and next steps.")}, {Role: "user", Content: text(string(encoded))}}
	response, err := a.modelRequest(prompt, nil, "compact", false)
	if err != nil {
		return "", err
	}
	if response == nil {
		return "Compaction aborted.", nil
	}
	summary := value(response.Message.Content)
	a.Messages = append([]Message{a.Messages[0], {Role: "user", Content: text("[Compacted history]\n" + summary)}}, recent...)
	if a.Session != nil {
		record := SessionRecord{Type: "compaction", Summary: &summary, CompactedMessages: len(old), KeptMessages: len(recent), Usage: usageJSON(response.Usage)}
		if err := a.Session.append(record); err != nil {
			return "", err
		}
	}
	return fmt.Sprintf("Compacted %d messages (kept last %d).", len(old), len(recent)), nil
}

var errExit = errors.New("exit")

type keyEvent struct {
	key byte
	err error
}

type crlfWriter struct{ io.Writer }

func (w crlfWriter) Write(p []byte) (int, error) {
	out := make([]byte, 0, len(p)+bytes.Count(p, []byte("\n")))
	for i, b := range p {
		if b == '\n' && (i == 0 || p[i-1] != '\r') {
			out = append(out, '\r')
		}
		out = append(out, b)
	}
	_, err := w.Writer.Write(out)
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

type terminal struct {
	reader *bufio.Reader
	keys   chan keyEvent
	out    io.Writer
	fd     int
	old    *term.State
}

func newTerminal(in *os.File, out io.Writer) (*terminal, error) {
	t := &terminal{reader: bufio.NewReader(in), out: out, fd: int(in.Fd())}
	if !term.IsTerminal(t.fd) {
		return t, nil
	}
	old, err := term.MakeRaw(t.fd)
	if err != nil {
		return nil, err
	}
	t.old, t.keys, t.out = old, make(chan keyEvent), crlfWriter{out}
	go func() {
		b := make([]byte, 1)
		for {
			_, err := in.Read(b)
			t.keys <- keyEvent{b[0], err}
			if err != nil {
				return
			}
		}
	}()
	return t, nil
}

func (t *terminal) close() error {
	if t.old == nil {
		return nil
	}
	return term.Restore(t.fd, t.old)
}

func (t *terminal) escapeSequence() (byte, bool, error) {
	timer := time.NewTimer(20 * time.Millisecond)
	defer timer.Stop()
	select {
	case event := <-t.keys:
		if event.err != nil {
			return 0, false, event.err
		}
		if event.key != '[' && event.key != 'O' {
			return 0, false, nil
		}
		for {
			event = <-t.keys
			if event.err != nil {
				return 0, false, event.err
			}
			if event.key >= 64 && event.key <= 126 {
				return event.key, false, nil
			}
		}
	case <-timer.C:
		return 0, true, nil
	}
}

func runeWidth(r rune) int {
	if unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Me, r) || unicode.Is(unicode.Cf, r) {
		return 0
	}
	if r >= 0x1100 && (r <= 0x115f || r == 0x2329 || r == 0x232a || r >= 0x2e80 && r <= 0xa4cf || r >= 0xac00 && r <= 0xd7a3 || r >= 0xf900 && r <= 0xfaff || r >= 0xfe10 && r <= 0xfe6f || r >= 0xff00 && r <= 0xff60 || r >= 0xffe0 && r <= 0xffe6 || r >= 0x1f300 && r <= 0x1faff || r >= 0x20000 && r <= 0x3fffd) {
		return 2
	}
	return 1
}

func visibleRunes(text []rune) []rune {
	visible := []rune{}
	for i := 0; i < len(text); i++ {
		if text[i] != 27 || i+1 >= len(text) || text[i+1] != '[' {
			visible = append(visible, text[i])
			continue
		}
		i += 2
		for i < len(text) && (text[i] < 64 || text[i] > 126) {
			i++
		}
	}
	return visible
}

func displayPosition(text []rune, columns int) (int, int) {
	offset := 0
	for _, r := range visibleRunes(text) {
		width := runeWidth(r)
		if width == 2 && offset%columns == columns-1 {
			offset++
		}
		offset += width
	}
	return offset / columns, offset % columns
}

func (t *terminal) redraw(prompt string, line []rune, cursor, oldRow int) int {
	width := 80
	if columns, _, err := term.GetSize(t.fd); err == nil && columns > 0 {
		width = columns
	}
	if oldRow > 0 {
		fmt.Fprintf(t.out, "\x1b[%dA", oldRow)
	}
	fmt.Fprintf(t.out, "\r\x1b[J%s%s", prompt, string(line))
	promptRunes := []rune(prompt)
	endRow, endColumn := displayPosition(append(append([]rune{}, promptRunes...), line...), width)
	targetRow, targetColumn := displayPosition(append(append([]rune{}, promptRunes...), line[:cursor]...), width)
	if endColumn == 0 {
		fmt.Fprint(t.out, " ")
	}
	if endRow > targetRow {
		fmt.Fprintf(t.out, "\x1b[%dA", endRow-targetRow)
	}
	fmt.Fprint(t.out, "\r")
	if targetColumn > 0 {
		fmt.Fprintf(t.out, "\x1b[%dC", targetColumn)
	}
	return targetRow
}

func (t *terminal) readLine(prompt string) (string, error) {
	fmt.Fprint(t.out, prompt)
	if t.old == nil {
		line, err := t.reader.ReadString('\n')
		return strings.TrimSpace(line), err
	}
	line, cursor, row, pending := []rune{}, 0, 0, []byte{}
	for {
		event := <-t.keys
		if event.err != nil {
			return "", event.err
		}
		if event.key == 3 {
			return "", errExit
		}
		if event.key == 27 {
			key, _, err := t.escapeSequence()
			if err != nil {
				return "", err
			}
			if key == 'D' && cursor > 0 {
				cursor--
				for cursor > 0 && runeWidth(line[cursor]) == 0 {
					cursor--
				}
				row = t.redraw(prompt, line, cursor, row)
			}
			if key == 'C' && cursor < len(line) {
				cursor++
				for cursor < len(line) && runeWidth(line[cursor]) == 0 {
					cursor++
				}
				row = t.redraw(prompt, line, cursor, row)
			}
			continue
		}
		if event.key == '\r' || event.key == '\n' {
			fmt.Fprint(t.out, "\r\n")
			return strings.TrimSpace(string(line)), nil
		}
		if event.key == 8 || event.key == 127 {
			if cursor == 0 {
				continue
			}
			start := cursor - 1
			for start > 0 && runeWidth(line[start]) == 0 {
				start--
			}
			line = append(line[:start], line[cursor:]...)
			cursor = start
			row = t.redraw(prompt, line, cursor, row)
			continue
		}
		if event.key < 32 || event.key == 127 {
			continue
		}
		pending = append(pending, event.key)
		if !utf8.FullRune(pending) {
			continue
		}
		r, _ := utf8.DecodeRune(pending)
		line = append(line, 0)
		copy(line[cursor+1:], line[cursor:])
		line[cursor], cursor = r, cursor+1
		pending = pending[:0]
		row = t.redraw(prompt, line, cursor, row)
	}
}

func (t *terminal) run(agent *Agent, operation func() (string, error)) (string, error) {
	if t.old == nil {
		return operation()
	}
	done := make(chan struct {
		answer string
		err    error
	}, 1)
	go func() {
		answer, err := operation()
		done <- struct {
			answer string
			err    error
		}{answer, err}
	}()
	for {
		select {
		case result := <-done:
			return result.answer, result.err
		case event := <-t.keys:
			if event.err != nil {
				agent.abort()
				<-done
				return "", event.err
			}
			if event.key == 27 {
				_, standalone, err := t.escapeSequence()
				if err != nil {
					agent.abort()
					<-done
					return "", err
				}
				if standalone {
					fmt.Fprint(t.out, "\r\n\x1b[33mAborting...\x1b[0m\r\n")
					agent.abort()
				}
			}
			if event.key == 3 {
				agent.abort()
				<-done
				return "", errExit
			}
		}
	}
}

func parseArgs(args []string) (sessionID string, extras, mcp []string, prompt string, err error) {
	words := []string{}
	for i := 0; i < len(args); i++ {
		if args[i] != "--session" && args[i] != "--skill" && args[i] != "--mcp" {
			words = append(words, args[i])
			continue
		}
		if i+1 == len(args) {
			return "", nil, nil, "", fmt.Errorf("%s requires a value", args[i])
		}
		if args[i] == "--session" {
			sessionID = args[i+1]
		} else if args[i] == "--skill" {
			extras = append(extras, args[i+1])
		} else {
			mcp = append(mcp, args[i+1])
		}
		i++
	}
	return sessionID, extras, splitList(mcp), strings.Join(words, " "), nil
}

func runCLI(args []string) error {
	sessionID, extras, mcpAliases, oneShot, err := parseArgs(args)
	if err != nil {
		return err
	}
	home, _ := os.UserHomeDir()
	configs, err := loadMCPConfigs(mcpAliases, currentEnvironment(), home)
	if err != nil {
		return err
	}
	skills, err := loadSkills(extras)
	if err != nil {
		return err
	}
	var session *Session
	if sessionID == "" {
		session, err = createSession(time.Now())
	} else {
		session, err = openSession(sessionID)
	}
	if err != nil {
		return err
	}
	agent := newAgent(skills, session, loadProjectInstructions())
	loadedMCP := []*MCPClient{}
	defer func() {
		for i := len(loadedMCP) - 1; i >= 0; i-- {
			_ = loadedMCP[i].Close()
		}
	}()
	for _, config := range configs {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		loaded, loadErr := loadMCPTools(ctx, config, http.DefaultClient)
		cancel()
		if loadErr != nil {
			return fmt.Errorf("MCP %s failed: %w", config.Alias, loadErr)
		}
		loadedMCP = append(loadedMCP, loaded)
		agent.Tools = append(agent.Tools, loaded.tools...)
		fmt.Printf("MCP %s: connected (%s, %d tools)\n", config.Alias, loaded.protocolVersion, len(loaded.tools))
	}
	out := io.Writer(os.Stdout)
	agent.OnTool = func(event ToolEvent) {
		color := "\x1b[2m"
		if event.Phase == "start" {
			color = "\x1b[33m"
		}
		fmt.Fprintln(out, color+formatToolEvent(ToolEvent{Phase: event.Phase, Name: displayToolName(event.Name), Args: event.Args, Result: event.Result})+"\x1b[0m")
	}
	if sessionID != "" {
		if err := agent.resumeSession(); err != nil {
			return err
		}
	}
	resume := func() { fmt.Fprintf(out, "\nResume: tiny-go --session %s\n", session.ID) }
	fmt.Printf("\x1b[36mtiny-agent\x1b[0m\nprovider: openrouter\nmodel: %s\nsession: %s\npath: %s\ntools: %s\nmcp: %s", model(), session.ID, session.Path, displayToolList(agent.Tools), emptyList(mcpAliases))
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
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
