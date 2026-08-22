package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	maxMCPTools       = 64
	maxMCPSchemaBytes = 50 * 1024
	maxMCPDescription = 8 * 1024
	maxMCPSchemaDepth = 20
	maxMCPResultBytes = 50 * 1024
)

type Tool struct {
	Name        string
	Description string
	Parameters  map[string]any
	Execute     func(context.Context, map[string]any) (string, error)
}

type MCPConfig struct {
	Alias        string
	URL          string
	Token        string
	AllowedTools []string
	CallTimeout  time.Duration
}

type MCPClient struct {
	config          MCPConfig
	httpClient      *http.Client
	sessionID       string
	protocolVersion string
	tools           []Tool
	mu              sync.Mutex
	nextID          int
	closed          bool
}

func splitList(values []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, value := range values {
		for _, item := range strings.Split(value, ",") {
			item = strings.TrimSpace(item)
			if item == "" || seen[item] {
				continue
			}
			seen[item] = true
			result = append(result, item)
		}
	}
	return result
}

func loadMCPConfigs(aliases []string, env map[string]string, home string) ([]MCPConfig, error) {
	if len(aliases) == 0 {
		return nil, nil
	}
	path := filepath.Join(home, ".tiny-agent", "mcp.json")
	if override, ok := env["TINY_MCP_CONFIG"]; ok && override != "" {
		if filepath.IsAbs(override) {
			path = override
		} else {
			path, _ = filepath.Abs(override)
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("Failed to load MCP catalog: file is missing, unreadable, or invalid JSON")
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(data, &root); err != nil || root == nil {
		return nil, errors.New("Failed to load MCP catalog: file is missing, unreadable, or invalid JSON")
	}
	if field := unknownField(root, "servers"); field != "" {
		return nil, fmt.Errorf("Unknown MCP catalog field: %s", field)
	}
	var servers map[string]json.RawMessage
	if raw, ok := root["servers"]; !ok || json.Unmarshal(raw, &servers) != nil || servers == nil {
		return nil, errors.New("MCP catalog servers must be an object")
	}
	configs := make(map[string]MCPConfig, len(servers))
	for alias, raw := range servers {
		if strings.TrimSpace(alias) == "" {
			return nil, errors.New("MCP server alias must not be empty")
		}
		var entry map[string]json.RawMessage
		if json.Unmarshal(raw, &entry) != nil || entry == nil {
			return nil, fmt.Errorf("MCP server %s must be an object", alias)
		}
		if field := unknownField(entry, "url", "tokenEnv", "allowedTools", "callTimeoutMs"); field != "" {
			return nil, fmt.Errorf("Unknown MCP server %s field: %s", alias, field)
		}
		var address string
		if rawURL, ok := entry["url"]; !ok || json.Unmarshal(rawURL, &address) != nil || address == "" {
			return nil, fmt.Errorf("MCP server %s url must be a string", alias)
		}
		config := MCPConfig{Alias: alias, URL: address, CallTimeout: 30 * time.Second}
		if rawToken, ok := entry["tokenEnv"]; ok {
			var name string
			if json.Unmarshal(rawToken, &name) != nil || !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`).MatchString(name) {
				return nil, fmt.Errorf("MCP server %s tokenEnv must be an environment variable name", alias)
			}
			token, exists := env[name]
			if !exists || token == "" {
				return nil, fmt.Errorf("MCP token environment variable is not set: %s", name)
			}
			config.Token = token
		}
		if rawAllowed, ok := entry["allowedTools"]; ok {
			if bytes.Equal(bytes.TrimSpace(rawAllowed), []byte("null")) || json.Unmarshal(rawAllowed, &config.AllowedTools) != nil {
				return nil, fmt.Errorf("MCP server %s allowedTools must contain nonempty strings", alias)
			}
			seen := map[string]bool{}
			for _, name := range config.AllowedTools {
				if name == "" {
					return nil, fmt.Errorf("MCP server %s allowedTools must contain nonempty strings", alias)
				}
				if seen[name] {
					return nil, fmt.Errorf("MCP server %s allowedTools must not contain duplicates", alias)
				}
				seen[name] = true
			}
		}
		if rawTimeout, ok := entry["callTimeoutMs"]; ok {
			var milliseconds float64
			if json.Unmarshal(rawTimeout, &milliseconds) != nil || milliseconds <= 0 || milliseconds > float64((1<<63-1)/int64(time.Millisecond)) {
				return nil, fmt.Errorf("MCP server %s callTimeoutMs must be a positive number", alias)
			}
			config.CallTimeout = time.Duration(milliseconds * float64(time.Millisecond))
		}
		configs[alias] = config
	}
	result := make([]MCPConfig, 0, len(aliases))
	for _, alias := range aliases {
		config, ok := configs[alias]
		if !ok {
			return nil, fmt.Errorf("Unknown MCP server: %s", alias)
		}
		result = append(result, config)
	}
	return result, nil
}

func unknownField(value map[string]json.RawMessage, allowed ...string) string {
	for field := range value {
		found := false
		for _, candidate := range allowed {
			found = found || field == candidate
		}
		if !found {
			return field
		}
	}
	return ""
}

func currentEnvironment() map[string]string {
	env := map[string]string{}
	for _, item := range os.Environ() {
		name, value, ok := strings.Cut(item, "=")
		if ok {
			env[name] = value
		}
	}
	return env
}

func loadMCPTools(ctx context.Context, config MCPConfig, client *http.Client) (*MCPClient, error) {
	if strings.TrimSpace(config.Alias) == "" {
		return nil, errors.New("MCP alias must be a nonempty string")
	}
	parsed, err := url.Parse(config.URL)
	if err != nil || parsed.Host == "" {
		return nil, errors.New("MCP URL must be a valid URL")
	}
	loopback := parsed.Hostname() == "localhost" || net.ParseIP(parsed.Hostname()) != nil && net.ParseIP(parsed.Hostname()).IsLoopback()
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && loopback) {
		return nil, errors.New("MCP URL must use HTTPS unless it targets loopback")
	}
	if parsed.User != nil {
		return nil, errors.New("MCP URL must not contain credentials")
	}
	if config.CallTimeout <= 0 {
		config.CallTimeout = 30 * time.Second
	}
	mcp := &MCPClient{config: config, httpClient: client}
	started := false
	defer func() {
		if !started {
			_ = mcp.Close()
		}
	}()
	if mcp.httpClient == nil {
		mcp.httpClient = http.DefaultClient
	}
	var initialized struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	if err := mcp.request(ctx, "initialize", map[string]any{"protocolVersion": "2025-03-26", "capabilities": map[string]any{}, "clientInfo": map[string]string{"name": "tiny-agent", "version": "0.1.0"}}, &initialized); err != nil {
		return nil, err
	}
	if initialized.ProtocolVersion == "" {
		return nil, errors.New("MCP server did not negotiate a protocol version")
	}
	mcp.protocolVersion = initialized.ProtocolVersion
	if err := mcp.notify(ctx, "notifications/initialized", map[string]any{}); err != nil {
		return nil, err
	}
	var listed struct {
		Tools []struct {
			Name        string          `json:"name"`
			Description string          `json:"description"`
			InputSchema json.RawMessage `json:"inputSchema"`
		} `json:"tools"`
	}
	if err := mcp.request(ctx, "tools/list", map[string]any{}, &listed); err != nil {
		return nil, err
	}
	if len(listed.Tools) > maxMCPTools {
		return nil, fmt.Errorf("MCP server returned more than %d tools", maxMCPTools)
	}
	remoteNames, allowed := map[string]bool{}, map[string]bool{}
	for _, name := range config.AllowedTools {
		allowed[name] = true
	}
	mapped := map[string]bool{}
	for _, remote := range listed.Tools {
		if remote.Name == "" {
			return nil, errors.New("MCP tool name must not be empty")
		}
		if remoteNames[remote.Name] {
			return nil, fmt.Errorf("duplicate MCP tool name: %s", remote.Name)
		}
		remoteNames[remote.Name] = true
		if config.AllowedTools != nil && !allowed[remote.Name] {
			continue
		}
		var inputSchema map[string]any
		if len(remote.InputSchema) == 0 || bytes.Equal(bytes.TrimSpace(remote.InputSchema), []byte("null")) || json.Unmarshal(remote.InputSchema, &inputSchema) != nil || inputSchema == nil {
			return nil, fmt.Errorf("MCP tool inputSchema must be an object: %s", remote.Name)
		}
		if len(remote.InputSchema) > maxMCPSchemaBytes {
			return nil, fmt.Errorf("MCP tool schema exceeds 50KB: %s", remote.Name)
		}
		if jsonDepth(inputSchema) > maxMCPSchemaDepth {
			return nil, fmt.Errorf("MCP tool schema exceeds depth %d: %s", maxMCPSchemaDepth, remote.Name)
		}
		if len([]byte(remote.Description)) > maxMCPDescription {
			return nil, fmt.Errorf("MCP tool description exceeds 8KB: %s", remote.Name)
		}
		mappedName, err := mapMCPToolName(config.Alias, remote.Name)
		if err != nil {
			return nil, err
		}
		if mapped[mappedName] {
			return nil, fmt.Errorf("duplicate mapped MCP tool name: %s", mappedName)
		}
		mapped[mappedName] = true
		description := remote.Description
		if description == "" {
			description = fmt.Sprintf("MCP tool %s from %s.", remote.Name, config.Alias)
		}
		remoteName := remote.Name
		mcp.tools = append(mcp.tools, Tool{Name: mappedName, Description: description, Parameters: inputSchema, Execute: func(callCtx context.Context, args map[string]any) (string, error) {
			return mcp.callTool(callCtx, remoteName, args)
		}})
	}
	missing := []string{}
	for _, name := range config.AllowedTools {
		if !remoteNames[name] {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("MCP allowed tools were not found: %s", strings.Join(missing, ", "))
	}
	started = true
	return mcp, nil
}

func (m *MCPClient) request(ctx context.Context, method string, params any, target any) error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return errors.New("MCP connection is closed")
	}
	m.nextID++
	id := m.nextID
	m.mu.Unlock()
	var response struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      int             `json:"id"`
		Result  json.RawMessage `json:"result"`
		Error   *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := m.send(ctx, map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}, &response); err != nil {
		return err
	}
	if response.JSONRPC != "2.0" || response.ID != id {
		return fmt.Errorf("MCP %s returned a mismatched JSON-RPC response", method)
	}
	if response.Error != nil {
		return fmt.Errorf("MCP %s error %d: %s", method, response.Error.Code, response.Error.Message)
	}
	return json.Unmarshal(response.Result, target)
}

func (m *MCPClient) notify(ctx context.Context, method string, params any) error {
	return m.send(ctx, map[string]any{"jsonrpc": "2.0", "method": method, "params": params}, nil)
}

func (m *MCPClient) send(ctx context.Context, body any, target any) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.config.URL, bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if m.config.Token != "" {
		req.Header.Set("Authorization", "Bearer "+m.config.Token)
	}
	m.mu.Lock()
	sessionID := m.sessionID
	m.mu.Unlock()
	if sessionID != "" {
		req.Header.Set("Mcp-Session-Id", sessionID)
	}
	response, err := m.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("MCP HTTP %d: %s", response.StatusCode, data)
	}
	if id := response.Header.Get("Mcp-Session-Id"); id != "" {
		m.mu.Lock()
		m.sessionID = id
		m.mu.Unlock()
	}
	if target == nil || response.StatusCode == http.StatusAccepted {
		return nil
	}
	if strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		scanner := bufio.NewScanner(response.Body)
		scanner.Buffer(make([]byte, 64*1024), maxMCPTools*maxMCPSchemaBytes+1024*1024)
		data := []string{}
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				if len(data) == 0 {
					continue
				}
				encodedEvent := []byte(strings.Join(data, "\n"))
				data = data[:0]
				var envelope struct {
					ID *int `json:"id"`
				}
				if json.Unmarshal(encodedEvent, &envelope) != nil || envelope.ID == nil {
					continue
				}
				return json.Unmarshal(encodedEvent, target)
			}
			if strings.HasPrefix(line, "data:") {
				data = append(data, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
			}
		}
		if err := scanner.Err(); err != nil {
			return err
		}
		if len(data) > 0 {
			return json.Unmarshal([]byte(strings.Join(data, "\n")), target)
		}
		return errors.New("MCP SSE response contained no data event")
	}
	return json.NewDecoder(response.Body).Decode(target)
}

func (m *MCPClient) callTool(ctx context.Context, name string, args map[string]any) (string, error) {
	if args == nil {
		return "", errors.New("MCP tool arguments must be a JSON object")
	}
	ctx, cancel := context.WithTimeout(ctx, m.config.CallTimeout)
	defer cancel()
	var result struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		StructuredContent json.RawMessage `json:"structuredContent"`
		IsError           bool            `json:"isError"`
		ResultType        string          `json:"resultType"`
	}
	if err := m.request(ctx, "tools/call", map[string]any{"name": name, "arguments": args}, &result); err != nil {
		return "", err
	}
	if result.ResultType == "input_required" {
		return "", errors.New("MCP tool requires additional user input; input_required is not supported")
	}
	parts := []string{}
	for _, item := range result.Content {
		if item.Type != "text" {
			return "", fmt.Errorf("Unsupported MCP content type: %s", item.Type)
		}
		parts = append(parts, item.Text)
	}
	if result.StructuredContent != nil {
		parts = append(parts, "Structured content:\n"+string(result.StructuredContent))
	}
	output := strings.Join(parts, "\n\n")
	if output == "" {
		output = "(no output)"
	}
	output = truncateMCPResult(output)
	if result.IsError {
		return "", errors.New("MCP tool error: " + output)
	}
	return output, nil
}

func (m *MCPClient) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	sessionID := m.sessionID
	m.mu.Unlock()
	if sessionID == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, m.config.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Mcp-Session-Id", sessionID)
	if m.config.Token != "" {
		req.Header.Set("Authorization", "Bearer "+m.config.Token)
	}
	response, err := m.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("MCP close HTTP %d", response.StatusCode)
	}
	return nil
}

func mapMCPToolName(alias, remote string) (string, error) {
	encode := func(value string) string { return base64.RawURLEncoding.EncodeToString([]byte(value)) }
	name := "mcp__" + encode(alias) + "__" + encode(remote)
	if len(name) > 64 {
		return "", fmt.Errorf("mapped MCP tool name exceeds 64 characters: %s", remote)
	}
	return name, nil
}

func displayToolName(name string) string {
	parts := strings.Split(name, "__")
	if len(parts) != 3 || parts[0] != "mcp" {
		return name
	}
	alias, errAlias := base64.RawURLEncoding.DecodeString(parts[1])
	remote, errRemote := base64.RawURLEncoding.DecodeString(parts[2])
	if errAlias != nil || errRemote != nil {
		return name
	}
	return "mcp:" + string(alias) + "/" + string(remote)
}

func jsonDepth(value any) int {
	depth := 0
	switch item := value.(type) {
	case map[string]any:
		for _, child := range item {
			depth = max(depth, jsonDepth(child))
		}
	case []any:
		for _, child := range item {
			depth = max(depth, jsonDepth(child))
		}
	default:
		return 0
	}
	return depth + 1
}

func truncateMCPResult(value string) string {
	data := []byte(value)
	if len(data) <= maxMCPResultBytes {
		return value
	}
	suffix := []byte("\n\n[MCP result truncated to 50KB]")
	data = data[:maxMCPResultBytes-len(suffix)]
	for !utf8.Valid(data) {
		data = data[:len(data)-1]
	}
	return string(data) + string(suffix)
}
