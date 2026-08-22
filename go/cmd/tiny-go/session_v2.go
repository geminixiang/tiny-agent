package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"unicode/utf8"
)

type sessionV2Message map[string]any
type sessionV2Usage struct {
	Input      int `json:"input"`
	Output     int `json:"output"`
	CacheRead  int `json:"cacheRead"`
	CacheWrite int `json:"cacheWrite"`
}
type sessionV2ToolDeclaration struct {
	Name         string `json:"name"`
	SchemaDigest string `json:"schemaDigest"`
	Replay       string `json:"replay"`
	ReplayKey    string `json:"replayKey"`
}
type sessionV2Configuration struct {
	Model               string                     `json:"model"`
	SystemPromptDigest  string                     `json:"systemPromptDigest"`
	Tools               []sessionV2ToolDeclaration `json:"tools"`
	EnvironmentIdentity string                     `json:"environmentIdentity"`
}
type sessionV2Step struct {
	OperationID           string                 `json:"operationId"`
	StepID                string                 `json:"stepId"`
	AttemptID             string                 `json:"attemptId"`
	Attempt               int                    `json:"attempt"`
	StepKind              string                 `json:"stepKind"`
	Status                string                 `json:"status"`
	ConfigurationSnapshot sessionV2Configuration `json:"configurationSnapshot"`
	ConfigurationDigest   string                 `json:"configurationDigest"`
}
type sessionV2ToolState struct {
	OperationID      string         `json:"operationId"`
	ToolStartedID    string         `json:"toolStartedId"`
	StepID           string         `json:"stepId"`
	AssistantEntryID string         `json:"assistantEntryId"`
	ToolIndex        int            `json:"toolIndex"`
	ToolCallID       string         `json:"toolCallId"`
	ToolName         string         `json:"toolName"`
	Arguments        map[string]any `json:"arguments"`
	Replay           string         `json:"replay"`
	ReplayKey        string         `json:"replayKey"`
	ResultEntryID    string         `json:"resultEntryId"`
	Status           string         `json:"status"`
}
type sessionV2Header struct {
	ID        string `json:"id"`
	CreatedAt int    `json:"createdAt"`
	Cwd       string `json:"cwd"`
	Provider  string `json:"provider"`
	Model     string `json:"model"`
}
type sessionV2Operation struct {
	Kind                string
	OperationID         string
	InputEntryID        string
	InputThroughEntryID string
	ResultEntryID       string
	Step                *sessionV2Step
	ToolCalls           []sessionV2ToolState
	AbortRequested      bool
}

func (o sessionV2Operation) MarshalJSON() ([]byte, error) {
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

type sessionV2State struct {
	Header         sessionV2Header    `json:"header"`
	Transcript     []sessionV2Message `json:"transcript"`
	ActiveContext  []sessionV2Message `json:"activeContext"`
	Usage          sessionV2Usage     `json:"usage"`
	Operation      sessionV2Operation `json:"operation"`
	RepairedLength int                `json:"repairedLength"`
}

type sessionV2Corruption struct {
	Code string `json:"code"`
	Line int    `json:"line"`
	Seq  *int   `json:"seq,omitempty"`
}

func (e *sessionV2Corruption) Error() string { return e.Code }
func corrupt(code string, line int, seq ...int) error {
	e := &sessionV2Corruption{Code: code, Line: line}
	if len(seq) > 0 {
		e.Seq = &seq[0]
	}
	return e
}

type v2EntryInfo struct {
	Entry                          map[string]any
	OperationID, StepID, AttemptID string
}
type v2Attempt struct {
	OperationID, StepID, AttemptID string
	Attempt                        int
	Kind                           string
	Closed, Failed                 bool
	SettledEntryID                 string
	Configuration                  sessionV2Configuration
	Digest                         string
}
type v2OperationInfo struct {
	Kind                                             string
	Finished                                         bool
	InputThroughEntryID, ResultEntryID, LatestStepID string
}
type v2ToolInfo struct {
	sessionV2ToolState
	OperationID string
}
type v2Internal struct {
	sessionV2State
	NextSeq    int
	IDs        map[string]bool
	Reserved   map[string]string
	Entries    map[string]v2EntryInfo
	Records    map[string]map[string]any
	Operations map[string]*v2OperationInfo
	Attempts   map[string]*v2Attempt
	Steps      map[string][]*v2Attempt
	Tools      map[string]*v2ToolInfo
	ToolPairs  map[string]bool
}

func v2Object(v any, code string, line int, seq ...int) (map[string]any, error) {
	m, ok := v.(map[string]any)
	if !ok || m == nil {
		return nil, corrupt(code, line, seq...)
	}
	return m, nil
}
func v2Exact(m map[string]any, keys ...string) bool {
	allowed := map[string]bool{}
	for _, k := range keys {
		allowed[k] = true
	}
	for k := range m {
		if !allowed[k] {
			return false
		}
	}
	return true
}
func v2String(v any) (string, bool) { s, ok := v.(string); return s, ok && s != "" }
func v2Int(v any, min int) (int, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	x, err := n.Int64()
	return int(x), err == nil && x >= int64(min) && x <= int64(math.MaxInt)
}
func v2ID(v any) (string, bool) {
	s, ok := v2String(v)
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
func v2Digest(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || len(s) != 71 || !strings.HasPrefix(s, "sha256:") {
		return "", false
	}
	_, err := hex.DecodeString(s[7:])
	return s, err == nil
}
func v2Fail(code string, line int, seq int) error {
	if seq > 0 {
		return corrupt(code, line, seq)
	}
	return corrupt(code, line)
}

func v2Decode(source []byte) (any, error) {
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
func v2JSONEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

func v2ParseMessage(v any, line, seq int) (sessionV2Message, error) {
	m, err := v2Object(v, "INVALID_FACT", line, seq)
	if err != nil {
		return nil, err
	}
	role, _ := m["role"].(string)
	if role == "user" {
		if !v2Exact(m, "role", "content") {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
		if _, ok := v2String(m["content"]); !ok {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
		return m, nil
	}
	if role == "tool" {
		if !v2Exact(m, "role", "content", "tool_call_id") {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
		if _, ok := m["content"].(string); !ok {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
		if _, ok := v2String(m["tool_call_id"]); !ok {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
		return m, nil
	}
	if role != "assistant" || !v2Exact(m, "role", "content", "tool_calls") {
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
		call, e := v2Object(item, "INVALID_FACT", line, seq)
		if e != nil || !v2Exact(call, "id", "type", "function") || call["type"] != "function" {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
		callID, ok := v2String(call["id"])
		if !ok {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
		if seen[callID] {
			return nil, corrupt("INVALID_TRANSCRIPT", line, seq)
		}
		seen[callID] = true
		fn, e := v2Object(call["function"], "INVALID_FACT", line, seq)
		if e != nil || !v2Exact(fn, "name", "arguments") {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
		if _, ok := v2String(fn["name"]); !ok {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
		if _, ok := fn["arguments"].(string); !ok {
			return nil, corrupt("INVALID_FACT", line, seq)
		}
	}
	return m, nil
}

func v2Clone(s *v2Internal) *v2Internal {
	n := *s
	n.Transcript = append([]sessionV2Message{}, s.Transcript...)
	n.ActiveContext = append([]sessionV2Message{}, s.ActiveContext...)
	n.IDs = copyBool(s.IDs)
	n.Reserved = copyString(s.Reserved)
	n.Entries = copyEntries(s.Entries)
	n.Records = copyRecords(s.Records)
	n.Operations = map[string]*v2OperationInfo{}
	for k, v := range s.Operations {
		x := *v
		n.Operations[k] = &x
	}
	n.Attempts = map[string]*v2Attempt{}
	for k, v := range s.Attempts {
		x := *v
		x.Configuration.Tools = append([]sessionV2ToolDeclaration{}, v.Configuration.Tools...)
		n.Attempts[k] = &x
	}
	n.Steps = map[string][]*v2Attempt{}
	for k, list := range s.Steps {
		for _, old := range list {
			n.Steps[k] = append(n.Steps[k], n.Attempts[old.AttemptID])
		}
	}
	n.Tools = map[string]*v2ToolInfo{}
	for k, v := range s.Tools {
		x := *v
		n.Tools[k] = &x
	}
	n.ToolPairs = copyBool(s.ToolPairs)
	if s.Operation.Step != nil {
		x := *s.Operation.Step
		x.ConfigurationSnapshot.Tools = append([]sessionV2ToolDeclaration{}, s.Operation.Step.ConfigurationSnapshot.Tools...)
		n.Operation.Step = &x
	}
	n.Operation.ToolCalls = append([]sessionV2ToolState{}, s.Operation.ToolCalls...)
	return &n
}
func copyBool(m map[string]bool) map[string]bool {
	n := map[string]bool{}
	for k, v := range m {
		n[k] = v
	}
	return n
}
func copyString(m map[string]string) map[string]string {
	n := map[string]string{}
	for k, v := range m {
		n[k] = v
	}
	return n
}
func copyEntries(m map[string]v2EntryInfo) map[string]v2EntryInfo {
	n := map[string]v2EntryInfo{}
	for k, v := range m {
		n[k] = v
	}
	return n
}
func copyRecords(m map[string]map[string]any) map[string]map[string]any {
	n := map[string]map[string]any{}
	for k, v := range m {
		n[k] = v
	}
	return n
}

func v2Reserve(s *v2Internal, v any, line, seq int, kind string) (string, error) {
	key, ok := v2ID(v)
	if !ok {
		return "", corrupt("INVALID_FACT", line, seq)
	}
	if s.IDs[key] || s.Reserved[key] != "" {
		return "", corrupt("DUPLICATE_ID", line, seq)
	}
	s.Reserved[key] = kind
	return key, nil
}
func v2CanonicalString(value string) string {
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

func v2Canonical(v any) (string, error) {
	switch x := v.(type) {
	case string:
		return v2CanonicalString(x), nil
	case []sessionV2ToolDeclaration:
		a := make([]any, len(x))
		for i, v := range x {
			a[i] = map[string]any{"name": v.Name, "schemaDigest": v.SchemaDigest, "replay": v.Replay, "replayKey": v.ReplayKey}
		}
		return v2Canonical(a)
	case []any:
		parts := make([]string, len(x))
		for i, v := range x {
			p, e := v2Canonical(v)
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
			a, _ := v2Canonical(k)
			b, e := v2Canonical(x[k])
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
func v2Configuration(v any, line, seq int) (sessionV2Configuration, error) {
	m, e := v2Object(v, "INVALID_FACT", line, seq)
	if e != nil || !v2Exact(m, "model", "systemPromptDigest", "tools", "environmentIdentity") {
		return sessionV2Configuration{}, corrupt("INVALID_FACT", line, seq)
	}
	model, ok := v2String(m["model"])
	if !ok {
		return sessionV2Configuration{}, corrupt("INVALID_FACT", line, seq)
	}
	prompt, ok := v2Digest(m["systemPromptDigest"])
	if !ok {
		return sessionV2Configuration{}, corrupt("INVALID_FACT", line, seq)
	}
	env, ok := v2String(m["environmentIdentity"])
	if !ok {
		return sessionV2Configuration{}, corrupt("INVALID_FACT", line, seq)
	}
	raw, ok := m["tools"].([]any)
	if !ok {
		return sessionV2Configuration{}, corrupt("INVALID_FACT", line, seq)
	}
	out := sessionV2Configuration{Model: model, SystemPromptDigest: prompt, EnvironmentIdentity: env}
	seen := map[string]bool{}
	for _, v := range raw {
		t, e := v2Object(v, "INVALID_FACT", line, seq)
		if e != nil || !v2Exact(t, "name", "schemaDigest", "replay", "replayKey") {
			return out, corrupt("INVALID_FACT", line, seq)
		}
		name, ok := v2String(t["name"])
		if !ok || seen[name] {
			return out, corrupt("INVALID_FACT", line, seq)
		}
		seen[name] = true
		schema, ok := v2Digest(t["schemaDigest"])
		if !ok {
			return out, corrupt("INVALID_FACT", line, seq)
		}
		replay, _ := t["replay"].(string)
		if replay != "safe" && replay != "never" {
			return out, corrupt("INVALID_FACT", line, seq)
		}
		key, ok := v2String(t["replayKey"])
		if !ok {
			return out, corrupt("INVALID_FACT", line, seq)
		}
		out.Tools = append(out.Tools, sessionV2ToolDeclaration{name, schema, replay, key})
	}
	return out, nil
}
func v2ConfigurationDigest(c sessionV2Configuration) string {
	tools := make([]any, len(c.Tools))
	for i, t := range c.Tools {
		tools[i] = map[string]any{"name": t.Name, "schemaDigest": t.SchemaDigest, "replay": t.Replay, "replayKey": t.ReplayKey}
	}
	raw, _ := v2Canonical(map[string]any{"model": c.Model, "systemPromptDigest": c.SystemPromptDigest, "tools": tools, "environmentIdentity": c.EnvironmentIdentity})
	sum := sha256.Sum256([]byte(raw))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func v2Operation(s *v2Internal, v any, line, seq int) (string, *v2OperationInfo, error) {
	key, ok := v2ID(v)
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
func v2CallAt(message sessionV2Message, index int) (string, string, bool) {
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

// apply functions mirror the TypeScript reference contract.
func v2ApplyEntry(s *v2Internal, f map[string]any, line, seq int) error {
	if !v2Exact(f, "kind", "seq", "id", "timestamp", "entry") {
		return corrupt("INVALID_FACT", line, seq)
	}
	entry, e := v2Object(f["entry"], "INVALID_FACT", line, seq)
	if e != nil {
		return e
	}
	factID, _ := f["id"].(string)
	if entry["type"] == "message" {
		msg, e := v2ParseMessage(entry["message"], line, seq)
		if e != nil {
			return e
		}
		role := msg["role"].(string)
		if role == "user" {
			if s.Reserved[factID] != "" || !v2Exact(entry, "type", "message") {
				return corrupt("DUPLICATE_ID", line, seq)
			}
		} else if role == "assistant" {
			if s.Reserved[factID] != "" || !v2Exact(entry, "type", "stepId", "attemptId", "stopReason", "message") {
				return corrupt("DUPLICATE_ID", line, seq)
			}
			step, ok := v2ID(entry["stepId"])
			if !ok {
				return corrupt("INVALID_FACT", line, seq)
			}
			aid, ok := v2ID(entry["attemptId"])
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
			}
		} else {
			if s.Reserved[factID] != "toolResult" || !v2Exact(entry, "type", "stepId", "message", "toolName", "toolStartedId", "isError") {
				return corrupt("INVALID_REFERENCE", line, seq)
			}
			step, ok := v2ID(entry["stepId"])
			if !ok {
				return corrupt("INVALID_FACT", line, seq)
			}
			startedID, ok := v2ID(entry["toolStartedId"])
			if !ok {
				return corrupt("INVALID_FACT", line, seq)
			}
			if _, ok := entry["isError"].(bool); !ok {
				return corrupt("INVALID_FACT", line, seq)
			}
			started := s.Tools[startedID]
			callID, _ := msg["tool_call_id"].(string)
			name, _ := entry["toolName"].(string)
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
		s.Transcript = append(s.Transcript, msg)
		s.ActiveContext = append(s.ActiveContext, msg)
		info := v2EntryInfo{Entry: entry}
		if role == "assistant" {
			a := s.Attempts[entry["attemptId"].(string)]
			info.OperationID, info.StepID, info.AttemptID = a.OperationID, a.StepID, a.AttemptID
		} else if role == "tool" {
			t := s.Tools[entry["toolStartedId"].(string)]
			info.OperationID, info.StepID = t.OperationID, t.StepID
		}
		s.Entries[factID] = info
		return nil
	}
	if entry["type"] != "compaction" || s.Reserved[factID] != "compactionResult" || !v2Exact(entry, "type", "operationId", "summary", "compactedThroughEntryId", "retainedTail") {
		return corrupt("INVALID_FACT", line, seq)
	}
	key, found, e := v2Operation(s, entry["operationId"], line, seq)
	if e != nil {
		return e
	}
	if found.Kind != "compaction" || s.Operation.Kind != "compaction" || s.Operation.OperationID != key || s.Operation.ResultEntryID != factID {
		return corrupt("INVALID_TRANSITION", line, seq)
	}
	through, ok := v2ID(entry["compactedThroughEntryId"])
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
		return v2SeqOfEntry(s.Entries[ids[i]].Entry) < v2SeqOfEntry(s.Entries[ids[j]].Entry)
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
	retained := []sessionV2Message{}
	for i, raw := range tail {
		item, e := v2Object(raw, "INVALID_FACT", line, seq)
		if e != nil || !v2Exact(item, "sourceEntryId", "message") {
			return corrupt("INVALID_FACT", line, seq)
		}
		source, ok := v2ID(item["sourceEntryId"])
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		msg, e := v2ParseMessage(item["message"], line, seq)
		if e != nil {
			return e
		}
		if i >= len(expected) || source != expected[i] || !v2JSONEqual(s.Entries[source].Entry["message"], msg) {
			return corrupt("INVALID_REFERENCE", line, seq)
		}
		retained = append(retained, msg)
	}
	if len(retained) != len(expected) {
		return corrupt("INVALID_REFERENCE", line, seq)
	}
	if e := v2ValidateTranscript(retained, line, seq); e != nil {
		return e
	}
	s.ActiveContext = []sessionV2Message{{"role": "user", "content": "[Compacted history]\n" + summary}}
	s.ActiveContext = append(s.ActiveContext, retained...)
	a := s.Attempts[s.Operation.Step.AttemptID]
	if a == nil || a.Closed || a.Kind != "compaction" {
		return corrupt("INVALID_TRANSITION", line, seq)
	}
	a.Closed = true
	a.SettledEntryID = factID
	delete(s.Reserved, factID)
	s.Operation.Step.Status = "settled"
	s.Entries[factID] = v2EntryInfo{Entry: entry, OperationID: key, StepID: a.StepID, AttemptID: a.AttemptID}
	return nil
}
func v2SeqOfEntry(m map[string]any) int {
	if n, ok := m["_seq"].(int); ok {
		return n
	}
	return 0
}

func v2ApplyRecord(s *v2Internal, f map[string]any, line, seq int) error {
	if !v2Exact(f, "kind", "seq", "id", "timestamp", "record") {
		return corrupt("INVALID_FACT", line, seq)
	}
	r, e := v2Object(f["record"], "INVALID_FACT", line, seq)
	if e != nil {
		return e
	}
	typ, _ := r["type"].(string)
	fid := f["id"].(string)
	if typ == "runStarted" {
		if !v2Exact(r, "type", "operationId", "operationKind", "inputEntryId") || r["operationKind"] != "run" || s.Operation.Kind != "idle" {
			return corrupt("INVALID_TRANSITION", line, seq)
		}
		op, e := v2Reserve(s, r["operationId"], line, seq, "identity")
		if e != nil {
			return e
		}
		input, ok := v2ID(r["inputEntryId"])
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		info, ok := s.Entries[input]
		role, _ := info.Entry["message"].(map[string]any)
		if !ok || info.Entry["type"] != "message" || role["role"] != "user" {
			return corrupt("INVALID_REFERENCE", line, seq)
		}
		s.Operations[op] = &v2OperationInfo{Kind: "run", InputThroughEntryID: input}
		s.Operation = sessionV2Operation{Kind: "run", OperationID: op, InputEntryID: input, ToolCalls: []sessionV2ToolState{}}
		s.Records[fid] = r
		return nil
	}
	if typ == "compactionStarted" {
		if !v2Exact(r, "type", "operationId", "operationKind", "inputThroughEntryId", "resultEntryId") || r["operationKind"] != "compaction" || s.Operation.Kind != "idle" {
			return corrupt("INVALID_TRANSITION", line, seq)
		}
		op, e := v2Reserve(s, r["operationId"], line, seq, "identity")
		if e != nil {
			return e
		}
		input, ok := v2ID(r["inputThroughEntryId"])
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		result, e := v2Reserve(s, r["resultEntryId"], line, seq, "compactionResult")
		if e != nil {
			return e
		}
		if _, ok := s.Entries[input]; !ok {
			return corrupt("INVALID_REFERENCE", line, seq)
		}
		s.Operations[op] = &v2OperationInfo{Kind: "compaction", InputThroughEntryID: input, ResultEntryID: result}
		s.Operation = sessionV2Operation{Kind: "compaction", OperationID: op, InputThroughEntryID: input, ResultEntryID: result}
		s.Records[fid] = r
		return nil
	}
	if typ == "stepAttempt" {
		if !v2Exact(r, "type", "operationId", "stepId", "attemptId", "stepKind", "attempt", "contextThroughEntryId", "configurationSnapshot", "configurationDigest") {
			return corrupt("INVALID_FACT", line, seq)
		}
		op, found, e := v2Operation(s, r["operationId"], line, seq)
		if e != nil {
			return e
		}
		attempt, ok := v2Int(r["attempt"], 1)
		if !ok || attempt > 2 {
			return corrupt("INVALID_FACT", line, seq)
		}
		var step string
		if attempt == 1 {
			step, e = v2Reserve(s, r["stepId"], line, seq, "identity")
		} else {
			step, ok = v2ID(r["stepId"])
			if !ok {
				e = corrupt("INVALID_FACT", line, seq)
			}
		}
		if e != nil {
			return e
		}
		aid, e := v2Reserve(s, r["attemptId"], line, seq, "identity")
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
		contextID, ok := v2ID(r["contextThroughEntryId"])
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		if _, ok := s.Entries[contextID]; !ok {
			return corrupt("INVALID_REFERENCE", line, seq)
		}
		config, e := v2Configuration(r["configurationSnapshot"], line, seq)
		if e != nil {
			return e
		}
		digest, ok := v2Digest(r["configurationDigest"])
		if !ok || v2ConfigurationDigest(config) != digest {
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
			if len(prior) != 1 || prior[0].Attempt != 1 || prior[0].Closed || prior[0].Failed || prior[0].Kind != kind || prior[0].OperationID != op || prior[0].Digest != digest {
				return corrupt("INVALID_TRANSITION", line, seq)
			}
			prior[0].Closed = true
		}
		a := &v2Attempt{OperationID: op, StepID: step, AttemptID: aid, Attempt: attempt, Kind: kind, Configuration: config, Digest: digest}
		s.Attempts[aid] = a
		s.Steps[step] = append(prior, a)
		found.LatestStepID = step
		s.Operation.Step = &sessionV2Step{OperationID: op, StepID: step, AttemptID: aid, Attempt: attempt, StepKind: kind, Status: "attempting", ConfigurationSnapshot: config, ConfigurationDigest: digest}
		s.Records[fid] = r
		return nil
	}
	if typ == "stepFailed" {
		if !v2Exact(r, "type", "operationId", "stepId", "attemptId", "error") {
			return corrupt("INVALID_FACT", line, seq)
		}
		op, _, e := v2Operation(s, r["operationId"], line, seq)
		if e != nil {
			return e
		}
		aid, ok := v2ID(r["attemptId"])
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		a := s.Attempts[aid]
		er, e := v2Object(r["error"], "INVALID_FACT", line, seq)
		if e != nil || !v2Exact(er, "code", "message") {
			return corrupt("INVALID_FACT", line, seq)
		}
		_, c := v2String(er["code"])
		_, m := v2String(er["message"])
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
		if !v2Exact(r, "type", "operationId", "stepId", "assistantEntryId", "toolIndex", "toolCallId", "toolName", "arguments", "replay", "replayKey", "resultEntryId") {
			return corrupt("INVALID_FACT", line, seq)
		}
		op, found, e := v2Operation(s, r["operationId"], line, seq)
		if e != nil {
			return e
		}
		if found.Kind != "run" || s.Operation.Kind != "run" || s.Operation.OperationID != op {
			return corrupt("INVALID_TRANSITION", line, seq)
		}
		assistantID, ok := v2ID(r["assistantEntryId"])
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		info := s.Entries[assistantID]
		if info.Entry == nil || info.Entry["type"] != "message" || info.Entry["stopReason"] != "toolUse" || info.OperationID != op {
			return corrupt("INVALID_REFERENCE", line, seq)
		}
		msg, e := v2ParseMessage(info.Entry["message"], line, seq)
		if e != nil {
			return e
		}
		idx, ok := v2Int(r["toolIndex"], 0)
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		callID, name, ok := v2CallAt(msg, idx)
		givenID, _ := v2String(r["toolCallId"])
		givenName, _ := v2String(r["toolName"])
		if !ok || callID != givenID || name != givenName || info.Entry["stepId"] != r["stepId"] {
			return corrupt("INVALID_REFERENCE", line, seq)
		}
		pair := assistantID + ":" + fmt.Sprint(idx)
		if s.ToolPairs[pair] {
			return corrupt("INVALID_TRANSITION", line, seq)
		}
		args, e := v2Object(r["arguments"], "INVALID_FACT", line, seq)
		if e != nil {
			return e
		}
		replay, _ := r["replay"].(string)
		if replay != "safe" && replay != "never" {
			return corrupt("INVALID_FACT", line, seq)
		}
		a := s.Attempts[info.AttemptID]
		var decl *sessionV2ToolDeclaration
		if a != nil {
			for i := range a.Configuration.Tools {
				if a.Configuration.Tools[i].Name == name {
					decl = &a.Configuration.Tools[i]
				}
			}
		}
		key, ok := v2String(r["replayKey"])
		if !ok || decl == nil || decl.Replay != replay || decl.ReplayKey != key {
			return corrupt("INVALID_TRANSITION", line, seq)
		}
		result, e := v2Reserve(s, r["resultEntryId"], line, seq, "toolResult")
		if e != nil {
			return e
		}
		stepID, ok := v2ID(r["stepId"])
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		tool := &v2ToolInfo{OperationID: op, sessionV2ToolState: sessionV2ToolState{OperationID: op, ToolStartedID: fid, StepID: stepID, AssistantEntryID: assistantID, ToolIndex: idx, ToolCallID: callID, ToolName: name, Arguments: args, Replay: replay, ReplayKey: key, ResultEntryID: result, Status: "pending"}}
		s.Tools[fid] = tool
		s.ToolPairs[pair] = true
		s.Operation.ToolCalls = append(s.Operation.ToolCalls, tool.sessionV2ToolState)
		s.Records[fid] = r
		return nil
	}
	if typ == "abortRequested" {
		if !v2Exact(r, "type", "operationId", "operationKind", "phase", "toolCallId", "reason") {
			return corrupt("INVALID_FACT", line, seq)
		}
		op, found, e := v2Operation(s, r["operationId"], line, seq)
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
	if typ != "operationFinished" || !v2Exact(r, "type", "operationId", "operationKind", "outcome", "finalEntryId", "error") {
		return corrupt("INVALID_FACT", line, seq)
	}
	op, found, e := v2Operation(s, r["operationId"], line, seq)
	if e != nil {
		return e
	}
	outcome, _ := r["outcome"].(string)
	if r["operationKind"] != found.Kind || (outcome != "completed" && outcome != "aborted" && outcome != "failed") || s.Operation.Kind == "idle" || s.Operation.OperationID != op {
		return corrupt("INVALID_TRANSITION", line, seq)
	}
	if outcome == "completed" {
		finalID, ok := v2ID(r["finalEntryId"])
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		info := s.Entries[finalID]
		if found.Kind == "run" {
			if info.OperationID != op || info.Entry["type"] != "message" || info.Entry["stopReason"] != "stop" {
				return corrupt("INVALID_REFERENCE", line, seq)
			}
			a := s.Attempts[info.AttemptID]
			if a == nil || !a.Closed || a.Failed || a.StepID != found.LatestStepID || a.SettledEntryID != finalID {
				return corrupt("INVALID_REFERENCE", line, seq)
			}
			msg, e := v2ParseMessage(info.Entry["message"], line, seq)
			if e != nil {
				return e
			}
			content, _ := msg["content"].(string)
			if msg["role"] != "assistant" || strings.TrimSpace(content) == "" {
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
	} else if _, ok := r["finalEntryId"]; ok {
		return corrupt("INVALID_FACT", line, seq)
	}
	if outcome == "failed" {
		er, e := v2Object(r["error"], "INVALID_FACT", line, seq)
		if e != nil || !v2Exact(er, "code", "message") {
			return corrupt("INVALID_FACT", line, seq)
		}
		_, a := v2String(er["code"])
		_, b := v2String(er["message"])
		if !a || !b {
			return corrupt("INVALID_FACT", line, seq)
		}
	} else if _, ok := r["error"]; ok {
		return corrupt("INVALID_FACT", line, seq)
	}
	found.Finished = true
	s.Operation = sessionV2Operation{Kind: "idle"}
	s.Records[fid] = r
	return nil
}

func v2ApplyUsage(s *v2Internal, f map[string]any, line, seq int) error {
	if !v2Exact(f, "kind", "seq", "id", "timestamp", "operationId", "attemptId", "toolStartedId", "usage") {
		return corrupt("INVALID_FACT", line, seq)
	}
	op, ok := v2ID(f["operationId"])
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
		id, ok := v2ID(f["attemptId"])
		if !ok || s.Attempts[id] == nil || s.Attempts[id].OperationID != op {
			return corrupt("INVALID_REFERENCE", line, seq)
		}
	} else {
		id, ok := v2ID(f["toolStartedId"])
		if !ok || s.Tools[id] == nil || s.Tools[id].OperationID != op {
			return corrupt("INVALID_REFERENCE", line, seq)
		}
	}
	u, e := v2Object(f["usage"], "INVALID_FACT", line, seq)
	if e != nil || !v2Exact(u, "input", "output", "cacheRead", "cacheWrite") {
		return corrupt("INVALID_FACT", line, seq)
	}
	vals := []*int{&s.Usage.Input, &s.Usage.Output, &s.Usage.CacheRead, &s.Usage.CacheWrite}
	for i, k := range []string{"input", "output", "cacheRead", "cacheWrite"} {
		n, ok := v2Int(u[k], 0)
		if !ok {
			return corrupt("INVALID_FACT", line, seq)
		}
		*vals[i] += n
	}
	return nil
}

func v2ApplyFact(s *v2Internal, v any, line int) error {
	f, e := v2Object(v, "INVALID_FACT", line)
	if e != nil {
		return e
	}
	seq, ok := v2Int(f["seq"], 1)
	if !ok {
		return corrupt("INVALID_FACT", line)
	}
	if seq != s.NextSeq {
		return corrupt("SEQ_MISMATCH", line, seq)
	}
	fid, ok := v2ID(f["id"])
	if !ok {
		return corrupt("INVALID_FACT", line, seq)
	}
	if _, ok := v2Int(f["timestamp"], 0); !ok {
		return corrupt("INVALID_FACT", line, seq)
	}
	if s.IDs[fid] {
		return corrupt("DUPLICATE_ID", line, seq)
	}
	kind, _ := f["kind"].(string)
	if kind == "entry" {
		if e := v2ApplyEntry(s, f, line, seq); e != nil {
			return e
		}
		s.Entries[fid] = v2AttachSeq(s.Entries[fid], seq)
	} else if kind == "record" {
		if e := v2ApplyRecord(s, f, line, seq); e != nil {
			return e
		}
	} else if kind == "usage" {
		if e := v2ApplyUsage(s, f, line, seq); e != nil {
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
func v2AttachSeq(info v2EntryInfo, seq int) v2EntryInfo {
	if info.Entry != nil {
		info.Entry = copyAnyMap(info.Entry)
		info.Entry["_seq"] = seq
	}
	return info
}
func copyAnyMap(m map[string]any) map[string]any {
	n := map[string]any{}
	for k, v := range m {
		n[k] = v
	}
	return n
}
func v2ValidateTranscript(messages []sessionV2Message, line, seq int) error {
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

func reduceSessionV2(data []byte) (sessionV2State, error) {
	last := bytes.LastIndexByte(data, '\n')
	if last < 0 {
		return sessionV2State{}, corrupt("MISSING_HEADER", 1)
	}
	committed := data[:last+1]
	if !utf8.Valid(committed) {
		return sessionV2State{}, corrupt("INVALID_UTF8", 1)
	}
	lines := bytes.Split(committed[:len(committed)-1], []byte{'\n'})
	if len(lines) == 0 || len(lines[0]) == 0 {
		return sessionV2State{}, corrupt("MISSING_HEADER", 1)
	}
	parse := func(raw []byte, line int) (any, error) {
		if len(raw) == 0 {
			return nil, corrupt("BLANK_LINE", line)
		}
		if raw[len(raw)-1] == '\r' {
			return nil, corrupt("CRLF_NOT_ALLOWED", line)
		}
		v, e := v2Decode(raw)
		if e != nil {
			return nil, corrupt("MALFORMED_JSON", line)
		}
		return v, nil
	}
	hraw, e := parse(lines[0], 1)
	if e != nil {
		return sessionV2State{}, e
	}
	hm, e := v2Object(hraw, "INVALID_HEADER", 1)
	if e != nil || !v2Exact(hm, "kind", "version", "id", "createdAt", "cwd", "provider", "model") || hm["kind"] != "header" {
		return sessionV2State{}, corrupt("INVALID_HEADER", 1)
	}
	version, ok := v2Int(hm["version"], 0)
	if !ok {
		return sessionV2State{}, corrupt("INVALID_HEADER", 1)
	}
	if version != 2 {
		return sessionV2State{}, corrupt("UNSUPPORTED_VERSION", 1)
	}
	id, ok := v2ID(hm["id"])
	created, ok2 := v2Int(hm["createdAt"], 0)
	cw, ok3 := v2String(hm["cwd"])
	provider, ok4 := v2String(hm["provider"])
	model, ok5 := v2String(hm["model"])
	if !ok || !ok2 || !ok3 || !ok4 || !ok5 {
		return sessionV2State{}, corrupt("INVALID_HEADER", 1)
	}
	s := &v2Internal{sessionV2State: sessionV2State{Header: sessionV2Header{id, created, cw, provider, model}, Transcript: []sessionV2Message{}, ActiveContext: []sessionV2Message{}, Operation: sessionV2Operation{Kind: "idle"}, RepairedLength: last + 1}, NextSeq: 1, IDs: map[string]bool{}, Reserved: map[string]string{}, Entries: map[string]v2EntryInfo{}, Records: map[string]map[string]any{}, Operations: map[string]*v2OperationInfo{}, Attempts: map[string]*v2Attempt{}, Steps: map[string][]*v2Attempt{}, Tools: map[string]*v2ToolInfo{}, ToolPairs: map[string]bool{}}
	for i := 1; i < len(lines); i++ {
		line := i + 1
		v, e := parse(lines[i], line)
		if e != nil {
			return sessionV2State{}, e
		}
		tx, ok := v.([]any)
		if !ok {
			tx = []any{v}
		}
		if len(tx) == 0 {
			return sessionV2State{}, corrupt("EMPTY_TRANSACTION", line)
		}
		next := v2Clone(s)
		for _, fact := range tx {
			if e := v2ApplyFact(next, fact, line); e != nil {
				return sessionV2State{}, e
			}
		}
		if e := v2ValidateTranscript(next.Transcript, line, next.NextSeq-1); e != nil {
			return sessionV2State{}, e
		}
		s = next
	}
	clean := func(messages []sessionV2Message) []sessionV2Message {
		out := make([]sessionV2Message, len(messages))
		for i, m := range messages {
			out[i] = m
		}
		return out
	}
	return sessionV2State{Header: s.Header, Transcript: clean(s.Transcript), ActiveContext: clean(s.ActiveContext), Usage: s.Usage, Operation: s.Operation, RepairedLength: s.RepairedLength}, nil
}
