//! tiny-rs core: agent loop, tools, sessions, model calls, and compaction.
//! Mirrors the TypeScript (`tiny-ts`), Go (`tiny-go`), and Python (`tiny-py`)
//! implementations of tiny-agent.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::path::Path as FsPath;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Deserializer, Serialize};

use crate::lifecycle::ExecutionLifecycle;
use crate::session::ConditionalAppend;
pub use crate::session::Session;
use crate::session_recovery::{CurrentConfiguration, CurrentTool, plan_recovery};
use crate::session_reducer::OperationState;
use crate::session_runtime::{
    RuntimeConfiguration, RuntimeTool, abort_requested, assistant_entry, compaction_entry,
    operation_finished, project_idle, runtime_configuration, source_digest, start_compaction,
    start_run, step_attempt, step_failed, synthetic_tool_result, tool_declaration, tool_result,
    tool_started, usage,
};

pub mod lifecycle;
pub mod mcp;
pub mod session;
pub mod session_recovery;
pub mod session_reducer;
pub mod session_runtime;
pub mod telemetry;
pub mod terminal;

pub const DEFAULT_MODEL: &str = "openai/gpt-5.6-luna";
pub const DEFAULT_ENDPOINT: &str = "https://openrouter.ai/api/v1";
pub const MAX_TOOL_OUTPUT: usize = 50 * 1024;
pub const MAX_BASH_OUTPUT: usize = 10_000_000;
pub const BASH_TIMEOUT: u64 = 120;

pub fn model_name() -> String {
    match std::env::var("TINY_MODEL") {
        Ok(v) if !v.is_empty() => v,
        _ => DEFAULT_MODEL.to_string(),
    }
}

pub fn endpoint() -> String {
    match std::env::var("TINY_ENDPOINT") {
        Ok(v) if !v.is_empty() => v,
        _ => DEFAULT_ENDPOINT.to_string(),
    }
}

pub fn chat_completions_url(endpoint: &str) -> String {
    let trimmed = endpoint.trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        return trimmed.to_string();
    }
    format!("{trimmed}/chat/completions")
}

// ---------------------------------------------------------------------------
// Data types (serde for session persistence and model JSON)
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type", default = "fn_type")]
    pub r#type: String,
    pub function: ToolFunction,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: Option<String>,
    #[serde(rename = "tool_call_id", default)]
    pub tool_call_id: String,
    #[serde(rename = "tool_calls", default, deserialize_with = "null_default")]
    pub tool_calls: Vec<ToolCall>,
}

#[derive(Debug, Clone)]
pub struct ToolEvent {
    pub phase: String,
    pub name: String,
    pub args: ToolArgs,
    pub result: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ToolEdit {
    #[serde(rename = "oldText")]
    pub old_text: String,
    #[serde(rename = "newText")]
    pub new_text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct ToolArgs {
    #[serde(default)]
    pub command: String,
    #[serde(default = "fn_type")]
    pub r#type: String,
    #[serde(default = "default_timeout")]
    pub timeout: f64,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub content: String,
    #[serde(default = "default_one")]
    pub offset: i64,
    #[serde(default = "default_two_thousand")]
    pub limit: i64,
    #[serde(default)]
    pub edits: Vec<ToolEdit>,
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub tail: i64,
    #[serde(default)]
    pub status: String,
}

impl ToolArgs {
    pub fn from_json(text: &str) -> Result<ToolArgs, String> {
        if text.is_empty() {
            return Ok(ToolArgs::default_layout());
        }
        serde_json::from_str(text).map_err(|e| e.to_string())
    }
    fn default_layout() -> ToolArgs {
        ToolArgs {
            command: String::new(),
            r#type: "function".to_string(),
            timeout: BASH_TIMEOUT as f64,
            path: String::new(),
            content: String::new(),
            offset: 1,
            limit: 2_000,
            edits: Vec::new(),
            action: String::new(),
            id: String::new(),
            tail: 0,
            status: String::new(),
        }
    }
}

fn null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

fn fn_type() -> String {
    "function".to_string()
}
fn default_timeout() -> f64 {
    BASH_TIMEOUT as f64
}
fn default_one() -> i64 {
    1
}
fn default_two_thousand() -> i64 {
    2_000
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct UsageJSON {
    pub input: u64,
    pub output: u64,
    #[serde(rename = "cacheRead")]
    pub cache_read: u64,
    #[serde(rename = "cacheWrite")]
    pub cache_write: u64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct UsageState {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cache_hit_rate: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    Stop,
    Length,
    ToolUse,
}

#[derive(Debug, Clone)]
pub struct ModelData {
    pub message: Message,
    pub usage: UsageJSON,
    pub stop_reason: StopReason,
}

// ---------------------------------------------------------------------------
// formatting (TUI + usage)
// ---------------------------------------------------------------------------
pub fn format_tokens(n: u64) -> String {
    if n < 1_000 {
        n.to_string()
    } else if n < 10_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else if n < 1_000_000 {
        format!("{}k", n / 1_000)
    } else if n < 10_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else {
        format!("{}M", n / 1_000_000)
    }
}

pub fn format_usage(u: UsageState) -> String {
    let mut parts = vec![
        format!("↑{}", format_tokens(u.input)),
        format!("↓{}", format_tokens(u.output)),
    ];
    if u.cache_read > 0 {
        parts.push(format!("R{}", format_tokens(u.cache_read)));
    }
    if u.cache_write > 0 {
        parts.push(format!("W{}", format_tokens(u.cache_write)));
    }
    if (u.cache_read > 0 || u.cache_write > 0) && u.cache_hit_rate >= 0.0 {
        parts.push(format!("CH{:.1}%", u.cache_hit_rate));
    }
    parts.join(" ")
}

pub fn format_tool_event(event: ToolEvent) -> String {
    if event.phase == "end" {
        return if event.result.starts_with("Error:")
            || event.result == "Operation aborted"
            || event.result == "ok"
            || event.result == "(no output)"
        {
            format!("  └ {}", event.result)
        } else {
            format!("  └ {} chars", event.result.len())
        };
    }
    let mut target = if event.name == "bash" || event.name == "bg" {
        if event.args.command.is_empty() {
            event.args.id
        } else {
            event.args.command
        }
    } else {
        event.args.path
    };
    if target.len() > 80 {
        target = target.chars().take(77).collect::<String>() + "...";
    }
    let suffix = if event.name == "write" {
        format!(" ({} chars)", event.args.content.len())
    } else if event.name == "edit" {
        format!(" ({} blocks)", event.args.edits.len())
    } else {
        String::new()
    };
    let prefix = if target.is_empty() {
        String::new()
    } else {
        format!(" {}", target)
    };
    format!("◆ {}{}{}", event.name, prefix, suffix)
}

// ---------------------------------------------------------------------------
// system prompt / skills
// ---------------------------------------------------------------------------
pub fn load_project_instructions(cwd: &str) -> String {
    std::fs::read_to_string(join_path(cwd, "AGENTS.md")).unwrap_or_default()
}

fn build_system_prompt(cwd: &str, project: &str, list: &str) -> String {
    format!(
        "You are tiny-agent, a concise coding agent in {}. Use only the tools provided in this request. If the available tools cannot complete the task, explain the missing capability instead of calling an unavailable tool. Follow the project instructions below. When a task matches an available skill, use its location only when a provided tool can read it.\n\nFor implementation tasks, inspect only what is needed, then make the changes and run focused tests. Do not keep researching the same uncertainty when a mature dependency or direct implementation is available.\nUse the provided tool descriptions to choose the right capability. Not every run enables file access, shell access, or file modification.\nPrefer completing a small working implementation over exhaustively researching every option. If repeated experiments fail, reconsider the approach instead of making another similar attempt.{}\n\n<available_skills>\n{}\n</available_skills>",
        cwd, project, list
    )
}

fn find_skill_files(dir: &str, out: &mut Vec<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path().to_string_lossy().to_string();
        if let Ok(kind) = entry.file_type() {
            if kind.is_dir() {
                find_skill_files(&path, out);
            } else if entry.file_name().to_string_lossy() == "SKILL.md" {
                out.push(path);
            }
        }
    }
}

fn frontmatter(text: &str, key: &str) -> String {
    if !text.starts_with("---\n") {
        return String::new();
    }
    let end = match text[4..].find("\n---") {
        Some(i) => i,
        None => return String::new(),
    };
    for line in text[4..4 + end].split("\n") {
        let line = line.trim();
        if let Some(v) = line.strip_prefix(&format!("{}:", key)) {
            return v.trim().trim_matches(['"', '\'']).to_string();
        }
    }
    String::new()
}

pub fn load_skills(extra: Vec<String>, cwd: &str) -> Result<Vec<Skill>, String> {
    let mut files = Vec::new();
    find_skill_files(&join_path(cwd, ".tiny-agent/skills"), &mut files);
    for e in extra {
        if !files.contains(&e) {
            files.push(e);
        }
    }
    let mut seen: Vec<String> = Vec::new();
    let mut skills = Vec::new();
    for path in files {
        let abs = absolute(&path)?;
        if seen.contains(&abs) {
            continue;
        }
        seen.push(abs.clone());
        let text = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
        let mut name = frontmatter(&text, "name");
        if name.is_empty() {
            name = basename(&dir_name(&abs));
        }
        skills.push(Skill {
            name,
            description: frontmatter(&text, "description"),
            path: abs,
        });
    }
    skills.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(skills)
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------
#[derive(Clone)]
pub struct AbortHandle {
    session: Option<Session>,
    coordination: Arc<(Mutex<AbortCoordination>, Condvar)>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AbortCoordination {
    Waiting,
    DurableReady,
    NonDurable,
}

impl AbortHandle {
    pub fn request(&self) -> Result<(), String> {
        let Some(session) = &self.session else {
            return Ok(());
        };
        let (lock, ready) = &*self.coordination;
        let mut coordination = lock.lock().unwrap();
        loop {
            let state = session.load()?;
            if !matches!(state.operation, OperationState::Idle) {
                let (operation_id, operation_kind, phase, tool_call_id, requested) =
                    match state.operation {
                        OperationState::Run {
                            operation_id,
                            tool_calls,
                            abort_requested,
                            ..
                        } => {
                            let pending = tool_calls
                                .iter()
                                .filter(|tool| tool.status == "pending")
                                .min_by_key(|tool| tool.tool_index);
                            (
                                operation_id,
                                "run",
                                if pending.is_some() { "tool" } else { "model" },
                                pending.map(|tool| tool.tool_call_id.clone()),
                                abort_requested,
                            )
                        }
                        OperationState::Compaction {
                            operation_id,
                            abort_requested,
                            ..
                        } => (operation_id, "compaction", "compact", None, abort_requested),
                        OperationState::Idle => unreachable!(),
                    };
                if !requested {
                    session.append_abort_if_active(
                        &operation_id,
                        abort_requested(
                            &uuid7(),
                            &operation_id,
                            operation_kind,
                            phase,
                            tool_call_id.as_deref(),
                        ),
                    )?;
                }
                return Ok(());
            }
            if *coordination == AbortCoordination::NonDurable
                || *coordination == AbortCoordination::DurableReady
            {
                return Ok(());
            }
            coordination = ready.wait(coordination).unwrap();
        }
    }
}

struct DurableExecution {
    content: String,
    aborted: bool,
}

pub struct Agent {
    pub messages: Vec<Message>,
    pub usage: UsageState,
    pub skills: Vec<Skill>,
    pub session: Option<Session>,
    pub cancel: Arc<AtomicBool>,
    pub endpoint: String,
    pub client: Arc<ureq::Agent>,
    pub on_tool: Arc<dyn Fn(ToolEvent) + Send + Sync>,
    pub on_event: Arc<dyn Fn(serde_json::Value) + Send + Sync>,
    pub lifecycle: Arc<ExecutionLifecycle>,
    pub cwd: String,
    pub local_tools: Vec<String>,
    pub mcp_tools: Vec<mcp::McpTool>,
    recovering: bool,
    abort_coordination: Arc<(Mutex<AbortCoordination>, Condvar)>,
}

pub fn new_agent(
    skills: Vec<Skill>,
    session: Option<Session>,
    instructions: String,
    cwd: &str,
) -> Agent {
    let mut list = skills
        .iter()
        .map(format_skill)
        .collect::<Vec<_>>()
        .join("\n");
    if list.is_empty() {
        list = "(none)".to_string();
    }
    let project = if instructions.is_empty() {
        String::new()
    } else {
        format!(
            "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path=\"{}\">\n{}\n</project_instructions>\n\n</project_context>",
            join_path(cwd, "AGENTS.md"),
            instructions
        )
    };
    let prompt = build_system_prompt(cwd, &project, &list);
    Agent {
        messages: vec![Message {
            role: "system".to_string(),
            content: Some(prompt),
            tool_call_id: String::new(),
            tool_calls: Vec::new(),
        }],
        usage: UsageState::default(),
        skills,
        session,
        cancel: Arc::new(AtomicBool::new(false)),
        endpoint: chat_completions_url(&endpoint()),
        client: Arc::new(open_router_agent()),
        on_tool: Arc::new(|_| {}),
        on_event: Arc::new(|_| {}),
        lifecycle: ExecutionLifecycle::new(Vec::new()),
        cwd: cwd.to_string(),
        local_tools: local_tool_names()
            .iter()
            .map(|name| (*name).to_string())
            .collect(),
        mcp_tools: Vec::new(),
        recovering: false,
        abort_coordination: Arc::new((Mutex::new(AbortCoordination::NonDurable), Condvar::new())),
    }
}

fn format_skill(s: &Skill) -> String {
    format!(
        "<skill>\n<name>{}</name>\n<description>{}</description>\n<location>{}</location>\n</skill>",
        s.name, s.description, s.path
    )
}

fn open_router_agent() -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(120)))
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_send_request(Some(Duration::from_secs(30)))
        .timeout_send_body(Some(Duration::from_secs(30)))
        .timeout_recv_response(Some(Duration::from_secs(120)))
        .timeout_recv_body(Some(Duration::from_secs(120)))
        .build();
    ureq::Agent::new_with_config(config)
}

fn api_key() -> String {
    match std::env::var("OPENROUTER_API_KEY") {
        Ok(v) if !v.is_empty() => v,
        _ => String::new(),
    }
}

pub fn timestamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    timestamp_at(millis)
}

pub(crate) fn timestamp_at(millis: u64) -> String {
    let seconds = (millis / 1000) as i64;
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_date(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        day_seconds / 3_600,
        day_seconds / 60 % 60,
        day_seconds % 60,
        millis % 1000,
    )
}

fn civil_date(days_since_epoch: i64) -> (i64, i64, i64) {
    let days = days_since_epoch + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_piece = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_piece + 2) / 5 + 1;
    let month = month_piece + if month_piece < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

fn operation_identity(operation: &OperationState) -> Option<(&str, &str)> {
    match operation {
        OperationState::Run { operation_id, .. } => Some((operation_id, "run")),
        OperationState::Compaction { operation_id, .. } => Some((operation_id, "compaction")),
        OperationState::Idle => None,
    }
}

fn operation_attempt_id(operation: &OperationState) -> Option<&str> {
    match operation {
        OperationState::Run { step, .. } | OperationState::Compaction { step, .. } => {
            step.as_ref().map(|value| value.attempt_id.as_str())
        }
        OperationState::Idle => None,
    }
}

impl Agent {
    pub fn set_lifecycle(&mut self, lifecycle: Arc<ExecutionLifecycle>) {
        if let Some(session) = &self.session {
            let commits = lifecycle.clone();
            session.observe_commits(Arc::new(move |facts| commits.committed(facts)));
        }
        self.lifecycle = lifecycle;
    }

    pub fn abort_handle(&self) -> AbortHandle {
        if let Ok(mut state) = self.abort_coordination.0.lock() {
            *state = AbortCoordination::Waiting;
        }
        AbortHandle {
            session: self.session.clone(),
            coordination: self.abort_coordination.clone(),
        }
    }

    fn publish_abort_coordination(&self, state: AbortCoordination) {
        let (lock, ready) = &*self.abort_coordination;
        *lock.lock().unwrap() = state;
        ready.notify_all();
    }

    fn abort_was_requested(&self) -> Result<bool, String> {
        let Some(session) = &self.session else {
            return Ok(false);
        };
        Ok(matches!(
            session.load()?.operation,
            OperationState::Run {
                abort_requested: true,
                ..
            } | OperationState::Compaction {
                abort_requested: true,
                ..
            }
        ))
    }

    fn record_interruption(&self, _phase: &str, _tool_call_id: &str) -> Result<(), String> {
        Ok(())
    }

    fn runtime_configuration(&self) -> RuntimeConfiguration {
        let mut definitions =
            serde_json::from_str::<Vec<serde_json::Value>>(tool_definitions_json())
                .unwrap_or_default();
        definitions.retain(|definition| {
            definition
                .pointer("/function/name")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|name| self.local_tools.iter().any(|selected| selected == name))
        });
        definitions.extend(self.mcp_tools.iter().map(|tool| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                }
            })
        }));
        let tools = definitions
            .into_iter()
            .map(|definition| {
                let name = definition
                    .pointer("/function/name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let implementation = if self.local_tools.iter().any(|selected| selected == &name) {
                    "builtin"
                } else {
                    "mcp"
                };
                RuntimeTool {
                    replay_key: format!("{implementation}:{name}:v1"),
                    name,
                    definition,
                    replay: "never".into(),
                }
            })
            .map(|mut tool| {
                if tool.name == "read" {
                    tool.replay = "safe".into();
                    tool.replay_key = "builtin:read:v1".into();
                }
                tool
            })
            .collect();
        runtime_configuration(
            &model_name(),
            self.messages[0].content.as_deref().unwrap_or_default(),
            tools,
            "openrouter:chat-completions:v1",
            &format!("openrouter:{}", model_name()),
        )
    }

    fn run_durable_model(&mut self, input: &str) -> Result<String, String> {
        let (coordination_lock, ready) = &*self.abort_coordination;
        let mut coordination = coordination_lock.lock().unwrap();
        self.cancel.store(false, Ordering::SeqCst);
        let user_entry_id = uuid7();
        let operation_id = uuid7();
        let started = self.session.as_ref().unwrap().append(start_run(
            &user_entry_id,
            &uuid7(),
            &operation_id,
            input,
        ));
        if let Err(error) = started {
            *coordination = AbortCoordination::NonDurable;
            ready.notify_all();
            return Err(error);
        }
        *coordination = AbortCoordination::DurableReady;
        ready.notify_all();
        drop(coordination);
        self.messages.push(Message {
            role: "user".into(),
            content: Some(input.into()),
            tool_call_id: String::new(),
            tool_calls: Vec::new(),
        });
        self.run_durable_operation(&operation_id, &user_entry_id, None, 1)
    }

    fn run_durable_operation(
        &mut self,
        operation_id: &str,
        context_entry_id: &str,
        existing_step_id: Option<&str>,
        attempt: u64,
    ) -> Result<String, String> {
        let mut context_entry_id = context_entry_id.to_string();
        let mut existing_step_id = existing_step_id.map(str::to_string);
        let mut attempt = attempt;
        loop {
            let step_id = existing_step_id.take().unwrap_or_else(uuid7);
            let attempt_id = uuid7();
            let configuration = self.runtime_configuration();
            self.session.as_ref().unwrap().append(vec![step_attempt(
                &uuid7(),
                operation_id,
                &step_id,
                &attempt_id,
                "assistant",
                attempt,
                &context_entry_id,
                &configuration,
            )])?;

            let messages = self.messages.clone();
            let data = match self.call_model(&messages, true, true) {
                Ok(data) => data,
                Err(error) => {
                    if self.cancel.load(Ordering::SeqCst) {
                        let mut facts = Vec::new();
                        if !self.abort_was_requested()? {
                            facts.push(abort_requested(
                                &uuid7(),
                                operation_id,
                                "run",
                                "model",
                                None,
                            ));
                        }
                        facts.extend([
                            step_failed(
                                &uuid7(),
                                operation_id,
                                &step_id,
                                &attempt_id,
                                "aborted",
                                &error,
                            ),
                            operation_finished(
                                &uuid7(),
                                operation_id,
                                "run",
                                "aborted",
                                None,
                                None,
                            ),
                        ]);
                        self.session.as_ref().unwrap().append(facts)?;
                        return Ok("Operation aborted.".into());
                    }
                    self.session.as_ref().unwrap().append(vec![
                        step_failed(
                            &uuid7(),
                            operation_id,
                            &step_id,
                            &attempt_id,
                            "model_error",
                            &error,
                        ),
                        operation_finished(
                            &uuid7(),
                            operation_id,
                            "run",
                            "failed",
                            None,
                            Some(("model_error", &error)),
                        ),
                    ])?;
                    return Err(error);
                }
            };

            let answer = data.message.clone();
            let answer_id = uuid7();
            let stop_reason = stop_reason_name(data.stop_reason);
            self.session.as_ref().unwrap().append(vec![
                assistant_entry(&answer_id, &step_id, &attempt_id, stop_reason, &answer),
                usage(&uuid7(), operation_id, Some(&attempt_id), None, data.usage),
            ])?;
            self.messages.push(answer.clone());

            if answer.tool_calls.is_empty() {
                let content = answer.content.unwrap_or_default();
                if data.stop_reason == StopReason::Stop && !content.trim().is_empty() {
                    self.session
                        .as_ref()
                        .unwrap()
                        .append(vec![operation_finished(
                            &uuid7(),
                            operation_id,
                            "run",
                            "completed",
                            Some(&answer_id),
                            None,
                        )])?;
                    return Ok(content);
                }
                let message = if content.trim().is_empty() {
                    format!("Model returned an empty response (finish_reason: {stop_reason}).")
                } else {
                    "Model response was truncated by the token limit.".into()
                };
                self.session
                    .as_ref()
                    .unwrap()
                    .append(vec![operation_finished(
                        &uuid7(),
                        operation_id,
                        "run",
                        "failed",
                        None,
                        Some(("model_length", &message)),
                    )])?;
                return Err(message);
            }

            let (aborted, result_entry_id) = self.run_durable_tools(
                operation_id,
                &step_id,
                &answer_id,
                &answer.tool_calls,
                data.stop_reason,
                &configuration,
            )?;
            if aborted {
                return Ok("Operation aborted.".into());
            }
            context_entry_id = result_entry_id;
            attempt = 1;
        }
    }

    fn run_durable_tools(
        &mut self,
        operation_id: &str,
        step_id: &str,
        assistant_entry_id: &str,
        calls: &[ToolCall],
        stop_reason: StopReason,
        configuration: &RuntimeConfiguration,
    ) -> Result<(bool, String), String> {
        let mut result_entry_id = String::new();
        for (index, call) in calls.iter().enumerate() {
            if stop_reason == StopReason::Length {
                result_entry_id = self.append_pre_execution_result(
                    step_id,
                    assistant_entry_id,
                    index,
                    call,
                    "truncated",
                    crate::session_recovery::SYNTHETIC_TRUNCATED,
                )?;
                continue;
            }
            let Some(declaration) = tool_declaration(configuration, &call.function.name) else {
                result_entry_id = self.append_pre_execution_result(
                    step_id,
                    assistant_entry_id,
                    index,
                    call,
                    "unknownTool",
                    crate::session_recovery::SYNTHETIC_UNKNOWN_TOOL,
                )?;
                continue;
            };
            let Ok(serde_json::Value::Object(arguments)) =
                serde_json::from_str::<serde_json::Value>(&call.function.arguments)
            else {
                result_entry_id = self.append_pre_execution_result(
                    step_id,
                    assistant_entry_id,
                    index,
                    call,
                    "invalidArguments",
                    crate::session_recovery::SYNTHETIC_INVALID_ARGUMENTS,
                )?;
                continue;
            };
            let parsed = if self
                .mcp_tools
                .iter()
                .any(|tool| tool.name == call.function.name)
            {
                Ok(ToolArgs::default_layout())
            } else {
                ToolArgs::from_json(&call.function.arguments)
            };
            let Ok(args) = parsed else {
                result_entry_id = self.append_pre_execution_result(
                    step_id,
                    assistant_entry_id,
                    index,
                    call,
                    "invalidArguments",
                    crate::session_recovery::SYNTHETIC_INVALID_ARGUMENTS,
                )?;
                continue;
            };
            let started_id = uuid7();
            let result_id = uuid7();
            let environment = crate::session::environment_identity(FsPath::new(&self.cwd))?;
            let mut aborted_facts = calls
                .iter()
                .enumerate()
                .skip(index)
                .map(|(pending_index, pending)| {
                    synthetic_tool_result(
                        &uuid7(),
                        step_id,
                        assistant_entry_id,
                        pending_index as u64,
                        &pending.id,
                        &pending.function.name,
                        crate::session_recovery::SYNTHETIC_ABORTED,
                        "aborted",
                    )
                })
                .collect::<Vec<_>>();
            aborted_facts.push(operation_finished(
                &uuid7(),
                operation_id,
                "run",
                "aborted",
                None,
                None,
            ));
            let started = self
                .session
                .as_ref()
                .unwrap()
                .append_unless_abort_requested(
                    vec![tool_started(
                        &started_id,
                        operation_id,
                        step_id,
                        assistant_entry_id,
                        index as u64,
                        &call.id,
                        &call.function.name,
                        arguments.clone(),
                        declaration,
                        &environment,
                        &result_id,
                    )],
                    aborted_facts,
                )?;
            if !started {
                return Ok((true, result_id));
            }
            if self.abort_was_requested()? {
                let mut facts = vec![tool_result(
                    &result_id,
                    step_id,
                    &started_id,
                    &call.id,
                    &call.function.name,
                    crate::session_recovery::SYNTHETIC_INTERRUPTED,
                    "synthetic",
                )];
                for (pending_index, pending) in calls.iter().enumerate().skip(index + 1) {
                    facts.push(synthetic_tool_result(
                        &uuid7(),
                        step_id,
                        assistant_entry_id,
                        pending_index as u64,
                        &pending.id,
                        &pending.function.name,
                        crate::session_recovery::SYNTHETIC_ABORTED,
                        "aborted",
                    ));
                }
                facts.push(operation_finished(
                    &uuid7(),
                    operation_id,
                    "run",
                    "aborted",
                    None,
                    None,
                ));
                self.session.as_ref().unwrap().append(facts)?;
                return Ok((true, result_id));
            }
            let execution = self.execute_durable_tool(
                operation_id,
                step_id,
                &started_id,
                &result_id,
                &call.id,
                &call.function.name,
                arguments,
                args,
            )?;
            if execution.aborted {
                let mut facts = Vec::new();
                for (pending_index, pending) in calls.iter().enumerate().skip(index + 1) {
                    facts.push(synthetic_tool_result(
                        &uuid7(),
                        step_id,
                        assistant_entry_id,
                        pending_index as u64,
                        &pending.id,
                        &pending.function.name,
                        crate::session_recovery::SYNTHETIC_ABORTED,
                        "aborted",
                    ));
                }
                facts.push(operation_finished(
                    &uuid7(),
                    operation_id,
                    "run",
                    "aborted",
                    None,
                    None,
                ));
                self.session.as_ref().unwrap().append(facts)?;
                return Ok((true, result_id));
            }
            result_entry_id = result_id;
            self.messages.push(Message {
                role: "tool".into(),
                content: Some(execution.content),
                tool_call_id: call.id.clone(),
                tool_calls: Vec::new(),
            });
        }
        Ok((false, result_entry_id))
    }

    #[allow(clippy::too_many_arguments)]
    fn execute_durable_tool(
        &mut self,
        operation_id: &str,
        step_id: &str,
        started_id: &str,
        result_id: &str,
        tool_call_id: &str,
        name: &str,
        arguments: serde_json::Map<String, serde_json::Value>,
        args: ToolArgs,
    ) -> Result<DurableExecution, String> {
        let physical_attempt_id = uuid7();
        let state = self.session.as_ref().unwrap().load()?;
        let parent_attempt_id = operation_attempt_id(&state.operation)
            .unwrap_or_default()
            .to_string();
        let recovery = self.recovering;
        self.lifecycle.observe(serde_json::json!({
            "type":"tool.started", "timestamp":timestamp(), "operationId":operation_id,
            "stepId":step_id, "attemptId":physical_attempt_id, "parentAttemptId":parent_attempt_id,
            "toolStartedId":started_id, "toolCallId":tool_call_id, "tool":name, "recovery":recovery,
        }));
        (self.on_tool.as_ref())(ToolEvent {
            phase: "start".into(),
            name: name.into(),
            args: args.clone(),
            result: String::new(),
        });
        let result = if let Some(tool) = self.mcp_tools.iter().find(|tool| tool.name == name) {
            tool.execute(serde_json::Value::Object(arguments), &self.cancel)
        } else {
            self.execute_tool(name, &args)
        };
        let aborted = self.cancel.load(Ordering::SeqCst);
        if aborted && !self.abort_was_requested()? {
            self.session.as_ref().unwrap().append(vec![abort_requested(
                &uuid7(),
                operation_id,
                "run",
                "tool",
                Some(tool_call_id),
            )])?;
        }
        let (content, result_type) = if aborted {
            (
                crate::session_recovery::SYNTHETIC_INTERRUPTED.to_string(),
                "synthetic",
            )
        } else {
            match result {
                Ok(content) => (content, "success"),
                Err(error) => (format!("Error: {error}"), "error"),
            }
        };
        (self.on_tool.as_ref())(ToolEvent {
            phase: "end".into(),
            name: name.into(),
            args,
            result: content.clone(),
        });
        self.session.as_ref().unwrap().append(vec![tool_result(
            result_id,
            step_id,
            started_id,
            tool_call_id,
            name,
            &content,
            result_type,
        )])?;
        Ok(DurableExecution { content, aborted })
    }

    fn append_pre_execution_result(
        &mut self,
        step_id: &str,
        assistant_entry_id: &str,
        index: usize,
        call: &ToolCall,
        reason: &str,
        content: &str,
    ) -> Result<String, String> {
        let entry_id = uuid7();
        self.session
            .as_ref()
            .unwrap()
            .append(vec![synthetic_tool_result(
                &entry_id,
                step_id,
                assistant_entry_id,
                index as u64,
                &call.id,
                &call.function.name,
                content,
                reason,
            )])?;
        self.messages.push(Message {
            role: "tool".into(),
            content: Some(content.into()),
            tool_call_id: call.id.clone(),
            tool_calls: Vec::new(),
        });
        Ok(entry_id)
    }

    pub fn resume_session(&mut self) -> Result<(), String> {
        if self.session.is_none() {
            return Ok(());
        }
        let system_prompt = self.messages[0].content.clone().unwrap_or_default();
        if matches!(
            self.session.as_ref().unwrap().load()?.operation,
            OperationState::Idle
        ) {
            let state = self.session.as_ref().unwrap().load()?;
            let projection = project_idle(&state, &system_prompt)?;
            self.messages = projection.messages;
            self.usage = projection.usage;
            self.restore_latest_cache_hit_rate()?;
            return Ok(());
        }
        self.recovering = true;
        let recovery = self.recover_session();
        self.recovering = false;
        recovery?;
        let state = self.session.as_ref().unwrap().load()?;
        let projection = project_idle(&state, &system_prompt)?;
        self.messages = projection.messages;
        self.usage = projection.usage;
        self.restore_latest_cache_hit_rate()?;
        Ok(())
    }

    fn restore_latest_cache_hit_rate(&mut self) -> Result<(), String> {
        let Some(request) = self
            .session
            .as_ref()
            .map(Session::latest_assistant_usage)
            .transpose()?
            .flatten()
        else {
            return Ok(());
        };
        let prompt = request.input + request.cache_read + request.cache_write;
        if prompt > 0 {
            self.usage.cache_hit_rate = request.cache_read as f64 / prompt as f64 * 100.0;
        }
        Ok(())
    }

    fn recover_session(&mut self) -> Result<(), String> {
        let state = self.session.as_ref().unwrap().load()?;
        if let Some((operation_id, operation_kind)) = operation_identity(&state.operation) {
            self.lifecycle.observe(serde_json::json!({
                "type":"recovery.attached", "timestamp":timestamp(),
                "operationId":operation_id, "operationKind":operation_kind,
            }));
        }
        loop {
            let state = self.session.as_ref().unwrap().load()?;
            if matches!(state.operation, OperationState::Idle) {
                return Ok(());
            }
            let configuration = self.runtime_configuration();
            let environment = crate::session::environment_identity(FsPath::new(&self.cwd))?;
            let current = CurrentConfiguration {
                configuration_digest: configuration.digest.clone(),
                environment_identity: environment.clone(),
                tools: configuration
                    .tools
                    .iter()
                    .map(|tool| CurrentTool {
                        name: tool.name.clone(),
                        definition_digest: configuration
                            .snapshot
                            .tools
                            .iter()
                            .find(|item| item.name == tool.name)
                            .map(|item| item.definition_digest.clone())
                            .unwrap_or_default(),
                        replay: tool.replay.clone(),
                        replay_key: tool.replay_key.clone(),
                    })
                    .collect(),
            };
            let action = plan_recovery(&state, &current);
            let action_type = action["type"].as_str().unwrap_or_default();
            let (operation_id, operation_kind) = match &state.operation {
                OperationState::Run { operation_id, .. } => (operation_id.as_str(), "run"),
                OperationState::Compaction { operation_id, .. } => {
                    (operation_id.as_str(), "compaction")
                }
                OperationState::Idle => return Ok(()),
            };
            match action_type {
                "blocked" => {
                    return Err(format!(
                        "Session recovery blocked: {}",
                        action["reason"].as_str().unwrap_or("unknown")
                    ));
                }
                "closeAttempt" => {
                    let step = match &state.operation {
                        OperationState::Run {
                            step: Some(step), ..
                        }
                        | OperationState::Compaction {
                            step: Some(step), ..
                        } => step,
                        _ => return Err("Session recovery attempt missing".into()),
                    };
                    self.session.as_ref().unwrap().append(vec![step_failed(
                        &uuid7(),
                        operation_id,
                        &step.step_id,
                        &step.attempt_id,
                        action["error"]["code"].as_str().unwrap_or("aborted"),
                        action["error"]["message"]
                            .as_str()
                            .unwrap_or("Operation aborted"),
                    )])?;
                }
                "appendSynthetic" => {
                    let step_id = match &state.operation {
                        OperationState::Run {
                            step: Some(step), ..
                        } => step.step_id.clone(),
                        _ => return Err("Session recovery step missing".into()),
                    };
                    let facts = action["results"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|result| {
                            let reason = result["reason"].as_str().unwrap_or("interrupted");
                            if let Some(started_id) = result["toolStartedId"].as_str() {
                                tool_result(
                                    result["resultEntryId"].as_str().unwrap_or_default(),
                                    &step_id,
                                    started_id,
                                    result["toolCallId"].as_str().unwrap_or_default(),
                                    result["toolName"].as_str().unwrap_or_default(),
                                    result["content"].as_str().unwrap_or_default(),
                                    "synthetic",
                                )
                            } else {
                                synthetic_tool_result(
                                    &uuid7(),
                                    &step_id,
                                    result["assistantEntryId"].as_str().unwrap_or_default(),
                                    result["toolIndex"].as_u64().unwrap_or_default(),
                                    result["toolCallId"].as_str().unwrap_or_default(),
                                    result["toolName"].as_str().unwrap_or_default(),
                                    result["content"].as_str().unwrap_or_default(),
                                    reason,
                                )
                            }
                        })
                        .collect();
                    self.session.as_ref().unwrap().append(facts)?;
                }
                "startTool" => {
                    if operation_kind != "run" {
                        return Err("Compaction recovery is not implemented".into());
                    }
                    let name = action["toolName"].as_str().unwrap_or_default();
                    let Some(declaration) = tool_declaration(&configuration, name) else {
                        return Err("Session recovery tool declaration missing".into());
                    };
                    let arguments = action["arguments"]
                        .as_object()
                        .cloned()
                        .ok_or_else(|| "Session recovery tool arguments missing".to_string())?;
                    let args: ToolArgs =
                        serde_json::from_value(serde_json::Value::Object(arguments.clone()))
                            .map_err(|error| error.to_string())?;
                    let tool = match &state.operation {
                        OperationState::Run {
                            step: Some(step),
                            tool_calls,
                            ..
                        } => {
                            let existing = action["toolStartedId"].as_str().and_then(|id| {
                                tool_calls.iter().find(|tool| tool.tool_started_id == id)
                            });
                            (
                                step.step_id.clone(),
                                existing
                                    .map(|tool| tool.tool_call_id.clone())
                                    .unwrap_or_else(|| {
                                        state
                                            .transcript
                                            .iter()
                                            .rev()
                                            .find_map(|message| {
                                                message["tool_calls"]
                                            .as_array()?
                                            .get(action["toolIndex"].as_u64()? as usize)?["id"]
                                            .as_str()
                                            .map(str::to_string)
                                            })
                                            .unwrap_or_default()
                                    }),
                                existing.map(|tool| tool.tool_started_id.clone()),
                                existing.map(|tool| tool.result_entry_id.clone()),
                            )
                        }
                        _ => return Err("Session recovery run step missing".into()),
                    };
                    let started_id = tool.2.unwrap_or_else(uuid7);
                    let result_id = tool.3.unwrap_or_else(uuid7);
                    if action["mode"] == "start" {
                        let started = self
                            .session
                            .as_ref()
                            .unwrap()
                            .append_unless_abort_requested(
                                vec![tool_started(
                                    &started_id,
                                    operation_id,
                                    &tool.0,
                                    action["assistantEntryId"].as_str().unwrap_or_default(),
                                    action["toolIndex"].as_u64().unwrap_or_default(),
                                    &tool.1,
                                    name,
                                    arguments.clone(),
                                    declaration,
                                    &environment,
                                    &result_id,
                                )],
                                Vec::new(),
                            )?;
                        if !started {
                            continue;
                        }
                    }
                    if self.abort_was_requested()? {
                        continue;
                    }
                    self.execute_durable_tool(
                        operation_id,
                        &tool.0,
                        &started_id,
                        &result_id,
                        &tool.1,
                        name,
                        arguments,
                        args,
                    )?;
                }
                "startStep" => {
                    if operation_kind == "compaction" {
                        self.run_compaction_attempt(
                            operation_id,
                            action["contextThroughEntryId"].as_str().unwrap_or_default(),
                            action["stepId"].as_str(),
                            action["attempt"].as_u64().unwrap_or(1),
                        )?;
                        continue;
                    }
                    self.messages = vec![Message {
                        role: "system".into(),
                        content: self.messages[0].content.clone(),
                        tool_call_id: String::new(),
                        tool_calls: Vec::new(),
                    }];
                    for message in &state.active_context {
                        self.messages.push(
                            serde_json::from_value(message.clone())
                                .map_err(|error| error.to_string())?,
                        );
                    }
                    self.run_durable_operation(
                        operation_id,
                        action["contextThroughEntryId"].as_str().unwrap_or_default(),
                        action["stepId"].as_str(),
                        action["attempt"].as_u64().unwrap_or(1),
                    )?;
                }
                "finish" => {
                    let outcome = action["outcome"].as_str().unwrap_or("failed");
                    let error = action.get("error").map(|error| {
                        (
                            error["code"].as_str().unwrap_or("recovery_error"),
                            error["message"]
                                .as_str()
                                .unwrap_or("Session recovery failed"),
                        )
                    });
                    let finished = operation_finished(
                        &uuid7(),
                        operation_id,
                        operation_kind,
                        outcome,
                        action["finalEntryId"].as_str(),
                        error,
                    );
                    if operation_kind == "compaction" && outcome == "completed" {
                        self.session
                            .as_ref()
                            .unwrap()
                            .finish_compaction(operation_id, finished)?;
                    } else {
                        self.session.as_ref().unwrap().append(vec![finished])?;
                    }
                }
                _ => return Err(format!("Unknown session recovery action: {action_type}")),
            }
        }
    }

    fn reproject_idle_session(&mut self) -> Result<(), String> {
        let session = self.session.as_ref().unwrap();
        let state = session.load()?;
        if !matches!(state.operation, OperationState::Idle) {
            return Ok(());
        }
        let projection = project_idle(
            &state,
            self.messages[0].content.as_deref().unwrap_or_default(),
        )?;
        self.messages = projection.messages;
        self.usage = projection.usage;
        self.restore_latest_cache_hit_rate()?;
        Ok(())
    }

    fn add_usage(&mut self, u: UsageJSON, cache_rate: bool) {
        self.usage.input += u.input;
        self.usage.output += u.output;
        self.usage.cache_read += u.cache_read;
        self.usage.cache_write += u.cache_write;
        let prompt = u.input + u.cache_read + u.cache_write;
        if cache_rate && prompt > 0 {
            self.usage.cache_hit_rate = u.cache_read as f64 / prompt as f64 * 100.0;
        }
    }

    fn model_request(
        &mut self,
        messages: &[Message],
        tools: bool,
        update_cache_rate: bool,
    ) -> Result<Option<ModelData>, String> {
        match self.call_model(messages, tools, update_cache_rate) {
            Ok(data) => Ok(Some(data)),
            Err(e) => {
                if self.cancel.load(Ordering::SeqCst) {
                    let phase = if tools { "model" } else { "compact" };
                    self.record_interruption(phase, "")?;
                    Ok(None)
                } else {
                    Err(e)
                }
            }
        }
    }

    fn call_model(
        &mut self,
        messages: &[Message],
        tools: bool,
        update_cache_rate: bool,
    ) -> Result<ModelData, String> {
        let some_tools = if tools {
            let mut definitions =
                serde_json::from_str::<Vec<serde_json::Value>>(tool_definitions_json())
                    .unwrap_or_default();
            definitions.retain(|definition| {
                definition
                    .pointer("/function/name")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|name| self.local_tools.iter().any(|selected| selected == name))
            });
            definitions.extend(self.mcp_tools.iter().map(|tool| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters
                    }
                })
            }));
            Some(definitions)
        } else {
            None
        };
        let mut body = serde_json::Map::new();
        body.insert("model".into(), serde_json::Value::String(model_name()));
        body.insert(
            "messages".into(),
            serde_json::Value::Array(json_messages(messages)),
        );
        if let Some(tools) = some_tools {
            body.insert("tools".into(), serde_json::Value::Array(tools));
        }
        let body_str =
            serde_json::to_string(&serde_json::Value::Object(body)).map_err(|e| e.to_string())?;
        let text = request_text_cancellable(&self.client, &self.endpoint, body_str, &self.cancel)?;
        let data = parse_model_body(&text)?;
        let prompt = data.usage.input + data.usage.cache_read + data.usage.cache_write;
        self.add_usage(data.usage, update_cache_rate && prompt > 0);
        if update_cache_rate && prompt > 0 {
            self.usage.cache_hit_rate = data.usage.cache_read as f64 / prompt as f64 * 100.0;
        }
        Ok(data)
    }

    pub fn run_agent_loop(&mut self, input: &str) -> Result<String, String> {
        if self.session.is_some() {
            return self.run_durable_model(input);
        }
        self.cancel.store(false, Ordering::SeqCst);
        let user = Message {
            role: "user".to_string(),
            content: Some(input.to_string()),
            tool_call_id: String::new(),
            tool_calls: Vec::new(),
        };
        self.messages.push(user.clone());
        loop {
            let messages = self.messages.clone();
            let response = self.model_request(&messages, true, true)?;
            let Some(data) = response else {
                return Ok("Operation aborted.".to_string());
            };
            let answer = data.message.clone();
            self.messages.push(answer.clone());
            if answer.tool_calls.is_empty() {
                let content = answer.content.unwrap_or_default();
                if !content.trim().is_empty() {
                    return Ok(content);
                }
                return Err(format!(
                    "Model returned an empty response (finish_reason: {}).",
                    stop_reason_name(data.stop_reason)
                ));
            }
            for i in 0..answer.tool_calls.len() {
                let call = answer.tool_calls[i].clone();
                let mcp_tool = self
                    .mcp_tools
                    .iter()
                    .find(|tool| tool.name == call.function.name);
                let parsed = if mcp_tool.is_some() {
                    serde_json::from_str::<serde_json::Value>(&call.function.arguments)
                        .map(|value| (ToolArgs::default_layout(), Some(value)))
                        .map_err(|error| error.to_string())
                } else {
                    ToolArgs::from_json(&call.function.arguments).map(|args| (args, None))
                };
                let content;
                let mut aborted = false;
                let event_args = parsed
                    .as_ref()
                    .map(|(args, _)| args.clone())
                    .unwrap_or_else(|_| ToolArgs::default_layout());
                if data.stop_reason == StopReason::Length {
                    content = "Error: Tool call arguments were truncated by the model token limit; the tool was not executed.".to_string();
                } else {
                    match parsed {
                        Ok((args, mcp_arguments)) => {
                            (self.on_tool.as_ref())(ToolEvent {
                                phase: "start".into(),
                                name: call.function.name.clone(),
                                args: args.clone(),
                                result: String::new(),
                            });
                            let result = match (mcp_tool, mcp_arguments) {
                                (Some(tool), Some(arguments)) => {
                                    tool.execute(arguments, &self.cancel)
                                }
                                _ => self.execute_tool(&call.function.name, &args),
                            };
                            aborted = self.cancel.load(Ordering::SeqCst);
                            content = match &result {
                                Err(_) if aborted => "Operation aborted".to_string(),
                                Err(e) => format!("Error: {}", e),
                                Ok(text) => text.clone(),
                            };
                            (self.on_tool.as_ref())(ToolEvent {
                                phase: "end".into(),
                                name: call.function.name.clone(),
                                args,
                                result: content.clone(),
                            });
                        }
                        Err(e) => {
                            content = format!("Error: {}", e);
                            (self.on_tool.as_ref())(ToolEvent {
                                phase: "end".into(),
                                name: call.function.name.clone(),
                                args: event_args,
                                result: content.clone(),
                            });
                        }
                    }
                }
                let tool_msg = Message {
                    role: "tool".to_string(),
                    content: Some(content),
                    tool_call_id: call.id.clone(),
                    tool_calls: Vec::new(),
                };
                self.messages.push(tool_msg.clone());
                if !aborted {
                    continue;
                }
                for pending in answer.tool_calls[i + 1..].iter() {
                    let skipped = Message {
                        role: "tool".to_string(),
                        content: Some("Operation aborted before execution".to_string()),
                        tool_call_id: pending.id.clone(),
                        tool_calls: Vec::new(),
                    };
                    self.messages.push(skipped.clone());
                }
                return Ok("Operation aborted.".to_string());
            }
        }
    }

    pub fn compact(&mut self) -> Result<String, String> {
        let Some(session) = self.session.clone() else {
            return Err("Session is required for compaction".into());
        };
        let state = session.load()?;
        if !matches!(state.operation, OperationState::Idle) {
            return Err("Session operation is not idle".into());
        }
        let messages = state.active_context;
        if messages.is_empty() {
            self.publish_abort_coordination(AbortCoordination::NonDurable);
            return Ok("Nothing to compact.".into());
        }
        let mut cut = messages.len().saturating_sub(6);
        while cut > 0
            && messages[cut]
                .get("role")
                .and_then(serde_json::Value::as_str)
                != Some("user")
        {
            cut -= 1;
        }
        if cut == 0 {
            self.publish_abort_coordination(AbortCoordination::NonDurable);
            return Ok("Nothing to compact.".into());
        }

        let source = session.message_source()?;
        let input_through_entry_id = state
            .active_context_through_entry_id
            .ok_or_else(|| "Compaction input boundary missing".to_string())?;
        let retained_count = messages.len() - cut;
        if source.len() <= retained_count {
            self.publish_abort_coordination(AbortCoordination::NonDurable);
            return Ok("Nothing to compact.".into());
        }
        let partition = source.len() - retained_count;
        let compacted_entry_ids = source[..partition]
            .iter()
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let retained_entry_ids = source[partition..]
            .iter()
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let operation_id = uuid7();
        let result_entry_id = uuid7();
        let digest = source_digest(&source);

        let (coordination_lock, ready) = &*self.abort_coordination;
        let mut coordination = coordination_lock.lock().unwrap();
        self.cancel.store(false, Ordering::SeqCst);
        if let Err(error) = session.append(vec![start_compaction(
            &uuid7(),
            &operation_id,
            &input_through_entry_id,
            &result_entry_id,
            &compacted_entry_ids,
            &retained_entry_ids,
            &digest,
        )]) {
            *coordination = AbortCoordination::NonDurable;
            ready.notify_all();
            return Err(error);
        }
        *coordination = AbortCoordination::DurableReady;
        ready.notify_all();
        drop(coordination);

        self.run_compaction_attempt(&operation_id, &input_through_entry_id, None, 1)
    }

    fn run_compaction_attempt(
        &mut self,
        operation_id: &str,
        context_entry_id: &str,
        existing_step_id: Option<&str>,
        attempt: u64,
    ) -> Result<String, String> {
        let session = self.session.clone().unwrap();
        let source = session.compaction_source(operation_id)?;
        let retained = source.retained_entry_ids.len();
        let state = session.load()?;
        let old_count = state.active_context.len().saturating_sub(retained);
        let old = &state.active_context[..old_count];
        let summary_prompt = vec![
            Message {
                role: "system".into(),
                content: Some("Summarize this coding session compactly. Preserve decisions, changed files, errors, and next steps.".into()),
                tool_call_id: String::new(),
                tool_calls: Vec::new(),
            },
            Message {
                role: "user".into(),
                content: Some(serde_json::to_string(old).map_err(|error| error.to_string())?),
                tool_call_id: String::new(),
                tool_calls: Vec::new(),
            },
        ];
        let step_id = existing_step_id.map(str::to_string).unwrap_or_else(uuid7);
        let attempt_id = uuid7();
        let configuration = self.runtime_configuration();
        let admitted = session.admit_compaction_attempt(
            operation_id,
            step_attempt(
                &uuid7(),
                operation_id,
                &step_id,
                &attempt_id,
                "compaction",
                attempt,
                context_entry_id,
                &configuration,
            ),
            operation_finished(&uuid7(), operation_id, "compaction", "aborted", None, None),
        )?;
        match admitted {
            ConditionalAppend::Appended => {}
            ConditionalAppend::Aborted => return Ok("Compaction aborted.".into()),
            ConditionalAppend::Inactive => return Ok("Compaction already finished.".into()),
        }
        let data = match self.call_model(&summary_prompt, false, false) {
            Ok(data)
                if data.stop_reason == StopReason::Stop
                    && data
                        .message
                        .content
                        .as_deref()
                        .is_some_and(|text| !text.trim().is_empty()) =>
            {
                data
            }
            Ok(_) => {
                let error = "Model returned an invalid compaction summary";
                let settled = session.settle_compaction_attempt(
                    operation_id,
                    &attempt_id,
                    vec![
                        step_failed(
                            &uuid7(),
                            operation_id,
                            &step_id,
                            &attempt_id,
                            "model_error",
                            error,
                        ),
                        operation_finished(
                            &uuid7(),
                            operation_id,
                            "compaction",
                            "failed",
                            None,
                            Some(("model_error", error)),
                        ),
                    ],
                    vec![
                        step_failed(
                            &uuid7(),
                            operation_id,
                            &step_id,
                            &attempt_id,
                            "aborted",
                            "Operation aborted",
                        ),
                        operation_finished(
                            &uuid7(),
                            operation_id,
                            "compaction",
                            "aborted",
                            None,
                            None,
                        ),
                    ],
                )?;
                self.reproject_idle_session()?;
                return match settled {
                    ConditionalAppend::Appended => Err(error.into()),
                    ConditionalAppend::Aborted => Ok("Compaction aborted.".into()),
                    ConditionalAppend::Inactive => Ok("Compaction already finished.".into()),
                };
            }
            Err(error) => {
                if self.cancel.load(Ordering::SeqCst) {
                    session.append_abort_if_active(
                        operation_id,
                        abort_requested(&uuid7(), operation_id, "compaction", "compact", None),
                    )?;
                }
                let settled = session.settle_compaction_attempt(
                    operation_id,
                    &attempt_id,
                    vec![
                        step_failed(
                            &uuid7(),
                            operation_id,
                            &step_id,
                            &attempt_id,
                            "model_error",
                            &error,
                        ),
                        operation_finished(
                            &uuid7(),
                            operation_id,
                            "compaction",
                            "failed",
                            None,
                            Some(("model_error", &error)),
                        ),
                    ],
                    vec![
                        step_failed(
                            &uuid7(),
                            operation_id,
                            &step_id,
                            &attempt_id,
                            "aborted",
                            "Operation aborted",
                        ),
                        operation_finished(
                            &uuid7(),
                            operation_id,
                            "compaction",
                            "aborted",
                            None,
                            None,
                        ),
                    ],
                )?;
                self.reproject_idle_session()?;
                return match settled {
                    ConditionalAppend::Appended => Err(error),
                    ConditionalAppend::Aborted => Ok("Compaction aborted.".into()),
                    ConditionalAppend::Inactive => Ok("Compaction already finished.".into()),
                };
            }
        };
        let summary = data.message.content.unwrap_or_default();
        let retained_ids = source
            .retained_entry_ids
            .iter()
            .collect::<std::collections::HashSet<_>>();
        let retained_tail = source
            .messages
            .iter()
            .filter(|(id, _)| retained_ids.contains(id))
            .cloned()
            .collect::<Vec<_>>();
        let compacted_through = source
            .compacted_entry_ids
            .last()
            .ok_or_else(|| "Compaction source is empty".to_string())?;
        let result_id = match session.load()?.operation {
            OperationState::Compaction {
                operation_id: active_operation,
                result_entry_id,
                ..
            } if active_operation == operation_id => result_entry_id,
            _ => return Ok("Compaction already finished.".into()),
        };
        let completed = session.settle_compaction_attempt(
            operation_id,
            &attempt_id,
            vec![
                usage(&uuid7(), operation_id, Some(&attempt_id), None, data.usage),
                compaction_entry(
                    &result_id,
                    operation_id,
                    &summary,
                    compacted_through,
                    &retained_tail,
                ),
            ],
            vec![
                step_failed(
                    &uuid7(),
                    operation_id,
                    &step_id,
                    &attempt_id,
                    "aborted",
                    "Operation aborted",
                ),
                operation_finished(&uuid7(), operation_id, "compaction", "aborted", None, None),
            ],
        )?;
        if completed == ConditionalAppend::Aborted {
            self.reproject_idle_session()?;
            return Ok("Compaction aborted.".into());
        }
        if completed == ConditionalAppend::Inactive {
            self.reproject_idle_session()?;
            return Ok("Compaction already finished.".into());
        }
        session.finish_compaction(
            operation_id,
            operation_finished(
                &uuid7(),
                operation_id,
                "compaction",
                "completed",
                Some(&result_id),
                None,
            ),
        )?;
        self.reproject_idle_session()?;
        Ok(format!(
            "Compacted {} messages (kept last {}).",
            source.compacted_entry_ids.len(),
            retained_tail.len()
        ))
    }

    pub fn execute_tool(&self, name: &str, args: &ToolArgs) -> Result<String, String> {
        if !self.local_tools.iter().any(|selected| selected == name) {
            return Err(format!("unknown tool: {name}"));
        }
        if self.cancel.load(Ordering::SeqCst) {
            return Err("Operation aborted".to_string());
        }
        if name == "bash" {
            if args.command.is_empty() {
                return Err("command is required".to_string());
            }
            let timeout = args.timeout;
            if timeout.is_nan() || timeout <= 0.0 {
                return Err("timeout must be a positive number of seconds".to_string());
            }
            let result = run_bash(&args.command, timeout, &self.cancel, &self.cwd);
            if self.cancel.load(Ordering::SeqCst) {
                return Err("Operation aborted".to_string());
            }
            return Ok(result);
        }
        if name == "bg" {
            return execute_bg(&self.cwd, args);
        }
        if args.path.is_empty() {
            return Err("path is required".to_string());
        }
        let path = resolve_path(&self.cwd, &args.path, name == "write")?;
        if name == "read" {
            let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            return read_lines(&text, args.offset, args.limit);
        }
        if name == "write" {
            if let Some(parent) = FsPath::new(&path).parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            if self.cancel.load(Ordering::SeqCst) {
                return Err("Operation aborted".to_string());
            }
            std::fs::write(&path, args.content.as_bytes()).map_err(|e| e.to_string())?;
            return Ok(format!(
                "Successfully wrote {} bytes to {}.",
                args.content.len(),
                args.path
            ));
        }
        if name == "edit" {
            return apply_edit_file(&path, &args.path, &args.edits);
        }
        Err(format!("unknown tool: {}", name))
    }
}

fn json_messages(messages: &[Message]) -> Vec<serde_json::Value> {
    messages
        .iter()
        .map(|m| serde_json::to_value(m).unwrap_or_default())
        .collect()
}

// ---------------------------------------------------------------------------
// model HTTP (ureq is blocking; run it in a sub-thread and poll cancel)
// ---------------------------------------------------------------------------
fn request_text_cancellable(
    client: &Arc<ureq::Agent>,
    endpoint: &str,
    body: String,
    cancel: &Arc<AtomicBool>,
) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    let client = client.clone();
    let endpoint = endpoint.to_string();
    let cancel = cancel.clone();
    thread::spawn(move || {
        let _ = tx.send(post_chat(&client, &endpoint, &body));
        let _ = cancel;
    });
    let timer = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("Operation aborted".to_string());
        }
        if timer.elapsed() > Duration::from_secs(50 * 60) {
            return Err("Operation aborted".to_string());
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(res) => return res,
            Err(_) => continue,
        }
    }
}

fn post_chat(client: &ureq::Agent, endpoint: &str, body: &str) -> Result<String, String> {
    let key = api_key();
    if key.is_empty() {
        return Err("Set OPENROUTER_API_KEY".to_string());
    }
    let mut resp = client
        .post(endpoint)
        .header("Authorization", format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .header("HTTP-Referer", "https://github.com/geminixiang/tiny-agent")
        .send(body.as_bytes())
        .map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let text = resp
            .body_mut()
            .read_to_string()
            .map_err(|e| e.to_string())?;
        return Err(format!("OpenRouter {}: {}", status, text));
    }
    resp.body_mut().read_to_string().map_err(|e| e.to_string())
}

fn parse_model_body(text: &str) -> Result<ModelData, String> {
    #[derive(Deserialize)]
    struct Resp {
        #[serde(default)]
        choices: Vec<Choice>,
        #[serde(default)]
        usage: UsageResp,
    }
    #[derive(Deserialize)]
    struct Choice {
        message: Option<Message>,
        #[serde(default)]
        finish_reason: Option<String>,
    }
    #[derive(Deserialize, Default)]
    struct UsageResp {
        #[serde(default)]
        prompt_tokens: u64,
        #[serde(default)]
        completion_tokens: u64,
        #[serde(rename = "prompt_cache_hit_tokens", default)]
        prompt_cache_hit_tokens: u64,
        #[serde(rename = "prompt_tokens_details", default)]
        details: Details,
    }
    #[derive(Deserialize, Default)]
    struct Details {
        #[serde(default)]
        cached_tokens: u64,
        #[serde(default)]
        cache_write_tokens: u64,
    }
    let data: Resp = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let choice = data
        .choices
        .first()
        .ok_or("OpenRouter returned no choices".to_string())?;
    let cache_read = if data.usage.details.cached_tokens > 0 {
        data.usage.details.cached_tokens
    } else {
        data.usage.prompt_cache_hit_tokens
    };
    let cache_write = data.usage.details.cache_write_tokens;
    let input = data
        .usage
        .prompt_tokens
        .saturating_sub(cache_read + cache_write);
    let message = choice
        .message
        .clone()
        .ok_or("OpenRouter returned no assistant message".to_string())?;
    let stop_reason = match choice.finish_reason.as_deref() {
        Some("length") => StopReason::Length,
        Some("tool_calls" | "function_call") => StopReason::ToolUse,
        Some("content_filter" | "network_error") => {
            return Err(format!(
                "Provider finish_reason: {}",
                choice.finish_reason.as_deref().unwrap_or_default()
            ));
        }
        Some(reason) if reason != "stop" => {
            return Err(format!("Unknown provider finish_reason: {}", reason));
        }
        _ if !message.tool_calls.is_empty() => StopReason::ToolUse,
        _ => StopReason::Stop,
    };
    Ok(ModelData {
        message,
        usage: UsageJSON {
            input,
            output: data.usage.completion_tokens,
            cache_read,
            cache_write,
        },
        stop_reason,
    })
}

fn stop_reason_name(reason: StopReason) -> &'static str {
    match reason {
        StopReason::Stop => "stop",
        StopReason::Length => "length",
        StopReason::ToolUse => "toolUse",
    }
}

pub const fn local_tool_names() -> &'static [&'static str] {
    &["bash", "read", "write", "edit", "bg"]
}

pub fn tool_definitions_json() -> &'static str {
    r#"[
      {
        "type": "function",
        "function": {
          "name": "bash",
          "description": "Run commands, builds, tests, and file discovery in the working directory. Use read, write, or edit for ordinary text file operations. Output is limited to the last 2,000 lines or 50KB; truncated output includes a full-output path.",
          "parameters": {
            "type": "object",
            "properties": {
              "command": { "type": "string", "description": "Shell command to execute in the working directory." },
              "timeout": { "type": "number", "exclusiveMinimum": 0, "description": "Optional timeout in seconds. Defaults to 120." }
            },
            "required": ["command"]
          }
        }
      },
      {
        "type": "function",
        "function": {
          "name": "read",
          "description": "Read a UTF-8 text file. Prefer this over cat or sed. Returns at most 2,000 complete lines or 50KB and includes an offset hint when more lines remain.",
          "parameters": {
            "type": "object",
            "properties": {
              "path": { "type": "string", "description": "Path to the UTF-8 text file." },
              "offset": { "type": "integer", "minimum": 1, "description": "1-indexed line number to start reading from." },
              "limit": { "type": "integer", "minimum": 1, "description": "Maximum number of lines to return." }
            },
            "required": ["path"]
          }
        }
      },
      {
        "type": "function",
        "function": {
          "name": "write",
          "description": "Create a new UTF-8 text file or completely rewrite an existing file. Parent directories are created automatically. Use edit for partial changes.",
          "parameters": {
            "type": "object",
            "properties": {
              "path": { "type": "string", "description": "Path to create or completely rewrite." },
              "content": { "type": "string", "description": "Complete UTF-8 file content." }
            },
            "required": ["path", "content"]
          }
        }
      },
      {
        "type": "function",
        "function": {
          "name": "edit",
          "description": "Make precise replacements in an existing UTF-8 text file. Every oldText must match exactly once in the original file, and edits must not overlap. All edits are validated before writing.",
          "parameters": {
            "type": "object",
            "properties": {
              "path": { "type": "string", "description": "Path to the existing UTF-8 text file." },
              "edits": {
                "type": "array",
                "minItems": 1,
                "description": "Non-overlapping replacements, all matched against the original file.",
                "items": {
                  "type": "object",
                  "properties": {
                    "oldText": { "type": "string", "minLength": 1, "description": "Exact text that must occur exactly once in the original file." },
                    "newText": { "type": "string", "description": "Replacement text." }
                  },
                  "required": ["oldText", "newText"]
                }
              }
            },
            "required": ["path", "edits"]
          }
        }
      },
      {
        "type": "function",
        "function": {
          "name": "bg",
          "description": "Manage background processes in the working directory. The id is the process pid; metadata and logs live in .tiny-agent/bg/<pid>.json and .log. Use for servers and other long-running commands. List shows running processes by default; use status=all or a specific status to inspect history in the same cwd.",
          "parameters": {
            "type": "object",
            "properties": {
              "action": { "type": "string", "enum": ["start", "list", "status", "logs", "stop"] },
              "command": { "type": "string", "description": "Shell command to start. Required for action=start." },
              "id": { "type": "string", "description": "Background process pid. Required for status/logs/stop." },
              "tail": { "type": "integer", "minimum": 1, "description": "Number of log lines for logs, status, or failed start." },
              "status": { "type": "string", "enum": ["running", "exited", "stopped", "stale", "all"], "description": "Filter for action=list. Defaults to running." }
            },
            "required": ["action"]
          }
        }
      }
    ]"#
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BgMeta {
    id: String,
    command: String,
    cwd: String,
    pid: u32,
    pgid: u32,
    owner_pid: u32,
    started_at: String,
    process_started_at: String,
    log: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exited_at: Option<String>,
}

static BG_PROCESSES: OnceLock<Mutex<HashMap<String, Child>>> = OnceLock::new();
fn bg_processes() -> &'static Mutex<HashMap<String, Child>> {
    BG_PROCESSES.get_or_init(|| Mutex::new(HashMap::new()))
}
fn bg_dir(cwd: &str) -> String {
    join_path(&join_path(cwd, ".tiny-agent"), "bg")
}
fn bg_paths(cwd: &str, id: &str) -> Result<(String, String, String), String> {
    if id.parse::<u32>().is_err() {
        return Err("id must be a pid".to_string());
    }
    let dir = bg_dir(cwd);
    Ok((
        join_path(&dir, &format!("{id}.json")),
        join_path(&dir, &format!("{id}.log")),
        format!(".tiny-agent/bg/{id}.log"),
    ))
}
fn process_running(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}
fn process_started_at(pid: u32) -> String {
    if !process_running(pid) {
        return String::new();
    }
    Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .env("LC_ALL", "C")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_default()
}
fn read_bg_meta(cwd: &str, id: &str) -> Result<BgMeta, String> {
    let (path, _, _) = bg_paths(cwd, id)?;
    let meta: BgMeta =
        serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if meta.cwd != cwd {
        return Err(format!("bg {id} belongs to a different cwd"));
    }
    Ok(meta)
}
fn write_bg_meta(cwd: &str, meta: &BgMeta) -> Result<(), String> {
    let (path, _, _) = bg_paths(cwd, &meta.id)?;
    std::fs::write(
        path,
        serde_json::to_string_pretty(meta).map_err(|e| e.to_string())? + "\n",
    )
    .map_err(|e| e.to_string())
}
fn current_bg_status(meta: &BgMeta) -> String {
    if meta.status != "running" {
        return meta.status.clone();
    }
    let started = process_started_at(meta.pid);
    if started.is_empty() {
        return "exited".to_string();
    }
    if started == meta.process_started_at {
        "running".to_string()
    } else {
        "stale".to_string()
    }
}
fn refresh_bg_meta(cwd: &str, meta: &mut BgMeta) {
    let exited = {
        let mut processes = bg_processes().lock().unwrap();
        processes
            .get_mut(&meta.id)
            .and_then(|child| child.try_wait().ok().flatten())
    };
    if let Some(status) = exited {
        bg_processes().lock().unwrap().remove(&meta.id);
        meta.status = "exited".to_string();
        meta.exit_code = status.code();
        meta.exited_at = Some(chrono_like_now());
        let _ = write_bg_meta(cwd, meta);
    }
}
fn bg_json(meta: &BgMeta) -> String {
    let mut value = meta.clone();
    value.status = current_bg_status(meta);
    serde_json::to_string(&value).unwrap_or_default()
}
fn tail_file(path: &str, lines: i64) -> String {
    let text = std::fs::read_to_string(path)
        .unwrap_or_default()
        .replace("\r\n", "\n");
    let mut parts = text
        .lines()
        .map(|line| line.to_string())
        .collect::<Vec<_>>();
    let count = (if lines < 1 { 80 } else { lines }).min(2_000) as usize;
    if parts.len() > count {
        parts = parts.split_off(parts.len() - count);
    }
    parts.join("\n")
}
fn start_bg(cwd: &str, command: &str) -> Result<String, String> {
    if command.is_empty() {
        return Err("command must be a nonempty string".to_string());
    }
    std::fs::create_dir_all(bg_dir(cwd)).map_err(|e| e.to_string())?;
    let temp_log = join_path(&bg_dir(cwd), &(uuid7() + ".log"));
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&temp_log)
        .map_err(|e| e.to_string())?;
    let err_log = log.try_clone().map_err(|e| e.to_string())?;
    let child = Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(cwd)
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err_log))
        .process_group(0)
        .spawn()
        .map_err(|e| e.to_string())?;
    let id = child.id().to_string();
    let (_, log_path, relative_log) = bg_paths(cwd, &id)?;
    let _ = std::fs::rename(&temp_log, &log_path);
    let started = chrono_like_now();
    OpenOptions::new()
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?
        .write_all(format!("$ {command}\ncwd: {cwd}\npid: {id}\nstarted: {started}\n\n").as_bytes())
        .map_err(|e| e.to_string())?;
    let meta = BgMeta {
        id: id.clone(),
        command: command.to_string(),
        cwd: cwd.to_string(),
        pid: child.id(),
        pgid: child.id(),
        owner_pid: std::process::id(),
        started_at: started,
        process_started_at: process_started_at(child.id()),
        log: relative_log,
        status: "running".to_string(),
        exit_code: None,
        signal: None,
        exited_at: None,
    };
    write_bg_meta(cwd, &meta)?;
    bg_processes().lock().unwrap().insert(id.clone(), child);
    thread::sleep(Duration::from_millis(500));
    let mut meta = meta;
    refresh_bg_meta(cwd, &mut meta);
    if current_bg_status(&meta) != "running" {
        return Ok(bg_json(&meta) + "\n" + &tail_file(&log_path, 80));
    }
    Ok(bg_json(&meta))
}
fn stop_bg(cwd: &str, mut meta: BgMeta) -> Result<BgMeta, String> {
    if current_bg_status(&meta) != "running" {
        meta.status = current_bg_status(&meta);
        return Ok(meta);
    }
    let mut child = bg_processes().lock().unwrap().remove(&meta.id);
    unsafe {
        libc::kill(-(meta.pgid as i32), libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if let Some(process) = child.as_mut() {
            if process.try_wait().map_err(|e| e.to_string())?.is_some() {
                break;
            }
        } else if !process_running(meta.pid) {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    if child
        .as_mut()
        .is_some_and(|process| process.try_wait().ok().flatten().is_none())
        || (child.is_none() && process_running(meta.pid))
    {
        unsafe {
            libc::kill(-(meta.pgid as i32), libc::SIGKILL);
        }
        if let Some(process) = child.as_mut() {
            let _ = process.wait();
        }
    }
    meta.status = "stopped".to_string();
    meta.exited_at = Some(chrono_like_now());
    write_bg_meta(cwd, &meta)?;
    Ok(meta)
}
fn execute_bg(cwd: &str, args: &ToolArgs) -> Result<String, String> {
    match args.action.as_str() {
        "start" => start_bg(cwd, &args.command),
        "list" => {
            let status = if args.status.is_empty() {
                "running"
            } else {
                &args.status
            };
            if !["running", "exited", "stopped", "stale", "all"].contains(&status) {
                return Err(format!("unknown bg status filter: {status}"));
            }
            let mut metas = Vec::new();
            if let Ok(entries) = std::fs::read_dir(bg_dir(cwd)) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                        continue;
                    }
                    if let Some(id) = path.file_stem().and_then(|stem| stem.to_str())
                        && let Ok(mut meta) = read_bg_meta(cwd, id)
                    {
                        refresh_bg_meta(cwd, &mut meta);
                        meta.status = current_bg_status(&meta);
                        if status == "all" || meta.status == status {
                            metas.push(meta);
                        }
                    }
                }
            }
            serde_json::to_string(&metas).map_err(|e| e.to_string())
        }
        "status" | "logs" | "stop" => {
            let mut meta = read_bg_meta(cwd, &args.id)?;
            refresh_bg_meta(cwd, &mut meta);
            let (_, log_path, _) = bg_paths(cwd, &args.id)?;
            if args.action == "status" {
                return Ok(bg_json(&meta)
                    + "\n"
                    + &tail_file(&log_path, if args.tail > 0 { args.tail } else { 40 }));
            }
            if args.action == "logs" {
                let text = tail_file(&log_path, if args.tail > 0 { args.tail } else { 80 });
                return Ok(if text.is_empty() {
                    "(no output)".to_string()
                } else {
                    text
                });
            }
            Ok(bg_json(&stop_bg(cwd, meta)?))
        }
        _ => Err(format!("unknown bg action: {}", args.action)),
    }
}
pub fn close_background_processes(cwd: &str) {
    let ids = bg_processes()
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    for id in ids {
        if let Ok(meta) = read_bg_meta(cwd, &id) {
            let _ = stop_bg(cwd, meta);
        }
    }
}
fn chrono_like_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{secs}")
}

fn resolve_path(cwd: &str, path: &str, new_file: bool) -> Result<String, String> {
    let candidate = if FsPath::new(path).is_absolute() {
        FsPath::new(path).to_path_buf()
    } else {
        FsPath::new(cwd).join(path)
    };
    if !new_file && !candidate.exists() {
        return Err(format!("{} does not exist", candidate.display()));
    }
    Ok(candidate.to_string_lossy().to_string())
}

fn run_bash(command: &str, timeout: f64, cancel: &Arc<AtomicBool>, cwd: &str) -> String {
    let mut child = match Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(cwd)
        .process_group(0)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => return format!("Command failed to start: {}", e),
    };
    let pid = child.id();
    let out_rx = spawn_reader(child.stdout.take());
    let err_rx = spawn_reader(child.stderr.take());
    let deadline = Instant::now() + Duration::from_secs_f64(timeout.max(0.0));
    let mut reason = "exit";
    loop {
        if cancel.load(Ordering::SeqCst) {
            reason = "cancelled";
            kill_group(pid);
            break;
        }
        if Instant::now() >= deadline {
            reason = "timeout";
            kill_group(pid);
            break;
        }
        if let Ok(Some(_)) = child.try_wait() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let (stdout_out, stdout_capped) = out_rx.recv().unwrap_or_default();
    let (stderr_out, stderr_capped) = err_rx.recv().unwrap_or_default();
    let capped = stdout_capped || stderr_capped;
    let status = child.wait().ok();
    let mut combined = stdout_out;
    combined.extend(stderr_out);
    if reason == "cancelled" {
        return String::new();
    }
    if reason == "timeout" {
        let text = String::from_utf8_lossy(&combined).to_string();
        if capped {
            return limit_output(
                &append_note(
                    &text,
                    "Bash output exceeded the 10MB safety cap; complete output was not captured.",
                ),
                false,
                cwd,
            );
        }
        return limit_output(
            &append_note(
                &text,
                &format!("Command timed out after {} seconds.", timeout),
            ),
            true,
            cwd,
        );
    }
    let exited_ok = matches!(status, Some(s) if s.success());
    let code = status.and_then(|s| s.code());
    let text = String::from_utf8_lossy(&combined).to_string();
    let final_text = if text.is_empty() {
        if exited_ok {
            "(no output)".to_string()
        } else {
            format!("Command exited with code {}", code.unwrap_or_default())
        }
    } else if exited_ok {
        text
    } else {
        format!(
            "{}\n\nCommand exited with code {}",
            text,
            code.unwrap_or_default()
        )
    };
    if capped {
        return limit_output(
            &append_note(
                &final_text,
                "Bash output exceeded the 10MB safety cap; complete output was not captured.",
            ),
            false,
            cwd,
        );
    }
    limit_output(&final_text, true, cwd)
}

fn append_note(text: &str, note: &str) -> String {
    if text.trim().is_empty() {
        note.to_string()
    } else {
        format!("{}\n\n{}", text, note)
    }
}

fn spawn_reader(handle: Option<impl Read + Send + 'static>) -> mpsc::Receiver<(Vec<u8>, bool)> {
    let (tx, rx) = mpsc::channel::<(Vec<u8>, bool)>();
    thread::spawn(move || {
        let mut buf = Vec::new();
        let mut capped = false;
        if let Some(mut reader) = handle {
            let mut chunk = [0u8; 8192];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        if buf.len() < MAX_BASH_OUTPUT {
                            let keep = n.min(MAX_BASH_OUTPUT - buf.len());
                            buf.extend_from_slice(&chunk[..keep]);
                            capped |= keep < n;
                        } else {
                            capped = true;
                        }
                    }
                    Err(_) => break,
                }
            }
        }
        let _ = tx.send((buf, capped));
    });
    rx
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

fn limit_output(output: &str, complete: bool, cwd: &str) -> String {
    let out = output.to_string();
    let mut lines: Vec<&str> = output.split("\n").collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    if lines.len() <= 2_000 && output.len() <= MAX_TOOL_OUTPUT {
        return out;
    }
    let bytes = output.as_bytes();
    let mut byte_start = bytes.len().saturating_sub(MAX_TOOL_OUTPUT);
    while byte_start < bytes.len() && (bytes[byte_start] & 0xc0) == 0x80 {
        byte_start += 1;
    }
    let mut tail_lines: Vec<&str> = std::str::from_utf8(&bytes[byte_start..])
        .map(|s| s.split("\n").collect())
        .unwrap_or_default();
    if tail_lines.len() > 2_000 {
        tail_lines = tail_lines[tail_lines.len() - 2_000..].to_vec();
    }
    let tail = tail_lines.join("\n");
    let total = lines.len();
    let start = (total as i64 - tail_lines.len() as i64 + 1).max(1) as usize;
    let dir = join_path(cwd, ".tiny-agent/tool-output");
    let _ = std::fs::create_dir_all(&dir);
    let path = join_path(&dir, &format!("{}.log", uuid7()));
    let _ = std::fs::write(&path, output.as_bytes());
    let label = if complete {
        "Full output"
    } else {
        "Captured output; command exceeded the 10MB safety cap"
    };
    format!(
        "{}\n\n[Showing lines {}-{} of {}. {}: {}]",
        tail, start, total, total, label, path
    )
}

fn read_lines(text: &str, offset: i64, limit: i64) -> Result<String, String> {
    if offset < 1 || limit < 1 {
        return Err("offset/limit must be integers >= 1".to_string());
    }
    let normalized = text.replace("\r\n", "\n");
    let mut lines: Vec<&str> = normalized.split("\n").collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    if lines.is_empty() {
        return if offset == 1 {
            Ok(String::new())
        } else {
            Err(format!(
                "Offset {} is beyond end of file (0 lines total).",
                offset
            ))
        };
    }
    if offset as usize > lines.len() {
        return Err(format!(
            "Offset {} is beyond end of file ({} lines total).",
            offset,
            lines.len()
        ));
    }
    let mut selected: Vec<&str> = Vec::new();
    let mut acc = 0usize;
    let end = ((offset - 1) + limit.min(2_000)).min(lines.len() as i64) as usize;
    for line in &lines[(offset - 1) as usize..end] {
        let add = if selected.is_empty() {
            line.len()
        } else {
            1 + line.len()
        };
        if acc + add > MAX_TOOL_OUTPUT {
            break;
        }
        acc += add;
        selected.push(line);
    }
    if selected.is_empty() {
        return Ok(format!(
            "Line {} exceeds 50KB. Use bash with a byte-oriented command to inspect this line.",
            offset
        ));
    }
    let last_offset = offset + selected.len() as i64 - 1;
    let hint = if (last_offset as usize) < lines.len() {
        format!(
            "\n\n[Showing lines {}-{} of {}. Use offset={} to continue.]",
            offset,
            last_offset,
            lines.len(),
            last_offset + 1
        )
    } else {
        String::new()
    };
    Ok(format!("{}{}", selected.join("\n"), hint))
}

fn apply_edit_file(path: &str, display_path: &str, edits: &[ToolEdit]) -> Result<String, String> {
    if edits.is_empty() {
        return Err("edits must be a nonempty array".to_string());
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let bom = text.starts_with("\u{FEFF}");
    let raw = if bom {
        &text["\u{FEFF}".len()..]
    } else {
        &text[..]
    };
    let ending = if raw.contains("\r\n") { "\r\n" } else { "\n" };
    let (normalized, positions) = normalize_map(raw);
    let mut ranges: Vec<(usize, usize, String, usize)> = Vec::new();
    for (index, edit) in edits.iter().enumerate() {
        let old = edit.old_text.replace("\r\n", "\n");
        if old.is_empty() {
            return Err(format!("edits[{}].oldText must not be empty", index));
        }
        let first = normalized.find(old.as_str()).ok_or_else(|| {
            format!(
                "edits[{}].oldText was not found in {}.",
                index, display_path
            )
        })?;
        if normalized[first + old.len()..].contains(old.as_str()) {
            return Err(format!(
                "edits[{}].oldText occurs more than once in {}; add more context.",
                index, display_path
            ));
        }
        let new_text = edit.new_text.replace("\r\n", "\n").replace("\n", ending);
        ranges.push((
            positions[first],
            positions[first + old.len()],
            new_text,
            index,
        ));
    }
    ranges.sort_by_key(|range| range.0);
    for i in 1..ranges.len() {
        if ranges[i].0 < ranges[i - 1].1 {
            return Err(format!(
                "edits[{}] and edits[{}] overlap in {}.",
                ranges[i - 1].3,
                ranges[i].3,
                display_path
            ));
        }
    }
    let mut edited = raw.to_string();
    for range in ranges.iter().rev() {
        edited = format!("{}{}{}", &edited[..range.0], range.2, &edited[range.1..]);
    }
    let final_text = if bom {
        format!("\u{FEFF}{}", edited)
    } else {
        edited
    };
    std::fs::write(path, final_text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(format!(
        "Successfully replaced {} block(s) in {}.",
        edits.len(),
        display_path
    ))
}

fn normalize_map(text: &str) -> (String, Vec<usize>) {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut positions = vec![0usize];
    let mut source = 0;
    while source < bytes.len() {
        if bytes[source..].starts_with(b"\r\n") {
            out.push(b'\n');
            source += 2;
            positions.push(source);
            continue;
        }
        let width = text[source..].chars().next().unwrap().len_utf8();
        out.extend_from_slice(&bytes[source..source + width]);
        for offset in 1..=width {
            positions.push(source + offset);
        }
        source += width;
    }
    (String::from_utf8(out).unwrap(), positions)
}

// ---------------------------------------------------------------------------
// path + time helpers
// ---------------------------------------------------------------------------
fn join_path(a: &str, b: &str) -> String {
    FsPath::new(a).join(b).to_string_lossy().to_string()
}

fn absolute(path: &str) -> Result<String, String> {
    // Lexical absolute path that also collapses "." and ".." without touching
    // symlinks, so a not-yet-created target and the working directory share a
    // stable prefix for the guard and `..` cannot escape cwd.
    let raw = std::path::absolute(path).map_err(|e| e.to_string())?;
    let raw = raw.to_string_lossy().to_string();
    Ok(normalize_abs(&raw))
}

fn normalize_abs(p: &str) -> String {
    let mut stack: Vec<&str> = Vec::new();
    for comp in p.split('/') {
        match comp {
            "" | "." => continue,
            ".." => {
                stack.pop();
            }
            c => stack.push(c),
        }
    }
    if p.starts_with('/') {
        format!("/{}", stack.join("/"))
    } else {
        stack.join("/")
    }
}

fn dir_name(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[..i].to_string(),
        None => ".".to_string(),
    }
}

fn basename(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[i + 1..].to_string(),
        None => path.to_string(),
    }
}

pub fn uuid7() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    uuid7_at(millis)
}

pub fn uuid7_at(millis: u64) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let counter = COUNTER.fetch_add(1, Ordering::SeqCst);
    let pid = std::process::id() as u64;
    let mut b = [0u8; 16];
    b[..6].copy_from_slice(&millis.to_be_bytes()[2..]);
    let random = counter.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ millis.rotate_left(17) ^ pid;
    b[6..14].copy_from_slice(&random.to_be_bytes());
    b[14..].copy_from_slice(&(counter as u16 ^ pid as u16).to_be_bytes());
    b[6] = (b[6] & 0x0f) | 0x70;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = b
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect::<String>();
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}
