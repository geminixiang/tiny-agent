use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub type JsonObject = Map<String, Value>;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionHeader {
    pub id: String,
    pub created_at: u64,
    pub cwd: String,
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationTool {
    pub name: String,
    pub schema_digest: String,
    pub replay: String,
    pub replay_key: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationSnapshot {
    pub model: String,
    pub system_prompt_digest: String,
    pub tools: Vec<ConfigurationTool>,
    pub environment_identity: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepState {
    pub operation_id: String,
    pub step_id: String,
    pub attempt_id: String,
    pub attempt: u64,
    pub step_kind: String,
    pub status: String,
    pub context_through_entry_id: String,
    pub configuration_snapshot: ConfigurationSnapshot,
    pub configuration_digest: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallState {
    pub operation_id: String,
    pub tool_started_id: String,
    pub step_id: String,
    pub assistant_entry_id: String,
    pub tool_index: u64,
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments: JsonObject,
    pub replay: String,
    pub replay_key: String,
    pub result_entry_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OperationState {
    Idle,
    Run {
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "inputEntryId")]
        input_entry_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        step: Option<StepState>,
        #[serde(rename = "toolCalls")]
        tool_calls: Vec<ToolCallState>,
        #[serde(rename = "abortRequested")]
        abort_requested: bool,
    },
    Compaction {
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "inputThroughEntryId")]
        input_through_entry_id: String,
        #[serde(rename = "resultEntryId")]
        result_entry_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        step: Option<StepState>,
        #[serde(rename = "abortRequested")]
        abort_requested: bool,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionV2State {
    pub header: SessionHeader,
    pub transcript: Vec<Value>,
    pub active_context: Vec<Value>,
    pub usage: SessionUsage,
    pub operation: OperationState,
    pub repaired_length: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CorruptionCode {
    InvalidUtf8,
    MissingHeader,
    InvalidHeader,
    UnsupportedVersion,
    BlankLine,
    CrlfNotAllowed,
    MalformedJson,
    EmptyTransaction,
    InvalidFact,
    SeqMismatch,
    DuplicateId,
    InvalidReference,
    InvalidTransition,
    InvalidTranscript,
}

impl CorruptionCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidUtf8 => "INVALID_UTF8",
            Self::MissingHeader => "MISSING_HEADER",
            Self::InvalidHeader => "INVALID_HEADER",
            Self::UnsupportedVersion => "UNSUPPORTED_VERSION",
            Self::BlankLine => "BLANK_LINE",
            Self::CrlfNotAllowed => "CRLF_NOT_ALLOWED",
            Self::MalformedJson => "MALFORMED_JSON",
            Self::EmptyTransaction => "EMPTY_TRANSACTION",
            Self::InvalidFact => "INVALID_FACT",
            Self::SeqMismatch => "SEQ_MISMATCH",
            Self::DuplicateId => "DUPLICATE_ID",
            Self::InvalidReference => "INVALID_REFERENCE",
            Self::InvalidTransition => "INVALID_TRANSITION",
            Self::InvalidTranscript => "INVALID_TRANSCRIPT",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionV2Corruption {
    pub code: CorruptionCode,
    pub line: usize,
    pub seq: Option<u64>,
}

impl std::fmt::Display for SessionV2Corruption {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} at line {}", self.code.as_str(), self.line)
    }
}

impl std::error::Error for SessionV2Corruption {}

type Result<T> = std::result::Result<T, SessionV2Corruption>;

#[derive(Debug, Clone)]
struct EntryInfo {
    entry: JsonObject,
    operation_id: Option<String>,
    step_id: Option<String>,
    attempt_id: Option<String>,
}

#[derive(Debug, Clone)]
struct AttemptInfo {
    operation_id: String,
    step_id: String,
    attempt_id: String,
    attempt: u64,
    kind: String,
    context_through_entry_id: String,
    closed: bool,
    failed: bool,
    settled_entry_id: Option<String>,
    configuration_snapshot: ConfigurationSnapshot,
    configuration_digest: String,
}

#[derive(Debug, Clone)]
struct OperationInfo {
    kind: String,
    finished: bool,
    result_entry_id: Option<String>,
    latest_step_id: Option<String>,
}

#[derive(Debug, Clone)]
struct InternalState {
    public: SessionV2State,
    next_seq: u64,
    ids: HashSet<String>,
    reserved_ids: HashMap<String, String>,
    entries: HashMap<String, EntryInfo>,
    entry_order: Vec<String>,
    operations: HashMap<String, OperationInfo>,
    attempts: HashMap<String, AttemptInfo>,
    steps: HashMap<String, Vec<AttemptInfo>>,
    tools: HashMap<String, ToolCallState>,
    tool_pairs: HashSet<String>,
    active_context_through_entry_id: Option<String>,
}

fn fail<T>(code: CorruptionCode, line: usize, seq: Option<u64>) -> Result<T> {
    Err(SessionV2Corruption { code, line, seq })
}

fn object(
    value: &Value,
    code: CorruptionCode,
    line: usize,
    seq: Option<u64>,
) -> Result<JsonObject> {
    value
        .as_object()
        .cloned()
        .ok_or(SessionV2Corruption { code, line, seq })
}

fn exact(
    value: &JsonObject,
    keys: &[&str],
    code: CorruptionCode,
    line: usize,
    seq: Option<u64>,
) -> Result<()> {
    if value.keys().any(|key| !keys.contains(&key.as_str())) {
        return fail(code, line, seq);
    }
    Ok(())
}

fn string(
    value: Option<&Value>,
    code: CorruptionCode,
    line: usize,
    seq: Option<u64>,
) -> Result<String> {
    match value.and_then(Value::as_str) {
        Some(value) if !value.is_empty() => Ok(value.to_string()),
        _ => fail(code, line, seq),
    }
}

fn safe_integer(
    value: Option<&Value>,
    code: CorruptionCode,
    line: usize,
    seq: Option<u64>,
    minimum: u64,
) -> Result<u64> {
    match value.and_then(Value::as_u64) {
        Some(value) if value >= minimum && value <= 9_007_199_254_740_991 => Ok(value),
        _ => fail(code, line, seq),
    }
}

fn valid_uuid7(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes[14] == b'7'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes.iter().enumerate().all(|(index, byte)| {
            [8, 13, 18, 23].contains(&index)
                || byte.is_ascii_digit()
                || (b'a'..=b'f').contains(byte)
        })
}

fn id(
    value: Option<&Value>,
    code: CorruptionCode,
    line: usize,
    seq: Option<u64>,
) -> Result<String> {
    let value = string(value, code, line, seq)?;
    if !valid_uuid7(&value) {
        return fail(code, line, seq);
    }
    Ok(value)
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_message(value: &Value, line: usize, seq: u64) -> Result<Value> {
    let message = object(value, CorruptionCode::InvalidFact, line, Some(seq))?;
    match message.get("role").and_then(Value::as_str) {
        Some("user") => {
            exact(
                &message,
                &["role", "content"],
                CorruptionCode::InvalidFact,
                line,
                Some(seq),
            )?;
            string(
                message.get("content"),
                CorruptionCode::InvalidFact,
                line,
                Some(seq),
            )?;
        }
        Some("tool") => {
            exact(
                &message,
                &["role", "content", "tool_call_id"],
                CorruptionCode::InvalidFact,
                line,
                Some(seq),
            )?;
            if !message.get("content").is_some_and(Value::is_string) {
                return fail(CorruptionCode::InvalidFact, line, Some(seq));
            }
            string(
                message.get("tool_call_id"),
                CorruptionCode::InvalidFact,
                line,
                Some(seq),
            )?;
        }
        Some("assistant") => {
            exact(
                &message,
                &["role", "content", "tool_calls"],
                CorruptionCode::InvalidFact,
                line,
                Some(seq),
            )?;
            if !matches!(message.get("content"), Some(Value::String(_) | Value::Null)) {
                return fail(CorruptionCode::InvalidFact, line, Some(seq));
            }
            if let Some(calls) = message.get("tool_calls") {
                let calls = calls.as_array().filter(|calls| !calls.is_empty()).ok_or(
                    SessionV2Corruption {
                        code: CorruptionCode::InvalidFact,
                        line,
                        seq: Some(seq),
                    },
                )?;
                let mut ids = HashSet::new();
                for raw in calls {
                    let call = object(raw, CorruptionCode::InvalidFact, line, Some(seq))?;
                    exact(
                        &call,
                        &["id", "type", "function"],
                        CorruptionCode::InvalidFact,
                        line,
                        Some(seq),
                    )?;
                    let call_id =
                        string(call.get("id"), CorruptionCode::InvalidFact, line, Some(seq))?;
                    if !ids.insert(call_id)
                        || call.get("type") != Some(&Value::String("function".into()))
                    {
                        return fail(CorruptionCode::InvalidTranscript, line, Some(seq));
                    }
                    let function = object(
                        call.get("function").unwrap_or(&Value::Null),
                        CorruptionCode::InvalidFact,
                        line,
                        Some(seq),
                    )?;
                    exact(
                        &function,
                        &["name", "arguments"],
                        CorruptionCode::InvalidFact,
                        line,
                        Some(seq),
                    )?;
                    string(
                        function.get("name"),
                        CorruptionCode::InvalidFact,
                        line,
                        Some(seq),
                    )?;
                    if !function.get("arguments").is_some_and(Value::is_string) {
                        return fail(CorruptionCode::InvalidFact, line, Some(seq));
                    }
                }
            }
        }
        _ => return fail(CorruptionCode::InvalidFact, line, Some(seq)),
    }
    Ok(Value::Object(message))
}

fn reserve(
    state: &mut InternalState,
    value: Option<&Value>,
    line: usize,
    seq: u64,
    kind: &str,
) -> Result<String> {
    let key = id(value, CorruptionCode::InvalidFact, line, Some(seq))?;
    if state.ids.contains(&key) || state.reserved_ids.contains_key(&key) {
        return fail(CorruptionCode::DuplicateId, line, Some(seq));
    }
    state.reserved_ids.insert(key.clone(), kind.to_string());
    Ok(key)
}

fn canonical_string(value: &str) -> Result<String> {
    serde_json::to_string(value).map_err(|_| SessionV2Corruption {
        code: CorruptionCode::InvalidFact,
        line: 0,
        seq: None,
    })
}

fn canonical_configuration(value: &Value) -> Result<String> {
    match value {
        Value::String(value) => canonical_string(value),
        Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(canonical_configuration)
                .collect::<Result<Vec<_>>>()?
                .join(",")
        )),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            Ok(format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| Ok(format!(
                        "{}:{}",
                        canonical_string(key)?,
                        canonical_configuration(&values[key])?
                    )))
                    .collect::<Result<Vec<_>>>()?
                    .join(",")
            ))
        }
        _ => fail(CorruptionCode::InvalidFact, 0, None),
    }
}

fn configuration(value: &Value, line: usize, seq: u64) -> Result<ConfigurationSnapshot> {
    let snapshot = object(value, CorruptionCode::InvalidFact, line, Some(seq))?;
    exact(
        &snapshot,
        &[
            "model",
            "systemPromptDigest",
            "tools",
            "environmentIdentity",
        ],
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let model = string(
        snapshot.get("model"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let system_prompt_digest = string(
        snapshot.get("systemPromptDigest"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    if !valid_digest(&system_prompt_digest) {
        return fail(CorruptionCode::InvalidFact, line, Some(seq));
    }
    let environment_identity = string(
        snapshot.get("environmentIdentity"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let raw_tools = snapshot
        .get("tools")
        .and_then(Value::as_array)
        .ok_or(SessionV2Corruption {
            code: CorruptionCode::InvalidFact,
            line,
            seq: Some(seq),
        })?;
    let mut names = HashSet::new();
    let mut tools = Vec::new();
    for raw in raw_tools {
        let tool = object(raw, CorruptionCode::InvalidFact, line, Some(seq))?;
        exact(
            &tool,
            &["name", "schemaDigest", "replay", "replayKey"],
            CorruptionCode::InvalidFact,
            line,
            Some(seq),
        )?;
        let name = string(
            tool.get("name"),
            CorruptionCode::InvalidFact,
            line,
            Some(seq),
        )?;
        if !names.insert(name.clone()) {
            return fail(CorruptionCode::InvalidFact, line, Some(seq));
        }
        let schema_digest = string(
            tool.get("schemaDigest"),
            CorruptionCode::InvalidFact,
            line,
            Some(seq),
        )?;
        let replay = string(
            tool.get("replay"),
            CorruptionCode::InvalidFact,
            line,
            Some(seq),
        )?;
        if !valid_digest(&schema_digest) || !matches!(replay.as_str(), "safe" | "never") {
            return fail(CorruptionCode::InvalidFact, line, Some(seq));
        }
        tools.push(ConfigurationTool {
            name,
            schema_digest,
            replay,
            replay_key: string(
                tool.get("replayKey"),
                CorruptionCode::InvalidFact,
                line,
                Some(seq),
            )?,
        });
    }
    Ok(ConfigurationSnapshot {
        model,
        system_prompt_digest,
        tools,
        environment_identity,
    })
}

fn configuration_digest(snapshot: &ConfigurationSnapshot) -> Result<String> {
    let value = serde_json::to_value(snapshot).map_err(|_| SessionV2Corruption {
        code: CorruptionCode::InvalidFact,
        line: 0,
        seq: None,
    })?;
    let digest = Sha256::digest(canonical_configuration(&value)?.as_bytes());
    Ok(format!("sha256:{digest:x}"))
}

fn operation(
    state: &InternalState,
    operation_id: Option<&Value>,
    line: usize,
    seq: u64,
) -> Result<(String, OperationInfo)> {
    let key = id(operation_id, CorruptionCode::InvalidFact, line, Some(seq))?;
    let found = state
        .operations
        .get(&key)
        .cloned()
        .ok_or(SessionV2Corruption {
            code: CorruptionCode::InvalidReference,
            line,
            seq: Some(seq),
        })?;
    if found.finished {
        return fail(CorruptionCode::InvalidTransition, line, Some(seq));
    }
    Ok((key, found))
}

fn operation_step_mut(operation: &mut OperationState) -> Option<&mut Option<StepState>> {
    match operation {
        OperationState::Run { step, .. } | OperationState::Compaction { step, .. } => Some(step),
        OperationState::Idle => None,
    }
}

fn operation_id(operation: &OperationState) -> Option<&str> {
    match operation {
        OperationState::Run { operation_id, .. }
        | OperationState::Compaction { operation_id, .. } => Some(operation_id),
        OperationState::Idle => None,
    }
}

fn apply_entry(
    state: &mut InternalState,
    fact: &JsonObject,
    line: usize,
    seq: u64,
    fact_id: &str,
) -> Result<()> {
    exact(
        fact,
        &["kind", "seq", "id", "timestamp", "entry"],
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let entry = object(
        fact.get("entry").unwrap_or(&Value::Null),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    match entry.get("type").and_then(Value::as_str) {
        Some("message") => apply_message_entry(state, entry, line, seq, fact_id),
        Some("compaction") => apply_compaction_entry(state, entry, line, seq, fact_id),
        _ => fail(CorruptionCode::InvalidFact, line, Some(seq)),
    }
}

fn apply_message_entry(
    state: &mut InternalState,
    entry: JsonObject,
    line: usize,
    seq: u64,
    fact_id: &str,
) -> Result<()> {
    let message = parse_message(entry.get("message").unwrap_or(&Value::Null), line, seq)?;
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut info = EntryInfo {
        entry: entry.clone(),
        operation_id: None,
        step_id: None,
        attempt_id: None,
    };
    if role == "user" {
        if state.reserved_ids.contains_key(fact_id) {
            return fail(CorruptionCode::DuplicateId, line, Some(seq));
        }
        exact(
            &entry,
            &["type", "message"],
            CorruptionCode::InvalidFact,
            line,
            Some(seq),
        )?;
    } else if role == "assistant" {
        if state.reserved_ids.contains_key(fact_id) {
            return fail(CorruptionCode::DuplicateId, line, Some(seq));
        }
        exact(
            &entry,
            &["type", "stepId", "attemptId", "stopReason", "message"],
            CorruptionCode::InvalidFact,
            line,
            Some(seq),
        )?;
        let step_id = id(
            entry.get("stepId"),
            CorruptionCode::InvalidFact,
            line,
            Some(seq),
        )?;
        let attempt_id = id(
            entry.get("attemptId"),
            CorruptionCode::InvalidFact,
            line,
            Some(seq),
        )?;
        let stop = string(
            entry.get("stopReason"),
            CorruptionCode::InvalidFact,
            line,
            Some(seq),
        )?;
        if !matches!(stop.as_str(), "stop" | "toolUse" | "length") {
            return fail(CorruptionCode::InvalidFact, line, Some(seq));
        }
        let has_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|calls| !calls.is_empty());
        if (stop == "toolUse" && !has_calls) || (stop == "stop" && has_calls) {
            return fail(CorruptionCode::InvalidTranscript, line, Some(seq));
        }
        let attempt = state
            .attempts
            .get_mut(&attempt_id)
            .ok_or(SessionV2Corruption {
                code: CorruptionCode::InvalidReference,
                line,
                seq: Some(seq),
            })?;
        if attempt.step_id != step_id || attempt.closed || attempt.kind != "assistant" {
            return fail(CorruptionCode::InvalidReference, line, Some(seq));
        }
        if !matches!(&state.public.operation, OperationState::Run { operation_id, .. } if operation_id == &attempt.operation_id)
        {
            return fail(CorruptionCode::InvalidTransition, line, Some(seq));
        }
        attempt.closed = true;
        attempt.settled_entry_id = Some(fact_id.to_string());
        if let Some(attempts) = state.steps.get_mut(&step_id)
            && let Some(stored) = attempts
                .iter_mut()
                .find(|stored| stored.attempt_id == attempt_id)
        {
            stored.closed = true;
            stored.settled_entry_id = Some(fact_id.to_string());
        }
        if let Some(Some(step)) = operation_step_mut(&mut state.public.operation)
            && step.attempt_id == attempt_id
        {
            step.status = "settled".into();
        }
        info.operation_id = Some(attempt.operation_id.clone());
        info.step_id = Some(step_id);
        info.attempt_id = Some(attempt_id);
    } else {
        if state.reserved_ids.get(fact_id).map(String::as_str) != Some("toolResult") {
            return fail(CorruptionCode::InvalidReference, line, Some(seq));
        }
        exact(
            &entry,
            &[
                "type",
                "stepId",
                "message",
                "toolName",
                "toolStartedId",
                "isError",
            ],
            CorruptionCode::InvalidFact,
            line,
            Some(seq),
        )?;
        let step_id = id(
            entry.get("stepId"),
            CorruptionCode::InvalidFact,
            line,
            Some(seq),
        )?;
        let started_id = id(
            entry.get("toolStartedId"),
            CorruptionCode::InvalidFact,
            line,
            Some(seq),
        )?;
        if !entry.get("isError").is_some_and(Value::is_boolean) {
            return fail(CorruptionCode::InvalidFact, line, Some(seq));
        }
        let call_id = message
            .get("tool_call_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let started = state
            .tools
            .get_mut(&started_id)
            .ok_or(SessionV2Corruption {
                code: CorruptionCode::InvalidReference,
                line,
                seq: Some(seq),
            })?;
        if started.step_id != step_id
            || started.result_entry_id != fact_id
            || started.tool_call_id != call_id
            || entry.get("toolName").and_then(Value::as_str) != Some(started.tool_name.as_str())
            || started.status != "pending"
        {
            return fail(CorruptionCode::InvalidReference, line, Some(seq));
        }
        started.status = "completed".into();
        if let OperationState::Run { tool_calls, .. } = &mut state.public.operation
            && let Some(tool) = tool_calls
                .iter_mut()
                .find(|tool| tool.tool_started_id == started_id)
        {
            tool.status = "completed".into();
        }
        state.reserved_ids.remove(fact_id);
        info.operation_id = Some(started.operation_id.clone());
        info.step_id = Some(step_id);
    }
    state.public.transcript.push(message.clone());
    state.public.active_context.push(message);
    state.active_context_through_entry_id = Some(fact_id.to_string());
    state.entries.insert(fact_id.to_string(), info);
    state.entry_order.push(fact_id.to_string());
    Ok(())
}

fn apply_compaction_entry(
    state: &mut InternalState,
    entry: JsonObject,
    line: usize,
    seq: u64,
    fact_id: &str,
) -> Result<()> {
    if state.reserved_ids.get(fact_id).map(String::as_str) != Some("compactionResult") {
        return fail(CorruptionCode::InvalidReference, line, Some(seq));
    }
    exact(
        &entry,
        &[
            "type",
            "operationId",
            "summary",
            "compactedThroughEntryId",
            "retainedTail",
        ],
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let (key, found) = operation(state, entry.get("operationId"), line, seq)?;
    if found.kind != "compaction"
        || !matches!(&state.public.operation, OperationState::Compaction { operation_id, result_entry_id, .. } if operation_id == &key && result_entry_id == fact_id)
    {
        return fail(CorruptionCode::InvalidTransition, line, Some(seq));
    }
    let through = id(
        entry.get("compactedThroughEntryId"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let summary = entry
        .get("summary")
        .and_then(Value::as_str)
        .ok_or(SessionV2Corruption {
            code: CorruptionCode::InvalidFact,
            line,
            seq: Some(seq),
        })?;
    let input_id = match &state.public.operation {
        OperationState::Compaction {
            input_through_entry_id,
            ..
        } => input_through_entry_id.clone(),
        _ => unreachable!(),
    };
    let boundary = state
        .entry_order
        .iter()
        .position(|item| item == &through)
        .ok_or(SessionV2Corruption {
            code: CorruptionCode::InvalidReference,
            line,
            seq: Some(seq),
        })?;
    let input_boundary = state
        .entry_order
        .iter()
        .position(|item| item == &input_id)
        .ok_or(SessionV2Corruption {
            code: CorruptionCode::InvalidReference,
            line,
            seq: Some(seq),
        })?;
    if input_boundary < boundary {
        return fail(CorruptionCode::InvalidReference, line, Some(seq));
    }
    let expected = state.entry_order[boundary + 1..=input_boundary]
        .iter()
        .filter(|entry_id| {
            state.entries.get(*entry_id).is_some_and(|info| {
                info.entry.get("type") == Some(&Value::String("message".into()))
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    let retained =
        entry
            .get("retainedTail")
            .and_then(Value::as_array)
            .ok_or(SessionV2Corruption {
                code: CorruptionCode::InvalidFact,
                line,
                seq: Some(seq),
            })?;
    if retained.len() != expected.len() {
        return fail(CorruptionCode::InvalidReference, line, Some(seq));
    }
    let mut messages = Vec::new();
    for (index, raw) in retained.iter().enumerate() {
        let item = object(raw, CorruptionCode::InvalidFact, line, Some(seq))?;
        exact(
            &item,
            &["sourceEntryId", "message"],
            CorruptionCode::InvalidFact,
            line,
            Some(seq),
        )?;
        let source_id = id(
            item.get("sourceEntryId"),
            CorruptionCode::InvalidFact,
            line,
            Some(seq),
        )?;
        let message = parse_message(item.get("message").unwrap_or(&Value::Null), line, seq)?;
        let source = state.entries.get(&source_id).map(|info| &info.entry);
        if source_id != expected[index]
            || source.and_then(|entry| entry.get("message")) != Some(&message)
        {
            return fail(CorruptionCode::InvalidReference, line, Some(seq));
        }
        messages.push(message);
    }
    validate_transcript(&messages, line, Some(seq))?;
    state.public.active_context = vec![
        serde_json::json!({"role":"user","content":format!("[Compacted history]\n{summary}")}),
    ];
    state.public.active_context.extend(messages);
    state.active_context_through_entry_id = Some(input_id);
    let current_attempt = match &state.public.operation {
        OperationState::Compaction {
            step: Some(step), ..
        } => Some(step.attempt_id.clone()),
        _ => None,
    };
    let attempt_id = current_attempt.ok_or(SessionV2Corruption {
        code: CorruptionCode::InvalidTransition,
        line,
        seq: Some(seq),
    })?;
    let attempt = state.attempts.get_mut(&attempt_id).unwrap();
    if attempt.closed || attempt.kind != "compaction" {
        return fail(CorruptionCode::InvalidTransition, line, Some(seq));
    }
    attempt.closed = true;
    attempt.settled_entry_id = Some(fact_id.to_string());
    if let Some(Some(step)) = operation_step_mut(&mut state.public.operation) {
        step.status = "settled".into();
    }
    state.reserved_ids.remove(fact_id);
    state.entries.insert(
        fact_id.to_string(),
        EntryInfo {
            entry,
            operation_id: Some(key),
            step_id: Some(attempt.step_id.clone()),
            attempt_id: Some(attempt_id),
        },
    );
    state.entry_order.push(fact_id.to_string());
    Ok(())
}

fn apply_record(
    state: &mut InternalState,
    fact: &JsonObject,
    line: usize,
    seq: u64,
    fact_id: &str,
) -> Result<()> {
    exact(
        fact,
        &["kind", "seq", "id", "timestamp", "record"],
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let record = object(
        fact.get("record").unwrap_or(&Value::Null),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    match record.get("type").and_then(Value::as_str) {
        Some("runStarted") => apply_run_started(state, &record, line, seq),
        Some("compactionStarted") => apply_compaction_started(state, &record, line, seq),
        Some("stepAttempt") => apply_step_attempt(state, &record, line, seq),
        Some("stepFailed") => apply_step_failed(state, &record, line, seq),
        Some("toolStarted") => apply_tool_started(state, &record, line, seq, fact_id),
        Some("abortRequested") => apply_abort_requested(state, &record, line, seq),
        Some("operationFinished") => apply_operation_finished(state, &record, line, seq),
        _ => fail(CorruptionCode::InvalidFact, line, Some(seq)),
    }
}

fn apply_run_started(
    state: &mut InternalState,
    record: &JsonObject,
    line: usize,
    seq: u64,
) -> Result<()> {
    exact(
        record,
        &["type", "operationId", "operationKind", "inputEntryId"],
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    if record.get("operationKind").and_then(Value::as_str) != Some("run")
        || !matches!(state.public.operation, OperationState::Idle)
    {
        return fail(CorruptionCode::InvalidTransition, line, Some(seq));
    }
    let operation_id = reserve(state, record.get("operationId"), line, seq, "identity")?;
    let input_entry_id = id(
        record.get("inputEntryId"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let input = state.entries.get(&input_entry_id).map(|info| &info.entry);
    if input
        .and_then(|entry| entry.get("type"))
        .and_then(Value::as_str)
        != Some("message")
        || input
            .and_then(|entry| entry.get("message"))
            .and_then(|message| message.get("role"))
            .and_then(Value::as_str)
            != Some("user")
    {
        return fail(CorruptionCode::InvalidReference, line, Some(seq));
    }
    state.operations.insert(
        operation_id.clone(),
        OperationInfo {
            kind: "run".into(),
            finished: false,
            result_entry_id: None,
            latest_step_id: None,
        },
    );
    state.public.operation = OperationState::Run {
        operation_id,
        input_entry_id,
        step: None,
        tool_calls: Vec::new(),
        abort_requested: false,
    };
    Ok(())
}

fn apply_compaction_started(
    state: &mut InternalState,
    record: &JsonObject,
    line: usize,
    seq: u64,
) -> Result<()> {
    exact(
        record,
        &[
            "type",
            "operationId",
            "operationKind",
            "inputThroughEntryId",
            "resultEntryId",
        ],
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    if record.get("operationKind").and_then(Value::as_str) != Some("compaction")
        || !matches!(state.public.operation, OperationState::Idle)
    {
        return fail(CorruptionCode::InvalidTransition, line, Some(seq));
    }
    let operation_id = reserve(state, record.get("operationId"), line, seq, "identity")?;
    let input_id = id(
        record.get("inputThroughEntryId"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let result_id = reserve(
        state,
        record.get("resultEntryId"),
        line,
        seq,
        "compactionResult",
    )?;
    if !state.entries.contains_key(&input_id) {
        return fail(CorruptionCode::InvalidReference, line, Some(seq));
    }
    state.operations.insert(
        operation_id.clone(),
        OperationInfo {
            kind: "compaction".into(),
            finished: false,
            result_entry_id: Some(result_id.clone()),
            latest_step_id: None,
        },
    );
    state.public.operation = OperationState::Compaction {
        operation_id,
        input_through_entry_id: input_id,
        result_entry_id: result_id,
        step: None,
        abort_requested: false,
    };
    Ok(())
}

fn apply_step_attempt(
    state: &mut InternalState,
    record: &JsonObject,
    line: usize,
    seq: u64,
) -> Result<()> {
    exact(
        record,
        &[
            "type",
            "operationId",
            "stepId",
            "attemptId",
            "stepKind",
            "attempt",
            "contextThroughEntryId",
            "configurationSnapshot",
            "configurationDigest",
        ],
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let (key, found) = operation(state, record.get("operationId"), line, seq)?;
    let attempt = safe_integer(
        record.get("attempt"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
        1,
    )?;
    let step_id = if attempt == 1 {
        reserve(state, record.get("stepId"), line, seq, "identity")?
    } else {
        id(
            record.get("stepId"),
            CorruptionCode::InvalidFact,
            line,
            Some(seq),
        )?
    };
    let attempt_id = reserve(state, record.get("attemptId"), line, seq, "identity")?;
    let step_kind = string(
        record.get("stepKind"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    if attempt > 2 || !matches!(step_kind.as_str(), "assistant" | "compaction") {
        return fail(CorruptionCode::InvalidFact, line, Some(seq));
    }
    if step_kind != found.kind.replace("run", "assistant") {
        return fail(CorruptionCode::InvalidTransition, line, Some(seq));
    }
    let context_id = id(
        record.get("contextThroughEntryId"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    if !state.entries.contains_key(&context_id) {
        return fail(CorruptionCode::InvalidReference, line, Some(seq));
    }
    if attempt == 1 && state.active_context_through_entry_id.as_deref() != Some(&context_id) {
        return fail(CorruptionCode::InvalidTransition, line, Some(seq));
    }
    let snapshot = configuration(
        record.get("configurationSnapshot").unwrap_or(&Value::Null),
        line,
        seq,
    )?;
    let digest = string(
        record.get("configurationDigest"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    if !valid_digest(&digest) || configuration_digest(&snapshot).ok().as_deref() != Some(&digest) {
        return fail(CorruptionCode::InvalidFact, line, Some(seq));
    }
    let prior = state.steps.get(&step_id).cloned().unwrap_or_default();
    let active_step = match &state.public.operation {
        OperationState::Run { step, .. } | OperationState::Compaction { step, .. } => step.clone(),
        OperationState::Idle => None,
    };
    if attempt == 1 {
        if !prior.is_empty()
            || active_step
                .as_ref()
                .is_some_and(|step| step.status != "settled")
        {
            return fail(CorruptionCode::InvalidTransition, line, Some(seq));
        }
        if active_step.is_some() {
            let previous = active_step
                .as_ref()
                .and_then(|step| state.attempts.get(&step.attempt_id));
            let settled = previous
                .and_then(|attempt| attempt.settled_entry_id.as_ref())
                .and_then(|entry_id| state.entries.get(entry_id));
            let pending = matches!(&state.public.operation, OperationState::Run { tool_calls, .. } if tool_calls.iter().any(|tool| tool.status == "pending"));
            if found.kind != "run"
                || settled
                    .and_then(|info| info.entry.get("stopReason"))
                    .and_then(Value::as_str)
                    != Some("toolUse")
                || pending
            {
                return fail(CorruptionCode::InvalidTransition, line, Some(seq));
            }
        }
    } else {
        if prior.len() != 1
            || prior[0].attempt != 1
            || prior[0].closed
            || prior[0].failed
            || prior[0].kind != step_kind
            || prior[0].operation_id != key
            || prior[0].context_through_entry_id != context_id
            || prior[0].configuration_digest != digest
        {
            return fail(CorruptionCode::InvalidTransition, line, Some(seq));
        }
        state.attempts.get_mut(&prior[0].attempt_id).unwrap().closed = true;
    }
    let info = AttemptInfo {
        operation_id: key.clone(),
        step_id: step_id.clone(),
        attempt_id: attempt_id.clone(),
        attempt,
        kind: step_kind.clone(),
        context_through_entry_id: context_id.clone(),
        closed: false,
        failed: false,
        settled_entry_id: None,
        configuration_snapshot: snapshot.clone(),
        configuration_digest: digest.clone(),
    };
    state.attempts.insert(attempt_id.clone(), info.clone());
    state
        .steps
        .insert(step_id.clone(), prior.into_iter().chain([info]).collect());
    state.operations.get_mut(&key).unwrap().latest_step_id = Some(step_id.clone());
    *operation_step_mut(&mut state.public.operation).unwrap() = Some(StepState {
        operation_id: key,
        step_id,
        attempt_id,
        attempt,
        step_kind,
        status: "attempting".into(),
        context_through_entry_id: context_id,
        configuration_snapshot: snapshot,
        configuration_digest: digest,
    });
    Ok(())
}

fn apply_step_failed(
    state: &mut InternalState,
    record: &JsonObject,
    line: usize,
    seq: u64,
) -> Result<()> {
    exact(
        record,
        &["type", "operationId", "stepId", "attemptId", "error"],
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let (key, _) = operation(state, record.get("operationId"), line, seq)?;
    let attempt_id = id(
        record.get("attemptId"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    validate_error(record.get("error"), line, seq)?;
    let attempt = state
        .attempts
        .get_mut(&attempt_id)
        .ok_or(SessionV2Corruption {
            code: CorruptionCode::InvalidReference,
            line,
            seq: Some(seq),
        })?;
    if attempt.operation_id != key
        || record.get("stepId").and_then(Value::as_str) != Some(&attempt.step_id)
        || attempt.closed
    {
        return fail(CorruptionCode::InvalidReference, line, Some(seq));
    }
    attempt.closed = true;
    attempt.failed = true;
    if let Some(attempts) = state.steps.get_mut(&attempt.step_id)
        && let Some(stored) = attempts
            .iter_mut()
            .find(|stored| stored.attempt_id == attempt_id)
    {
        stored.closed = true;
        stored.failed = true;
    }
    if let Some(Some(step)) = operation_step_mut(&mut state.public.operation)
        && step.attempt_id == attempt_id
    {
        step.status = "failed".into();
    }
    Ok(())
}

fn apply_tool_started(
    state: &mut InternalState,
    record: &JsonObject,
    line: usize,
    seq: u64,
    fact_id: &str,
) -> Result<()> {
    exact(
        record,
        &[
            "type",
            "operationId",
            "stepId",
            "assistantEntryId",
            "toolIndex",
            "toolCallId",
            "toolName",
            "arguments",
            "replay",
            "replayKey",
            "resultEntryId",
        ],
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let (key, found) = operation(state, record.get("operationId"), line, seq)?;
    if found.kind != "run"
        || !matches!(&state.public.operation, OperationState::Run { operation_id, .. } if operation_id == &key)
    {
        return fail(CorruptionCode::InvalidTransition, line, Some(seq));
    }
    let assistant_id = id(
        record.get("assistantEntryId"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let assistant_info = state
        .entries
        .get(&assistant_id)
        .cloned()
        .ok_or(SessionV2Corruption {
            code: CorruptionCode::InvalidReference,
            line,
            seq: Some(seq),
        })?;
    if assistant_info.entry.get("type").and_then(Value::as_str) != Some("message")
        || assistant_info
            .entry
            .get("stopReason")
            .and_then(Value::as_str)
            != Some("toolUse")
        || assistant_info.operation_id.as_deref() != Some(&key)
    {
        return fail(CorruptionCode::InvalidReference, line, Some(seq));
    }
    let tool_index = safe_integer(
        record.get("toolIndex"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
        0,
    )?;
    let message = parse_message(assistant_info.entry.get("message").unwrap(), line, seq)?;
    let call = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .and_then(|calls| calls.get(tool_index as usize));
    let call_id = string(
        record.get("toolCallId"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let tool_name = string(
        record.get("toolName"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    if call.and_then(|call| call.get("id")).and_then(Value::as_str) != Some(&call_id)
        || call
            .and_then(|call| call.pointer("/function/name"))
            .and_then(Value::as_str)
            != Some(&tool_name)
        || record.get("stepId").and_then(Value::as_str) != assistant_info.step_id.as_deref()
    {
        return fail(CorruptionCode::InvalidReference, line, Some(seq));
    }
    let pair = format!("{assistant_id}:{tool_index}");
    if !state.tool_pairs.insert(pair) {
        return fail(CorruptionCode::InvalidTransition, line, Some(seq));
    }
    let arguments = object(
        record.get("arguments").unwrap_or(&Value::Null),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let replay = string(
        record.get("replay"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let replay_key = string(
        record.get("replayKey"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    if !matches!(replay.as_str(), "safe" | "never") {
        return fail(CorruptionCode::InvalidFact, line, Some(seq));
    }
    let declaration = assistant_info
        .attempt_id
        .as_ref()
        .and_then(|attempt_id| state.attempts.get(attempt_id))
        .and_then(|attempt| {
            attempt
                .configuration_snapshot
                .tools
                .iter()
                .find(|tool| tool.name == tool_name)
        });
    if !declaration.is_some_and(|tool| tool.replay == replay && tool.replay_key == replay_key) {
        return fail(CorruptionCode::InvalidTransition, line, Some(seq));
    }
    let result_entry_id = reserve(state, record.get("resultEntryId"), line, seq, "toolResult")?;
    let tool = ToolCallState {
        operation_id: key,
        tool_started_id: fact_id.to_string(),
        step_id: assistant_info.step_id.unwrap(),
        assistant_entry_id: assistant_id,
        tool_index,
        tool_call_id: call_id,
        tool_name,
        arguments,
        replay,
        replay_key,
        result_entry_id,
        status: "pending".into(),
    };
    state.tools.insert(fact_id.to_string(), tool.clone());
    if let OperationState::Run { tool_calls, .. } = &mut state.public.operation {
        tool_calls.push(tool);
    }
    Ok(())
}

fn apply_abort_requested(
    state: &mut InternalState,
    record: &JsonObject,
    line: usize,
    seq: u64,
) -> Result<()> {
    exact(
        record,
        &[
            "type",
            "operationId",
            "operationKind",
            "phase",
            "toolCallId",
            "reason",
        ],
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let (key, found) = operation(state, record.get("operationId"), line, seq)?;
    let phase = string(
        record.get("phase"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    if record.get("operationKind").and_then(Value::as_str) != Some(&found.kind)
        || record.get("reason").and_then(Value::as_str) != Some("escape")
        || !matches!(phase.as_str(), "model" | "tool" | "compact")
        || ((phase == "tool") != record.get("toolCallId").is_some_and(Value::is_string))
        || operation_id(&state.public.operation) != Some(&key)
    {
        return fail(CorruptionCode::InvalidTransition, line, Some(seq));
    }
    let requested = match &mut state.public.operation {
        OperationState::Run {
            abort_requested, ..
        }
        | OperationState::Compaction {
            abort_requested, ..
        } => abort_requested,
        OperationState::Idle => return fail(CorruptionCode::InvalidTransition, line, Some(seq)),
    };
    if *requested {
        return fail(CorruptionCode::InvalidTransition, line, Some(seq));
    }
    *requested = true;
    Ok(())
}

fn apply_operation_finished(
    state: &mut InternalState,
    record: &JsonObject,
    line: usize,
    seq: u64,
) -> Result<()> {
    exact(
        record,
        &[
            "type",
            "operationId",
            "operationKind",
            "outcome",
            "finalEntryId",
            "error",
        ],
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let (key, found) = operation(state, record.get("operationId"), line, seq)?;
    let outcome = string(
        record.get("outcome"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    if record.get("operationKind").and_then(Value::as_str) != Some(&found.kind)
        || !matches!(outcome.as_str(), "completed" | "aborted" | "failed")
        || operation_id(&state.public.operation) != Some(&key)
    {
        return fail(CorruptionCode::InvalidTransition, line, Some(seq));
    }
    if outcome == "completed" {
        validate_completed_operation(state, record, line, seq, &key, &found)?;
    } else if outcome == "aborted" {
        let pending_tools = matches!(&state.public.operation, OperationState::Run { tool_calls, .. } if tool_calls.iter().any(|tool| tool.status == "pending"));
        let open_attempt = matches!(&state.public.operation, OperationState::Run { step: Some(step), .. } | OperationState::Compaction { step: Some(step), .. } if step.status == "attempting");
        let abort_requested = matches!(
            &state.public.operation,
            OperationState::Run {
                abort_requested: true,
                ..
            } | OperationState::Compaction {
                abort_requested: true,
                ..
            }
        );
        if record.contains_key("finalEntryId") || !abort_requested || pending_tools || open_attempt
        {
            return fail(CorruptionCode::InvalidTransition, line, Some(seq));
        }
    } else if record.contains_key("finalEntryId") {
        return fail(CorruptionCode::InvalidFact, line, Some(seq));
    }
    if outcome == "failed" {
        validate_error(record.get("error"), line, seq)?;
    } else if record.contains_key("error") {
        return fail(CorruptionCode::InvalidFact, line, Some(seq));
    }
    state.operations.get_mut(&key).unwrap().finished = true;
    state.public.operation = OperationState::Idle;
    Ok(())
}

fn validate_completed_operation(
    state: &InternalState,
    record: &JsonObject,
    line: usize,
    seq: u64,
    key: &str,
    found: &OperationInfo,
) -> Result<()> {
    let final_id = id(
        record.get("finalEntryId"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let info = state.entries.get(&final_id).ok_or(SessionV2Corruption {
        code: CorruptionCode::InvalidReference,
        line,
        seq: Some(seq),
    })?;
    if info.operation_id.as_deref() != Some(key) {
        return fail(CorruptionCode::InvalidReference, line, Some(seq));
    }
    let attempt = info
        .attempt_id
        .as_ref()
        .and_then(|attempt_id| state.attempts.get(attempt_id));
    if found.kind == "run" {
        if info.entry.get("type").and_then(Value::as_str) != Some("message")
            || info.entry.get("stopReason").and_then(Value::as_str) != Some("stop")
            || !attempt.is_some_and(|attempt| {
                !attempt.failed
                    && attempt.closed
                    && attempt.step_id == found.latest_step_id.clone().unwrap_or_default()
                    && attempt.settled_entry_id.as_deref() == Some(&final_id)
            })
        {
            return fail(CorruptionCode::InvalidReference, line, Some(seq));
        }
        let message = parse_message(info.entry.get("message").unwrap(), line, seq)?;
        if message.get("role").and_then(Value::as_str) != Some("assistant")
            || message
                .get("content")
                .and_then(Value::as_str)
                .is_none_or(|content| content.trim().is_empty())
            || matches!(&state.public.operation, OperationState::Run { tool_calls, .. } if tool_calls.iter().any(|tool| tool.status == "pending"))
        {
            return fail(CorruptionCode::InvalidTranscript, line, Some(seq));
        }
    } else if info.entry.get("type").and_then(Value::as_str) != Some("compaction")
        || found.result_entry_id.as_deref() != Some(&final_id)
        || !attempt.is_some_and(|attempt| {
            attempt.step_id == found.latest_step_id.clone().unwrap_or_default()
                && attempt.settled_entry_id.as_deref() == Some(&final_id)
        })
    {
        return fail(CorruptionCode::InvalidReference, line, Some(seq));
    }
    Ok(())
}

fn validate_error(value: Option<&Value>, line: usize, seq: u64) -> Result<()> {
    let error = object(
        value.unwrap_or(&Value::Null),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    exact(
        &error,
        &["code", "message"],
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    string(
        error.get("code"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    string(
        error.get("message"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    Ok(())
}

fn apply_usage(state: &mut InternalState, fact: &JsonObject, line: usize, seq: u64) -> Result<()> {
    exact(
        fact,
        &[
            "kind",
            "seq",
            "id",
            "timestamp",
            "operationId",
            "attemptId",
            "toolStartedId",
            "usage",
        ],
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    let operation_id = id(
        fact.get("operationId"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    if !state.operations.contains_key(&operation_id) {
        return fail(CorruptionCode::InvalidReference, line, Some(seq));
    }
    let has_attempt = fact.contains_key("attemptId");
    let has_tool = fact.contains_key("toolStartedId");
    if has_attempt == has_tool {
        return fail(CorruptionCode::InvalidFact, line, Some(seq));
    }
    if has_attempt {
        let attempt_id = id(
            fact.get("attemptId"),
            CorruptionCode::InvalidFact,
            line,
            Some(seq),
        )?;
        if state
            .attempts
            .get(&attempt_id)
            .is_none_or(|attempt| attempt.operation_id != operation_id)
        {
            return fail(CorruptionCode::InvalidReference, line, Some(seq));
        }
    } else {
        let tool_id = id(
            fact.get("toolStartedId"),
            CorruptionCode::InvalidFact,
            line,
            Some(seq),
        )?;
        if state
            .tools
            .get(&tool_id)
            .is_none_or(|tool| tool.operation_id != operation_id)
        {
            return fail(CorruptionCode::InvalidReference, line, Some(seq));
        }
    }
    let usage = object(
        fact.get("usage").unwrap_or(&Value::Null),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    exact(
        &usage,
        &["input", "output", "cacheRead", "cacheWrite"],
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
    )?;
    for key in ["input", "output", "cacheRead", "cacheWrite"] {
        let amount = safe_integer(
            usage.get(key),
            CorruptionCode::InvalidFact,
            line,
            Some(seq),
            0,
        )?;
        let total = match key {
            "input" => &mut state.public.usage.input,
            "output" => &mut state.public.usage.output,
            "cacheRead" => &mut state.public.usage.cache_read,
            "cacheWrite" => &mut state.public.usage.cache_write,
            _ => unreachable!(),
        };
        *total = total
            .checked_add(amount)
            .filter(|value| *value <= 9_007_199_254_740_991)
            .ok_or(SessionV2Corruption {
                code: CorruptionCode::InvalidFact,
                line,
                seq: Some(seq),
            })?;
    }
    Ok(())
}

fn apply_fact(state: &mut InternalState, value: &Value, line: usize) -> Result<()> {
    let fact = object(value, CorruptionCode::InvalidFact, line, None)?;
    let seq = safe_integer(fact.get("seq"), CorruptionCode::InvalidFact, line, None, 1)?;
    if seq != state.next_seq {
        return fail(CorruptionCode::SeqMismatch, line, Some(seq));
    }
    let fact_id = id(fact.get("id"), CorruptionCode::InvalidFact, line, Some(seq))?;
    safe_integer(
        fact.get("timestamp"),
        CorruptionCode::InvalidFact,
        line,
        Some(seq),
        0,
    )?;
    if state.ids.contains(&fact_id) {
        return fail(CorruptionCode::DuplicateId, line, Some(seq));
    }
    match fact.get("kind").and_then(Value::as_str) {
        Some("entry") => apply_entry(state, &fact, line, seq, &fact_id)?,
        Some("record") => apply_record(state, &fact, line, seq, &fact_id)?,
        Some("usage") => apply_usage(state, &fact, line, seq)?,
        _ => return fail(CorruptionCode::InvalidFact, line, Some(seq)),
    }
    if state.reserved_ids.contains_key(&fact_id) {
        return fail(CorruptionCode::DuplicateId, line, Some(seq));
    }
    state.ids.insert(fact_id);
    state.next_seq += 1;
    Ok(())
}

fn validate_transcript(messages: &[Value], line: usize, seq: Option<u64>) -> Result<()> {
    let mut pending = HashSet::new();
    for message in messages {
        match message.get("role").and_then(Value::as_str) {
            Some("assistant") => {
                if !pending.is_empty() {
                    return fail(CorruptionCode::InvalidTranscript, line, seq);
                }
                for call in message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    pending.insert(
                        call.get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    );
                }
            }
            Some("tool") => {
                let call_id = message
                    .get("tool_call_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !pending.remove(call_id) {
                    return fail(CorruptionCode::InvalidTranscript, line, seq);
                }
            }
            Some("user") if !pending.is_empty() => {
                return fail(CorruptionCode::InvalidTranscript, line, seq);
            }
            Some("user") => {}
            _ => return fail(CorruptionCode::InvalidTranscript, line, seq),
        }
    }
    Ok(())
}

fn validate_header(value: &Value, line: usize) -> Result<SessionHeader> {
    let header = object(value, CorruptionCode::InvalidHeader, line, None)?;
    exact(
        &header,
        &[
            "kind",
            "version",
            "id",
            "createdAt",
            "cwd",
            "provider",
            "model",
        ],
        CorruptionCode::InvalidHeader,
        line,
        None,
    )?;
    if header.get("kind").and_then(Value::as_str) != Some("header") {
        return fail(CorruptionCode::InvalidHeader, line, None);
    }
    if header.get("version").and_then(Value::as_u64) != Some(2) {
        return fail(CorruptionCode::UnsupportedVersion, line, None);
    }
    Ok(SessionHeader {
        id: id(header.get("id"), CorruptionCode::InvalidHeader, line, None)?,
        created_at: safe_integer(
            header.get("createdAt"),
            CorruptionCode::InvalidHeader,
            line,
            None,
            0,
        )?,
        cwd: string(header.get("cwd"), CorruptionCode::InvalidHeader, line, None)?,
        provider: string(
            header.get("provider"),
            CorruptionCode::InvalidHeader,
            line,
            None,
        )?,
        model: string(
            header.get("model"),
            CorruptionCode::InvalidHeader,
            line,
            None,
        )?,
    })
}

struct JsonScanner<'a> {
    source: &'a str,
    index: usize,
    line: usize,
}

impl JsonScanner<'_> {
    fn malformed<T>(&self) -> Result<T> {
        fail(CorruptionCode::MalformedJson, self.line, None)
    }

    fn whitespace(&mut self) {
        while self
            .source
            .as_bytes()
            .get(self.index)
            .is_some_and(u8::is_ascii_whitespace)
        {
            self.index += 1;
        }
    }

    fn string(&mut self) -> Result<String> {
        let start = self.index;
        if self.source.as_bytes().get(self.index) != Some(&b'"') {
            return self.malformed();
        }
        self.index += 1;
        while let Some(byte) = self.source.as_bytes().get(self.index).copied() {
            match byte {
                b'"' => {
                    self.index += 1;
                    return serde_json::from_str(&self.source[start..self.index]).map_err(|_| {
                        SessionV2Corruption {
                            code: CorruptionCode::MalformedJson,
                            line: self.line,
                            seq: None,
                        }
                    });
                }
                b'\\' => {
                    self.index += 1;
                    let Some(escape) = self.source.as_bytes().get(self.index).copied() else {
                        return self.malformed();
                    };
                    self.index += 1;
                    if escape != b'u' {
                        if !matches!(
                            escape,
                            b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't'
                        ) {
                            return self.malformed();
                        }
                        continue;
                    }
                    let high = self.hex_quad()?;
                    if (0xd800..=0xdbff).contains(&high) {
                        if self.source.as_bytes().get(self.index..self.index + 2) != Some(b"\\u") {
                            return self.malformed();
                        }
                        self.index += 2;
                        let low = self.hex_quad()?;
                        if !(0xdc00..=0xdfff).contains(&low) {
                            return self.malformed();
                        }
                    } else if (0xdc00..=0xdfff).contains(&high) {
                        return self.malformed();
                    }
                }
                0x00..=0x1f => return self.malformed(),
                0x20..=0x7f => self.index += 1,
                _ => {
                    let character =
                        self.source[self.index..]
                            .chars()
                            .next()
                            .ok_or(SessionV2Corruption {
                                code: CorruptionCode::MalformedJson,
                                line: self.line,
                                seq: None,
                            })?;
                    self.index += character.len_utf8();
                }
            }
        }
        self.malformed()
    }

    fn hex_quad(&mut self) -> Result<u16> {
        let end = self.index + 4;
        let Some(value) = self.source.get(self.index..end) else {
            return self.malformed();
        };
        if !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return self.malformed();
        }
        self.index = end;
        u16::from_str_radix(value, 16).map_err(|_| SessionV2Corruption {
            code: CorruptionCode::MalformedJson,
            line: self.line,
            seq: None,
        })
    }

    fn value(&mut self) -> Result<()> {
        self.whitespace();
        match self.source.as_bytes().get(self.index).copied() {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => self.string().map(|_| ()),
            Some(_) => self.primitive(),
            None => self.malformed(),
        }
    }

    fn object(&mut self) -> Result<()> {
        self.index += 1;
        self.whitespace();
        let mut keys = HashSet::new();
        if self.source.as_bytes().get(self.index) == Some(&b'}') {
            self.index += 1;
            return Ok(());
        }
        loop {
            self.whitespace();
            if !keys.insert(self.string()?) {
                return self.malformed();
            }
            self.whitespace();
            if self.source.as_bytes().get(self.index) != Some(&b':') {
                return self.malformed();
            }
            self.index += 1;
            self.value()?;
            self.whitespace();
            match self.source.as_bytes().get(self.index) {
                Some(b'}') => {
                    self.index += 1;
                    return Ok(());
                }
                Some(b',') => self.index += 1,
                _ => return self.malformed(),
            }
        }
    }

    fn array(&mut self) -> Result<()> {
        self.index += 1;
        self.whitespace();
        if self.source.as_bytes().get(self.index) == Some(&b']') {
            self.index += 1;
            return Ok(());
        }
        loop {
            self.value()?;
            self.whitespace();
            match self.source.as_bytes().get(self.index) {
                Some(b']') => {
                    self.index += 1;
                    return Ok(());
                }
                Some(b',') => self.index += 1,
                _ => return self.malformed(),
            }
        }
    }

    fn primitive(&mut self) -> Result<()> {
        let start = self.index;
        while self
            .source
            .as_bytes()
            .get(self.index)
            .is_some_and(|byte| !byte.is_ascii_whitespace() && !matches!(byte, b',' | b']' | b'}'))
        {
            self.index += 1;
        }
        serde_json::from_str::<Value>(&self.source[start..self.index])
            .map(|_| ())
            .map_err(|_| SessionV2Corruption {
                code: CorruptionCode::MalformedJson,
                line: self.line,
                seq: None,
            })
    }
}

fn scan_json(source: &str, line: usize) -> Result<()> {
    let mut scanner = JsonScanner {
        source,
        index: 0,
        line,
    };
    scanner.value()?;
    scanner.whitespace();
    if scanner.index != source.len() {
        return scanner.malformed();
    }
    Ok(())
}

fn parse_line(source: &[u8], line: usize) -> Result<Value> {
    if source.is_empty() {
        return fail(CorruptionCode::BlankLine, line, None);
    }
    if source.ends_with(b"\r") {
        return fail(CorruptionCode::CrlfNotAllowed, line, None);
    }
    let source = std::str::from_utf8(source).map_err(|_| SessionV2Corruption {
        code: CorruptionCode::MalformedJson,
        line,
        seq: None,
    })?;
    scan_json(source, line)?;
    serde_json::from_str(source).map_err(|_| SessionV2Corruption {
        code: CorruptionCode::MalformedJson,
        line,
        seq: None,
    })
}

pub fn reduce_session_v2(bytes: &[u8]) -> Result<SessionV2State> {
    let Some(last_lf) = bytes.iter().rposition(|byte| *byte == b'\n') else {
        return fail(CorruptionCode::MissingHeader, 1, None);
    };
    let committed = &bytes[..=last_lf];
    if let Some(index) = committed.windows(3).position(|bytes| {
        bytes[0] == 0xed && (0xa0..=0xbf).contains(&bytes[1]) && (0x80..=0xbf).contains(&bytes[2])
    }) {
        return fail(
            CorruptionCode::MalformedJson,
            committed[..index]
                .iter()
                .filter(|byte| **byte == b'\n')
                .count()
                + 1,
            None,
        );
    }
    if std::str::from_utf8(committed).is_err() {
        return fail(CorruptionCode::InvalidUtf8, 1, None);
    }
    let lines = committed[..committed.len() - 1]
        .split(|byte| *byte == b'\n')
        .collect::<Vec<_>>();
    if lines.first().is_none_or(|line| line.is_empty()) {
        return fail(CorruptionCode::MissingHeader, 1, None);
    }
    let header = validate_header(&parse_line(lines[0], 1)?, 1)?;
    let mut state = InternalState {
        public: SessionV2State {
            header,
            transcript: Vec::new(),
            active_context: Vec::new(),
            usage: SessionUsage {
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
            },
            operation: OperationState::Idle,
            repaired_length: last_lf + 1,
        },
        next_seq: 1,
        ids: HashSet::new(),
        reserved_ids: HashMap::new(),
        entries: HashMap::new(),
        entry_order: Vec::new(),
        operations: HashMap::new(),
        attempts: HashMap::new(),
        steps: HashMap::new(),
        tools: HashMap::new(),
        tool_pairs: HashSet::new(),
        active_context_through_entry_id: None,
    };
    for (index, source) in lines.iter().enumerate().skip(1) {
        let line = index + 1;
        let value = parse_line(source, line)?;
        let facts = match &value {
            Value::Array(values) if values.is_empty() => {
                return fail(CorruptionCode::EmptyTransaction, line, None);
            }
            Value::Array(values) => values.clone(),
            _ => vec![value],
        };
        let mut next = state.clone();
        for fact in &facts {
            apply_fact(&mut next, fact, line)?;
        }
        validate_transcript(&next.public.transcript, line, Some(next.next_seq - 1))?;
        state = next;
    }
    Ok(state.public)
}
