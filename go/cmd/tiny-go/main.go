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
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
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
	toolDefinition("bash", "Run a shell command in the working directory", map[string]any{"command": map[string]string{"type": "string"}}),
	toolDefinition("read", "Read a UTF-8 text file", map[string]any{"path": map[string]string{"type": "string"}}),
	toolDefinition("write", "Create or overwrite a UTF-8 text file", map[string]any{"path": map[string]string{"type": "string"}, "content": map[string]string{"type": "string"}}),
	toolDefinition("edit", "Replace one unique exact string in a UTF-8 text file", map[string]any{"path": map[string]string{"type": "string"}, "oldText": map[string]string{"type": "string"}, "newText": map[string]string{"type": "string"}}),
}

func toolDefinition(name, description string, properties map[string]any) map[string]any {
	required := slices.Sorted(maps.Keys(properties))
	return map[string]any{"type": "function", "function": map[string]any{"name": name, "description": description, "parameters": map[string]any{"type": "object", "properties": properties, "required": required}}}
}

func resolveToolPath(path string) (string, error) {
	full := filepath.Clean(path)
	if !filepath.IsAbs(full) {
		full = filepath.Join(cwd, full)
	}
	return filepath.Abs(full)
}

func executeTool(ctx context.Context, name string, args map[string]string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if name == "bash" {
		return executeBash(ctx, args["command"])
	}
	path, err := resolveToolPath(args["path"])
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
	prompt := fmt.Sprintf("You are tiny-agent, a concise coding agent in %s. Use only the tools provided in this request. If the available tools cannot complete the task, explain the missing capability instead of calling an unavailable tool. Follow the project instructions below. When a task matches an available skill, use its location only when a provided tool can read it.%s\n\n<available_skills>\n%s\n</available_skills>", cwd, project, list)
	return &Agent{Messages: []Message{{Role: "system", Content: text(prompt)}}, Skills: skills, Session: session, Client: http.DefaultClient, Endpoint: openRouterURL, OnTool: func(ToolEvent) {}, Tools: localTools()}
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
	a.addUsage(usage)
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

func parseArgs(args []string) (sessionID string, extras, plugins, mcp []string, prompt string, err error) {
	words := []string{}
	for i := 0; i < len(args); i++ {
		if args[i] != "--session" && args[i] != "--skill" && args[i] != "--plugin" && args[i] != "--mcp" {
			words = append(words, args[i])
			continue
		}
		if i+1 == len(args) {
			return "", nil, nil, nil, "", fmt.Errorf("%s requires a value", args[i])
		}
		if args[i] == "--session" {
			sessionID = args[i+1]
		} else if args[i] == "--skill" {
			extras = append(extras, args[i+1])
		} else if args[i] == "--plugin" {
			plugins = append(plugins, args[i+1])
		} else {
			mcp = append(mcp, args[i+1])
		}
		i++
	}
	return sessionID, extras, splitList(plugins), splitList(mcp), strings.Join(words, " "), nil
}

func runCLI(args []string) error {
	sessionID, extras, plugins, mcpAliases, oneShot, err := parseArgs(args)
	if err != nil {
		return err
	}
	selectedPlugins := plugins
	if len(selectedPlugins) == 0 {
		selectedPlugins = []string{"bash", "read", "write", "edit"}
	}
	for _, plugin := range selectedPlugins {
		if !slices.Contains([]string{"bash", "read", "write", "edit"}, plugin) {
			return fmt.Errorf("Unknown plugin: %s. Available plugins: bash, read, write, edit", plugin)
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
	agent := newAgent(skills, session, loadProjectInstructions())
	agent.Tools = localTools(selectedPlugins...)
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
		if err := agent.restoreSession(); err != nil {
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
