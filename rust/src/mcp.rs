use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{Value, json};

const MODERN_VERSION: &str = "2026-07-28";
const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
const MAX_RESULT_BYTES: usize = 50 * 1024;
const MAX_SCHEMA_BYTES: usize = 50 * 1024;
const MAX_DESCRIPTION_BYTES: usize = 8 * 1024;
const MAX_SCHEMA_DEPTH: usize = 20;
const MAX_TOOLS: usize = 64;
const STARTUP_TIMEOUT_MS: u64 = 10_000;

#[derive(Clone)]
struct McpHeaderDeclaration {
    path: Vec<String>,
    name: String,
}

#[derive(Clone)]
pub struct McpTool {
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub parameters: Value,
    remote_name: String,
    header_declarations: Vec<McpHeaderDeclaration>,
    client: Arc<McpClient>,
}

impl McpTool {
    pub fn execute(&self, arguments: Value, cancel: &Arc<AtomicBool>) -> Result<String, String> {
        if !arguments.is_object() {
            return Err("MCP tool arguments must be a JSON object".into());
        }
        let headers = build_mcp_param_headers(&self.header_declarations, &arguments);
        let result = self
            .client
            .request_mode_raw(
                "tools/call",
                json!({"name":self.remote_name,"arguments":arguments}),
                self.client.call_timeout_ms,
                Some(cancel),
                headers,
            )
            .map_err(RequestError::message)?;
        validate_modern_call_result(&result)?;
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

#[derive(Clone, Debug)]
pub struct McpConfig {
    pub alias: String,
    pub url: String,
    pub token: Option<String>,
    pub allowed_tools: Option<Vec<String>>,
    pub call_timeout_ms: u64,
}

#[derive(Debug)]
enum RequestError {
    Http(u16, Option<Value>),
    Rpc(Value),
    Message(String),
}

impl RequestError {
    fn message(self) -> String {
        match self {
            Self::Http(status, _) => format!("MCP HTTP {status}"),
            Self::Rpc(error) => {
                let code = error
                    .get("code")
                    .and_then(Value::as_i64)
                    .unwrap_or_default();
                format!("MCP JSON-RPC error {code}")
            }
            Self::Message(message) => message,
        }
    }
}

struct McpClient {
    agent: ureq::Agent,
    url: String,
    token: Option<String>,
    next_id: AtomicU64,
    call_timeout_ms: u64,
    closed: AtomicBool,
    workers: Mutex<Vec<JoinHandle<()>>>,
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
        self.request_mode_raw(method, params, timeout_ms, cancel, Vec::new())
            .map_err(RequestError::message)
    }

    fn request_mode_raw(
        &self,
        method: &str,
        mut params: Value,
        timeout_ms: u64,
        cancel: Option<&Arc<AtomicBool>>,
        headers: Vec<(String, String)>,
    ) -> Result<Value, RequestError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(RequestError::Message("MCP connection is closed".into()));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        add_modern_metadata(&mut params).map_err(RequestError::Message)?;
        let body = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string();
        self.post(body, timeout_ms, cancel, Some(id), headers)
    }

    fn post(
        &self,
        body: String,
        timeout_ms: u64,
        cancel: Option<&Arc<AtomicBool>>,
        expected_id: Option<u64>,
        headers: Vec<(String, String)>,
    ) -> Result<Value, RequestError> {
        self.reap_workers();
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let (tx, rx) = mpsc::channel();
        let agent = self.agent.clone();
        let url = self.url.clone();
        let token = self.token.clone();
        let method = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .get("method")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .ok_or_else(|| RequestError::Message("MCP request has no method".into()))?;
        let transport_timeout = deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(1));
        let handle = thread::spawn(move || {
            let mut request = agent
                .post(&url)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json, text/event-stream")
                .header("MCP-Protocol-Version", MODERN_VERSION)
                .header("Mcp-Method", &method);
            for (name, value) in headers {
                request = request.header(name, value);
            }
            if method == "tools/call"
                && let Ok(value) = serde_json::from_str::<Value>(&body)
                && let Some(name) = value.pointer("/params/name").and_then(Value::as_str)
            {
                request = request.header("Mcp-Name", encode_mcp_name(name));
            }
            if let Some(token) = token {
                request = request.header("Authorization", format!("Bearer {token}"));
            }
            let response = request
                .config()
                .timeout_global(Some(transport_timeout))
                .timeout_connect(Some(transport_timeout))
                .timeout_recv_response(Some(transport_timeout))
                .timeout_recv_body(Some(transport_timeout))
                .build()
                .send(body.as_bytes());
            let result = response
                .map_err(|_| RequestError::Message("MCP transport request failed".into()))
                .and_then(|response| read_response(response, expected_id));
            let _ = tx.send(result);
        });
        self.workers
            .lock()
            .map_err(|_| RequestError::Message("MCP worker lock failed".into()))?
            .push(handle);
        loop {
            if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                return Err(RequestError::Message("Operation aborted".into()));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(RequestError::Message("MCP request timed out".into()));
            }
            match rx.recv_timeout(remaining.min(Duration::from_millis(20))) {
                Ok(Ok(value)) => {
                    self.reap_workers();
                    if expected_id.is_none() || value.is_null() {
                        return Ok(Value::Null);
                    }
                    if let Some(error) = value.get("error") {
                        return Err(RequestError::Rpc(error.clone()));
                    }
                    return value
                        .get("result")
                        .cloned()
                        .ok_or_else(|| RequestError::Message("MCP response has no result".into()));
                }
                Ok(Err(error)) => {
                    self.reap_workers();
                    return Err(error);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => {
                    return Err(RequestError::Message("MCP request worker stopped".into()));
                }
            }
        }
    }

    fn reap_workers(&self) {
        if let Ok(mut workers) = self.workers.lock() {
            let mut pending = Vec::new();
            for handle in workers.drain(..) {
                if handle.is_finished() {
                    let _ = handle.join();
                } else {
                    pending.push(handle);
                }
            }
            *workers = pending;
        }
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Ok(mut workers) = self.workers.lock() {
            for handle in workers.drain(..) {
                let _ = handle.join();
            }
        }
    }
}

fn add_modern_metadata(params: &mut Value) -> Result<(), String> {
    let object = params
        .as_object_mut()
        .ok_or("MCP request params must be an object")?;
    object.insert(
        "_meta".into(),
        json!({
            "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
            "io.modelcontextprotocol/clientInfo": {"name":"tiny-agent","version":"0.1.0"},
            "io.modelcontextprotocol/clientCapabilities": {}
        }),
    );
    Ok(())
}

fn read_response(
    mut response: ureq::http::Response<ureq::Body>,
    expected_id: Option<u64>,
) -> Result<Value, RequestError> {
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("Content-Type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if let Some(length) = response
        .headers()
        .get("Content-Length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        && length > MAX_RESPONSE_BYTES
    {
        return Err(RequestError::Message("MCP response exceeded 10MB".into()));
    }
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| RequestError::Message("Failed to read MCP response".into()))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(RequestError::Message("MCP response exceeded 10MB".into()));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| RequestError::Message("MCP response was not valid UTF-8".into()))?;
    if !(200..300).contains(&status) {
        return Err(RequestError::Http(
            status,
            serde_json::from_str::<Value>(&text).ok(),
        ));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    if content_type.starts_with("text/event-stream") {
        parse_sse(&text, expected_id).map_err(RequestError::Message)
    } else {
        let payload: Value = serde_json::from_str(&text)
            .map_err(|_| RequestError::Message("Invalid MCP JSON response".into()))?;
        validate_response_id(&payload, expected_id).map_err(RequestError::Message)?;
        Ok(payload)
    }
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
            serde_json::from_str(&data).map_err(|_| "Invalid MCP SSE response".to_string())?;
        if validate_response_id(&value, expected_id).is_ok() {
            return Ok(value);
        }
    }
    Err("MCP SSE response contained no matching JSON-RPC response".into())
}
fn validate_response_id(value: &Value, expected_id: Option<u64>) -> Result<(), String> {
    if let Some(expected) = expected_id
        && value.get("id").and_then(Value::as_u64) != Some(expected)
    {
        return Err(format!("MCP response id did not match request {expected}"));
    }
    Ok(())
}

pub fn load_mcp_configs(aliases: &[String]) -> Result<Vec<McpConfig>, String> {
    if aliases.is_empty() {
        return Ok(Vec::new());
    }
    let path = PathBuf::from(
        std::env::var("TINY_MCP_CONFIG")
            .map_err(|_| "TINY_MCP_CONFIG must be set to use --mcp".to_string())?,
    );
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
            Some(Value::Number(n)) => n.as_u64().filter(|n| *n > 0).ok_or_else(|| {
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
    aliases
        .iter()
        .map(|alias| {
            let (url, token_env, allowed_tools, call_timeout_ms) = validated
                .get(alias)
                .ok_or_else(|| format!("Unknown MCP server: {alias}"))?;
            let token = token_env
                .as_ref()
                .map(|name| {
                    std::env::var(name)
                        .ok()
                        .filter(|v| !v.is_empty())
                        .ok_or_else(|| format!("MCP token environment variable is not set: {name}"))
                })
                .transpose()?;
            Ok(McpConfig {
                alias: alias.trim().into(),
                url: url.clone(),
                token,
                allowed_tools: allowed_tools.clone(),
                call_timeout_ms: *call_timeout_ms,
            })
        })
        .collect()
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
        let name = value.as_str().filter(|n| !n.is_empty()).ok_or_else(|| {
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
    if scheme != "https"
        && !(scheme == "http"
            && matches!(
                authority.host(),
                "127.0.0.1" | "localhost" | "[::1]" | "::1"
            ))
    {
        return Err("MCP URL must use HTTPS unless it targets loopback".into());
    }
    Ok(())
}

pub fn load_mcp_tools(config: McpConfig) -> Result<LoadedMcp, String> {
    let agent_config = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build();
    let client = Arc::new(McpClient {
        agent: ureq::Agent::new_with_config(agent_config),
        url: config.url.clone(),
        token: config.token.clone(),
        next_id: AtomicU64::new(1),
        call_timeout_ms: config.call_timeout_ms,
        closed: AtomicBool::new(false),
        workers: Mutex::new(Vec::new()),
    });
    let deadline = Instant::now() + Duration::from_millis(STARTUP_TIMEOUT_MS);
    let discover = client.request_mode_raw(
        "server/discover",
        json!({}),
        remaining_ms(deadline)?,
        None,
        Vec::new(),
    );
    match classify_discover(discover) {
        DiscoverDecision::Modern => {}
        DiscoverDecision::RetryModern => {
            let retry = client.request_mode_raw(
                "server/discover",
                json!({}),
                remaining_ms(deadline)?,
                None,
                Vec::new(),
            );
            match classify_discover(retry) {
                DiscoverDecision::Modern => {}
                DiscoverDecision::RetryModern => {
                    return Err("MCP modern discovery retry was rejected".into());
                }
                DiscoverDecision::Hard(error) => return Err(error),
            }
        }
        DiscoverDecision::Hard(error) => return Err(error),
    };
    let protocol_version = MODERN_VERSION.to_string();
    let listed = client.request("tools/list", json!({}), remaining_ms(deadline)?, None)?;
    validate_modern_list_result(&listed)?;
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
            .filter(|n| !n.is_empty())
            .ok_or("MCP tool name must not be empty")?;
        if !remote_names.insert(name.to_string()) {
            return Err(format!("duplicate MCP tool name: {name}"));
        }
        if allowed.as_ref().is_some_and(|set| !set.contains(name)) {
            continue;
        }
        let schema = remote
            .get("inputSchema")
            .filter(|s| s.is_object())
            .cloned()
            .ok_or_else(|| format!("MCP tool inputSchema must be an object: {name}"))?;
        validate_schema(&schema, name)?;
        let Some(header_declarations) = scan_mcp_header_declarations(&schema) else {
            continue;
        };
        let description = match remote.get("description") {
            None => format!("MCP tool {name} from {}.", config.alias),
            Some(Value::String(v)) => v.clone(),
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
            header_declarations,
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

#[derive(Debug, Eq, PartialEq)]
enum DiscoverDecision {
    Modern,
    RetryModern,
    Hard(String),
}

fn classify_discover(result: Result<Value, RequestError>) -> DiscoverDecision {
    const UNSUPPORTED: &str = "MCP server does not support the modern protocol version";
    match result {
        Ok(result) => {
            let Some(object) = result.as_object() else {
                return DiscoverDecision::Hard(UNSUPPORTED.into());
            };
            if object.get("resultType").and_then(Value::as_str) != Some("complete")
                || !object.get("capabilities").is_some_and(Value::is_object)
            {
                return DiscoverDecision::Hard(UNSUPPORTED.into());
            }
            let Some(versions) = string_array(object.get("supportedVersions")) else {
                return DiscoverDecision::Hard(UNSUPPORTED.into());
            };
            if versions.contains(&MODERN_VERSION) {
                DiscoverDecision::Modern
            } else {
                DiscoverDecision::Hard(UNSUPPORTED.into())
            }
        }
        Err(RequestError::Rpc(error)) => classify_discover_rpc_error(&error),
        Err(RequestError::Http(status, payload)) => {
            if matches!(status, 401 | 403) || status >= 500 {
                return DiscoverDecision::Hard(format!("MCP HTTP {status}"));
            }
            if (400..500).contains(&status)
                && let Some(error) = payload.as_ref().and_then(|value| value.get("error"))
            {
                return classify_discover_rpc_error(error);
            }
            DiscoverDecision::Hard(format!("MCP HTTP {status}"))
        }
        Err(RequestError::Message(error)) => DiscoverDecision::Hard(error),
    }
}

fn classify_discover_rpc_error(error: &Value) -> DiscoverDecision {
    if error.get("code").and_then(Value::as_i64) != Some(-32022) {
        return DiscoverDecision::Hard(
            "MCP server does not support the modern protocol version".into(),
        );
    }
    let Some(supported) = string_array(error.pointer("/data/supported")) else {
        return DiscoverDecision::Hard(
            "MCP server does not support the modern protocol version".into(),
        );
    };
    if supported.contains(&MODERN_VERSION) {
        DiscoverDecision::RetryModern
    } else {
        DiscoverDecision::Hard("MCP server does not support the modern protocol version".into())
    }
}

fn string_array(value: Option<&Value>) -> Option<Vec<&str>> {
    let values = value?.as_array()?;
    if values.is_empty() {
        return None;
    }
    values.iter().map(Value::as_str).collect()
}

fn validate_modern_list_result(result: &Value) -> Result<(), String> {
    let object = result
        .as_object()
        .ok_or("MCP modern tools/list result must be an object")?;
    validate_complete_result_type(object, "tools/list")?;
    object
        .get("ttlMs")
        .and_then(Value::as_u64)
        .ok_or("MCP modern tools/list ttlMs must be a nonnegative integer")?;
    if !matches!(
        object.get("cacheScope").and_then(Value::as_str),
        Some("public" | "private")
    ) {
        return Err("MCP modern tools/list cacheScope must be public or private".into());
    }
    Ok(())
}

fn validate_modern_call_result(result: &Value) -> Result<(), String> {
    let object = result
        .as_object()
        .ok_or("MCP modern tools/call result must be an object")?;
    let result_type = object
        .get("resultType")
        .and_then(Value::as_str)
        .ok_or("MCP modern tools/call resultType must be a string")?;
    match result_type {
        "input_required" => {
            let has_requests = object
                .get("inputRequests")
                .and_then(Value::as_array)
                .is_some_and(|requests| !requests.is_empty());
            let has_state = object
                .get("requestState")
                .is_some_and(|state| !state.is_null());
            if !has_requests && !has_state {
                return Err(
                    "MCP modern tools/call input_required must include inputRequests or requestState"
                        .into(),
                );
            }
            Ok(())
        }
        "complete" => {
            if !object.get("content").is_some_and(Value::is_array) {
                return Err("MCP modern tools/call complete content must be an array".into());
            }
            Ok(())
        }
        _ => Err(format!(
            "Unsupported MCP tools/call resultType: {result_type}"
        )),
    }
}

fn validate_complete_result_type(
    object: &serde_json::Map<String, Value>,
    method: &str,
) -> Result<(), String> {
    let result_type = object
        .get("resultType")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("MCP modern {method} resultType must be a string"))?;
    if result_type != "complete" {
        return Err(format!(
            "Unsupported MCP {method} resultType: {result_type}"
        ));
    }
    Ok(())
}

fn valid_http_token(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

fn scan_mcp_header_declarations(schema: &Value) -> Option<Vec<McpHeaderDeclaration>> {
    fn visit(
        schema: &Value,
        path: &mut Vec<String>,
        seen: &mut HashSet<String>,
        declarations: &mut Vec<McpHeaderDeclaration>,
    ) -> bool {
        let Some(object) = schema.as_object() else {
            return true;
        };
        if let Some(raw) = object.get("x-mcp-header") {
            let Some(name) = raw.as_str() else {
                return false;
            };
            let primitive = matches!(
                object.get("type").and_then(Value::as_str),
                Some("string" | "number" | "integer" | "boolean")
            );
            let folded = name.to_ascii_lowercase();
            if path.is_empty() || !primitive || !valid_http_token(name) || !seen.insert(folded) {
                return false;
            }
            declarations.push(McpHeaderDeclaration {
                path: path.clone(),
                name: name.to_string(),
            });
        }
        let Some(properties) = object.get("properties").and_then(Value::as_object) else {
            return true;
        };
        for (name, child) in properties {
            path.push(name.clone());
            let valid = visit(child, path, seen, declarations);
            path.pop();
            if !valid {
                return false;
            }
        }
        true
    }

    let mut declarations = Vec::new();
    let mut seen = HashSet::new();
    visit(schema, &mut Vec::new(), &mut seen, &mut declarations).then_some(declarations)
}

fn value_at_path<'a>(arguments: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter().try_fold(arguments, |value, key| value.get(key))
}

fn mirrored_primitive(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Number(value) => {
            if let Some(integer) = value.as_i64() {
                return (integer.unsigned_abs() <= 9_007_199_254_740_991)
                    .then(|| integer.to_string());
            }
            if let Some(integer) = value.as_u64() {
                return (integer <= 9_007_199_254_740_991).then(|| integer.to_string());
            }
            let number = value.as_f64()?;
            number.is_finite().then(|| number.to_string())
        }
        _ => None,
    }
}

fn build_mcp_param_headers(
    declarations: &[McpHeaderDeclaration],
    arguments: &Value,
) -> Vec<(String, String)> {
    declarations
        .iter()
        .filter_map(|declaration| {
            let value = value_at_path(arguments, &declaration.path)?;
            if value.is_null() {
                return None;
            }
            let value = mirrored_primitive(value)?;
            Some((
                format!("Mcp-Param-{}", declaration.name),
                encode_mcp_name(&value),
            ))
        })
        .collect()
}

fn encode_mcp_name(name: &str) -> String {
    let plain = !name.is_empty()
        && name.trim() == name
        && name
            .chars()
            .all(|character| character == '\t' || (' '..='~').contains(&character))
        && !(name.starts_with("=?base64?") && name.ends_with("?="));
    if plain {
        return name.to_string();
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(name.as_bytes());
    format!("=?base64?{encoded}?=")
}

fn remaining_ms(deadline: Instant) -> Result<u64, String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        Err("MCP request timed out".into())
    } else {
        Ok(remaining.as_millis().min(u64::MAX as u128) as u64)
    }
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
        Value::Array(v) => 1 + v.iter().map(json_depth).max().unwrap_or(0),
        Value::Object(v) => 1 + v.values().map(json_depth).max().unwrap_or(0),
        _ => 0,
    }
}
fn map_tool_name(alias: &str, remote: &str) -> Result<String, String> {
    let e = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let name = format!("mcp__{}__{}", e.encode(alias), e.encode(remote));
    if name.len() > 64 {
        Err(format!(
            "mapped MCP tool name exceeds 64 characters: {remote}"
        ))
    } else {
        Ok(name)
    }
}
pub fn display_tool_name(name: &str) -> String {
    let Some(encoded) = name.strip_prefix("mcp__") else {
        return name.into();
    };
    let Some((alias, tool)) = encoded.split_once("__") else {
        return name.into();
    };
    let e = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    e.decode(alias)
        .ok()
        .and_then(|a| e.decode(tool).ok().map(|t| (a, t)))
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
            match kind {
                "text" => parts.push(
                    item.get("text")
                        .and_then(Value::as_str)
                        .ok_or("MCP text content must contain string text")?
                        .to_string(),
                ),
                "resource" => {
                    let resource = item
                        .get("resource")
                        .and_then(Value::as_object)
                        .ok_or("MCP resource content must contain an object resource")?;
                    if resource.contains_key("blob") {
                        return Err("Unsupported MCP content type: resource".into());
                    }
                    let text = resource
                        .get("text")
                        .and_then(Value::as_str)
                        .ok_or("Unsupported MCP content type: resource")?;
                    let source = resource
                        .get("uri")
                        .and_then(Value::as_str)
                        .map(|uri| format!("Resource: {uri}\n"))
                        .unwrap_or_default();
                    parts.push(format!("{source}{text}"));
                }
                _ => return Err(format!("Unsupported MCP content type: {kind}")),
            }
        }
    }
    if let Some(v) = result.get("structuredContent") {
        parts.push(format!(
            "Structured content:\n{}",
            serde_json::to_string(v).map_err(|e| e.to_string())?
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
        end -= 1
    }
    format!("{}{suffix}", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resource_normalization_rejects_blob_and_allows_missing_uri() {
        assert_eq!(
            normalize_result(&json!({"content":[{"type":"resource","resource":{"text":"body"}}]}))
                .unwrap(),
            "body"
        );
        assert_eq!(
            normalize_result(
                &json!({"content":[{"type":"resource","resource":{"text":"body","blob":"AA=="}}]})
            )
            .unwrap_err(),
            "Unsupported MCP content type: resource"
        );
    }

    #[test]
    fn catalog_validates_unselected_entries() {
        let catalog =
            json!({"servers":{"selected":{"url":"https://example.com/mcp"},"broken":{"url":42}}});
        assert_eq!(
            validate_catalog(&catalog, &["selected".into()]).unwrap_err(),
            "MCP server broken url must be a string"
        );
    }

    #[test]
    fn discover_classifier_is_modern_only_with_a_corrective_retry() {
        const UNSUPPORTED: &str = "MCP server does not support the modern protocol version";
        let complete = |versions: Value| {
            Ok(json!({
                "resultType":"complete",
                "supportedVersions":versions,
                "capabilities":{},
                "protocolVersion":"an allowed extension"
            }))
        };
        assert_eq!(
            classify_discover(complete(json!([MODERN_VERSION]))),
            DiscoverDecision::Modern
        );
        assert_eq!(
            classify_discover(complete(json!(["2025-11-25"]))),
            DiscoverDecision::Hard(UNSUPPORTED.into())
        );
        assert_eq!(
            classify_discover(Ok(json!({"supportedVersions":[MODERN_VERSION]}))),
            DiscoverDecision::Hard(UNSUPPORTED.into())
        );
        assert_eq!(
            classify_discover(Err(RequestError::Rpc(json!({"code":-32601})))),
            DiscoverDecision::Hard(UNSUPPORTED.into())
        );
        assert_eq!(
            classify_discover(Err(RequestError::Rpc(json!({
                "code":-32022,
                "data":{"supported":[MODERN_VERSION]}
            })))),
            DiscoverDecision::RetryModern
        );
        assert_eq!(
            classify_discover(Err(RequestError::Rpc(json!({
                "code":-32022,
                "data":{"supported":["2027-01-01"]}
            })))),
            DiscoverDecision::Hard(UNSUPPORTED.into())
        );
        assert_eq!(
            classify_discover(Err(RequestError::Rpc(json!({
                "code":-32022,
                "data":{"supported":[MODERN_VERSION, 1]}
            })))),
            DiscoverDecision::Hard(UNSUPPORTED.into())
        );
        assert_eq!(
            classify_discover(Err(RequestError::Http(
                400,
                Some(json!({"error":{"code":-32601}}))
            ))),
            DiscoverDecision::Hard(UNSUPPORTED.into())
        );
        assert_eq!(
            classify_discover(Err(RequestError::Http(401, None))),
            DiscoverDecision::Hard("MCP HTTP 401".into())
        );
        assert_eq!(
            classify_discover(Err(RequestError::Message("network failed".into()))),
            DiscoverDecision::Hard("network failed".into())
        );
    }

    #[test]
    fn mcp_name_uses_sep_2243_encoding() {
        assert_eq!(
            encode_mcp_name("echo tool\t"),
            "=?base64?ZWNobyB0b29sCQ==?="
        );
        assert_eq!(encode_mcp_name(" padded "), "=?base64?IHBhZGRlZCA=?=");
        assert_eq!(encode_mcp_name("工具"), "=?base64?5bel5YW3?=");
        assert_eq!(
            encode_mcp_name("=?base64?ZWNobw==?="),
            "=?base64?PT9iYXNlNjQ/WldOb2J3PT0/PQ==?="
        );
        assert_eq!(encode_mcp_name(""), "=?base64??=");
    }

    #[test]
    fn modern_results_require_official_wrappers() {
        assert!(
            validate_modern_list_result(&json!({
                "resultType":"complete","tools":[],"ttlMs":0,"cacheScope":"public"
            }))
            .is_ok()
        );
        assert!(
            validate_modern_list_result(&json!({
                "resultType":"complete","tools":[],"ttlMs":-1,"cacheScope":"public"
            }))
            .is_err()
        );
        assert!(
            validate_modern_call_result(&json!({
                "resultType":"complete","content":[]
            }))
            .is_ok()
        );
        assert!(
            validate_modern_call_result(&json!({
                "resultType":"input_required",
                "inputRequests":[{"type":"text"}]
            }))
            .is_ok()
        );
        assert!(validate_modern_call_result(&json!({"resultType":"input_required"})).is_err());
        assert!(
            validate_modern_call_result(&json!({
                "resultType":"unknown","content":[]
            }))
            .is_err()
        );
        assert!(validate_modern_call_result(&json!({"content":[]})).is_err());
    }
}
