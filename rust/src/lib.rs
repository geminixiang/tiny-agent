//! tiny-rs core: agent loop, tools, sessions, model calls, and compaction.
//! Mirrors the TypeScript (`tiny-ts`), Go (`tiny-go`), and Python (`tiny-py`)
//! implementations of tiny-agent.

use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::Path as FsPath;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub use crate::session::Session;
use crate::session_runtime::project_idle;

pub mod mcp;
pub mod session;
pub mod session_recovery;
pub mod session_reducer;
pub mod session_runtime;
pub mod terminal;

pub const DEFAULT_MODEL: &str = "deepseek/deepseek-v4-flash-0731";
pub const OPENROUTER_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
pub const MAX_TOOL_OUTPUT: usize = 50 * 1024;
pub const MAX_BASH_OUTPUT: usize = 10 * 1024 * 1024;
pub const BASH_TIMEOUT: u64 = 120;

pub fn model_name() -> String {
    match std::env::var("TINY_MODEL") {
        Ok(v) if !v.is_empty() => v,
        _ => DEFAULT_MODEL.to_string(),
    }
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
    #[serde(rename = "tool_calls", default)]
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
        }
    }
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
        return if event.result == "ok" || event.result == "(no output)" {
            format!("  └ {}", event.result)
        } else {
            format!("  └ {} chars", event.result.len())
        };
    }
    let mut target = if event.name == "bash" {
        event.args.command
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
        "You are tiny-agent, a concise coding agent in {}. Use tools to inspect and change files. Follow the project instructions below. When a task matches an available skill, use read on its location before following it.\n\nFor implementation tasks, inspect only what is needed, then make the changes and run focused tests. Do not keep researching the same uncertainty when a mature dependency or direct implementation is available.\nUse read to inspect files, write for new files, edit for existing files, and bash for discovery, commands, builds, and tests.\nPrefer completing a small working implementation over exhaustively researching every option. If repeated experiments fail, reconsider the approach instead of making another similar attempt.{}\n\n<available_skills>\n{}\n</available_skills>",
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
pub struct Agent {
    pub messages: Vec<Message>,
    pub usage: UsageState,
    pub skills: Vec<Skill>,
    pub session: Option<Session>,
    pub cancel: Arc<AtomicBool>,
    pub endpoint: String,
    pub client: Arc<ureq::Agent>,
    pub on_tool: Arc<dyn Fn(ToolEvent) + Send + Sync>,
    pub cwd: String,
    pub local_tools: Vec<String>,
    pub mcp_tools: Vec<mcp::McpTool>,
}

pub fn new_agent(
    skills: Vec<Skill>,
    session: Option<Session>,
    instructions: String,
    cwd: &str,
) -> Agent {
    let list = skills
        .iter()
        .map(format_skill)
        .collect::<Vec<_>>()
        .join("\n");
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
        endpoint: OPENROUTER_URL.to_string(),
        client: Arc::new(open_router_agent()),
        on_tool: Arc::new(|_| {}),
        cwd: cwd.to_string(),
        local_tools: local_tool_names()
            .iter()
            .map(|name| (*name).to_string())
            .collect(),
        mcp_tools: Vec::new(),
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

impl Agent {
    fn session_append(
        &self,
        _map: serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        Ok(())
    }

    fn record_interruption(&self, _phase: &str, _tool_call_id: &str) -> Result<(), String> {
        Ok(())
    }

    pub fn resume_session(&mut self) -> Result<(), String> {
        let Some(session) = &self.session else {
            return Ok(());
        };
        let system_prompt = self.messages[0].content.clone().unwrap_or_default();
        let projection = project_idle(&session.load()?, &system_prompt)
            .map_err(|_| "Session recovery required".to_string())?;
        self.messages = projection.messages;
        self.usage = projection.usage;
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
        self.cancel.store(false, Ordering::SeqCst);
        let user = Message {
            role: "user".to_string(),
            content: Some(input.to_string()),
            tool_call_id: String::new(),
            tool_calls: Vec::new(),
        };
        self.messages.push(user.clone());
        self.session_append(message_record(&user, None, None))?;
        loop {
            let messages = self.messages.clone();
            let response = self.model_request(&messages, true, true)?;
            let Some(data) = response else {
                return Ok("Operation aborted.".to_string());
            };
            let answer = data.message.clone();
            self.messages.push(answer.clone());
            self.session_append(message_record(&answer, Some(data.usage), None))?;
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
                self.session_append(message_record(&tool_msg, None, Some(&call.function.name)))?;
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
                    self.session_append(message_record(
                        &skipped,
                        None,
                        Some(&pending.function.name),
                    ))?;
                }
                self.record_interruption("tool", &call.id)?;
                return Ok("Operation aborted.".to_string());
            }
        }
    }

    pub fn compact(&mut self) -> Result<String, String> {
        self.cancel.store(false, Ordering::SeqCst);
        let keep = 6;
        if self.messages.len() <= 1 {
            return Ok("Nothing to compact.".to_string());
        }
        let mut cut = (self.messages.len() - keep).max(1);
        while cut > 1 && self.messages[cut].role != "user" {
            cut -= 1;
        }
        let old = self.messages[1..cut].to_vec();
        if old.is_empty() {
            return Ok("Nothing to compact.".to_string());
        }
        let recent = self.messages[cut..].to_vec();
        let summary_prompt = vec![
            Message {
                role: "system".to_string(),
                content: Some(
                    "Summarize this coding session compactly. Preserve decisions, changed files, errors, and next steps."
                        .to_string(),
                ),
                tool_call_id: String::new(),
                tool_calls: Vec::new(),
            },
            Message {
                role: "user".to_string(),
                content: Some(serde_json::to_string(&old).map_err(|e| e.to_string())?),
                tool_call_id: String::new(),
                tool_calls: Vec::new(),
            },
        ];
        let response = self.model_request(&summary_prompt, false, false)?;
        let Some(data) = response else {
            return Ok("Compaction aborted.".to_string());
        };
        let summary = data.message.content.unwrap_or_default();
        let compacted = Message {
            role: "user".to_string(),
            content: Some(format!("[Compacted history]\n{}", summary)),
            tool_call_id: String::new(),
            tool_calls: Vec::new(),
        };
        let mut new_messages = vec![self.messages[0].clone(), compacted.clone()];
        new_messages.extend(recent.iter().cloned());
        self.messages = new_messages;
        let mut map = serde_json::Map::new();
        map.insert(
            "type".into(),
            serde_json::Value::String("compaction".into()),
        );
        map.insert("summary".into(), serde_json::Value::String(summary));
        map.insert(
            "compactedMessages".into(),
            serde_json::Value::Number((old.len()).into()),
        );
        map.insert(
            "keptMessages".into(),
            serde_json::Value::Number((recent.len()).into()),
        );
        map.insert(
            "usage".into(),
            serde_json::to_value(data.usage).unwrap_or_default(),
        );
        self.session_append(map)?;
        Ok(format!(
            "Compacted {} messages (kept last {}).",
            old.len(),
            recent.len()
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

fn message_record(
    message: &Message,
    usage: Option<UsageJSON>,
    tool_name: Option<&str>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut map = serde_json::Map::new();
    map.insert("type".into(), serde_json::Value::String("message".into()));
    map.insert(
        "message".into(),
        serde_json::to_value(message).unwrap_or_default(),
    );
    if let Some(usage) = usage {
        map.insert(
            "usage".into(),
            serde_json::to_value(usage).unwrap_or_default(),
        );
    }
    if let Some(tool_name) = tool_name {
        map.insert(
            "toolName".into(),
            serde_json::Value::String(tool_name.to_string()),
        );
    }
    map
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
    &["bash", "read", "write", "edit"]
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
              "path": { "type": "string", "description": "Path to the UTF-8 text file within the working directory." },
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
      }
    ]"#
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------
fn resolve_path(cwd: &str, path: &str, new_file: bool) -> Result<String, String> {
    let root = std::fs::canonicalize(cwd).map_err(|e| e.to_string())?;
    let candidate = if FsPath::new(path).is_absolute() {
        FsPath::new(path).to_path_buf()
    } else {
        root.join(path)
    };
    let exists = candidate.exists();
    let full = if !exists {
        let mut existing = candidate.as_path();
        while !existing.exists() {
            existing = existing.parent().ok_or("path must stay inside cwd")?;
        }
        let base = std::fs::canonicalize(existing).map_err(|e| e.to_string())?;
        base.join(
            candidate
                .strip_prefix(existing)
                .map_err(|e| e.to_string())?,
        )
    } else {
        std::fs::canonicalize(&candidate).map_err(|e| e.to_string())?
    };
    if full != root && !full.starts_with(&root) {
        return Err("path must stay inside cwd".to_string());
    }
    if !new_file && !exists {
        return Err(format!("{} does not exist", candidate.display()));
    }
    Ok(full.to_string_lossy().to_string())
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
        let text = if combined.is_empty() {
            String::new()
        } else {
            String::from_utf8_lossy(&combined).to_string()
        };
        let tail = if capped {
            limit_output(
                &append_note(
                    &text,
                    &format!(
                        "Bash output exceeded the 10MB safety cap; complete output was not captured.\n\nCommand timed out after {} seconds.",
                        timeout
                    ),
                ),
                false,
                cwd,
            )
        } else {
            format!("{}\n\nCommand timed out after {} seconds.", text, timeout)
        };
        return tail;
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
    ranges.sort_by(|a, b| a.0.cmp(&b.0));
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
