use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use base64::Engine;
use http::{HeaderName, HeaderValue};
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, ClientCapabilities, ClientInfo, Implementation,
    ProtocolVersion,
};
use rmcp::transport::{
    StreamableHttpClientTransport, streamable_http_client::StreamableHttpClientTransportConfig,
};
use rmcp::{ClientLifecycleMode, ClientServiceExt};
use serde_json::Value;

const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
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
        let result = self.client.call(&self.remote_name, arguments, cancel)?;
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
    alias: String,
    url: String,
    auth_header: Option<(String, String)>,
    allowed_tools: Option<Vec<String>>,
    call_timeout_ms: u64,
}

impl McpConfig {
    pub fn new(
        alias: String,
        url: String,
        token: Option<String>,
        allowed_tools: Option<Vec<String>>,
        call_timeout_ms: u64,
    ) -> Result<Self, String> {
        if alias.trim().is_empty() {
            return Err("MCP alias must be a nonempty string".into());
        }
        validate_url(&url)?;
        if call_timeout_ms == 0 {
            return Err("MCP callTimeoutMs must be a positive number".into());
        }
        if token
            .as_ref()
            .is_some_and(|token| token.chars().any(char::is_control))
        {
            return Err("MCP token contains invalid HTTP header characters".into());
        }
        if let Some(tools) = &allowed_tools {
            let mut seen = HashSet::new();
            if tools
                .iter()
                .any(|tool| tool.is_empty() || !seen.insert(tool))
            {
                return Err("MCP allowedTools must contain nonempty, unique strings".into());
            }
        }
        Ok(Self {
            alias: alias.trim().into(),
            url,
            auth_header: token.map(|token| ("Authorization".into(), format!("Bearer {token}"))),
            allowed_tools,
            call_timeout_ms,
        })
    }

    pub fn alias(&self) -> &str {
        &self.alias
    }
}

enum McpCommand {
    Call {
        name: String,
        arguments: Value,
        cancel: Arc<AtomicBool>,
        reply: mpsc::Sender<Result<Value, String>>,
    },
    Close(mpsc::Sender<()>),
}

struct McpClient {
    commands: mpsc::Sender<McpCommand>,
    thread: Mutex<Option<JoinHandle<()>>>,
    closed: Arc<AtomicBool>,
}

impl McpClient {
    fn call(
        &self,
        name: &str,
        arguments: Value,
        cancel: &Arc<AtomicBool>,
    ) -> Result<Value, String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("MCP connection is closed".into());
        }
        let (reply, result) = mpsc::channel();
        self.commands
            .send(McpCommand::Call {
                name: name.into(),
                arguments,
                cancel: cancel.clone(),
                reply,
            })
            .map_err(|_| "MCP connection is closed".to_string())?;
        result
            .recv()
            .map_err(|_| "MCP connection is closed".to_string())?
    }

    fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let (reply, closed) = mpsc::channel();
        let _ = self.commands.send(McpCommand::Close(reply));
        let _ = closed.recv_timeout(Duration::from_secs(5));
        if let Ok(mut handle) = self.thread.lock()
            && let Some(handle) = handle.take()
        {
            let _ = handle.join();
        }
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        self.close();
    }
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
    let allowed_keys = ["url", "tokenEnv", "auth", "allowedTools", "callTimeoutMs"];
    let mut validated = HashMap::new();
    for (alias, raw) in servers {
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
        let token_env = match server.get("tokenEnv") {
            None => None,
            Some(Value::String(name)) if valid_env_name(name) => Some(name.clone()),
            _ => {
                return Err(format!(
                    "MCP server {alias} tokenEnv must be an environment variable name"
                ));
            }
        };
        if token_env.is_some() && server.get("auth").is_some() {
            return Err(format!(
                "MCP server {alias} must not set both tokenEnv and auth"
            ));
        }
        let (credential_env, header_name) = if let Some(auth) = server.get("auth") {
            let auth = auth
                .as_object()
                .ok_or_else(|| format!("MCP server {alias} auth must be an object"))?;
            let allowed_auth_keys = ["type", "tokenEnv"];
            if let Some(field) = auth
                .keys()
                .find(|key| !allowed_auth_keys.contains(&key.as_str()))
            {
                return Err(format!("Unknown MCP server {alias} auth field: {field}"));
            }
            if auth.get("type").and_then(Value::as_str) != Some("metabaseApiKey") {
                return Err(format!(
                    "MCP server {alias} auth type must be metabaseApiKey"
                ));
            }
            let name = auth
                .get("tokenEnv")
                .and_then(Value::as_str)
                .filter(|name| valid_env_name(name))
                .ok_or_else(|| {
                    format!("MCP server {alias} auth tokenEnv must be an environment variable name")
                })?;
            (Some(name.to_string()), "X-API-Key")
        } else {
            (token_env, "Authorization")
        };
        let allowed_tools = parse_allowed_tools(alias, server.get("allowedTools"))?;
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
            (
                url.to_string(),
                credential_env,
                header_name,
                allowed_tools,
                call_timeout_ms,
            ),
        );
    }
    aliases
        .iter()
        .map(|alias| {
            let (url, token_env, header_name, allowed_tools, call_timeout_ms) = validated
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
            if token
                .as_ref()
                .is_some_and(|token| token.chars().any(char::is_control))
            {
                return Err(format!(
                    "MCP token environment variable contains invalid HTTP header characters: {}",
                    token_env.as_deref().unwrap_or_default()
                ));
            }
            let mut config = McpConfig::new(
                alias.clone(),
                url.clone(),
                None,
                allowed_tools.clone(),
                *call_timeout_ms,
            )?;
            config.auth_header = token.map(|token| {
                if *header_name == "X-API-Key" {
                    (header_name.to_string(), token)
                } else {
                    (header_name.to_string(), format!("Bearer {token}"))
                }
            });
            Ok(config)
        })
        .collect()
}

fn parse_allowed_tools(alias: &str, value: Option<&Value>) -> Result<Option<Vec<String>>, String> {
    let Some(value) = value else { return Ok(None) };
    let array = value
        .as_array()
        .ok_or_else(|| format!("MCP server {alias} allowedTools must contain nonempty strings"))?;
    let mut tools = Vec::new();
    for value in array {
        let name = value
            .as_str()
            .ok_or_else(|| format!("MCP server {alias} allowedTools must contain strings"))?;
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
    let (commands, receiver) = mpsc::channel();
    let (started, startup) = mpsc::channel();
    let closed = Arc::new(AtomicBool::new(false));
    let thread_closed = closed.clone();
    let thread_config = config.clone();
    let handle =
        thread::spawn(move || run_mcp_client(thread_config, receiver, started, thread_closed));
    let (protocol_version, remotes) =
        match startup.recv_timeout(Duration::from_millis(STARTUP_TIMEOUT_MS)) {
            Ok(Ok(started)) => started,
            Ok(Err(error)) => {
                let _ = handle.join();
                return Err(error);
            }
            Err(_) => {
                closed.store(true, Ordering::SeqCst);
                return Err("MCP request timed out".into());
            }
        };
    let client = Arc::new(McpClient {
        commands,
        thread: Mutex::new(Some(handle)),
        closed,
    });
    if remotes.len() > MAX_TOOLS {
        client.close();
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
        let Some(_header_declarations) = scan_mcp_header_declarations(&schema) else {
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

fn run_mcp_client(
    config: McpConfig,
    commands: mpsc::Receiver<McpCommand>,
    started: mpsc::Sender<Result<(String, Vec<Value>), String>>,
    closed: Arc<AtomicBool>,
) {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => {
            let _ = started.send(Err("Failed to start MCP runtime".into()));
            return;
        }
    };
    let connected = runtime.block_on(async {
        let mut headers = HashMap::new();
        if let Some((name, value)) = &config.auth_header {
            let name =
                HeaderName::from_bytes(name.as_bytes()).map_err(|_| "Invalid MCP auth header")?;
            let value = HeaderValue::from_str(value).map_err(|_| "Invalid MCP auth header")?;
            headers.insert(name, value);
        }
        let transport_config = StreamableHttpClientTransportConfig::with_uri(config.url.clone())
            .custom_headers(headers)
            .max_sse_event_size(MAX_RESPONSE_BYTES);
        let transport =
            StreamableHttpClientTransport::with_client(reqwest::Client::new(), transport_config);
        let info = ClientInfo::new(
            ClientCapabilities::default(),
            Implementation::new("tiny-agent", "0.1.0"),
        );
        let service = info
            .serve_with_lifecycle(
                transport,
                ClientLifecycleMode::Auto {
                    preferred_versions: vec![ProtocolVersion::V_2026_07_28],
                    legacy_version: Some(ProtocolVersion::V_2025_11_25),
                },
            )
            .await
            .map_err(|_| "MCP request failed")?;
        let protocol = service
            .peer_info()
            .map(|info| info.protocol_version.to_string())
            .ok_or("MCP server did not negotiate a protocol version")?;
        let tools = service
            .list_all_tools()
            .await
            .map_err(|_| "MCP request failed")?
            .into_iter()
            .map(|tool| serde_json::to_value(tool).map_err(|_| "Invalid MCP tool definition"))
            .collect::<Result<Vec<_>, _>>()?;
        Ok::<_, &'static str>((service, protocol, tools))
    });
    let (mut service, protocol, tools) = match connected {
        Ok(connected) => connected,
        Err(error) => {
            let _ = started.send(Err(error.into()));
            return;
        }
    };
    if started.send(Ok((protocol, tools))).is_err() {
        let _ = runtime.block_on(service.close_with_timeout(Duration::from_secs(5)));
        return;
    }
    while let Ok(command) = commands.recv() {
        match command {
            McpCommand::Call {
                name,
                arguments,
                cancel,
                reply,
            } => {
                let object = match arguments.as_object() {
                    Some(object) => object.clone(),
                    None => {
                        let _ = reply.send(Err("MCP tool arguments must be a JSON object".into()));
                        continue;
                    }
                };
                let timeout = Duration::from_millis(config.call_timeout_ms);
                let result = runtime.block_on(async {
                    tokio::select! {
                        result = service.call_tool_once(CallToolRequestParams::new(name).with_arguments(object)) => {
                            result.map_err(|_| "MCP request failed".to_string()).and_then(|value| {
                                match value {
                                    CallToolResponse::Complete(value) => serde_json::to_value(value),
                                    CallToolResponse::InputRequired(value) => serde_json::to_value(value),
                                    CallToolResponse::Task(_) => return Err("Unsupported MCP tools/call result".into()),
                                    _ => return Err("Unsupported MCP tools/call result".into()),
                                }
                                .map_err(|_| "Invalid MCP tools/call response".to_string())
                            })
                        }
                        _ = wait_for_cancel(cancel, closed.clone()) => Err("Operation aborted".into()),
                        _ = tokio::time::sleep(timeout) => Err("MCP request timed out".into()),
                    }
                });
                let _ = reply.send(result);
            }
            McpCommand::Close(reply) => {
                let _ = runtime.block_on(service.close_with_timeout(Duration::from_secs(5)));
                let _ = reply.send(());
                return;
            }
        }
    }
    let _ = runtime.block_on(service.close_with_timeout(Duration::from_secs(5)));
}

async fn wait_for_cancel(cancel: Arc<AtomicBool>, closed: Arc<AtomicBool>) {
    while !cancel.load(Ordering::SeqCst) && !closed.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
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

fn scan_mcp_header_declarations(schema: &Value) -> Option<()> {
    fn visit(schema: &Value, path: &mut Vec<String>, seen: &mut HashSet<String>) -> bool {
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
        }
        let Some(properties) = object.get("properties").and_then(Value::as_object) else {
            return true;
        };
        for (name, child) in properties {
            path.push(name.clone());
            let valid = visit(child, path, seen);
            path.pop();
            if !valid {
                return false;
            }
        }
        true
    }

    let mut seen = HashSet::new();
    visit(schema, &mut Vec::new(), &mut seen).then_some(())
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
    use serde_json::json;
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
    fn catalog_supports_closed_metabase_api_key_auth() {
        unsafe { std::env::set_var("TINY_TEST_METABASE_KEY", "secret") };
        let catalog = json!({"servers":{"fixture":{
            "url":"https://example.com/mcp",
            "auth":{"type":"metabaseApiKey","tokenEnv":"TINY_TEST_METABASE_KEY"}
        }}});
        let configs = validate_catalog(&catalog, &["fixture".into()]).unwrap();
        assert_eq!(
            configs[0].auth_header,
            Some(("X-API-Key".into(), "secret".into()))
        );
        let conflicting = json!({"servers":{"fixture":{
            "url":"https://example.com/mcp", "tokenEnv":"TOKEN",
            "auth":{"type":"metabaseApiKey","tokenEnv":"TOKEN"}
        }}});
        assert!(
            validate_catalog(&conflicting, &["fixture".into()])
                .unwrap_err()
                .contains("must not set both")
        );
    }
}
