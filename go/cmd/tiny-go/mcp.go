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
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	modernMCPVersion  = "2026-07-28"
	maxMCPTools       = 64
	maxMCPHTTPBytes   = 10 * 1024 * 1024
	maxMCPSchemaBytes = 50 * 1024
	maxMCPDescription = 8 * 1024
	maxMCPSchemaDepth = 20
	maxMCPResultBytes = 50 * 1024
)

type Tool struct {
	Name        string
	Description string
	Parameters  map[string]any
	Replay      string
	ReplayKey   string
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
	protocolVersion string
	tools           []Tool
	mu              sync.Mutex
	nextID          int
	closed          bool
}

type mcpHTTPError struct {
	status int
	body   []byte
}

func (e *mcpHTTPError) Error() string {
	class := "request failed"
	if e.status >= 500 {
		class = "server error"
	} else if e.status == http.StatusUnauthorized || e.status == http.StatusForbidden {
		class = "authentication failed"
	} else if e.status >= 400 {
		class = "client error"
	}
	return fmt.Sprintf("MCP HTTP %d (%s)", e.status, class)
}

type mcpRPCError struct {
	code int
	data json.RawMessage
}

func (e *mcpRPCError) Error() string { return fmt.Sprintf("MCP JSON-RPC error %d", e.code) }

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

func loadMCPConfigs(aliases []string, env map[string]string) ([]MCPConfig, error) {
	if len(aliases) == 0 {
		return nil, nil
	}
	override, ok := env["TINY_MCP_CONFIG"]
	if !ok || override == "" {
		return nil, errors.New("TINY_MCP_CONFIG must be set to use --mcp")
	}
	path, err := filepath.Abs(override)
	if err != nil {
		return nil, errors.New("Failed to load MCP catalog: file is missing, unreadable, or invalid JSON")
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
	endpoint, err := canonicalMCPEndpoint(parsed)
	if err != nil {
		return nil, err
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
	if err := mcp.negotiate(ctx); err != nil {
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
		if err := validateMCPToolSchema(inputSchema, remote.Name); err != nil {
			return nil, err
		}
		if len(remote.InputSchema) > maxMCPSchemaBytes {
			return nil, fmt.Errorf("MCP tool schema exceeds 50KB: %s", remote.Name)
		}
		if jsonDepth(inputSchema) > maxMCPSchemaDepth {
			return nil, fmt.Errorf("MCP tool schema exceeds depth %d: %s", maxMCPSchemaDepth, remote.Name)
		}
		if containsXMCPHeader(inputSchema) {
			return nil, fmt.Errorf("MCP tool x-mcp-header declarations are not supported: %s", remote.Name)
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
		replayKey := "mcp:" + config.Alias + ":" + endpoint + ":" + remoteName + ":v1"
		mcp.tools = append(mcp.tools, Tool{Name: mappedName, Description: description, Parameters: inputSchema, Replay: "never", ReplayKey: replayKey, Execute: func(callCtx context.Context, args map[string]any) (string, error) {
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

func (m *MCPClient) negotiate(ctx context.Context) error {
	var discovered struct {
		SupportedVersions []string       `json:"supportedVersions"`
		Capabilities      map[string]any `json:"capabilities"`
	}
	err := m.request(ctx, "server/discover", map[string]any{}, &discovered)
	if rpc, ok := err.(*mcpRPCError); ok && rpc.code == -32022 {
		var continuation struct {
			Supported []string `json:"supported"`
		}
		if json.Unmarshal(rpc.data, &continuation) == nil && slices.Contains(continuation.Supported, modernMCPVersion) {
			err = m.request(ctx, "server/discover", map[string]any{}, &discovered)
		}
	}
	if err != nil {
		return fmt.Errorf("MCP server does not support the modern protocol: %w", err)
	}
	supported := false
	for _, version := range discovered.SupportedVersions {
		supported = supported || version == modernMCPVersion
	}
	if !supported || discovered.Capabilities == nil {
		return errors.New("MCP server does not support the modern protocol version")
	}
	m.protocolVersion = modernMCPVersion
	return nil
}

func modernMetadata() map[string]any {
	return map[string]any{
		"io.modelcontextprotocol/protocolVersion":    modernMCPVersion,
		"io.modelcontextprotocol/clientInfo":         map[string]string{"name": "tiny-agent", "version": "0.1.0"},
		"io.modelcontextprotocol/clientCapabilities": map[string]any{},
	}
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
	object, ok := params.(map[string]any)
	if !ok {
		return errors.New("MCP modern request params must be an object")
	}
	requestParams := make(map[string]any, len(object)+1)
	for key, value := range object {
		requestParams[key] = value
	}
	requestParams["_meta"] = modernMetadata()
	var response struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      int             `json:"id"`
		Result  json.RawMessage `json:"result"`
		Error   *struct {
			Code    int             `json:"code"`
			Message string          `json:"message"`
			Data    json.RawMessage `json:"data"`
		} `json:"error"`
	}
	if err := m.send(ctx, map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": requestParams}, &response, method); err != nil {
		return err
	}
	if response.JSONRPC != "2.0" || response.ID != id {
		return fmt.Errorf("MCP %s returned a mismatched JSON-RPC response", method)
	}
	if response.Error != nil {
		return &mcpRPCError{code: response.Error.Code, data: response.Error.Data}
	}
	return json.Unmarshal(response.Result, target)
}

func (m *MCPClient) send(ctx context.Context, body any, target any, method string) error {
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
	req.Header.Set("Mcp-Protocol-Version", modernMCPVersion)
	req.Header.Set("Mcp-Method", method)
	if method == "tools/call" {
		if envelope, ok := body.(map[string]any); ok {
			if params, ok := envelope["params"].(map[string]any); ok {
				if name, ok := params["name"].(string); ok {
					req.Header.Set("Mcp-Name", encodeMCPHeaderValue(name))
				}
			}
		}
	}
	if m.config.Token != "" {
		req.Header.Set("Authorization", "Bearer "+m.config.Token)
	}
	response, err := m.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	limited := &io.LimitedReader{R: response.Body, N: maxMCPHTTPBytes + 1}
	data, readErr := io.ReadAll(limited)
	if readErr != nil {
		return readErr
	}
	if int64(len(data)) > maxMCPHTTPBytes {
		return errors.New("MCP response exceeds 10MB")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &mcpHTTPError{status: response.StatusCode, body: data}
	}
	if target == nil || response.StatusCode == http.StatusAccepted {
		return nil
	}
	if strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		scanner := bufio.NewScanner(bytes.NewReader(data))
		scanner.Buffer(make([]byte, 64*1024), maxMCPHTTPBytes)
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
	return json.Unmarshal(data, target)
}

func (m *MCPClient) callTool(ctx context.Context, name string, args map[string]any) (string, error) {
	if args == nil {
		return "", errors.New("MCP tool arguments must be a JSON object")
	}
	ctx, cancel := context.WithTimeout(ctx, m.config.CallTimeout)
	defer cancel()
	var result struct {
		Content []struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Resource *struct {
				URI      string  `json:"uri"`
				MimeType string  `json:"mimeType"`
				Text     *string `json:"text"`
				Blob     *string `json:"blob"`
			} `json:"resource"`
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
		if item.Type == "text" {
			parts = append(parts, item.Text)
			continue
		}
		if item.Type == "resource" && item.Resource != nil && item.Resource.Text != nil && item.Resource.Blob == nil {
			prefix := ""
			if item.Resource.URI != "" {
				prefix = "Resource: " + item.Resource.URI + "\n"
			}
			parts = append(parts, prefix+*item.Resource.Text)
			continue
		}
		return "", fmt.Errorf("Unsupported MCP content type: %s", item.Type)
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
	m.closed = true
	m.mu.Unlock()
	return nil
}

func canonicalMCPEndpoint(parsed *url.URL) (string, error) {
	if parsed.Fragment != "" {
		return "", errors.New("MCP URL must not contain a fragment")
	}
	canonical := *parsed
	canonical.Scheme = strings.ToLower(canonical.Scheme)
	hostname := strings.ToLower(canonical.Hostname())
	port := canonical.Port()
	if canonical.Scheme == "https" && port == "443" || canonical.Scheme == "http" && port == "80" {
		port = ""
	}
	if strings.Contains(hostname, ":") {
		hostname = "[" + hostname + "]"
	}
	canonical.Host = hostname
	if port != "" {
		canonical.Host += ":" + port
	}
	if canonical.Path == "" {
		canonical.Path = "/"
	}
	return canonical.String(), nil
}

func validateMCPToolSchema(schema map[string]any, toolName string) error {
	if err := validateSharedSchema(schema, "$", true); err != nil {
		return fmt.Errorf("MCP tool inputSchema is invalid for %s: %w", toolName, err)
	}
	return nil
}

func validateSharedSchema(schema map[string]any, path string, root bool) error {
	allowed := map[string]bool{
		"type": true, "properties": true, "required": true, "additionalProperties": true,
		"items": true, "enum": true, "const": true, "oneOf": true,
		"minimum": true, "maximum": true, "exclusiveMinimum": true, "exclusiveMaximum": true,
		"minLength": true, "maxLength": true, "pattern": true, "minItems": true, "maxItems": true,
	}
	for key := range schema {
		if !allowed[key] {
			return fmt.Errorf("unsupported schema keyword %s/%s", path, key)
		}
	}
	if raw, ok := schema["type"]; ok {
		typeName, valid := raw.(string)
		if !valid || !map[string]bool{"object": true, "array": true, "string": true, "number": true, "integer": true, "boolean": true, "null": true}[typeName] {
			return fmt.Errorf("%s/type must be a supported type string", path)
		}
	} else if root {
		return fmt.Errorf("%s/type is required", path)
	}
	if raw, ok := schema["properties"]; ok {
		properties, valid := raw.(map[string]any)
		if !valid {
			return fmt.Errorf("%s/properties must be an object", path)
		}
		for name, child := range properties {
			childSchema, valid := child.(map[string]any)
			if !valid {
				return fmt.Errorf("%s/properties/%s must be an object", path, name)
			}
			if err := validateSharedSchema(childSchema, path+"/properties/"+name, false); err != nil {
				return err
			}
		}
	}
	if raw, ok := schema["required"]; ok {
		required, valid := raw.([]any)
		if !valid {
			return fmt.Errorf("%s/required must be an array", path)
		}
		seen := map[string]bool{}
		for _, item := range required {
			name, valid := item.(string)
			if !valid || name == "" || seen[name] {
				return fmt.Errorf("%s/required must contain unique nonempty strings", path)
			}
			seen[name] = true
		}
	}
	if raw, ok := schema["additionalProperties"]; ok {
		if _, valid := raw.(bool); !valid {
			child, valid := raw.(map[string]any)
			if !valid {
				return fmt.Errorf("%s/additionalProperties must be a boolean or object", path)
			}
			if err := validateSharedSchema(child, path+"/additionalProperties", false); err != nil {
				return err
			}
		}
	}
	if raw, ok := schema["items"]; ok {
		child, valid := raw.(map[string]any)
		if !valid {
			return fmt.Errorf("%s/items must be an object", path)
		}
		if err := validateSharedSchema(child, path+"/items", false); err != nil {
			return err
		}
	}
	if raw, ok := schema["oneOf"]; ok {
		options, valid := raw.([]any)
		if !valid || len(options) == 0 {
			return fmt.Errorf("%s/oneOf must be a nonempty array", path)
		}
		for index, option := range options {
			child, valid := option.(map[string]any)
			if !valid {
				return fmt.Errorf("%s/oneOf/%d must be an object", path, index)
			}
			if err := validateSharedSchema(child, fmt.Sprintf("%s/oneOf/%d", path, index), false); err != nil {
				return err
			}
		}
	}
	if raw, ok := schema["enum"]; ok {
		values, valid := raw.([]any)
		if !valid || len(values) == 0 {
			return fmt.Errorf("%s/enum must be a nonempty array", path)
		}
	}
	for _, key := range []string{"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"} {
		if raw, ok := schema[key]; ok {
			if _, valid := raw.(float64); !valid {
				return fmt.Errorf("%s/%s must be a number", path, key)
			}
		}
	}
	for _, key := range []string{"minLength", "maxLength", "minItems", "maxItems"} {
		if raw, ok := schema[key]; ok {
			number, valid := raw.(float64)
			if !valid || number < 0 || number != float64(int64(number)) {
				return fmt.Errorf("%s/%s must be a nonnegative integer", path, key)
			}
		}
	}
	if raw, ok := schema["pattern"]; ok {
		pattern, valid := raw.(string)
		if !valid {
			return fmt.Errorf("%s/pattern must be a string", path)
		}
		if _, err := regexp.Compile(pattern); err != nil {
			return fmt.Errorf("%s/pattern must be valid", path)
		}
	}
	return nil
}

func encodeMCPHeaderValue(value string) string {
	safe := value != "" && value == strings.TrimSpace(value) && !(strings.HasPrefix(value, "=?base64?") && strings.HasSuffix(value, "?="))
	for _, char := range value {
		if char != '\t' && (char < 32 || char > 126) {
			safe = false
		}
	}
	if safe {
		return value
	}
	return "=?base64?" + base64.StdEncoding.EncodeToString([]byte(value)) + "?="
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

func containsXMCPHeader(value any) bool {
	switch item := value.(type) {
	case map[string]any:
		if _, exists := item["x-mcp-header"]; exists {
			return true
		}
		for _, child := range item {
			if containsXMCPHeader(child) {
				return true
			}
		}
	case []any:
		for _, child := range item {
			if containsXMCPHeader(child) {
				return true
			}
		}
	}
	return false
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
