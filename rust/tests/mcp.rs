use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};
use tiny_agent_rust::mcp::{McpConfig, display_tool_name, load_mcp_tools};

fn fixture_config(url: String) -> McpConfig {
    McpConfig {
        alias: "fixture".into(),
        url,
        token: None,
        allowed_tools: None,
        call_timeout_ms: 1_000,
    }
}

fn start_fixture(tool: Value, call_result: Option<Value>) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let count = if call_result.is_some() { 4 } else { 3 };
    let handle = thread::spawn(move || {
        for index in 0..count {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut stream);
            let response = match index {
                0 => json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26"}}),
                1 => {
                    respond(&mut stream, "application/json", "", false);
                    continue;
                }
                2 => json!({"jsonrpc":"2.0","id":2,"result":{"tools":[tool.clone()]}}),
                _ => json!({"jsonrpc":"2.0","id":3,"result":call_result.clone().unwrap()}),
            };
            respond(
                &mut stream,
                "application/json",
                &response.to_string(),
                false,
            );
        }
    });
    (url, handle)
}

fn read_request(stream: &mut TcpStream) -> (String, String) {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = stream.read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        let text = String::from_utf8_lossy(&bytes);
        if let Some(split) = text.find("\r\n\r\n") {
            let length = text[..split]
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")?
                        .trim()
                        .parse::<usize>()
                        .ok()
                })
                .unwrap_or(0);
            if bytes.len() >= split + 4 + length {
                return (
                    text[..split].to_string(),
                    text[split + 4..split + 4 + length].to_string(),
                );
            }
        }
    }
    panic!("incomplete request")
}

fn respond(stream: &mut TcpStream, content_type: &str, body: &str, session: bool) {
    let session_header = if session {
        "Mcp-Session-Id: fixture-session\r\n"
    } else {
        ""
    };
    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\n{session_header}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
}

#[test]
fn streamable_http_lists_calls_and_normalizes_tools() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let server = thread::spawn(move || {
        for index in 0..4 {
            let (mut stream, _) = listener.accept().unwrap();
            let (headers, body) = read_request(&mut stream);
            captured
                .lock()
                .unwrap()
                .push((headers.clone(), body.clone()));
            match index {
                0 => respond(&mut stream, "application/json", &json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"fixture","version":"1"}}}).to_string(), true),
                1 => respond(&mut stream, "application/json", "", false),
                2 => respond(&mut stream, "text/event-stream", &format!("event: message\ndata: {}\n\nevent: message\ndata: {}\n\n", json!({"jsonrpc":"2.0","method":"notifications/progress","params":{}}), json!({"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo","description":"Echo text.","inputSchema":{"type":"object"}}]}})), false),
                _ => respond(&mut stream, "application/json", &json!({"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"hello"}],"structuredContent":{"ok":true}}}).to_string(), false),
            }
        }
    });

    let loaded = load_mcp_tools(McpConfig {
        alias: "fixture".into(),
        url,
        token: Some("secret".into()),
        allowed_tools: Some(vec!["echo".into()]),
        call_timeout_ms: 1_000,
    })
    .unwrap();
    assert_eq!(loaded.protocol_version, "2025-03-26");
    assert_eq!(loaded.tools.len(), 1);
    assert_eq!(display_tool_name(&loaded.tools[0].name), "mcp:fixture/echo");
    assert_eq!(
        loaded.tools[0]
            .execute(
                json!({"message":"hello"}),
                &Arc::new(AtomicBool::new(false))
            )
            .unwrap(),
        "hello\n\nStructured content:\n{\"ok\":true}"
    );
    server.join().unwrap();
    let requests = requests.lock().unwrap();
    assert!(requests.iter().all(|(headers, _)| {
        headers
            .to_ascii_lowercase()
            .contains("authorization: bearer secret")
    }));
    assert!(
        requests[2]
            .0
            .to_ascii_lowercase()
            .contains("mcp-session-id: fixture-session")
    );
    assert_eq!(
        serde_json::from_str::<Value>(&requests[3].1).unwrap()["method"],
        "tools/call"
    );
}

#[test]
fn rejects_malformed_discovery_and_result_content() {
    let (url, server) = start_fixture(json!({"name":"bad","inputSchema":42}), None);
    let error = match load_mcp_tools(fixture_config(url)) {
        Ok(_) => panic!("invalid schema was accepted"),
        Err(error) => error,
    };
    assert_eq!(error, "MCP tool inputSchema must be an object: bad");
    server.join().unwrap();

    let (url, server) = start_fixture(
        json!({"name":"bad","description":"Bad result.","inputSchema":{"type":"object"}}),
        Some(json!({"content":{"type":"text","text":"not an array"}})),
    );
    let loaded = load_mcp_tools(fixture_config(url)).unwrap();
    let error = loaded.tools[0]
        .execute(
            json!({"arbitrary":{"nested":[1, true]}}),
            &Arc::new(AtomicBool::new(false)),
        )
        .unwrap_err();
    assert_eq!(error, "MCP tool content must be an array");
    server.join().unwrap();
}
