use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tiny_agent_rust::mcp::{McpConfig, display_tool_name, load_mcp_tools};

fn config(url: String) -> McpConfig {
    McpConfig::new("fixture".into(), url, None, None, 150).unwrap()
}

#[test]
fn config_rejects_untrusted_values() {
    assert!(McpConfig::new("".into(), "https://example.com".into(), None, None, 1).is_err());
    assert!(McpConfig::new("x".into(), "http://example.com".into(), None, None, 1).is_err());
    assert!(McpConfig::new("x".into(), "https://example.com".into(), None, None, 0).is_err());
    assert!(
        McpConfig::new(
            "x".into(),
            "https://example.com".into(),
            Some("secret\r\nX-Injected: yes".into()),
            None,
            1,
        )
        .is_err()
    );
    assert!(
        McpConfig::new(
            "x".into(),
            "https://example.com".into(),
            None,
            Some(vec!["echo".into(), "echo".into()]),
            1,
        )
        .is_err()
    );
}

fn read_request(stream: &mut TcpStream) -> (String, Value) {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = stream.read(&mut buffer).unwrap();
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
                    serde_json::from_slice(&bytes[split + 4..split + 4 + length]).unwrap(),
                );
            }
        }
    }
}

fn respond(stream: &mut TcpStream, status: u16, body: Value) {
    let body = body.to_string();
    write!(stream, "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
}

fn modern_result(index: usize, call: Value) -> Value {
    match index {
        0 => json!({"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{}}),
        1 => {
            json!({"resultType":"complete","ttlMs":0,"cacheScope":"private","tools":[{"name":"echo","inputSchema":{"type":"object"}}]})
        }
        _ => call,
    }
}

#[test]
fn strict_modern_is_stateless_and_repeats_metadata() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let server = thread::spawn(move || {
        for index in 0..3 {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            captured.lock().unwrap().push(request.clone());
            let id = request.1["id"].clone();
            let result = match index {
                0 => {
                    json!({"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"protocolVersion":"extra-is-extensible"})
                }
                1 => {
                    json!({
                        "resultType":"complete",
                        "ttlMs":0,
                        "cacheScope":"private",
                        "tools":[
                            {
                                "name":"echo",
                                "inputSchema":{
                                    "type":"object",
                                    "properties":{
                                        "context":{
                                            "type":"object",
                                            "properties":{
                                                "label":{"type":"string","x-mcp-header":"Nested-Label"}
                                            }
                                        }
                                    }
                                }
                            },
                            {
                                "name":"invalid",
                                "inputSchema":{
                                    "type":"object",
                                    "properties":{
                                        "first":{"type":"string","x-mcp-header":"Trace"},
                                        "second":{"type":"string","x-mcp-header":"trace"}
                                    }
                                }
                            }
                        ]
                    })
                }
                _ => json!({"resultType":"complete","content":[{"type":"text","text":"hello"}]}),
            };
            respond(
                &mut stream,
                200,
                json!({"jsonrpc":"2.0","id":id,"result":result}),
            );
        }
    });
    let loaded = load_mcp_tools(config(url)).unwrap();
    assert_eq!(loaded.protocol_version, "2026-07-28");
    assert_eq!(loaded.tools.len(), 1);
    assert_eq!(display_tool_name(&loaded.tools[0].name), "mcp:fixture/echo");
    assert_eq!(
        loaded.tools[0]
            .execute(
                json!({"context":{"label":" 北極 "}}),
                &Arc::new(AtomicBool::new(false))
            )
            .unwrap(),
        "hello"
    );
    loaded.close();
    server.join().unwrap();
    for (index, (headers, body)) in requests.lock().unwrap().iter().enumerate() {
        let lower = headers.to_ascii_lowercase();
        assert!(lower.contains("mcp-protocol-version: 2026-07-28"));
        assert_eq!(
            lower
                .lines()
                .find_map(|line| line.strip_prefix("mcp-method: ")),
            body["method"].as_str()
        );
        assert_eq!(
            body["params"]["_meta"],
            json!({
                "io.modelcontextprotocol/protocolVersion":"2026-07-28",
                "io.modelcontextprotocol/clientInfo":{"name":"tiny-agent","version":"0.1.0"},
                "io.modelcontextprotocol/clientCapabilities":{}
            })
        );
        assert!(!lower.contains("mcp-session-id:"));
        if index == 2 {
            assert!(lower.contains("mcp-name: echo"));
            assert!(lower.contains("mcp-param-nested-label: =?base64?iowml+altsa=?="));
            assert_eq!(
                body["params"]["arguments"],
                json!({"context":{"label":" 北極 "}})
            );
        }
    }
}

#[test]
fn normalizes_text_resources_and_rejects_binary_resources() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        for index in 0..4 {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            let result = match index {
                0 => {
                    json!({"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{}})
                }
                1 => json!({
                    "resultType":"complete",
                    "ttlMs":0,
                    "cacheScope":"private",
                    "tools":[
                        {"name":"text_resource","inputSchema":{"type":"object"}},
                        {"name":"binary_resource","inputSchema":{"type":"object"}}
                    ]
                }),
                2 => json!({
                    "resultType":"complete",
                    "content":[{"type":"resource","resource":{
                        "uri":"repo://README.md",
                        "mimeType":"text/markdown",
                        "text":"# tiny-agent"
                    }}]
                }),
                _ => json!({
                    "resultType":"complete",
                    "content":[{"type":"resource","resource":{
                        "uri":"repo://image.png",
                        "mimeType":"image/png",
                        "blob":"iVBORw0KGgo="
                    }}]
                }),
            };
            respond(
                &mut stream,
                200,
                json!({"jsonrpc":"2.0","id":request.1["id"],"result":result}),
            );
        }
    });
    let loaded = load_mcp_tools(config(url)).unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    assert_eq!(
        loaded.tools[0].execute(json!({}), &cancel).unwrap(),
        "Resource: repo://README.md\n# tiny-agent"
    );
    assert_eq!(
        loaded.tools[1].execute(json!({}), &cancel).unwrap_err(),
        "Unsupported MCP content type: resource"
    );
    loaded.close();
    server.join().unwrap();
}

#[test]
fn modern_input_required_is_explicitly_unsupported() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        for index in 0..3 {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            respond(
                &mut stream,
                200,
                json!({
                    "jsonrpc":"2.0",
                    "id":request.1["id"],
                    "result":modern_result(index, json!({
                        "resultType":"input_required",
                        "inputRequests":[{"type":"text","prompt":"More detail"}]
                    }))
                }),
            );
        }
    });
    let loaded = load_mcp_tools(config(url)).unwrap();
    assert_eq!(
        loaded.tools[0]
            .execute(json!({}), &Arc::new(AtomicBool::new(false)))
            .unwrap_err(),
        "MCP tool requires additional user input; input_required is not supported"
    );
    loaded.close();
    server.join().unwrap();
}

#[test]
fn modern_corrective_retry_succeeds() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        for index in 0..3 {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            let response = match index {
                0 => {
                    json!({"jsonrpc":"2.0","id":request.1["id"],"error":{"code":-32022,"data":{"supported":["2026-07-28"]}}})
                }
                1 => {
                    json!({"jsonrpc":"2.0","id":request.1["id"],"result":{"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{}}})
                }
                _ => {
                    json!({"jsonrpc":"2.0","id":request.1["id"],"result":{"resultType":"complete","ttlMs":0,"cacheScope":"private","tools":[]}})
                }
            };
            respond(&mut stream, 200, response);
        }
    });
    let loaded = load_mcp_tools(config(url)).unwrap();
    assert!(loaded.tools.is_empty());
    loaded.close();
    server.join().unwrap();
}

#[test]
fn modern_only_rejects_server_without_modern_support() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let request = read_request(&mut stream);
        respond(
            &mut stream,
            200,
            json!({"jsonrpc":"2.0","id":request.1["id"],"error":{"code":-32022,"data":{"supported":["2025-11-25"]}}}),
        );
    });
    let error = load_mcp_tools(config(url)).err().unwrap();
    assert!(
        error.contains("does not support the modern protocol"),
        "unexpected error: {error}"
    );
    server.join().unwrap();
}

#[test]
fn rejects_chunked_response_over_10mb() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let _ = read_request(&mut stream);
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").unwrap();
        let chunk = vec![b'x'; 64 * 1024];
        for _ in 0..161 {
            if write!(stream, "{:x}\r\n", chunk.len()).is_err()
                || stream.write_all(&chunk).is_err()
                || stream.write_all(b"\r\n").is_err()
            {
                return;
            }
        }
        let _ = stream.write_all(b"0\r\n\r\n");
    });
    assert_eq!(
        load_mcp_tools(config(url)).err().unwrap(),
        "MCP response exceeded 10MB"
    );
    server.join().unwrap();
}

#[test]
fn rejects_oversized_content_length_without_reading_body() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let _ = read_request(&mut stream);
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 10485761\r\nConnection: close\r\n\r\n").unwrap();
    });
    assert_eq!(
        load_mcp_tools(config(url)).err().unwrap(),
        "MCP response exceeded 10MB"
    );
    server.join().unwrap();
}

#[test]
fn close_joins_cancelled_request_workers_within_transport_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        for index in 0..3 {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            if index < 2 {
                let result = if index == 0 {
                    json!({"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{}})
                } else {
                    json!({"resultType":"complete","ttlMs":0,"cacheScope":"public","tools":[{"name":"slow","inputSchema":{"type":"object"}}]})
                };
                respond(
                    &mut stream,
                    200,
                    json!({"jsonrpc":"2.0","id":request.1["id"],"result":result}),
                );
            } else {
                thread::sleep(Duration::from_millis(500));
            }
        }
    });
    let loaded = load_mcp_tools(config(url)).unwrap();
    let cancel = Arc::new(AtomicBool::new(true));
    assert_eq!(
        loaded.tools[0].execute(json!({}), &cancel).unwrap_err(),
        "Operation aborted"
    );
    let start = Instant::now();
    loaded.close();
    assert!(start.elapsed() < Duration::from_secs(1));
    server.join().unwrap();
}
