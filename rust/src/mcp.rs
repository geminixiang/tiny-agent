use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{Value, json};

const MAX_RESULT_BYTES: usize = 50 * 1024;
const MAX_SCHEMA_BYTES: usize = 50 * 1024;
const MAX_DESCRIPTION_BYTES: usize = 8 * 1024;
const MAX_SCHEMA_DEPTH: usize = 20;
const MAX_TOOLS: usize = 64;
const STARTUP_TIMEOUT_MS: u64 = 10_000;

#[derive(Clone)]
pub struct McpTool {
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub parameters: Value,
    remote_name: String,
    client: Arc<McpClient>,
}

impl McpTool {
    pub fn execute(&self, arguments: Value, cancel: &Arc<AtomicBool>) -> Result<String, String> {
        if !arguments.is_object() {
            return Err("MCP tool arguments must be a JSON object".into());
        }
        let result = self.client.request(
            "tools/call",
            json!({"name": self.remote_name, "arguments": arguments}),
            self.client.call_timeout_ms,
            Some(cancel),
        )?;
        if result.get("resultType").and_then(Value::as_str) == Some("input_required") {
            return Err(
                "MCP tool requires additional user input; input_required is not supported".into(),
            );
        }
        let normalized = normalize_result(&result)?;
        if result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Err(format!("MCP tool error: {normalized}"));
        }
        Ok(normalized)
    }
}

pub struct LoadedMcp {
    pub alias: String,
    pub protocol_version: String,
    pub tools: Vec<McpTool>,
    client: Arc<McpClient>,
}

impl LoadedMcp {
    pub fn close(&self) {
        self.client.close();
    }
}

#[derive(Clone)]
pub struct McpConfig {
    pub alias: String,
    pub url: String,
    pub token: Option<String>,
    pub allowed_tools: Option<Vec<String>>,
    pub call_timeout_ms: u64,
}

struct McpClient {
    agent: ureq::Agent,
    url: String,
    token: Option<String>,
    session_id: std::sync::Mutex<Option<String>>,
    protocol_version: std::sync::Mutex<String>,
    next_id: AtomicU64,
    call_timeout_ms: u64,
    closed: AtomicBool,
}

impl Drop for McpClient {
    fn drop(&mut self) {
        self.close();
    }
}

impl McpClient {
    fn request(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
        cancel: Option<&Arc<AtomicBool>>,
    ) -> Result<Value, String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("MCP connection is closed".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let body = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string();
        self.post(body, timeout_ms, cancel, Some(id))
    }

    fn notify(&self, method: &str, timeout_ms: u64) -> Result<(), String> {
        let body = json!({"jsonrpc":"2.0","method":method}).to_string();
        self.post(body, timeout_ms, None, None).map(|_| ())
    }

    fn post(
        &self,
        body: String,
        timeout_ms: u64,
        cancel: Option<&Arc<AtomicBool>>,
        expected_id: Option<u64>,
    ) -> Result<Value, String> {
        let (tx, rx) = mpsc::channel();
        let agent = self.agent.clone();
        let url = self.url.clone();
        let token = self.token.clone();
        let session = self
            .session_id
            .lock()
            .map_err(|_| "MCP session lock failed")?
            .clone();
        let protocol_version = self
            .protocol_version
            .lock()
            .map_err(|_| "MCP protocol version lock failed")?
            .clone();
        thread::spawn(move || {
            let mut request = agent
                .post(&url)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json, text/event-stream")
                .header("MCP-Protocol-Version", protocol_version);
            if let Some(token) = token {
                request = request.header("Authorization", format!("Bearer {token}"));
            }
            if let Some(session) = session {
                request = request.header("Mcp-Session-Id", session);
            }
            let response = request.send(body.as_bytes()).map_err(|e| e.to_string());
            let _ = tx.send(response.and_then(|response| read_response(response, expected_id)));
        });
        let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                // ureq is blocking and cannot abort an in-flight socket. Returning detaches the
                // bounded worker; its configured I/O timeout remains the final cleanup bound.
                return Err("Operation aborted".into());
            }
            if std::time::Instant::now() >= deadline {
                return Err("MCP request timed out".into());
            }
            match rx.recv_timeout(Duration::from_millis(20)) {
                Ok(Ok((value, response_session))) => {
                    if let Some(value) = response_session {
                        *self
                            .session_id
                            .lock()
                            .map_err(|_| "MCP session lock failed")? = Some(value);
                    }
                    if expected_id.is_none() || value.is_null() {
                        return Ok(Value::Null);
                    }
                    if let Some(error) = value.get("error") {
                        return Err(format!("MCP error: {error}"));
                    }
                    return value
                        .get("result")
                        .cloned()
                        .ok_or("MCP response has no result".into());
                }
                Ok(Err(error)) => return Err(error),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => return Err("MCP request worker stopped".into()),
            }
        }
    }

    fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(session) = self.session_id.lock().ok().and_then(|value| value.clone()) else {
            return;
        };
        let mut request = self
            .agent
            .delete(&self.url)
            .header("Mcp-Session-Id", session);
        if let Some(token) = &self.token {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        let _ = request.call();
    }
}

fn read_response(
    mut response: ureq::http::Response<ureq::Body>,
    expected_id: Option<u64>,
) -> Result<(Value, Option<String>), String> {
    let status = response.status().as_u16();
    let session = response
        .headers()
        .get("Mcp-Session-Id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let content_type = response
        .headers()
        .get("Content-Type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let text = response
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    if !(200..300).contains(&status) {
        return Err(format!("MCP HTTP {status}"));
    }
    if text.trim().is_empty() {
        return Ok((Value::Null, session));
    }
    let payload = if content_type.starts_with("text/event-stream") {
        parse_sse(&text, expected_id)?
    } else {
        let payload: Value =
            serde_json::from_str(&text).map_err(|e| format!("Invalid MCP JSON response: {e}"))?;
        validate_response_id(&payload, expected_id)?;
        payload
    };
    Ok((payload, session))
}

fn parse_sse(text: &str, expected_id: Option<u64>) -> Result<Value, String> {
    for event in text.replace("\r\n", "\n").split("\n\n") {
        let data = event
            .lines()
            .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            continue;
        }
        let value: Value =
            serde_json::from_str(&data).map_err(|e| format!("Invalid MCP SSE response: {e}"))?;
        if validate_response_id(&value, expected_id).is_ok() {
            return Ok(value);
        }
    }
    Err("MCP SSE response contained no matching JSON-RPC response".into())
}

fn validate_response_id(value: &Value, expected_id: Option<u64>) -> Result<(), String> {
    let Some(expected_id) = expected_id else {
        return Ok(());
    };
    if value.get("id").and_then(Value::as_u64) != Some(expected_id) {
        return Err(format!(
            "MCP response id did not match request {expected_id}"
        ));
    }
    Ok(())
}

pub fn load_mcp_configs(aliases: &[String]) -> Result<Vec<McpConfig>, String> {
    if aliases.is_empty() {
        return Ok(Vec::new());
    }
    let path = std::env::var("TINY_MCP_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_default();
            PathBuf::from(home).join(".tiny-agent/mcp.json")
        });
    let text = std::fs::read_to_string(path).map_err(|_| {
        "Failed to load MCP catalog: file is missing, unreadable, or invalid JSON".to_string()
    })?;
    let value: Value = serde_json::from_str(&text).map_err(|_| {
        "Failed to load MCP catalog: file is missing, unreadable, or invalid JSON".to_string()
    })?;
    validate_catalog(&value, aliases)
}

fn validate_catalog(value: &Value, aliases: &[String]) -> Result<Vec<McpConfig>, String> {
    let root = value.as_object().ok_or("MCP catalog must be an object")?;
    if let Some(field) = root.keys().find(|key| key.as_str() != "servers") {
        return Err(format!("Unknown MCP catalog field: {field}"));
    }
    let servers = root
        .get("servers")
        .and_then(Value::as_object)
        .ok_or("MCP catalog servers must be an object")?;
    let allowed_keys = ["url", "tokenEnv", "allowedTools", "callTimeoutMs"];
    let mut validated = HashMap::new();
    for (alias, raw) in servers {
        if alias.trim().is_empty() {
            return Err("MCP server alias must not be empty".into());
        }
        let server = raw
            .as_object()
            .ok_or_else(|| format!("MCP server {alias} must be an object"))?;
        if let Some(field) = server
            .keys()
            .find(|key| !allowed_keys.contains(&key.as_str()))
        {
            return Err(format!("Unknown MCP server {alias} field: {field}"));
        }
        let url = server
            .get("url")
            .and_then(Value::as_str)
            .filter(|url| !url.is_empty())
            .ok_or_else(|| format!("MCP server {alias} url must be a string"))?;
        validate_url(url)?;
        let token_env = match server.get("tokenEnv") {
            None => None,
            Some(Value::String(name)) if valid_env_name(name) => Some(name.clone()),
            _ => {
                return Err(format!(
                    "MCP server {alias} tokenEnv must be an environment variable name"
                ));
            }
        };
        let allowed_tools = validate_allowed_tools(alias, server.get("allowedTools"))?;
        let call_timeout_ms = match server.get("callTimeoutMs") {
            None => 30_000,
            Some(Value::Number(number)) => number.as_u64().filter(|n| *n > 0).ok_or_else(|| {
                format!("MCP server {alias} callTimeoutMs must be a positive number")
            })?,
            _ => {
                return Err(format!(
                    "MCP server {alias} callTimeoutMs must be a positive number"
                ));
            }
        };
        validated.insert(
            alias.clone(),
            (url.to_string(), token_env, allowed_tools, call_timeout_ms),
        );
    }

    let mut configs = Vec::new();
    for alias in aliases {
        let (url, token_env, allowed_tools, call_timeout_ms) = validated
            .get(alias)
            .ok_or_else(|| format!("Unknown MCP server: {alias}"))?;
        let token = match token_env {
            Some(name) => Some(
                std::env::var(name)
                    .ok()
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| format!("MCP token environment variable is not set: {name}"))?,
            ),
            None => None,
        };
        configs.push(McpConfig {
            alias: alias.trim().into(),
            url: url.clone(),
            token,
            allowed_tools: allowed_tools.clone(),
            call_timeout_ms: *call_timeout_ms,
        });
    }
    Ok(configs)
}

fn validate_allowed_tools(
    alias: &str,
    value: Option<&Value>,
) -> Result<Option<Vec<String>>, String> {
    let Some(value) = value else { return Ok(None) };
    let array = value
        .as_array()
        .ok_or_else(|| format!("MCP server {alias} allowedTools must contain nonempty strings"))?;
    let mut seen = HashSet::new();
    let mut tools = Vec::new();
    for value in array {
        let name = value
            .as_str()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                format!("MCP server {alias} allowedTools must contain nonempty strings")
            })?;
        if !seen.insert(name.to_string()) {
            return Err(format!(
                "MCP server {alias} allowedTools must not contain duplicates"
            ));
        }
        tools.push(name.to_string());
    }
    Ok(Some(tools))
}

fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some('_' | 'A'..='Z' | 'a'..='z'))
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

fn validate_url(url: &str) -> Result<(), String> {
    let uri: http::Uri = url.parse().map_err(|_| "MCP URL must be a valid URL")?;
    let scheme = uri.scheme_str().ok_or("MCP URL must be a valid URL")?;
    let authority = uri.authority().ok_or("MCP URL must be a valid URL")?;
    if authority.as_str().contains('@') {
        return Err("MCP URL must not contain credentials".into());
    }
    let host = authority.host();
    if scheme != "https"
        && !(scheme == "http" && matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1"))
    {
        return Err("MCP URL must use HTTPS unless it targets loopback".into());
    }
    Ok(())
}

pub fn load_mcp_tools(config: McpConfig) -> Result<LoadedMcp, String> {
    let agent_config = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_millis(
            config.call_timeout_ms.max(STARTUP_TIMEOUT_MS),
        )))
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_recv_response(Some(Duration::from_millis(
            config.call_timeout_ms.max(STARTUP_TIMEOUT_MS),
        )))
        .timeout_recv_body(Some(Duration::from_millis(
            config.call_timeout_ms.max(STARTUP_TIMEOUT_MS),
        )))
        .build();
    let client = Arc::new(McpClient {
        agent: ureq::Agent::new_with_config(agent_config),
        url: config.url,
        token: config.token,
        session_id: std::sync::Mutex::new(None),
        protocol_version: std::sync::Mutex::new("2025-03-26".into()),
        next_id: AtomicU64::new(1),
        call_timeout_ms: config.call_timeout_ms,
        closed: AtomicBool::new(false),
    });
    let startup_deadline = Instant::now() + Duration::from_millis(STARTUP_TIMEOUT_MS);
    let initialized = client.request(
        "initialize",
        json!({
            "protocolVersion":"2025-03-26",
            "capabilities":{},
            "clientInfo":{"name":"tiny-agent","version":"0.1.0"}
        }),
        remaining_ms(startup_deadline)?,
        None,
    )?;
    let protocol_version = initialized
        .get("protocolVersion")
        .and_then(Value::as_str)
        .ok_or("MCP server did not negotiate a protocol version")?
        .to_string();
    if protocol_version != "2025-03-26" {
        return Err(format!(
            "MCP server negotiated unsupported protocol version: {protocol_version}"
        ));
    }
    *client
        .protocol_version
        .lock()
        .map_err(|_| "MCP protocol version lock failed")? = protocol_version.clone();
    client.notify("notifications/initialized", remaining_ms(startup_deadline)?)?;
    let listed = client.request(
        "tools/list",
        json!({}),
        remaining_ms(startup_deadline)?,
        None,
    )?;
    let remotes = listed
        .get("tools")
        .and_then(Value::as_array)
        .ok_or("MCP tools/list returned invalid tools")?;
    if remotes.len() > MAX_TOOLS {
        return Err(format!("MCP server returned more than {MAX_TOOLS} tools"));
    }
    let allowed = config
        .allowed_tools
        .as_ref()
        .map(|v| v.iter().cloned().collect::<HashSet<_>>());
    let mut remote_names = HashSet::new();
    let mut mapped_names = HashSet::new();
    let mut tools = Vec::new();
    for remote in remotes {
        let remote = remote
            .as_object()
            .ok_or("MCP tools/list returned a non-object tool")?;
        let name = remote
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .ok_or("MCP tool name must not be empty")?;
        if !remote_names.insert(name.to_string()) {
            return Err(format!("duplicate MCP tool name: {name}"));
        }
        if allowed.as_ref().is_some_and(|set| !set.contains(name)) {
            continue;
        }
        let schema = remote
            .get("inputSchema")
            .filter(|schema| schema.is_object())
            .cloned()
            .ok_or_else(|| format!("MCP tool inputSchema must be an object: {name}"))?;
        validate_schema(&schema, name)?;
        let description = match remote.get("description") {
            None => format!("MCP tool {name} from {}.", config.alias),
            Some(Value::String(description)) => description.clone(),
            Some(_) => return Err(format!("MCP tool description must be a string: {name}")),
        };
        if description.len() > MAX_DESCRIPTION_BYTES {
            return Err(format!("MCP tool description exceeds 8KB: {name}"));
        }
        let mapped = map_tool_name(&config.alias, name)?;
        if !mapped_names.insert(mapped.clone()) {
            return Err(format!("duplicate mapped MCP tool name: {mapped}"));
        }
        tools.push(McpTool {
            name: mapped,
            display_name: format!("mcp:{}/{name}", config.alias),
            description,
            parameters: schema,
            remote_name: name.into(),
            client: client.clone(),
        });
    }
    if let Some(allowed) = allowed {
        let missing = allowed
            .difference(&remote_names)
            .cloned()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(format!(
                "MCP allowed tools were not found: {}",
                missing.join(", ")
            ));
        }
    }
    Ok(LoadedMcp {
        alias: config.alias,
        protocol_version,
        tools,
        client,
    })
}

fn remaining_ms(deadline: Instant) -> Result<u64, String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err("MCP request timed out".into());
    }
    Ok(remaining.as_millis().min(u64::MAX as u128) as u64)
}

fn validate_schema(schema: &Value, name: &str) -> Result<(), String> {
    let encoded = serde_json::to_vec(schema)
        .map_err(|_| format!("MCP tool schema is not JSON-serializable: {name}"))?;
    if encoded.len() > MAX_SCHEMA_BYTES {
        return Err(format!("MCP tool schema exceeds 50KB: {name}"));
    }
    if json_depth(schema) > MAX_SCHEMA_DEPTH {
        return Err(format!(
            "MCP tool schema exceeds depth {MAX_SCHEMA_DEPTH}: {name}"
        ));
    }
    Ok(())
}
fn json_depth(value: &Value) -> usize {
    match value {
        Value::Array(values) => 1 + values.iter().map(json_depth).max().unwrap_or(0),
        Value::Object(values) => 1 + values.values().map(json_depth).max().unwrap_or(0),
        _ => 0,
    }
}
fn map_tool_name(alias: &str, remote: &str) -> Result<String, String> {
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let name = format!("mcp__{}__{}", engine.encode(alias), engine.encode(remote));
    if name.len() > 64 {
        return Err(format!(
            "mapped MCP tool name exceeds 64 characters: {remote}"
        ));
    }
    Ok(name)
}

pub fn display_tool_name(name: &str) -> String {
    let Some(encoded) = name.strip_prefix("mcp__") else {
        return name.into();
    };
    let Some((alias, tool)) = encoded.split_once("__") else {
        return name.into();
    };
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let decoded = engine
        .decode(alias)
        .ok()
        .and_then(|a| engine.decode(tool).ok().map(|t| (a, t)));
    decoded
        .and_then(|(a, t)| {
            Some(format!(
                "mcp:{}/{}",
                String::from_utf8(a).ok()?,
                String::from_utf8(t).ok()?
            ))
        })
        .unwrap_or_else(|| name.into())
}

fn normalize_result(result: &Value) -> Result<String, String> {
    let result = result
        .as_object()
        .ok_or("MCP tool result must be an object")?;
    let mut parts = Vec::new();
    if let Some(value) = result.get("content") {
        let content = value
            .as_array()
            .ok_or("MCP tool content must be an array")?;
        for item in content {
            let item = item
                .as_object()
                .ok_or("MCP tool content item must be an object")?;
            let kind = item
                .get("type")
                .and_then(Value::as_str)
                .ok_or("MCP tool content type must be a string")?;
            if kind != "text" {
                return Err(format!("Unsupported MCP content type: {kind}"));
            }
            let text = item
                .get("text")
                .and_then(Value::as_str)
                .ok_or("MCP text content must contain string text")?;
            parts.push(text.to_string());
        }
    }
    if let Some(structured) = result.get("structuredContent") {
        parts.push(format!(
            "Structured content:\n{}",
            serde_json::to_string(structured).map_err(|e| e.to_string())?
        ));
    }
    let text = if parts.is_empty() {
        "(no output)".into()
    } else {
        parts.join("\n\n")
    };
    Ok(truncate_utf8(&text))
}
fn truncate_utf8(text: &str) -> String {
    if text.len() <= MAX_RESULT_BYTES {
        return text.into();
    }
    let suffix = "\n\n[MCP result truncated to 50KB]";
    let mut end = MAX_RESULT_BYTES - suffix.len();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{suffix}", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_validates_unselected_entries_before_selection() {
        let catalog = json!({
            "servers": {
                "selected": {"url": "https://example.com/mcp"},
                "broken": {"url": 42}
            }
        });
        let error = validate_catalog(&catalog, &["selected".into()])
            .err()
            .expect("catalog should fail");
        assert_eq!(error, "MCP server broken url must be a string");
    }

    #[test]
    fn catalog_rejects_empty_unselected_aliases() {
        let catalog = json!({
            "servers": {
                "selected": {"url": "https://example.com/mcp"},
                "  ": {"url": "https://example.com/other"}
            }
        });
        let error = validate_catalog(&catalog, &["selected".into()])
            .err()
            .expect("catalog should fail");
        assert_eq!(error, "MCP server alias must not be empty");
    }
}
