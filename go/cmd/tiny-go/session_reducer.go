package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

type sessionMessage map[string]any
type sessionUsage struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
}
type sessionToolDeclaration struct {
	Name             string `json:"name"`
	DefinitionDigest string `json:"definitionDigest"`
}
type sessionConfiguration struct {
	Model               string                   `json:"model"`
	SystemPromptDigest  string                   `json:"systemPromptDigest"`
	Tools               []sessionToolDeclaration `json:"tools"`
	AdapterIdentity     string                   `json:"adapterIdentity"`
	RoutingIdentity     string                   `json:"routingIdentity"`
	OutputOptionsDigest string                   `json:"outputOptionsDigest"`
}
type sessionStep struct {
	OperationID           string               `json:"operationId"`
	StepID                string               `json:"stepId"`
	AttemptID             string               `json:"attemptId"`
	Attempt               int                  `json:"attempt"`
	StepKind              string               `json:"stepKind"`
	Status                string               `json:"status"`
	ContextThroughEntryID string               `json:"contextThroughEntryId"`
	ConfigurationSnapshot sessionConfiguration `json:"configurationSnapshot"`
	ConfigurationDigest   string               `json:"configurationDigest"`
	SettledEntryID        string               `json:"settledEntryId,omitempty"`
	StopReason            string               `json:"stopReason,omitempty"`
}
type sessionToolState struct {
	OperationID         string         `json:"operationId"`
	ToolStartedID       string         `json:"toolStartedId"`
	StepID              string         `json:"stepId"`
	AssistantEntryID    string         `json:"assistantEntryId"`
	ToolIndex           int            `json:"toolIndex"`
	ToolCallID          string         `json:"toolCallId"`
	ToolName            string         `json:"toolName"`
	Arguments           map[string]any `json:"arguments"`
	Replay              string         `json:"replay"`
	ReplayKey           string         `json:"replayKey"`
	EnvironmentIdentity string         `json:"environmentIdentity"`
	ResultEntryID       string         `json:"resultEntryId"`
	Status              string         `json:"status"`
}
type sessionHeader struct {
	ID                  string `json:"id"`
	CreatedAt           int    `json:"createdAt"`
	Cwd                 string `json:"cwd"`
	Provider            string `json:"provider"`
	Model               string `json:"model"`
	EnvironmentIdentity string `json:"environmentIdentity"`
}
type sessionOperation struct {
	Kind                string
	OperationID         string
	InputEntryID        string
	InputThroughEntryID string
	ResultEntryID       string
	Step                *sessionStep
	ToolCalls           []sessionToolState
	AbortRequested      bool
	compactedEntryIDs   []string
	retainedEntryIDs    []string
}

func (o sessionOperation) MarshalJSON() ([]byte, error) {
	if o.Kind == "idle" {
		return json.Marshal(map[string]any{"kind": "idle"})
	}
	value := map[string]any{"kind": o.Kind, "operationId": o.OperationID, "abortRequested": o.AbortRequested}
	if o.Kind == "run" {
		value["inputEntryId"], value["toolCalls"] = o.InputEntryID, o.ToolCalls
	} else {
		value["inputThroughEntryId"], value["resultEntryId"] = o.InputThroughEntryID, o.ResultEntryID
	}
	if o.Step != nil {
		value["step"] = o.Step
	}
	return json.Marshal(value)
}

type sessionMessageFact struct {
	ID      string
	Message sessionMessage
}

type sessionState struct {
	Header                      sessionHeader    `json:"header"`
	Transcript                  []sessionMessage `json:"transcript"`
	ActiveContext               []sessionMessage `json:"activeContext"`
	Usage                       sessionUsage     `json:"usage"`
	Operation                   sessionOperation `json:"operation"`
	RepairedLength              int              `json:"repairedLength"`
	entryIDs                    []string
	resultPairs                 map[string]bool
	messageFacts                []sessionMessageFact
	activeContextThroughEntryID string
}

type sessionCorruption struct {
	Code string `json:"code"`
	Line int    `json:"line"`
	Seq  *int   `json:"seq,omitempty"`
}

func (e *sessionCorruption) Error() string { return e.Code }
func corrupt(code string, line int, seq ...int) error {
	e := &sessionCorruption{Code: code, Line: line}
	if len(seq) > 0 {
		e.Seq = &seq[0]
	}
	return e
}

type sessionEntryInfo struct {
	Entry                          map[string]any
	OperationID, StepID, AttemptID string
}
type sessionAttempt struct {
	OperationID, StepID, AttemptID string
	Attempt                        int
	Kind                           string
	ContextThroughEntryID          string
	Closed, Failed                 bool
	SettledEntryID                 string
	Configuration                  sessionConfiguration
	Digest                         string
}
type sessionOperationInfo struct {
	Kind                                             string
	Finished                                         bool
	InputThroughEntryID, ResultEntryID, LatestStepID string
}
type sessionToolInfo struct {
	sessionToolState
	OperationID string
}
type sessionInternal struct {
	sessionState
	NextSeq                     int
	ActiveContextThroughEntryID string
	IDs                         map[string]bool
	Reserved                    map[string]string
	Entries                     map[string]sessionEntryInfo
	Records                     map[string]map[string]any
	Operations                  map[string]*sessionOperationInfo
	Attempts                    map[string]*sessionAttempt
	Steps                       map[string][]*sessionAttempt
	Tools                       map[string]*sessionToolInfo
	ToolPairs                   map[string]bool
}

func sessionObject(v any, code string, line int, seq ...int) (map[string]any, error) {
	m, ok := v.(map[string]any)
	if !ok || m == nil {
		return nil, corrupt(code, line, seq...)
	}
	return m, nil
}
func sessionExact(m map[string]any, keys ...string) bool {
	for key := range m {
		if !slices.Contains(keys, key) {
			return false
		}
	}
	return true
}
func sessionString(v any) (string, bool) { s, ok := v.(string); return s, ok && s != "" }
func sessionInt64(v any, min int64) (int64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	x, err := n.Int64()
	return x, err == nil && x >= min && x <= 9007199254740991
}
func sessionInt(v any, min int) (int, bool) {
	x, ok := sessionInt64(v, int64(min))
	return int(x), ok && x <= int64(math.MaxInt)
}
func sessionID(v any) (string, bool) {
	s, ok := sessionString(v)
	if !ok || len(s) != 36 || s[14] != '7' || !strings.Contains("89ab", s[19:20]) {
		return "", false
	}
	for i, c := range s {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return "", false
			}
			continue
		}
		if !strings.ContainsRune("0123456789abcdef", c) {
			return "", false
		}
	}
	return s, true
}
func sessionDigest(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || len(s) != 71 || !strings.HasPrefix(s, "sha256:") {
		return "", false
	}
	_, err := hex.DecodeString(s[7:])
	return s, err == nil
}
func sessionFail(code string, line int, seq int) error {
	if seq > 0 {
		return corrupt(code, line, seq)
	}
	return corrupt(code, line)
}

var sessionJSONToken = regexp.MustCompile(`^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)`)

func sessionScanJSON(source []byte) error {
	index := 0
	space := func() {
		for index < len(source) && strings.ContainsRune(" \t\n\r", rune(source[index])) {
			index++
		}
	}
	var scanString func() (string, error)
	scanString = func() (string, error) {
		if index >= len(source) || source[index] != '"' {
			return "", fmt.Errorf("string")
		}
		start := index
		index++
		for index < len(source) && source[index] != '"' {
			if source[index] < 0x20 {
				return "", fmt.Errorf("control")
			}
			if source[index] != '\\' {
				_, size := utf8.DecodeRune(source[index:])
				if size == 0 || size == 1 && source[index] >= 0x80 {
					return "", fmt.Errorf("utf8")
				}
				index += size
				continue
			}
			index++
			if index >= len(source) {
				return "", fmt.Errorf("escape")
			}
			escape := source[index]
			index++
			if strings.ContainsRune(`"\\/bfnrt`, rune(escape)) {
				continue
			}
			if escape != 'u' || index+4 > len(source) {
				return "", fmt.Errorf("escape")
			}
			first, err := strconv.ParseUint(string(source[index:index+4]), 16, 16)
			if err != nil {
				return "", err
			}
			index += 4
			if first >= 0xdc00 && first <= 0xdfff {
				return "", fmt.Errorf("lone surrogate")
			}
			if first >= 0xd800 && first <= 0xdbff {
				if index+6 > len(source) || string(source[index:index+2]) != `\u` {
					return "", fmt.Errorf("lone surrogate")
				}
				second, err := strconv.ParseUint(string(source[index+2:index+6]), 16, 16)
				if err != nil || second < 0xdc00 || second > 0xdfff {
					return "", fmt.Errorf("lone surrogate")
				}
				index += 6
			}
		}
		if index >= len(source) {
			return "", fmt.Errorf("string")
		}
		index++
		var decoded string
		if err := json.Unmarshal(source[start:index], &decoded); err != nil {
			return "", err
		}
		return decoded, nil
	}
	var value func() error
	value = func() error {
		space()
		if index >= len(source) {
			return fmt.Errorf("value")
		}
		if source[index] == '{' {
			index++
			space()
			keys := map[string]bool{}
			if index < len(source) && source[index] == '}' {
				index++
				return nil
			}
			for {
				space()
				key, err := scanString()
				if err != nil || keys[key] {
					return fmt.Errorf("duplicate or invalid key")
				}
				keys[key] = true
				space()
				if index >= len(source) || source[index] != ':' {
					return fmt.Errorf("colon")
				}
				index++
				if err := value(); err != nil {
					return err
				}
				space()
				if index < len(source) && source[index] == '}' {
					index++
					return nil
				}
				if index >= len(source) || source[index] != ',' {
					return fmt.Errorf("comma")
				}
				index++
			}
		}
		if source[index] == '[' {
			index++
			space()
			if index < len(source) && source[index] == ']' {
				index++
				return nil
			}
			for {
				if err := value(); err != nil {
					return err
				}
				space()
				if index < len(source) && source[index] == ']' {
					index++
					return nil
				}
				if index >= len(source) || source[index] != ',' {
					return fmt.Errorf("comma")
				}
				index++
			}
		}
		if source[index] == '"' {
			_, err := scanString()
			return err
		}
		match := sessionJSONToken.Find(source[index:])
		if len(match) == 0 {
			return fmt.Errorf("value")
		}
		index += len(match)
		return nil
	}
	if err := value(); err != nil {
		return err
	}
	space()
	if index != len(source) {
		return fmt.Errorf("trailing")
	}
	return nil
}

func sessionDecode(source []byte) (any, error) {
	if err := sessionScanJSON(source); err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(source))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return nil, err
	}
	var trailing any
	if err := dec.Decode(&trailing); err == nil {
		return nil, fmt.Errorf("extra JSON")
	}
	return value, nil
}
func sessionJSONEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

func sessionParseMessage(v any, line, seq int) (sessionMessage, error) {
	m, err := sessionObject(v, "INVALID_FACT", line, seq)
	if err != nil {
		return nil, err
	}
	role, _ := m["role"].(string)
	if role == "user" {
		if !sessionExact(m, "role", "content") {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
		if _, ok := sessionString(m["content"]); !ok {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
		return m, nil
	}
	if role == "tool" {
		if !sessionExact(m, "role", "content", "tool_call_id") {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
		if _, ok := m["content"].(string); !ok {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
		if _, ok := sessionString(m["tool_call_id"]); !ok {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
		return m, nil
	}
	if role != "assistant" || !sessionExact(m, "role", "content", "tool_calls") {
		return nil, corrupt("INVALID_FACT", line, seq)
	}
	if m["content"] != nil {
		if _, ok := m["content"].(string); !ok {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
	}
	raw, exists := m["tool_calls"]
	if !exists {
		return m, nil
	}
	calls, ok := raw.([]any)
	if !ok || len(calls) == 0 {
		return nil, corrupt("INVALID_FACT", line, seq)
	}
	seen := map[string]bool{}
	for _, item := range calls {
		call, e := sessionObject(item, "INVALID_FACT", line, seq)
		if e != nil || !sessionExact(call, "id", "type", "function") || call["type"] != "function" {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
		callID, ok := sessionString(call["id"])
		if !ok {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
		if seen[callID] {
			return nil, corrupt("INVALID_TRANSCRIPT", line, seq)
		}
		seen[callID] = true
		fn, e := sessionObject(call["function"], "INVALID_FACT", line, seq)
		if e != nil || !sessionExact(fn, "name", "arguments") {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
		if _, ok := sessionString(fn["name"]); !ok {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
		if _, ok := fn["arguments"].(string); !ok {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
	}
	return m, nil
}

func sessionClone(s *sessionInternal) *sessionInternal {
	n := *s
	n.Transcript = append([]sessionMessage{}, s.Transcript...)
	n.ActiveContext = append([]sessionMessage{}, s.ActiveContext...)
	n.IDs = maps.Clone(s.IDs)
	n.Reserved = maps.Clone(s.Reserved)
	n.Entries = maps.Clone(s.Entries)
	n.Records = maps.Clone(s.Records)
	n.Operations = map[string]*sessionOperationInfo{}
	for k, v := range s.Operations {
		x := *v
		n.Operations[k] = &x
	}
	n.Attempts = map[string]*sessionAttempt{}
	for k, v := range s.Attempts {
		x := *v
		x.Configuration.Tools = append([]sessionToolDeclaration{}, v.Configuration.Tools...)
		n.Attempts[k] = &x
	}
	n.Steps = map[string][]*sessionAttempt{}
	for k, list := range s.Steps {
		for _, old := range list {
			n.Steps[k] = append(n.Steps[k], n.Attempts[old.AttemptID])
		}
	}
	n.Tools = map[string]*sessionToolInfo{}
	for k, v := range s.Tools {
		x := *v
		n.Tools[k] = &x
	}
	n.ToolPairs = maps.Clone(s.ToolPairs)
	if s.Operation.Step != nil {
		x := *s.Operation.Step
		x.ConfigurationSnapshot.Tools = append([]sessionToolDeclaration{}, s.Operation.Step.ConfigurationSnapshot.Tools...)
		n.Operation.Step = &x
	}
	n.Operation.ToolCalls = append([]sessionToolState{}, s.Operation.ToolCalls...)
	n.Operation.compactedEntryIDs = append([]string{}, s.Operation.compactedEntryIDs...)
	n.Operation.retainedEntryIDs = append([]string{}, s.Operation.retainedEntryIDs...)
	return &n
}

func sessionReserve(s *sessionInternal, v any, line, seq int, kind string) (string, error) {
	key, ok := sessionID(v)
	if !ok {
		return "", corrupt("INVALID_FACT", line, seq)
	}
	if s.IDs[key] || s.Reserved[key] != "" {
		return "", corrupt("DUPLICATE_ID", line, seq)
	}
	s.Reserved[key] = kind
	return key, nil
}
func sessionCanonicalString(value string) string {
	var out strings.Builder
	out.WriteByte('"')
	for _, character := range value {
		switch character {
		case '\\':
			out.WriteString(`\\`)
		case '"':
			out.WriteString(`\"`)
		case '\b':
			out.WriteString(`\b`)
		case '\t':
			out.WriteString(`\t`)
		case '\n':
			out.WriteString(`\n`)
		case '\f':
			out.WriteString(`\f`)
		case '\r':
			out.WriteString(`\r`)
		default:
			if character < 0x20 {
				fmt.Fprintf(&out, `\u%04x`, character)
			} else {
				out.WriteRune(character)
			}
		}
	}
	out.WriteByte('"')
	return out.String()
}

func sessionCanonical(v any) (string, error) {
	switch x := v.(type) {
	case nil, bool, json.Number:
		b, err := json.Marshal(x)
		return string(b), err
	case string:
		return sessionCanonicalString(x), nil
	case []sessionToolDeclaration:
		a := make([]any, len(x))
		for i, v := range x {
			a[i] = map[string]any{"name": v.Name, "definitionDigest": v.DefinitionDigest}
		}
		return sessionCanonical(a)
	case []any:
		parts := make([]string, len(x))
		for i, v := range x {
			p, e := sessionCanonical(v)
			if e != nil {
				return "", e
			}
			parts[i] = p
		}
		return "[" + strings.Join(parts, ",") + "]", nil
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, len(keys))
		for i, k := range keys {
			a, _ := sessionCanonical(k)
			b, e := sessionCanonical(x[k])
			if e != nil {
				return "", e
			}
			parts[i] = a + ":" + b
		}
		return "{" + strings.Join(parts, ",") + "}", nil
	default:
		return "", fmt.Errorf("unsupported")
	}
}
func parseSessionConfiguration(v any, line, seq int) (sessionConfiguration, error) {
	m, e := sessionObject(v, "INVALID_FACT", line, seq)
	if e != nil || !sessionExact(m, "model", "systemPromptDigest", "tools", "adapterIdentity", "routingIdentity", "outputOptionsDigest") {
		return sessionConfiguration{}, corrupt("INVALID_FACT", line, seq)
	}
	model, ok := sessionString(m["model"])
	if !ok {
		return sessionConfiguration{}, corrupt("INVALID_FACT", line, seq)
	}
	prompt, ok := sessionDigest(m["systemPromptDigest"])
	output, ok2 := sessionDigest(m["outputOptionsDigest"])
	adapter, ok3 := sessionString(m["adapterIdentity"])
	routing, ok4 := sessionString(m["routingIdentity"])
	if !ok || !ok2 || !ok3 || !ok4 {
		return sessionConfiguration{}, corrupt("INVALID_FACT", line, seq)
	}
	raw, ok := m["tools"].([]any)
	if !ok {
		return sessionConfiguration{}, corrupt("INVALID_FACT", line, seq)
	}
	out := sessionConfiguration{Model: model, SystemPromptDigest: prompt, AdapterIdentity: adapter, RoutingIdentity: routing, OutputOptionsDigest: output}
	seen := map[string]bool{}
	for _, v := range raw {
		t, e := sessionObject(v, "INVALID_FACT", line, seq)
		if e != nil || !sessionExact(t, "name", "definitionDigest") {
			return out, corrupt("INVALID_FACT", line, seq)
		}
		name, ok := sessionString(t["name"])
		definition, ok2 := sessionDigest(t["definitionDigest"])
		if !ok || !ok2 || seen[name] {
			return out, corrupt("INVALID_FACT", line, seq)
		}
		seen[name] = true
		out.Tools = append(out.Tools, sessionToolDeclaration{name, definition})
	}
	return out, nil
}
func sessionConfigurationDigest(c sessionConfiguration) string {
	tools := make([]any, len(c.Tools))
	for i, t := range c.Tools {
		tools[i] = map[string]any{"name": t.Name, "definitionDigest": t.DefinitionDigest}
	}
	raw, _ := sessionCanonical(map[string]any{"model": c.Model, "systemPromptDigest": c.SystemPromptDigest, "tools": tools, "adapterIdentity": c.AdapterIdentity, "routingIdentity": c.RoutingIdentity, "outputOptionsDigest": c.OutputOptionsDigest})
	sum := sha256.Sum256([]byte(raw))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func getSessionOperation(s *sessionInternal, v any, line, seq int) (string, *sessionOperationInfo, error) {
	key, ok := sessionID(v)
	if !ok {
		return "", nil, corrupt("INVALID_FACT", line, seq)
	}
	found := s.Operations[key]
	if found == nil {
		return "", nil, corrupt("INVALID_REFERENCE", line, seq)
	}
	if found.Finished {
		return "", nil, corrupt("INVALID_TRANSITION", line, seq)
	}
	return key, found, nil
}
func sessionCallAt(message sessionMessage, index int) (string, string, bool) {
	calls, _ := message["tool_calls"].([]any)
	if index < 0 || index >= len(calls) {
		return "", "", false
	}
	call, _ := calls[index].(map[string]any)
	id, _ := call["id"].(string)
	fn, _ := call["function"].(map[string]any)
	name, _ := fn["name"].(string)
	return id, name, id != "" && name != ""
}

var syntheticContent = map[string]string{
	"invalidArguments": "Error: Tool arguments were invalid; the tool was not executed.",
	"unknownTool":      "Error: Unknown tool; the tool was not executed.",
	"truncated":        "Error: Tool call arguments were truncated by the model token limit; the tool was not executed.",
	"aborted":          "Operation aborted before execution.",
	"interrupted":      "Operation interrupted after execution status became unknown; the tool was not replayed.",
}

func sessionCanonicalValue(v any) (string, error) {
	switch x := v.(type) {
	case nil, bool, json.Number:
		b, err := json.Marshal(x)
		return string(b), err
	case string, []any, map[string]any:
		return sessionCanonical(x)
	default:
		return "", fmt.Errorf("unsupported")
	}
}

func sessionSourceDigest(s *sessionInternal, inputID string) (string, error) {
	source := []any{}
	ids := make([]string, 0, len(s.Entries))
	for id := range s.Entries {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		return sessionSeqOfEntry(s.Entries[ids[i]].Entry) < sessionSeqOfEntry(s.Entries[ids[j]].Entry)
	})
	for _, id := range ids {
		entry := s.Entries[id].Entry
		if entry["type"] == "message" {
			source = append(source, map[string]any{"sourceEntryId": id, "message": entry["message"]})
		}
		if id == inputID {
			break
		}
	}
	canonical, err := sessionCanonicalValue(source)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(canonical))
	return "sha256:" + hex.EncodeToString(digest[:]), nil
}

func validateSyntheticContent(reason, content string, line, seq int) error {
	if syntheticContent[reason] != content {
		return corrupt("INVALID_TRANSCRIPT", line, seq)
	}
	return nil
}

// apply functions mirror the TypeScript reference contract.
func sessionApplyEntry(s *sessionInternal, f map[string]any, line, seq int) error {
	if !sessionExact(f, "kind", "seq", "id", "timestamp", "entry") {
		return corrupt("INVALID_FACT", line, seq)
	}
	entry, e := sessionObject(f["entry"], "INVALID_FACT", line, seq)
	if e != nil {
		return e
	}
	factID, _ := f["id"].(string)
	if entry["type"] == "message" {
		msg, e := sessionParseMessage(entry["message"], line, seq)
		if e != nil {
			return e
		}
		role := msg["role"].(string)
		if role == "user" {
			if s.Reserved[factID] != "" || !sessionExact(entry, "type", "message") {
				return corrupt("DUPLICATE_ID", line, seq)
			}
		} else if role == "assistant" {
			if s.Reserved[factID] != "" || !sessionExact(entry, "type", "stepId", "attemptId", "stopReason", "message") {
				return corrupt("DUPLICATE_ID", line, seq)
			}
			step, ok := sessionID(entry["stepId"])
			if !ok {
				return corrupt("INVALID_FACT", line, seq)
			}
			aid, ok := sessionID(entry["attemptId"])
			if !ok {
				return corrupt("INVALID_FACT", line, seq)
			}
			stop, _ := entry["stopReason"].(string)
			if stop != "stop" && stop != "toolUse" && stop != "length" {
				return corrupt("INVALID_FACT", line, seq)
			}
			a := s.Attempts[aid]
			if a == nil || a.StepID != step || a.Closed || a.Kind != "assistant" {
				return corrupt("INVALID_REFERENCE", line, seq)
			}
			if s.Operation.Kind != "run" || s.Operation.OperationID != a.OperationID {
				return corrupt("INVALID_TRANSITION", line, seq)
			}
			_, has := msg["tool_calls"]
			if stop == "toolUse" && !has || stop == "stop" && has {
				return corrupt("INVALID_TRANSCRIPT", line, seq)
			}
			a.Closed = true
			a.SettledEntryID = factID
			if s.Operation.Step != nil && s.Operation.Step.AttemptID == aid {
				s.Operation.Step.Status = "settled"
				s.Operation.Step.SettledEntryID = factID
				s.Operation.Step.StopReason, _ = entry["stopReason"].(string)
			}
		} else {
			_, preAssistant := entry["assistantEntryId"]
			_, preIndex := entry["toolIndex"]
			preExecution := preAssistant || preIndex
			keys := []string{"type", "stepId", "message", "toolName", "toolStartedId", "result"}
			if preExecution {
				keys = []string{"type", "stepId", "assistantEntryId", "toolIndex", "message", "toolName", "result"}
			}
			if !sessionExact(entry, keys...) {
				return corrupt("INVALID_FACT", line, seq)
			}
			step, ok := sessionID(entry["stepId"])
			if !ok {
				return corrupt("INVALID_FACT", line, seq)
			}
			result, e := sessionObject(entry["result"], "INVALID_FACT", line, seq)
			if e != nil || !sessionExact(result, "type", "reason") {
				return corrupt("INVALID_FACT", line, seq)
			}
			name, ok := sessionString(entry["toolName"])
			if !ok {
				return corrupt("INVALID_FACT", line, seq)
			}
			if preExecution {
				reason, _ := result["reason"].(string)
				if result["type"] != "synthetic" || (reason != "invalidArguments" && reason != "unknownTool" && reason != "truncated" && reason != "aborted") {
					return corrupt("INVALID_FACT", line, seq)
				}
				assistantID, ok := sessionID(entry["assistantEntryId"])
				if !ok {
					return corrupt("INVALID_FACT", line, seq)
				}
				idx, ok := sessionInt(entry["toolIndex"], 0)
				if !ok {
					return corrupt("INVALID_FACT", line, seq)
				}
				info := s.Entries[assistantID]
				if info.Entry == nil || info.StepID != step || s.Operation.Kind != "run" || info.OperationID != s.Operation.OperationID {
					return corrupt("INVALID_REFERENCE", line, seq)
				}
				assistant, e := sessionParseMessage(info.Entry["message"], line, seq)
				if e != nil {
					return e
				}
				callID, callName, ok := sessionCallAt(assistant, idx)
				if !ok || callID != msg["tool_call_id"] || callName != name {
					return corrupt("INVALID_REFERENCE", line, seq)
				}
				pair := assistantID + ":" + fmt.Sprint(idx)
				if s.ToolPairs[pair] {
					return corrupt("INVALID_TRANSITION", line, seq)
				}
				content, _ := msg["content"].(string)
				if e := validateSyntheticContent(reason, content, line, seq); e != nil {
					return e
				}
				s.ToolPairs[pair] = true
			} else {
				if s.Reserved[factID] != "toolResult" {
					return corrupt("INVALID_REFERENCE", line, seq)
				}
				resultType, _ := result["type"].(string)
				if resultType != "success" && resultType != "error" && resultType != "synthetic" {
					return corrupt("INVALID_FACT", line, seq)
				}
				if resultType == "synthetic" {
					if result["reason"] != "interrupted" {
						return corrupt("INVALID_FACT", line, seq)
					}
					content, _ := msg["content"].(string)
					if e := validateSyntheticContent("interrupted", content, line, seq); e != nil {
						return e
					}
				} else if _, ok := result["reason"]; ok {
					return corrupt("INVALID_FACT", line, seq)
				}
				startedID, ok := sessionID(entry["toolStartedId"])
				if !ok {
					return corrupt("INVALID_FACT", line, seq)
				}
				started := s.Tools[startedID]
				callID, _ := msg["tool_call_id"].(string)
				if started == nil || started.StepID != step || started.ResultEntryID != factID || started.ToolCallID != callID || started.ToolName != name || started.Status != "pending" {
					return corrupt("INVALID_REFERENCE", line, seq)
				}
				started.Status = "completed"
				for i := range s.Operation.ToolCalls {
					if s.Operation.ToolCalls[i].ToolStartedID == startedID {
						s.Operation.ToolCalls[i].Status = "completed"
					}
				}
				delete(s.Reserved, factID)
			}
		}
		s.Transcript = append(s.Transcript, msg)
		s.ActiveContext = append(s.ActiveContext, msg)
		s.ActiveContextThroughEntryID = factID
		info := sessionEntryInfo{Entry: entry}
		if role == "assistant" {
			a := s.Attempts[entry["attemptId"].(string)]
			info.OperationID, info.StepID, info.AttemptID = a.OperationID, a.StepID, a.AttemptID
		} else if role == "tool" {
			if startedID, ok := entry["toolStartedId"].(string); ok {
				t := s.Tools[startedID]
				info.OperationID, info.StepID = t.OperationID, t.StepID
			} else {
				assistant := s.Entries[entry["assistantEntryId"].(string)]
				info.OperationID, info.StepID = assistant.OperationID, assistant.StepID
			}
		}
		s.Entries[factID] = info
		return nil
	}
	if entry["type"] != "compaction" || s.Reserved[factID] != "compactionResult" || !sessionExact(entry, "type", "operationId", "summary", "compactedThroughEntryId", "retainedTail") {
		return corrupt("INVALID_FACT", line, seq)
	}
	key, found, e := getSessionOperation(s, entry["operationId"], line, seq)
	if e != nil {
		return e
	}
	if found.Kind != "compaction" || s.Operation.Kind != "compaction" || s.Operation.OperationID != key || s.Operation.ResultEntryID != factID {
		return corrupt("INVALID_TRANSITION", line, seq)
	}
	through, ok := sessionID(entry["compactedThroughEntryId"])
	if !ok {
		return corrupt("INVALID_FACT", line, seq)
	}
	if _, ok := s.Entries[through]; !ok {
		return corrupt("INVALID_REFERENCE", line, seq)
	}
	summary, ok := entry["summary"].(string)
	if !ok {
		return corrupt("INVALID_FACT", line, seq)
	}
	tail, ok := entry["retainedTail"].([]any)
	if !ok {
		return corrupt("INVALID_FACT", line, seq)
	}
	ids := make([]string, 0, len(s.Entries))
	for id := range s.Entries {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		return sessionSeqOfEntry(s.Entries[ids[i]].Entry) < sessionSeqOfEntry(s.Entries[ids[j]].Entry)
	}) // insertion order recovered below from recorded synthetic seq
	// Maps do not preserve insertion order; derive expected retained entries from transcript order via explicit entry sequence metadata.
	sort.SliceStable(ids, func(i, j int) bool {
		return s.Entries[ids[i]].Entry["_seq"].(int) < s.Entries[ids[j]].Entry["_seq"].(int)
	})
	boundary, inputBoundary := -1, -1
	for i, id := range ids {
		if id == through {
			boundary = i
		}
		if id == s.Operation.InputThroughEntryID {
			inputBoundary = i
		}
	}
	if boundary < 0 || inputBoundary < boundary {
		return corrupt("INVALID_REFERENCE", line, seq)
	}
	expected := []string{}
	for _, id := range ids[boundary+1 : inputBoundary+1] {
		if s.Entries[id].Entry["type"] == "message" {
			expected = append(expected, id)
		}
	}
	retained := []sessionMessage{}
	for i, raw := range tail {
		item, e := sessionObject(raw, "INVALID_FACT", line, seq)
		if e != nil || !sessionExact(item, "sourceEntryId", "message") {
			return corrupt("INVALID_FACT", line, seq)
		}
		source, ok := sessionID(item["sourceEntryId"])
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		msg, e := sessionParseMessage(item["message"], line, seq)
		if e != nil {
			return e
		}
		if i >= len(expected) || source != expected[i] || !sessionJSONEqual(s.Entries[source].Entry["message"], msg) {
			return corrupt("INVALID_REFERENCE", line, seq)
		}
		retained = append(retained, msg)
	}
	if len(retained) != len(expected) {
		return corrupt("INVALID_REFERENCE", line, seq)
	}
	if e := sessionValidateTranscript(retained, line, seq); e != nil {
		return e
	}
	s.ActiveContext = []sessionMessage{{"role": "user", "content": "[Compacted history]\n" + summary}}
	s.ActiveContext = append(s.ActiveContext, retained...)
	s.ActiveContextThroughEntryID = s.Operation.InputThroughEntryID
	a := s.Attempts[s.Operation.Step.AttemptID]
	if a == nil || a.Closed || a.Kind != "compaction" {
		return corrupt("INVALID_TRANSITION", line, seq)
	}
	a.Closed = true
	a.SettledEntryID = factID
	delete(s.Reserved, factID)
	s.Operation.Step.Status = "settled"
	s.Operation.Step.SettledEntryID = factID
	s.Entries[factID] = sessionEntryInfo{Entry: entry, OperationID: key, StepID: a.StepID, AttemptID: a.AttemptID}
	return nil
}
func sessionSeqOfEntry(m map[string]any) int {
	if n, ok := m["_seq"].(int); ok {
		return n
	}
	return 0
}

func sessionApplyRecord(s *sessionInternal, f map[string]any, line, seq int) error {
	if !sessionExact(f, "kind", "seq", "id", "timestamp", "record") {
		return corrupt("INVALID_FACT", line, seq)
	}
	r, e := sessionObject(f["record"], "INVALID_FACT", line, seq)
	if e != nil {
		return e
	}
	typ, _ := r["type"].(string)
	fid := f["id"].(string)
	if typ == "runStarted" {
		if !sessionExact(r, "type", "operationId", "operationKind", "inputEntryId") || r["operationKind"] != "run" || s.Operation.Kind != "idle" {
			return corrupt("INVALID_TRANSITION", line, seq)
		}
		op, e := sessionReserve(s, r["operationId"], line, seq, "identity")
		if e != nil {
			return e
		}
		input, ok := sessionID(r["inputEntryId"])
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		info, ok := s.Entries[input]
		role, _ := info.Entry["message"].(map[string]any)
		if !ok || info.Entry["type"] != "message" || role["role"] != "user" {
			return corrupt("INVALID_REFERENCE", line, seq)
		}
		s.Operations[op] = &sessionOperationInfo{Kind: "run", InputThroughEntryID: input}
		s.Operation = sessionOperation{Kind: "run", OperationID: op, InputEntryID: input, ToolCalls: []sessionToolState{}}
		s.Records[fid] = r
		return nil
	}
	if typ == "compactionStarted" {
		if !sessionExact(r, "type", "operationId", "operationKind", "inputThroughEntryId", "resultEntryId", "compactedEntryIds", "retainedEntryIds", "sourceDigest") || r["operationKind"] != "compaction" || s.Operation.Kind != "idle" {
			return corrupt("INVALID_TRANSITION", line, seq)
		}
		op, e := sessionReserve(s, r["operationId"], line, seq, "identity")
		if e != nil {
			return e
		}
		input, ok := sessionID(r["inputThroughEntryId"])
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		result, e := sessionReserve(s, r["resultEntryId"], line, seq, "compactionResult")
		if e != nil {
			return e
		}
		if _, ok := s.Entries[input]; !ok {
			return corrupt("INVALID_REFERENCE", line, seq)
		}
		compactedRaw, compactedOK := r["compactedEntryIds"].([]any)
		retainedRaw, retainedOK := r["retainedEntryIds"].([]any)
		if !compactedOK || len(compactedRaw) == 0 || !retainedOK {
			return corrupt("INVALID_FACT", line, seq)
		}
		partition := append(append([]any{}, compactedRaw...), retainedRaw...)
		expected := []string{}
		ids := make([]string, 0, len(s.Entries))
		for id := range s.Entries {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool {
			return sessionSeqOfEntry(s.Entries[ids[i]].Entry) < sessionSeqOfEntry(s.Entries[ids[j]].Entry)
		})
		for _, id := range ids {
			if s.Entries[id].Entry["type"] == "message" {
				expected = append(expected, id)
			}
			if id == input {
				break
			}
		}
		if len(partition) != len(expected) {
			return corrupt("INVALID_REFERENCE", line, seq)
		}
		compacted, retained := make([]string, len(compactedRaw)), make([]string, len(retainedRaw))
		for index, raw := range partition {
			id, ok := sessionID(raw)
			if !ok {
				return corrupt("INVALID_FACT", line, seq)
			}
			if id != expected[index] {
				return corrupt("INVALID_REFERENCE", line, seq)
			}
			if index < len(compacted) {
				compacted[index] = id
			} else {
				retained[index-len(compacted)] = id
			}
		}
		digest, ok := sessionDigest(r["sourceDigest"])
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		expectedDigest, e := sessionSourceDigest(s, input)
		if e != nil || digest != expectedDigest {
			return corrupt("INVALID_REFERENCE", line, seq)
		}
		s.Operations[op] = &sessionOperationInfo{Kind: "compaction", InputThroughEntryID: input, ResultEntryID: result}
		s.Operation = sessionOperation{Kind: "compaction", OperationID: op, InputThroughEntryID: input, ResultEntryID: result, compactedEntryIDs: compacted, retainedEntryIDs: retained}
		s.Records[fid] = r
		return nil
	}
	if typ == "stepAttempt" {
		if !sessionExact(r, "type", "operationId", "stepId", "attemptId", "stepKind", "attempt", "contextThroughEntryId", "configurationSnapshot", "configurationDigest") {
			return corrupt("INVALID_FACT", line, seq)
		}
		op, found, e := getSessionOperation(s, r["operationId"], line, seq)
		if e != nil {
			return e
		}
		attempt, ok := sessionInt(r["attempt"], 1)
		if !ok || attempt > 2 {
			return corrupt("INVALID_FACT", line, seq)
		}
		var step string
		if attempt == 1 {
			step, e = sessionReserve(s, r["stepId"], line, seq, "identity")
		} else {
			step, ok = sessionID(r["stepId"])
			if !ok {
				e = corrupt("INVALID_FACT", line, seq)
			}
		}
		if e != nil {
			return e
		}
		aid, e := sessionReserve(s, r["attemptId"], line, seq, "identity")
		if e != nil {
			return e
		}
		kind, _ := r["stepKind"].(string)
		if kind != "assistant" && kind != "compaction" {
			return corrupt("INVALID_FACT", line, seq)
		}
		want := found.Kind
		if want == "run" {
			want = "assistant"
		}
		if kind != want {
			return corrupt("INVALID_TRANSITION", line, seq)
		}
		contextID, ok := sessionID(r["contextThroughEntryId"])
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		if _, ok := s.Entries[contextID]; !ok {
			return corrupt("INVALID_REFERENCE", line, seq)
		}
		if attempt == 1 && contextID != s.ActiveContextThroughEntryID {
			return corrupt("INVALID_TRANSITION", line, seq)
		}
		config, e := parseSessionConfiguration(r["configurationSnapshot"], line, seq)
		if e != nil {
			return e
		}
		digest, ok := sessionDigest(r["configurationDigest"])
		if !ok || sessionConfigurationDigest(config) != digest {
			return corrupt("INVALID_FACT", line, seq)
		}
		prior := s.Steps[step]
		if attempt == 1 {
			if len(prior) > 0 || (s.Operation.Step != nil && s.Operation.Step.Status != "settled") {
				return corrupt("INVALID_TRANSITION", line, seq)
			}
			if s.Operation.Step != nil {
				p := s.Attempts[s.Operation.Step.AttemptID]
				info := s.Entries[p.SettledEntryID]
				if found.Kind != "run" || info.Entry["stopReason"] != "toolUse" {
					return corrupt("INVALID_TRANSITION", line, seq)
				}
				for _, t := range s.Operation.ToolCalls {
					if t.Status == "pending" {
						return corrupt("INVALID_TRANSITION", line, seq)
					}
				}
			}
		} else {
			if len(prior) != 1 || prior[0].Attempt != 1 || prior[0].Closed || prior[0].Failed || prior[0].Kind != kind || prior[0].OperationID != op || prior[0].ContextThroughEntryID != contextID || prior[0].Digest != digest {
				return corrupt("INVALID_TRANSITION", line, seq)
			}
			prior[0].Closed = true
		}
		a := &sessionAttempt{OperationID: op, StepID: step, AttemptID: aid, Attempt: attempt, Kind: kind, ContextThroughEntryID: contextID, Configuration: config, Digest: digest}
		s.Attempts[aid] = a
		s.Steps[step] = append(prior, a)
		found.LatestStepID = step
		s.Operation.Step = &sessionStep{OperationID: op, StepID: step, AttemptID: aid, Attempt: attempt, StepKind: kind, Status: "attempting", ContextThroughEntryID: contextID, ConfigurationSnapshot: config, ConfigurationDigest: digest}
		s.Records[fid] = r
		return nil
	}
	if typ == "stepFailed" {
		if !sessionExact(r, "type", "operationId", "stepId", "attemptId", "error") {
			return corrupt("INVALID_FACT", line, seq)
		}
		op, _, e := getSessionOperation(s, r["operationId"], line, seq)
		if e != nil {
			return e
		}
		aid, ok := sessionID(r["attemptId"])
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		a := s.Attempts[aid]
		er, e := sessionObject(r["error"], "INVALID_FACT", line, seq)
		if e != nil || !sessionExact(er, "code", "message") {
			return corrupt("INVALID_FACT", line, seq)
		}
		_, c := sessionString(er["code"])
		_, m := sessionString(er["message"])
		if !c || !m {
			return corrupt("INVALID_FACT", line, seq)
		}
		if a == nil || a.OperationID != op || a.StepID != r["stepId"] || a.Closed {
			return corrupt("INVALID_REFERENCE", line, seq)
		}
		a.Closed = true
		a.Failed = true
		if s.Operation.Step != nil && s.Operation.Step.AttemptID == aid {
			s.Operation.Step.Status = "failed"
		}
		s.Records[fid] = r
		return nil
	}
	if typ == "toolStarted" {
		if !sessionExact(r, "type", "operationId", "stepId", "assistantEntryId", "toolIndex", "toolCallId", "toolName", "arguments", "replay", "replayKey", "environmentIdentity", "resultEntryId") {
			return corrupt("INVALID_FACT", line, seq)
		}
		op, found, e := getSessionOperation(s, r["operationId"], line, seq)
		if e != nil {
			return e
		}
		if found.Kind != "run" || s.Operation.Kind != "run" || s.Operation.OperationID != op {
			return corrupt("INVALID_TRANSITION", line, seq)
		}
		assistantID, ok := sessionID(r["assistantEntryId"])
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		info := s.Entries[assistantID]
		if info.Entry == nil || info.Entry["type"] != "message" || info.Entry["stopReason"] != "toolUse" || info.OperationID != op {
			return corrupt("INVALID_REFERENCE", line, seq)
		}
		msg, e := sessionParseMessage(info.Entry["message"], line, seq)
		if e != nil {
			return e
		}
		idx, ok := sessionInt(r["toolIndex"], 0)
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		callID, name, ok := sessionCallAt(msg, idx)
		givenID, _ := sessionString(r["toolCallId"])
		givenName, _ := sessionString(r["toolName"])
		if !ok || callID != givenID || name != givenName || info.Entry["stepId"] != r["stepId"] {
			return corrupt("INVALID_REFERENCE", line, seq)
		}
		pair := assistantID + ":" + fmt.Sprint(idx)
		if s.ToolPairs[pair] {
			return corrupt("INVALID_TRANSITION", line, seq)
		}
		args, e := sessionObject(r["arguments"], "INVALID_FACT", line, seq)
		if e != nil {
			return e
		}
		replay, _ := r["replay"].(string)
		if replay != "safe" && replay != "never" {
			return corrupt("INVALID_FACT", line, seq)
		}
		a := s.Attempts[info.AttemptID]
		var decl *sessionToolDeclaration
		if a != nil {
			for i := range a.Configuration.Tools {
				if a.Configuration.Tools[i].Name == name {
					decl = &a.Configuration.Tools[i]
				}
			}
		}
		key, ok := sessionString(r["replayKey"])
		if !ok || decl == nil {
			return corrupt("INVALID_TRANSITION", line, seq)
		}
		result, e := sessionReserve(s, r["resultEntryId"], line, seq, "toolResult")
		if e != nil {
			return e
		}
		stepID, ok := sessionID(r["stepId"])
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		tool := &sessionToolInfo{OperationID: op, sessionToolState: sessionToolState{OperationID: op, ToolStartedID: fid, StepID: stepID, AssistantEntryID: assistantID, ToolIndex: idx, ToolCallID: callID, ToolName: name, Arguments: args, Replay: replay, ReplayKey: key, EnvironmentIdentity: r["environmentIdentity"].(string), ResultEntryID: result, Status: "pending"}}
		s.Tools[fid] = tool
		s.ToolPairs[pair] = true
		s.Operation.ToolCalls = append(s.Operation.ToolCalls, tool.sessionToolState)
		s.Records[fid] = r
		return nil
	}
	if typ == "abortRequested" {
		if !sessionExact(r, "type", "operationId", "operationKind", "phase", "toolCallId", "reason") {
			return corrupt("INVALID_FACT", line, seq)
		}
		op, found, e := getSessionOperation(s, r["operationId"], line, seq)
		if e != nil {
			return e
		}
		phase, _ := r["phase"].(string)
		_, hasTool := r["toolCallId"].(string)
		if r["operationKind"] != found.Kind || r["reason"] != "escape" || phase != "model" && phase != "tool" && phase != "compact" || (phase == "tool") != hasTool || s.Operation.Kind == "idle" || s.Operation.OperationID != op || s.Operation.AbortRequested {
			return corrupt("INVALID_TRANSITION", line, seq)
		}
		s.Operation.AbortRequested = true
		s.Records[fid] = r
		return nil
	}
	if typ != "operationFinished" || !sessionExact(r, "type", "operationId", "operationKind", "outcome", "completion", "finalEntryId", "error") {
		return corrupt("INVALID_FACT", line, seq)
	}
	op, found, e := getSessionOperation(s, r["operationId"], line, seq)
	if e != nil {
		return e
	}
	outcome, _ := r["outcome"].(string)
	if r["operationKind"] != found.Kind || (outcome != "completed" && outcome != "aborted" && outcome != "failed") || s.Operation.Kind == "idle" || s.Operation.OperationID != op {
		return corrupt("INVALID_TRANSITION", line, seq)
	}
	if outcome == "completed" {
		completion, _ := r["completion"].(string)
		if found.Kind == "run" && completion != "normal" && completion != "truncated" {
			return corrupt("INVALID_FACT", line, seq)
		}
		if found.Kind == "compaction" {
			if _, ok := r["completion"]; ok {
				return corrupt("INVALID_FACT", line, seq)
			}
		}
		finalID, ok := sessionID(r["finalEntryId"])
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		info := s.Entries[finalID]
		if found.Kind == "run" {
			if info.OperationID != op || info.Entry["type"] != "message" || completion == "normal" && info.Entry["stopReason"] != "stop" || completion == "truncated" && info.Entry["stopReason"] != "length" {
				return corrupt("INVALID_REFERENCE", line, seq)
			}
			a := s.Attempts[info.AttemptID]
			if a == nil || !a.Closed || a.Failed || a.StepID != found.LatestStepID || a.SettledEntryID != finalID {
				return corrupt("INVALID_REFERENCE", line, seq)
			}
			msg, e := sessionParseMessage(info.Entry["message"], line, seq)
			if e != nil {
				return e
			}
			content, _ := msg["content"].(string)
			calls, _ := msg["tool_calls"].([]any)
			if msg["role"] != "assistant" || completion == "normal" && strings.TrimSpace(content) == "" || completion == "truncated" && len(calls) == 0 {
				return corrupt("INVALID_TRANSCRIPT", line, seq)
			}
			for _, t := range s.Operation.ToolCalls {
				if t.Status == "pending" {
					return corrupt("INVALID_TRANSCRIPT", line, seq)
				}
			}
		} else {
			if info.OperationID != op || info.Entry["type"] != "compaction" || found.ResultEntryID != finalID {
				return corrupt("INVALID_REFERENCE", line, seq)
			}
			a := s.Attempts[info.AttemptID]
			if a == nil || a.StepID != found.LatestStepID || a.SettledEntryID != finalID {
				return corrupt("INVALID_REFERENCE", line, seq)
			}
		}
	} else if outcome == "aborted" {
		pendingTools := false
		if s.Operation.Kind == "run" {
			for _, tool := range s.Operation.ToolCalls {
				pendingTools = pendingTools || tool.Status == "pending"
			}
		}
		openAttempt := s.Operation.Step != nil && s.Operation.Step.Status == "attempting"
		if _, ok := r["finalEntryId"]; ok || !s.Operation.AbortRequested || pendingTools || openAttempt {
			return corrupt("INVALID_TRANSITION", line, seq)
		}
	} else if _, ok := r["finalEntryId"]; ok {
		return corrupt("INVALID_FACT", line, seq)
	}
	if outcome != "completed" {
		if _, ok := r["completion"]; ok {
			return corrupt("INVALID_FACT", line, seq)
		}
	}
	if outcome == "failed" {
		er, e := sessionObject(r["error"], "INVALID_FACT", line, seq)
		if e != nil || !sessionExact(er, "code", "message") {
			return corrupt("INVALID_FACT", line, seq)
		}
		_, a := sessionString(er["code"])
		_, b := sessionString(er["message"])
		if !a || !b {
			return corrupt("INVALID_FACT", line, seq)
		}
	} else if _, ok := r["error"]; ok {
		return corrupt("INVALID_FACT", line, seq)
	}
	found.Finished = true
	s.Operation = sessionOperation{Kind: "idle"}
	s.Records[fid] = r
	return nil
}

func sessionApplyUsage(s *sessionInternal, f map[string]any, line, seq int) error {
	if !sessionExact(f, "kind", "seq", "id", "timestamp", "operationId", "attemptId", "toolStartedId", "usage") {
		return corrupt("INVALID_FACT", line, seq)
	}
	op, ok := sessionID(f["operationId"])
	if !ok {
		return corrupt("INVALID_FACT", line, seq)
	}
	if s.Operations[op] == nil {
		return corrupt("INVALID_REFERENCE", line, seq)
	}
	_, ha := f["attemptId"]
	_, ht := f["toolStartedId"]
	if ha == ht {
		return corrupt("INVALID_FACT", line, seq)
	}
	if ha {
		id, ok := sessionID(f["attemptId"])
		if !ok || s.Attempts[id] == nil || s.Attempts[id].OperationID != op {
			return corrupt("INVALID_REFERENCE", line, seq)
		}
	} else {
		id, ok := sessionID(f["toolStartedId"])
		if !ok || s.Tools[id] == nil || s.Tools[id].OperationID != op {
			return corrupt("INVALID_REFERENCE", line, seq)
		}
	}
	u, e := sessionObject(f["usage"], "INVALID_FACT", line, seq)
	if e != nil || !sessionExact(u, "input", "output", "cacheRead", "cacheWrite") {
		return corrupt("INVALID_FACT", line, seq)
	}
	vals := []*int64{&s.Usage.Input, &s.Usage.Output, &s.Usage.CacheRead, &s.Usage.CacheWrite}
	for i, k := range []string{"input", "output", "cacheRead", "cacheWrite"} {
		n, ok := sessionInt64(u[k], 0)
		if !ok || *vals[i] > 9007199254740991-n {
			return corrupt("INVALID_FACT", line, seq)
		}
		*vals[i] += n
	}
	return nil
}

func sessionApplyFact(s *sessionInternal, v any, line int) error {
	f, e := sessionObject(v, "INVALID_FACT", line)
	if e != nil {
		return e
	}
	seq, ok := sessionInt(f["seq"], 1)
	if !ok {
		return corrupt("INVALID_FACT", line)
	}
	if seq != s.NextSeq {
		return corrupt("SEQ_MISMATCH", line, seq)
	}
	fid, ok := sessionID(f["id"])
	if !ok {
		return corrupt("INVALID_FACT", line, seq)
	}
	if _, ok := sessionInt(f["timestamp"], 0); !ok {
		return corrupt("INVALID_FACT", line, seq)
	}
	if s.IDs[fid] {
		return corrupt("DUPLICATE_ID", line, seq)
	}
	kind, _ := f["kind"].(string)
	if kind == "entry" {
		if e := sessionApplyEntry(s, f, line, seq); e != nil {
			return e
		}
		s.Entries[fid] = sessionAttachSeq(s.Entries[fid], seq)
	} else if kind == "record" {
		if e := sessionApplyRecord(s, f, line, seq); e != nil {
			return e
		}
	} else if kind == "usage" {
		if e := sessionApplyUsage(s, f, line, seq); e != nil {
			return e
		}
	} else {
		return corrupt("INVALID_FACT", line, seq)
	}
	if s.Reserved[fid] != "" {
		return corrupt("DUPLICATE_ID", line, seq)
	}
	s.IDs[fid] = true
	s.NextSeq++
	return nil
}
func sessionAttachSeq(info sessionEntryInfo, seq int) sessionEntryInfo {
	if info.Entry != nil {
		info.Entry = maps.Clone(info.Entry)
		info.Entry["_seq"] = seq
	}
	return info
}
func sessionValidateTranscript(messages []sessionMessage, line, seq int) error {
	pending := map[string]bool{}
	for _, m := range messages {
		role := m["role"]
		if role == "assistant" {
			if len(pending) > 0 {
				return corrupt("INVALID_TRANSCRIPT", line, seq)
			}
			calls, _ := m["tool_calls"].([]any)
			for _, raw := range calls {
				call := raw.(map[string]any)
				pending[call["id"].(string)] = true
			}
			continue
		}
		if role == "tool" {
			id := m["tool_call_id"].(string)
			if !pending[id] {
				return corrupt("INVALID_TRANSCRIPT", line, seq)
			}
			delete(pending, id)
			continue
		}
		if len(pending) > 0 {
			return corrupt("INVALID_TRANSCRIPT", line, seq)
		}
	}
	return nil
}

func reduceSession(data []byte) (sessionState, error) {
	last := bytes.LastIndexByte(data, '\n')
	if last < 0 {
		return sessionState{}, corrupt("MISSING_HEADER", 1)
	}
	committed := data[:last+1]
	line := 1
	for index := 0; index+2 < len(committed); index++ {
		if committed[index] == '\n' {
			line++
		}
		if committed[index] == 0xed && committed[index+1] >= 0xa0 && committed[index+1] <= 0xbf && committed[index+2]&0xc0 == 0x80 {
			return sessionState{}, corrupt("MALFORMED_JSON", line)
		}
	}
	if !utf8.Valid(committed) {
		return sessionState{}, corrupt("INVALID_UTF8", 1)
	}
	lines := bytes.Split(committed[:len(committed)-1], []byte{'\n'})
	if len(lines) == 0 || len(lines[0]) == 0 {
		return sessionState{}, corrupt("MISSING_HEADER", 1)
	}
	parse := func(raw []byte, line int) (any, error) {
		if len(raw) == 0 {
			return nil, corrupt("BLANK_LINE", line)
		}
		if raw[len(raw)-1] == '\r' {
			return nil, corrupt("CRLF_NOT_ALLOWED", line)
		}
		v, e := sessionDecode(raw)
		if e != nil {
			return nil, corrupt("MALFORMED_JSON", line)
		}
		return v, nil
	}
	hraw, e := parse(lines[0], 1)
	if e != nil {
		return sessionState{}, e
	}
	hm, e := sessionObject(hraw, "INVALID_HEADER", 1)
	if e != nil || !sessionExact(hm, "kind", "version", "id", "createdAt", "cwd", "provider", "model", "environmentIdentity") || hm["kind"] != "header" {
		return sessionState{}, corrupt("INVALID_HEADER", 1)
	}
	version, ok := sessionInt(hm["version"], 0)
	if !ok {
		return sessionState{}, corrupt("INVALID_HEADER", 1)
	}
	if version != 2 {
		return sessionState{}, corrupt("UNSUPPORTED_VERSION", 1)
	}
	id, ok := sessionID(hm["id"])
	created, ok2 := sessionInt(hm["createdAt"], 0)
	cw, ok3 := sessionString(hm["cwd"])
	provider, ok4 := sessionString(hm["provider"])
	model, ok5 := sessionString(hm["model"])
	environment, ok6 := sessionString(hm["environmentIdentity"])
	if !ok || !ok2 || !ok3 || !ok4 || !ok5 || !ok6 {
		return sessionState{}, corrupt("INVALID_HEADER", 1)
	}
	s := &sessionInternal{sessionState: sessionState{Header: sessionHeader{id, created, cw, provider, model, environment}, Transcript: []sessionMessage{}, ActiveContext: []sessionMessage{}, Operation: sessionOperation{Kind: "idle"}, RepairedLength: last + 1}, NextSeq: 1, IDs: map[string]bool{}, Reserved: map[string]string{}, Entries: map[string]sessionEntryInfo{}, Records: map[string]map[string]any{}, Operations: map[string]*sessionOperationInfo{}, Attempts: map[string]*sessionAttempt{}, Steps: map[string][]*sessionAttempt{}, Tools: map[string]*sessionToolInfo{}, ToolPairs: map[string]bool{}}
	for i := 1; i < len(lines); i++ {
		line := i + 1
		v, e := parse(lines[i], line)
		if e != nil {
			return sessionState{}, e
		}
		tx, ok := v.([]any)
		if !ok {
			tx = []any{v}
		}
		if len(tx) == 0 {
			return sessionState{}, corrupt("EMPTY_TRANSACTION", line)
		}
		next := sessionClone(s)
		for _, fact := range tx {
			if e := sessionApplyFact(next, fact, line); e != nil {
				return sessionState{}, e
			}
		}
		if e := sessionValidateTranscript(next.Transcript, line, next.NextSeq-1); e != nil {
			return sessionState{}, e
		}
		s = next
	}
	clean := func(messages []sessionMessage) []sessionMessage {
		out := make([]sessionMessage, len(messages))
		copy(out, messages)
		return out
	}
	ids := make([]string, 0, len(s.Entries))
	for id := range s.Entries {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		return sessionSeqOfEntry(s.Entries[ids[i]].Entry) < sessionSeqOfEntry(s.Entries[ids[j]].Entry)
	})
	entryIDs := make([]string, 0, len(s.Transcript))
	resultPairs := map[string]bool{}
	messageFacts := make([]sessionMessageFact, 0, len(s.Transcript))
	for _, id := range ids {
		entry := s.Entries[id].Entry
		if entry["type"] != "message" {
			continue
		}
		entryIDs = append(entryIDs, id)
		message, _ := sessionParseMessage(entry["message"], 0, 0)
		messageFacts = append(messageFacts, sessionMessageFact{ID: id, Message: message})
		if assistantID, ok := entry["assistantEntryId"].(string); ok {
			if index, ok := sessionInt(entry["toolIndex"], 0); ok {
				resultPairs[fmt.Sprintf("%s:%d", assistantID, index)] = true
			}
		}
	}
	return sessionState{Header: s.Header, Transcript: clean(s.Transcript), ActiveContext: clean(s.ActiveContext), Usage: s.Usage, Operation: s.Operation, RepairedLength: s.RepairedLength, entryIDs: entryIDs, resultPairs: resultPairs, messageFacts: messageFacts, activeContextThroughEntryID: s.ActiveContextThroughEntryID}, nil
}
