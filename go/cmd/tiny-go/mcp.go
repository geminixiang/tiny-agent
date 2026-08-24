package main

import (
	"bytes"
	"context"
	"crypto/sha256"
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

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
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
	Identity    string
	Execute     func(context.Context, map[string]any) (string, error)
}

type MCPConfig struct {
	Alias           string
	URL             string
	Token           string
	AuthHeader      string
	AuthEnv         string
	AllowedTools    []string
	AllowedToolsSet bool
	CallTimeout     time.Duration
}

type MCPClient struct {
	config          MCPConfig
	session         *sdk.ClientSession
	protocolVersion string
	tools           []Tool
	mu              sync.Mutex
	closed          bool
}

type mcpBoundedTransport struct {
	base http.RoundTripper
}

func (t mcpBoundedTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := t.base.RoundTrip(request)
	if err != nil || response == nil || response.Body == nil {
		return response, err
	}
	response.Body = &mcpBoundedBody{ReadCloser: response.Body, remaining: maxMCPHTTPBytes + 1}
	return response, nil
}

type mcpBoundedBody struct {
	io.ReadCloser
	remaining int64
}

func (b *mcpBoundedBody) Read(p []byte) (int, error) {
	if b.remaining <= 0 {
		return 0, errors.New("MCP response exceeds 10MB")
	}
	if int64(len(p)) > b.remaining {
		p = p[:b.remaining]
	}
	n, err := b.ReadCloser.Read(p)
	b.remaining -= int64(n)
	if b.remaining == 0 {
		return n, errors.New("MCP response exceeds 10MB")
	}
	return n, err
}

type mcpLifecycleTransport struct {
	base  http.RoundTripper
	state *mcpLifecycleState
}
type mcpLifecycleState struct {
	mu          sync.Mutex
	allowLegacy bool
}

func (t mcpLifecycleTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	method, err := mcpRequestMethod(r)
	if err != nil {
		return nil, err
	}
	t.state.mu.Lock()
	allowed := t.state.allowLegacy
	t.state.allowLegacy = false
	t.state.mu.Unlock()
	if method == "initialize" && !allowed {
		return nil, errors.New("MCP legacy fallback was not authorized by server/discover")
	}
	response, err := t.base.RoundTrip(r)
	if err != nil || method != "server/discover" || response == nil || response.Body == nil {
		return response, err
	}
	body, readErr := io.ReadAll(response.Body)
	response.Body.Close()
	response.Body = io.NopCloser(bytes.NewReader(body))
	if readErr != nil {
		return nil, readErr
	}
	t.state.mu.Lock()
	t.state.allowLegacy = mcpLegacyDiscoverSignal(body)
	t.state.mu.Unlock()
	return response, nil
}
func mcpRequestMethod(r *http.Request) (string, error) {
	if r.Method != http.MethodPost || r.Body == nil {
		return "", nil
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return "", err
	}
	r.Body.Close()
	r.Body = io.NopCloser(bytes.NewReader(body))
	var e struct {
		Method string `json:"method"`
	}
	if json.Unmarshal(body, &e) != nil {
		return "", nil
	}
	return e.Method, nil
}
func mcpLegacyDiscoverSignal(body []byte) bool {
	var e struct {
		Error *struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &e) == nil && e.Error != nil {
		return e.Error.Code == -32601
	}
	lines := []string{}
	for _, line := range strings.Split(string(body), "\n") {
		if strings.HasPrefix(line, "data:") {
			lines = append(lines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	return json.Unmarshal([]byte(strings.Join(lines, "\n")), &e) == nil && e.Error != nil && e.Error.Code == -32601
}

type mcpAuthTransport struct {
	base   http.RoundTripper
	header string
	token  string
}

func (t mcpAuthTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	request = request.Clone(request.Context())
	if t.token != "" {
		value := t.token
		if t.header == "Authorization" {
			value = "Bearer " + value
		}
		request.Header.Set(t.header, value)
	}
	return t.base.RoundTrip(request)
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

func loadMCPConfigs(aliases []string, env map[string]string) ([]MCPConfig, error) {
	if len(aliases) == 0 {
		return nil, nil
	}
	override := env["TINY_MCP_CONFIG"]
	if override == "" {
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
	if json.Unmarshal(data, &root) != nil || root == nil {
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
		if field := unknownField(entry, "url", "tokenEnv", "auth", "allowedTools", "callTimeoutMs"); field != "" {
			return nil, fmt.Errorf("Unknown MCP server %s field: %s", alias, field)
		}
		var address string
		if rawURL, ok := entry["url"]; !ok || json.Unmarshal(rawURL, &address) != nil || address == "" {
			return nil, fmt.Errorf("MCP server %s url must be a string", alias)
		}
		config := MCPConfig{Alias: alias, URL: address, CallTimeout: 30 * time.Second}
		_, tokenSet := entry["tokenEnv"]
		_, authSet := entry["auth"]
		if tokenSet && authSet {
			return nil, fmt.Errorf("MCP server %s must not combine tokenEnv and auth", alias)
		}
		if rawToken, ok := entry["tokenEnv"]; ok {
			name, token, err := mcpTokenFromEnv(rawToken, env)
			if err != nil {
				return nil, fmt.Errorf("MCP server %s %w", alias, err)
			}
			config.Token, config.AuthEnv, config.AuthHeader = token, name, "Authorization"
		}
		if rawAuth, ok := entry["auth"]; ok {
			var auth map[string]json.RawMessage
			if json.Unmarshal(rawAuth, &auth) != nil || auth == nil || unknownField(auth, "type", "tokenEnv") != "" {
				return nil, fmt.Errorf("MCP server %s auth must be {type: metabaseApiKey, tokenEnv}", alias)
			}
			var kind string
			if json.Unmarshal(auth["type"], &kind) != nil || kind != "metabaseApiKey" {
				return nil, fmt.Errorf("MCP server %s auth type must be metabaseApiKey", alias)
			}
			name, token, err := mcpTokenFromEnv(auth["tokenEnv"], env)
			if err != nil {
				return nil, fmt.Errorf("MCP server %s auth %w", alias, err)
			}
			config.Token, config.AuthEnv, config.AuthHeader = token, name, "X-API-Key"
		}
		_, allowedSet := entry["allowedTools"]
		config.AllowedToolsSet = allowedSet
		if rawAllowed, ok := entry["allowedTools"]; ok {
			if bytes.Equal(bytes.TrimSpace(rawAllowed), []byte("null")) || json.Unmarshal(rawAllowed, &config.AllowedTools) != nil {
				return nil, fmt.Errorf("MCP server %s allowedTools must contain nonempty strings", alias)
			}
			seen := map[string]bool{}
			for _, name := range config.AllowedTools {
				if name == "" || seen[name] {
					return nil, fmt.Errorf("MCP server %s allowedTools must contain nonempty, unique strings", alias)
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

func mcpTokenFromEnv(raw json.RawMessage, env map[string]string) (string, string, error) {
	var name string
	if json.Unmarshal(raw, &name) != nil || !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`).MatchString(name) {
		return "", "", errors.New("tokenEnv must be an environment variable name")
	}
	token := env[name]
	if token == "" {
		return "", "", fmt.Errorf("token environment variable is not set: %s", name)
	}
	return name, token, nil
}

func unknownField(value map[string]json.RawMessage, allowed ...string) string {
	for field := range value {
		if !slices.Contains(allowed, field) {
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
	loopback := parsed.Hostname() == "localhost" || (net.ParseIP(parsed.Hostname()) != nil && net.ParseIP(parsed.Hostname()).IsLoopback())
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
	if client == nil {
		client = http.DefaultClient
	}
	clone := *client
	base := clone.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	base = mcpBoundedTransport{base: base}
	if config.Token != "" {
		base = mcpAuthTransport{base: base, header: config.AuthHeader, token: config.Token}
	}
	clone.Transport = mcpLifecycleTransport{base: base, state: &mcpLifecycleState{}}
	transport := &sdk.StreamableClientTransport{Endpoint: endpoint, HTTPClient: &clone, DisableStandaloneSSE: true, MaxRetries: -1}
	session, err := sdk.NewClient(&sdk.Implementation{Name: "tiny-agent", Version: "0.1.0"}, nil).Connect(ctx, transport, nil)
	if err != nil {
		return nil, fmt.Errorf("MCP connect: %w", err)
	}
	mcp := &MCPClient{config: config, session: session, protocolVersion: session.InitializeResult().ProtocolVersion}
	fail := func(err error) (*MCPClient, error) { _ = mcp.Close(); return nil, err }
	listed, err := listAllMCPTools(ctx, session)
	if err != nil {
		return fail(fmt.Errorf("MCP tools/list: %w", err))
	}
	endpointDigest := digestMCPIdentity(map[string]any{"endpoint": endpoint, "auth": config.AuthHeader, "protocol": mcp.protocolVersion})
	seenRemote := map[string]bool{}
	seenMapped := map[string]bool{}
	for _, remote := range listed {
		if seenRemote[remote.Name] {
			return fail(fmt.Errorf("duplicate MCP tool name: %s", remote.Name))
		}
		seenRemote[remote.Name] = true
		if remote.Name == "" {
			return fail(errors.New("MCP tool name must not be empty"))
		}
		if config.AllowedToolsSet && !slices.Contains(config.AllowedTools, remote.Name) {
			continue
		}
		schema, ok := remote.InputSchema.(map[string]any)
		if !ok {
			return fail(fmt.Errorf("MCP tool inputSchema must be an object: %s", remote.Name))
		}
		if err := validateMCPToolSchema(schema, remote.Name); err != nil {
			return fail(err)
		}
		encoded, _ := json.Marshal(schema)
		if len(encoded) > maxMCPSchemaBytes {
			return fail(fmt.Errorf("MCP tool schema exceeds 50KB: %s", remote.Name))
		}
		if jsonDepth(schema) > maxMCPSchemaDepth {
			return fail(fmt.Errorf("MCP tool schema exceeds depth %d: %s", maxMCPSchemaDepth, remote.Name))
		}
		if containsXMCPHeader(schema) {
			return fail(fmt.Errorf("MCP tool x-mcp-header declarations are not supported: %s", remote.Name))
		}
		if len([]byte(remote.Description)) > maxMCPDescription {
			return fail(fmt.Errorf("MCP tool description exceeds 8KB: %s", remote.Name))
		}
		mapped, err := mapMCPToolName(config.Alias, remote.Name)
		if err != nil {
			return fail(err)
		}
		if seenMapped[mapped] {
			return fail(fmt.Errorf("duplicate mapped MCP tool name: %s", mapped))
		}
		seenMapped[mapped] = true
		remoteName := remote.Name
		identity := digestMCPIdentity(map[string]any{"endpoint": endpointDigest, "tool": remoteName})
		mcp.tools = append(mcp.tools, Tool{Name: mapped, Description: remote.Description, Parameters: schema, Replay: "never", ReplayKey: "mcp:" + identity, Identity: identity, Execute: func(callCtx context.Context, args map[string]any) (string, error) {
			return mcp.callTool(callCtx, remoteName, args)
		}})
	}
	if config.AllowedToolsSet {
		for _, name := range config.AllowedTools {
			if !seenRemote[name] {
				return fail(fmt.Errorf("MCP allowlisted tool is missing: %s", name))
			}
		}
	}
	return mcp, nil
}

func listAllMCPTools(ctx context.Context, session *sdk.ClientSession) ([]*sdk.Tool, error) {
	var all []*sdk.Tool
	cursor := ""
	seen := map[string]bool{}
	for {
		listed, err := session.ListTools(ctx, &sdk.ListToolsParams{Cursor: cursor})
		if err != nil {
			return nil, err
		}
		all = append(all, listed.Tools...)
		if len(all) > maxMCPTools {
			return nil, fmt.Errorf("MCP server returned more than %d tools", maxMCPTools)
		}
		if listed.NextCursor == "" {
			return all, nil
		}
		if seen[listed.NextCursor] {
			return nil, errors.New("MCP tools/list returned a repeated cursor")
		}
		seen[listed.NextCursor] = true
		cursor = listed.NextCursor
	}
}

func digestMCPIdentity(value any) string {
	encoded, _ := json.Marshal(value)
	return fmt.Sprintf("sha256:%x", sha256.Sum256(encoded))
}

func (m *MCPClient) callTool(ctx context.Context, name string, args map[string]any) (string, error) {
	if args == nil {
		return "", errors.New("MCP tool arguments must be a JSON object")
	}
	ctx, cancel := context.WithTimeout(ctx, m.config.CallTimeout)
	defer cancel()
	result, err := m.session.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		return "", err
	}
	if result.NeedsInput() {
		return "", errors.New("MCP tool requires additional user input; input_required is not supported")
	}
	parts := []string{}
	for _, content := range result.Content {
		switch item := content.(type) {
		case *sdk.TextContent:
			parts = append(parts, item.Text)
		case *sdk.EmbeddedResource:
			if item.Resource.Blob != nil {
				return "", errors.New("Unsupported MCP content type: resource")
			}
			prefix := ""
			if item.Resource.URI != "" {
				prefix = "Resource: " + item.Resource.URI + "\n"
			}
			parts = append(parts, prefix+item.Resource.Text)
		default:
			return "", fmt.Errorf("Unsupported MCP content type: %T", content)
		}
	}
	if result.StructuredContent != nil {
		encoded, err := json.Marshal(result.StructuredContent)
		if err != nil {
			return "", err
		}
		parts = append(parts, "Structured content:\n"+string(encoded))
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
	defer m.mu.Unlock()
	if m.closed {
		return nil
	}
	m.closed = true
	return m.session.Close()
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
func validateSchemaChild(value any, path string) error {
	child, ok := value.(map[string]any)
	if !ok {
		return fmt.Errorf("%s must be an object", path)
	}
	return validateSharedSchema(child, path, false)
}

func validateSharedSchema(schema map[string]any, path string, root bool) error {
	allowed := []string{"type", "properties", "required", "additionalProperties", "items", "enum", "const", "oneOf", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "minItems", "maxItems"}
	for key := range schema {
		if !slices.Contains(allowed, key) {
			return fmt.Errorf("unsupported schema keyword %s/%s", path, key)
		}
	}
	if raw, ok := schema["type"]; ok {
		typeName, valid := raw.(string)
		if !valid || !slices.Contains([]string{"object", "array", "string", "number", "integer", "boolean", "null"}, typeName) {
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
			if err := validateSchemaChild(child, path+"/properties/"+name); err != nil {
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
		if err := validateSchemaChild(raw, path+"/items"); err != nil {
			return err
		}
	}
	if raw, ok := schema["oneOf"]; ok {
		options, valid := raw.([]any)
		if !valid || len(options) == 0 {
			return fmt.Errorf("%s/oneOf must be a nonempty array", path)
		}
		for index, option := range options {
			if err := validateSchemaChild(option, fmt.Sprintf("%s/oneOf/%d", path, index)); err != nil {
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
	safe := value != "" && value == strings.TrimSpace(value) && !(strings.HasPrefix(value, "=?base64?") && strings.HasSuffix(value, "?=")) && strings.IndexFunc(value, func(char rune) bool { return char != '\t' && (char < 32 || char > 126) }) < 0
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
