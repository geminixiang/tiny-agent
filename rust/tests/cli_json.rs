use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn contract() -> serde_json::Value {
    serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../schemas/monitoring/execution-lifecycle-contract.json"),
        )
        .unwrap(),
    )
    .unwrap()
}

fn temp_cwd(label: &str) -> std::path::PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let cwd = std::env::temp_dir().join(format!("tiny-rs-{label}-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&cwd).unwrap();
    cwd
}

#[test]
fn json_mode_emits_one_shot_lifecycle_without_tui_output() {
    let cwd = temp_cwd("json-failure");
    let output = Command::new(env!("CARGO_BIN_EXE_tiny-rs"))
        .current_dir(&cwd)
        .env("OPENROUTER_API_KEY", "test")
        .env("TINY_ENDPOINT", "http://127.0.0.1:1")
        .args(["--json", "hello"])
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(&cwd);

    assert!(!output.status.success());
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let events: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let types = [
        "startup.started",
        "session.attached",
        "startup.completed",
        "operation.started",
        "model.started",
        "model.completed",
        "operation.completed",
    ];
    assert_eq!(events.len(), types.len());
    for (event, expected) in events.iter().zip(types) {
        assert_eq!(event["type"], expected);
    }
}

#[test]
fn json_mode_matches_shared_successful_lifecycle() {
    let contract = contract();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let responses = contract["responses"].as_array().unwrap().clone();
    let server = std::thread::spawn(move || {
        for response in responses {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            let header_end = loop {
                let count = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..count]);
                if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let headers = std::str::from_utf8(&request[..header_end]).unwrap();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(str::trim)
                        .map(str::to_string)
                })
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            while request.len() - header_end < content_length {
                let count = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..count]);
            }
            let body = serde_json::to_vec(&response).unwrap();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        }
    });
    let cwd = temp_cwd("json-success");
    std::fs::write(cwd.join("contract-read.txt"), "fixture").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_tiny-rs"))
        .current_dir(&cwd)
        .env("OPENROUTER_API_KEY", "test")
        .env("TINY_MODEL", contract["model"].as_str().unwrap())
        .env("TINY_ENDPOINT", format!("http://{address}"))
        .args([
            "--json",
            "--plugin",
            "read",
            contract["prompt"].as_str().unwrap(),
        ])
        .output()
        .unwrap();
    server.join().unwrap();
    let _ = std::fs::remove_dir_all(&cwd);

    assert!(output.status.success());
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let events: Vec<serde_json::Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let expected = contract["events"].as_array().unwrap();
    assert_eq!(events.len(), expected.len());
    for (actual, expected) in events.iter().zip(expected) {
        assert_eq!(actual["type"], expected["type"]);
        for key in expected["required"].as_array().unwrap() {
            assert!(actual.get(key.as_str().unwrap()).is_some());
        }
        for (key, value) in expected.as_object().unwrap() {
            if key != "type" && key != "required" {
                assert_eq!(actual[key], *value, "event {} field {key}", actual["type"]);
            }
        }
        if let Some(duration) = actual.get("durationMs") {
            assert!(duration.as_f64().unwrap() >= 0.0);
        }
        assert!(actual["timestamp"].as_str().unwrap().contains('T'));
    }
    assert_eq!(events[0]["model"], contract["model"]);
    assert_eq!(events[0]["plugins"], contract["plugins"]);
    assert_eq!(events[0]["mcp"], serde_json::json!([]));
}
