//! Integration tests for tiny-rs using a mock OpenRouter HTTP server.
//! These mirror the TypeScript, Go, and Python test suites.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tiny_agent_rust::*;

fn temp_dir() -> String {
    let id = uuid7();
    let dir = std::env::temp_dir().join(format!("tiny-rs-{}", id));
    std::fs::create_dir_all(&dir).unwrap();
    dir.to_string_lossy().to_string()
}

#[allow(dead_code)]
struct MockServer {
    url: String,
    requests: Arc<Mutex<Vec<String>>>,
    handle: Option<thread::JoinHandle<()>>,
}

fn read_request(stream: &mut TcpStream) -> String {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1000)));
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    loop {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if let Some(end) = head_body_split(&buf) {
                    return end;
                }
            }
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(_) => break,
        }
    }
    // fallback: return everything we read after headers
    head_body_split(&buf).unwrap_or_default()
}

fn head_body_split(buf: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(buf);
    let idx = text.find("\r\n\r\n")?;
    let mut body_len = 0usize;
    for line in text[..idx].lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("content-length:") {
            body_len = v.trim().parse().unwrap_or(0);
        }
    }
    let body_start = idx + 4;
    if buf.len() >= body_start + body_len {
        Some(String::from_utf8_lossy(&buf[body_start..body_start + body_len]).to_string())
    } else {
        None
    }
}

fn start_serving(responses: Vec<String>) -> MockServer {
    start_serving_with_delay(responses, Duration::ZERO)
}

fn start_serving_with_delay(responses: Vec<String>, delay: Duration) -> MockServer {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let reqs = requests.clone();
    let handle = thread::spawn(move || {
        for resp in responses {
            let (mut stream, _) = listener.accept().unwrap();
            let body = read_request(&mut stream);
            reqs.lock().unwrap().push(body);
            thread::sleep(delay);
            let out = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                resp.len(),
                resp
            );
            let _ = stream.write_all(out.as_bytes());
            let _ = stream.flush();
        }
        drop(listener);
    });
    MockServer {
        url,
        requests,
        handle: Some(handle),
    }
}

fn start_hanging() -> MockServer {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let reqs = requests.clone();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let body = read_request(&mut stream);
        reqs.lock().unwrap().push(body);
        // keep the connection open, never respond
        thread::sleep(Duration::from_secs(60));
    });
    MockServer {
        url,
        requests,
        handle: Some(handle),
    }
}

fn test_agent(cwd: &str, endpoint: &str, session: Option<Session>) -> Agent {
    let mut agent = new_agent(Vec::new(), session, String::new(), cwd);
    agent.endpoint = endpoint.to_string();
    agent
}

fn tool_args(call_id: &str, name: &str, arguments: &str) -> String {
    format!(
        r#"{{"choices":[{{"finish_reason":"tool_calls","message":{{"role":"assistant","content":null,"tool_calls":[{{"id":"{}","type":"function","function":{{"name":"{}","arguments":{}}}}}]}}}}],"usage":{{"prompt_tokens":10,"completion_tokens":1}}}}"#,
        call_id,
        name,
        serde_json::to_string(arguments).unwrap()
    )
}

#[test]
fn accepts_null_tool_calls_from_openai_compatible_providers() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    let server = start_serving(vec![
        r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"done","tool_calls":null}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}"#.into(),
    ]);
    let mut agent = test_agent(&cwd, &server.url, None);

    assert_eq!(agent.run_agent_loop("hi").unwrap(), "done");
}

#[test]
fn handles_finish_reasons_and_empty_assistant() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();

    let empty = start_serving(vec![r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":" \n"}}],"usage":{}}"#.into()]);
    let mut agent = test_agent(&cwd, &empty.url, None);
    assert!(
        agent
            .run_agent_loop("hi")
            .unwrap_err()
            .contains("empty response")
    );

    let missing = start_serving(vec![
        r#"{"choices":[{"finish_reason":"stop"}],"usage":{}}"#.into(),
    ]);
    let mut agent = test_agent(&cwd, &missing.url, None);
    assert!(
        agent
            .run_agent_loop("hi")
            .unwrap_err()
            .contains("no assistant message")
    );

    let filtered = start_serving(vec![r#"{"choices":[{"finish_reason":"content_filter","message":{"role":"assistant","content":"no"}}],"usage":{}}"#.into()]);
    let mut agent = test_agent(&cwd, &filtered.url, None);
    assert!(
        agent
            .run_agent_loop("hi")
            .unwrap_err()
            .contains("content_filter")
    );

    let replies = vec![
        tool_args("1", "write", r#"{"path":"no.txt","content":"bad"}"#).replace("\"finish_reason\":\"tool_calls\"", "\"finish_reason\":\"length\""),
        r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"recovered"}}],"usage":{}}"#.into(),
    ];
    let server = start_serving(replies);
    let mut agent = test_agent(&cwd, &server.url, None);
    assert_eq!(agent.run_agent_loop("hi").unwrap(), "recovered");
    assert!(!std::path::Path::new(&format!("{}/no.txt", cwd)).exists());
    assert!(agent.messages.iter().any(|message| {
        message
            .content
            .as_deref()
            .unwrap_or("")
            .contains("truncated by the model token limit")
    }));
}

#[test]
fn durable_model_runs_persist_normal_error_and_truncated_outcomes() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };

    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let server = start_serving(vec![
        r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"done"}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":3}}}"#.into(),
    ]);
    let mut agent = test_agent(&cwd, &server.url, Some(session));
    assert_eq!(agent.run_agent_loop("inspect").unwrap(), "done");
    let state = agent.session.as_ref().unwrap().load().unwrap();
    assert!(matches!(
        state.operation,
        tiny_agent_rust::session_reducer::OperationState::Idle
    ));
    assert_eq!(state.transcript.len(), 2);
    assert_eq!(state.usage.input, 7);
    assert_eq!(state.usage.output, 2);
    assert_eq!(state.usage.cache_read, 3);

    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let server = start_serving(vec![r#"{"choices":[],"usage":{}}"#.into()]);
    let mut agent = test_agent(&cwd, &server.url, Some(session));
    assert!(
        agent
            .run_agent_loop("inspect")
            .unwrap_err()
            .contains("no choices")
    );
    let state = agent.session.as_ref().unwrap().load().unwrap();
    assert!(matches!(
        state.operation,
        tiny_agent_rust::session_reducer::OperationState::Idle
    ));
    assert_eq!(state.transcript.len(), 1);

    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let server = start_serving(vec![
        r#"{"choices":[{"finish_reason":"length","message":{"role":"assistant","content":"partial"}}],"usage":{"prompt_tokens":4,"completion_tokens":1}}"#.into(),
    ]);
    let mut agent = test_agent(&cwd, &server.url, Some(session));
    assert!(
        agent
            .run_agent_loop("inspect")
            .unwrap_err()
            .contains("truncated")
    );
    let state = agent.session.as_ref().unwrap().load().unwrap();
    assert!(matches!(
        state.operation,
        tiny_agent_rust::session_reducer::OperationState::Idle
    ));
    assert_eq!(state.transcript.len(), 2);
    assert_eq!(state.usage.input, 4);
}

#[test]
fn durable_model_run_persists_attempt_before_request() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let path = session.path.clone();
    let server = start_hanging();
    let mut agent = test_agent(&cwd, &server.url, Some(session));
    let cancel = agent.cancel.clone();
    let handle = thread::spawn(move || agent.run_agent_loop("wait"));
    thread::sleep(Duration::from_millis(200));

    let bytes = std::fs::read(path).unwrap();
    let state = tiny_agent_rust::session_reducer::reduce_session(&bytes).unwrap();
    assert!(matches!(
        state.operation,
        tiny_agent_rust::session_reducer::OperationState::Run {
            step: Some(tiny_agent_rust::session_reducer::StepState {
                status,
                attempt: 1,
                ..
            }),
            ..
        } if status == "attempting"
    ));

    cancel.store(true, Ordering::SeqCst);
    assert_eq!(handle.join().unwrap().unwrap(), "Operation aborted.");
}

#[test]
fn durable_compaction_abort_persists_intent_before_signal() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let replies = (0..4)
        .map(|index| format!(r#"{{"choices":[{{"finish_reason":"stop","message":{{"role":"assistant","content":"answer {index}"}}}}],"usage":{{}}}}"#))
        .collect();
    let server = start_serving(replies);
    let mut agent = test_agent(&cwd, &server.url, Some(session.clone()));
    for index in 0..4 {
        agent.run_agent_loop(&format!("question {index}")).unwrap();
    }
    let hanging = start_hanging();
    agent.endpoint = hanging.url;
    let abort = agent.abort_handle();
    let cancel = agent.cancel.clone();
    let result = Arc::new(Mutex::new(None));
    let output = result.clone();
    let worker = thread::spawn(move || {
        *output.lock().unwrap() = Some(agent.compact());
    });
    while hanging.requests.lock().unwrap().is_empty() {
        thread::sleep(Duration::from_millis(5));
    }
    abort.request().unwrap();
    let log = std::fs::read_to_string(&session.path).unwrap();
    assert!(log.contains("\"operationKind\":\"compaction\",\"phase\":\"compact\""));
    cancel.store(true, Ordering::SeqCst);
    worker.join().unwrap();
    assert_eq!(
        result.lock().unwrap().as_ref().unwrap().as_ref().unwrap(),
        "Compaction aborted."
    );
    assert!(matches!(
        session.load().unwrap().operation,
        tiny_agent_rust::session_reducer::OperationState::Idle
    ));
    assert!(
        !std::fs::read_to_string(&session.path)
            .unwrap()
            .contains("\"type\":\"compaction\",\"operationId\"")
    );
}

#[test]
fn compaction_recovery_mismatch_appends_nothing_and_makes_no_request() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let replies = (0..4)
        .map(|index| format!(r#"{{"choices":[{{"finish_reason":"stop","message":{{"role":"assistant","content":"answer {index}"}}}}],"usage":{{}}}}"#))
        .collect();
    let server = start_serving(replies);
    let mut seed = test_agent(&cwd, &server.url, Some(session.clone()));
    for index in 0..4 {
        seed.run_agent_loop(&format!("question {index}")).unwrap();
    }
    let (operation_id, input_id) = append_compaction_prefix(&session);
    let configuration = recovery_configuration(&seed);
    session
        .append(vec![tiny_agent_rust::session_runtime::step_attempt(
            &session.allocate_id(),
            &operation_id,
            &session.allocate_id(),
            &session.allocate_id(),
            "compaction",
            1,
            &input_id,
            &configuration,
        )])
        .unwrap();
    let before = std::fs::read(&session.path).unwrap();
    let no_requests = start_serving(Vec::new());
    let mut changed = new_agent(
        Vec::new(),
        Some(session),
        "changed instructions".into(),
        &cwd,
    );
    changed.endpoint = no_requests.url.clone();
    assert_eq!(
        changed.resume_session().unwrap_err(),
        "Session recovery blocked: configuration_changed"
    );
    assert_eq!(
        std::fs::read(&changed.session.as_ref().unwrap().path).unwrap(),
        before
    );
    assert!(no_requests.requests.lock().unwrap().is_empty());
}

#[test]
fn compaction_abort_after_start_before_attempt_makes_no_request() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let replies = (0..4)
        .map(|index| format!(r#"{{"choices":[{{"finish_reason":"stop","message":{{"role":"assistant","content":"answer {index}"}}}}],"usage":{{}}}}"#))
        .collect();
    let server = start_serving(replies);
    let mut seed = test_agent(&cwd, &server.url, Some(session.clone()));
    for index in 0..4 {
        seed.run_agent_loop(&format!("question {index}")).unwrap();
    }
    let (operation_id, _) = append_compaction_prefix(&session);
    session
        .append(vec![tiny_agent_rust::session_runtime::abort_requested(
            &session.allocate_id(),
            &operation_id,
            "compaction",
            "compact",
            None,
        )])
        .unwrap();
    let no_requests = start_serving(Vec::new());
    let mut recovered = test_agent(&cwd, &no_requests.url, Some(session.clone()));
    recovered.resume_session().unwrap();
    assert!(no_requests.requests.lock().unwrap().is_empty());
    assert!(matches!(
        session.load().unwrap().operation,
        tiny_agent_rust::session_reducer::OperationState::Idle
    ));
    let log = std::fs::read_to_string(&session.path).unwrap();
    assert!(!log.contains("\"stepKind\":\"compaction\""));
    assert!(!log.contains("\"type\":\"compaction\",\"operationId\""));
}

#[test]
fn compaction_abort_racing_successful_response_wins_settlement() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let replies = (0..4)
        .map(|index| format!(r#"{{"choices":[{{"finish_reason":"stop","message":{{"role":"assistant","content":"answer {index}"}}}}],"usage":{{}}}}"#))
        .collect();
    let server = start_serving(replies);
    let mut agent = test_agent(&cwd, &server.url, Some(session.clone()));
    for index in 0..4 {
        agent.run_agent_loop(&format!("question {index}")).unwrap();
    }
    let delayed = start_serving_with_delay(
        vec![r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"too late"}}],"usage":{"prompt_tokens":9,"completion_tokens":2}}"#.into()],
        Duration::from_millis(200),
    );
    agent.endpoint = delayed.url.clone();
    let abort = agent.abort_handle();
    let worker = thread::spawn(move || {
        let result = agent.compact();
        (agent, result)
    });
    while delayed.requests.lock().unwrap().is_empty() {
        thread::sleep(Duration::from_millis(5));
    }
    abort.request().unwrap();
    let (agent, result) = worker.join().unwrap();
    assert_eq!(result.unwrap(), "Compaction aborted.");
    assert_eq!(delayed.requests.lock().unwrap().len(), 1);
    let state = session.load().unwrap();
    assert!(matches!(
        state.operation,
        tiny_agent_rust::session_reducer::OperationState::Idle
    ));
    assert_eq!(state.usage.input, 0);
    assert_eq!(agent.usage.input, state.usage.input);
    assert_eq!(agent.usage.output, state.usage.output);
    assert_eq!(agent.messages.len(), state.active_context.len() + 1);
    let log = std::fs::read_to_string(&session.path).unwrap();
    assert!(log.contains("\"code\":\"aborted\""));
    assert!(!log.contains("\"type\":\"compaction\",\"operationId\""));
}

#[test]
fn compaction_recovery_retries_open_attempt_and_finishes_committed_entry_idempotently() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let mut replies = (0..4)
        .map(|index| format!(r#"{{"choices":[{{"finish_reason":"stop","message":{{"role":"assistant","content":"answer {index}"}}}}],"usage":{{}}}}"#))
        .collect::<Vec<_>>();
    replies.push(r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"original summary"}}],"usage":{}}"#.into());
    let server = start_serving(replies);
    let mut agent = test_agent(&cwd, &server.url, Some(session.clone()));
    for index in 0..4 {
        agent.run_agent_loop(&format!("question {index}")).unwrap();
    }
    agent.compact().unwrap();
    let id = session.id.clone();
    let path = session.path.clone();
    session.close().unwrap();
    let lines = std::fs::read(&path)
        .unwrap()
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| [line, b"\n"].concat())
        .collect::<Vec<_>>();
    let attempt_line = lines
        .iter()
        .rposition(|line| String::from_utf8_lossy(line).contains("\"stepKind\":\"compaction\""))
        .unwrap();
    std::fs::write(&path, lines[..=attempt_line].concat()).unwrap();

    let reopened = Session::open(&id, std::path::Path::new(&cwd)).unwrap();
    let recovery = start_serving(vec![r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"recovered summary"}}],"usage":{}}"#.into()]);
    let mut recovered = test_agent(&cwd, &recovery.url, Some(reopened.clone()));
    recovered.resume_session().unwrap();
    let log = std::fs::read_to_string(&path).unwrap();
    assert_eq!(log.matches("\"attempt\":2").count(), 1);
    let before = std::fs::read(&path).unwrap();
    recovered.resume_session().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), before);

    let lines = before
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| [line, b"\n"].concat())
        .collect::<Vec<_>>();
    let entry_line = lines
        .iter()
        .rposition(|line| String::from_utf8_lossy(line).contains("\"type\":\"compaction\""))
        .unwrap();
    reopened.close().unwrap();
    std::fs::write(&path, lines[..=entry_line].concat()).unwrap();
    let unfinished = Session::open(&id, std::path::Path::new(&cwd)).unwrap();
    assert!(matches!(
        unfinished.load().unwrap().operation,
        tiny_agent_rust::session_reducer::OperationState::Compaction {
            step: Some(tiny_agent_rust::session_reducer::StepState { status, .. }),
            ..
        } if status == "settled"
    ));
    let no_requests = start_serving(Vec::new());
    let mut finisher = test_agent(&cwd, &no_requests.url, Some(unfinished.clone()));
    let prefix = std::fs::read(&path).unwrap();
    finisher.resume_session().unwrap();
    assert!(no_requests.requests.lock().unwrap().is_empty());
    assert!(matches!(
        unfinished.load().unwrap().operation,
        tiny_agent_rust::session_reducer::OperationState::Idle
    ));
    let finished = std::fs::read(&path).unwrap();
    assert!(finished.starts_with(&prefix));
    let suffix = std::str::from_utf8(&finished[prefix.len()..]).unwrap();
    assert_eq!(suffix.lines().count(), 1);
    assert!(suffix.contains("\"type\":\"operationFinished\""));
    finisher.resume_session().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), finished);
    assert!(no_requests.requests.lock().unwrap().is_empty());
}

#[test]
fn repeated_compaction_summarizes_bounded_materialized_context() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let mut replies = (0..4)
        .map(|index| format!(r#"{{"choices":[{{"finish_reason":"stop","message":{{"role":"assistant","content":"old {index}"}}}}],"usage":{{}}}}"#))
        .collect::<Vec<_>>();
    replies.push(r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"first knowledge"}}],"usage":{}}"#.into());
    replies.extend((0..4).map(|index| format!(r#"{{"choices":[{{"finish_reason":"stop","message":{{"role":"assistant","content":"new {index}"}}}}],"usage":{{}}}}"#)));
    replies.push(r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"second knowledge including first knowledge"}}],"usage":{}}"#.into());
    let server = start_serving(replies);
    let mut agent = test_agent(&cwd, &server.url, Some(session.clone()));
    for index in 0..4 {
        agent
            .run_agent_loop(&format!("old question {index}"))
            .unwrap();
    }
    agent.compact().unwrap();
    for index in 0..4 {
        agent
            .run_agent_loop(&format!("new question {index}"))
            .unwrap();
    }
    agent.compact().unwrap();
    let requests = server.requests.lock().unwrap();
    let compact_requests = requests
        .iter()
        .filter_map(|request| serde_json::from_str::<serde_json::Value>(request).ok())
        .filter(|request| request.get("tools").is_none())
        .collect::<Vec<_>>();
    let second = compact_requests.last().unwrap();
    let summarized: Vec<serde_json::Value> = serde_json::from_str(
        second
            .pointer("/messages/1/content")
            .unwrap()
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        summarized[0]["content"],
        "[Compacted history]\nfirst knowledge"
    );
    assert!(summarized.len() < session.message_source().unwrap().len());
    let state = session.load().unwrap();
    assert!(
        state.active_context[0]["content"]
            .as_str()
            .unwrap()
            .contains("first knowledge")
    );
    assert_eq!(state.active_context.len(), 7);
}

// ---------------------------------------------------------------------------
#[test]
fn formats_tui_tool_events() {
    let start = ToolEvent {
        phase: "start".into(),
        name: "read".into(),
        args: ToolArgs {
            command: String::new(),
            r#type: "function".into(),
            timeout: 120.0,
            path: "README.md".into(),
            content: String::new(),
            offset: 1,
            limit: 2000,
            edits: Vec::new(),
            action: String::new(),
            id: String::new(),
            tail: 0,
            status: String::new(),
        },
        result: String::new(),
    };
    assert_eq!(format_tool_event(start.clone()), "◆ read README.md");
    let write = ToolEvent {
        phase: "start".into(),
        name: "write".into(),
        args: ToolArgs {
            command: String::new(),
            r#type: "function".into(),
            timeout: 120.0,
            path: "a.txt".into(),
            content: "hello".into(),
            offset: 1,
            limit: 2000,
            edits: Vec::new(),
            action: String::new(),
            id: String::new(),
            tail: 0,
            status: String::new(),
        },
        result: String::new(),
    };
    assert_eq!(format_tool_event(write), "◆ write a.txt (5 chars)");
    let end = ToolEvent {
        phase: "end".into(),
        name: "read".into(),
        args: ToolArgs {
            command: String::new(),
            r#type: "function".into(),
            timeout: 120.0,
            path: String::new(),
            content: String::new(),
            offset: 1,
            limit: 2000,
            edits: Vec::new(),
            action: String::new(),
            id: String::new(),
            tail: 0,
            status: String::new(),
        },
        result: "hello".into(),
    };
    assert_eq!(format_tool_event(end), "  └ 5 chars");
}

#[test]
fn formats_pi_style_usage() {
    let u = UsageState {
        input: 1200,
        output: 30,
        cache_read: 500,
        cache_write: 100,
        cache_hit_rate: 27.777,
    };
    assert_eq!(format_usage(u), "↑1.2k ↓30 R500 W100 CH27.8%");
    assert_eq!(format_usage(UsageState::default()), "↑0 ↓0");
}

// ---------------------------------------------------------------------------
#[test]
fn loads_cwd_instructions_and_skills() {
    let cwd = temp_dir();
    std::fs::write(format!("{}/AGENTS.md", cwd), "Always answer briefly.\n").unwrap();
    std::fs::create_dir_all(format!("{}/.tiny-agent/skills/teach", cwd)).unwrap();
    std::fs::write(
        format!("{}/.tiny-agent/skills/teach/SKILL.md", cwd),
        "---\nname: teach\ndescription: Teaches tiny agents.\n---\nSECRET INSTRUCTIONS",
    )
    .unwrap();
    let instructions = load_project_instructions(&cwd);
    assert_eq!(instructions, "Always answer briefly.\n");
    let skills = load_skills(Vec::new(), &cwd).unwrap();
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].name, "teach");
    assert_eq!(skills[0].description, "Teaches tiny agents.");
    let agent = new_agent(skills.clone(), None, instructions, &cwd);
    let system = agent.messages[0].content.clone().unwrap();
    for expected in [
        "Use only the tools provided in this request",
        "inspect only what is needed, then make the changes and run focused tests",
        "Use the provided tool descriptions to choose the right capability",
        "Always answer briefly.",
        "<name>teach</name>",
        "<description>Teaches tiny agents.</description>",
        &skills[0].path,
    ] {
        assert!(system.contains(expected), "missing {expected:?}:\n{system}");
    }
    assert!(!system.contains("SECRET"));

    let empty = new_agent(Vec::new(), None, String::new(), &cwd);
    assert!(
        empty.messages[0]
            .content
            .as_deref()
            .unwrap()
            .contains("<available_skills>\n(none)\n</available_skills>")
    );
}

// ---------------------------------------------------------------------------
#[test]
fn session_create_open_and_idle_resume() {
    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    assert_eq!(session.id.len(), 36);
    assert!(
        session
            .path
            .to_string_lossy()
            .contains(".tiny-agent/sessions/")
    );
    assert!(
        session
            .path
            .to_string_lossy()
            .ends_with(&format!("_{}.jsonl", session.id))
    );
    let id = session.id.clone();
    let path = session.path.clone();
    session.close().unwrap();
    let reopened = Session::open(&id, std::path::Path::new(&cwd)).unwrap();
    assert_eq!(reopened.path, path);
    let mut agent = test_agent(&cwd, "", Some(reopened));
    agent.resume_session().unwrap();
    assert_eq!(agent.messages.len(), 1);
    assert_eq!(agent.usage.input, 0);
    assert!(Session::open("bad", std::path::Path::new(&cwd)).is_err());
    let fixed = uuid7_at(0x019f_c5c3_79ae);
    assert_eq!(&fixed[..13], "019fc5c3-79ae");
    assert_eq!(fixed.as_bytes()[14], b'7');
    assert!(matches!(fixed.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
}

fn recovery_configuration(agent: &Agent) -> tiny_agent_rust::session_runtime::RuntimeConfiguration {
    let definitions: Vec<serde_json::Value> =
        serde_json::from_str(tool_definitions_json()).unwrap();
    let tools = definitions
        .into_iter()
        .map(|definition| {
            let name = definition["function"]["name"].as_str().unwrap().to_string();
            tiny_agent_rust::session_runtime::RuntimeTool {
                replay: if name == "read" { "safe" } else { "never" }.into(),
                replay_key: if name == "read" {
                    "builtin:read:v1".into()
                } else {
                    format!("builtin:{name}:v1")
                },
                name,
                definition,
            }
        })
        .collect();
    tiny_agent_rust::session_runtime::runtime_configuration(
        &model_name(),
        agent.messages[0].content.as_deref().unwrap(),
        tools,
        "openrouter:chat-completions:v1",
        &format!("openrouter:{}", model_name()),
    )
}

fn append_compaction_prefix(session: &Session) -> (String, String) {
    let state = session.load().unwrap();
    let source = session.message_source().unwrap();
    let input_id = state.active_context_through_entry_id.unwrap();
    let retained = 6;
    let partition = source.len() - retained;
    let compacted_ids = source[..partition]
        .iter()
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    let retained_ids = source[partition..]
        .iter()
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    let operation_id = session.allocate_id();
    session
        .append(vec![tiny_agent_rust::session_runtime::start_compaction(
            &session.allocate_id(),
            &operation_id,
            &input_id,
            &session.allocate_id(),
            &compacted_ids,
            &retained_ids,
            &tiny_agent_rust::session_runtime::source_digest(&source),
        )])
        .unwrap();
    (operation_id, input_id)
}

struct ToolPrefix {
    operation_id: String,
    step_id: String,
    assistant_id: String,
    configuration: tiny_agent_rust::session_runtime::RuntimeConfiguration,
}

fn append_tool_prefix(session: &Session, agent: &Agent, calls: Vec<ToolCall>) -> ToolPrefix {
    let input_id = session.allocate_id();
    let operation_id = session.allocate_id();
    let step_id = session.allocate_id();
    let attempt_id = session.allocate_id();
    let assistant_id = session.allocate_id();
    let configuration = recovery_configuration(agent);
    session
        .append(tiny_agent_rust::session_runtime::start_run(
            &input_id,
            &session.allocate_id(),
            &operation_id,
            "recover tools",
        ))
        .unwrap();
    session
        .append(vec![tiny_agent_rust::session_runtime::step_attempt(
            &session.allocate_id(),
            &operation_id,
            &step_id,
            &attempt_id,
            "assistant",
            1,
            &input_id,
            &configuration,
        )])
        .unwrap();
    session
        .append(vec![tiny_agent_rust::session_runtime::assistant_entry(
            &assistant_id,
            &step_id,
            &attempt_id,
            "toolUse",
            &Message {
                role: "assistant".into(),
                content: None,
                tool_call_id: String::new(),
                tool_calls: calls,
            },
        )])
        .unwrap();
    ToolPrefix {
        operation_id,
        step_id,
        assistant_id,
        configuration,
    }
}

fn tool_call(id: &str, name: &str, arguments: &str) -> ToolCall {
    ToolCall {
        id: id.into(),
        r#type: "function".into(),
        function: ToolFunction {
            name: name.into(),
            arguments: arguments.into(),
        },
    }
}

#[test]
fn non_idle_session_recovers_open_attempt_once_and_retry_two_is_terminal() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let input_id = session.allocate_id();
    let operation_id = session.allocate_id();
    session
        .append(tiny_agent_rust::session_runtime::start_run(
            &input_id,
            &session.allocate_id(),
            &operation_id,
            "unfinished",
        ))
        .unwrap();
    let seed_agent = test_agent(&cwd, "", None);
    let configuration = recovery_configuration(&seed_agent);
    let step_id = session.allocate_id();
    session
        .append(vec![tiny_agent_rust::session_runtime::step_attempt(
            &session.allocate_id(),
            &operation_id,
            &step_id,
            &session.allocate_id(),
            "assistant",
            1,
            &input_id,
            &configuration,
        )])
        .unwrap();
    let server = start_serving(vec![
        r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"recovered"}}],"usage":{}}"#.into(),
    ]);
    let mut agent = test_agent(&cwd, &server.url, Some(session));
    agent.resume_session().unwrap();
    let state = agent.session.as_ref().unwrap().load().unwrap();
    assert!(matches!(
        state.operation,
        tiny_agent_rust::session_reducer::OperationState::Idle
    ));
    assert_eq!(
        agent.messages.last().unwrap().content.as_deref(),
        Some("recovered")
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let log = std::fs::read_to_string(&agent.session.as_ref().unwrap().path).unwrap();
    assert_eq!(log.matches("\"attempt\":2").count(), 1);

    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let input_id = session.allocate_id();
    let operation_id = session.allocate_id();
    session
        .append(tiny_agent_rust::session_runtime::start_run(
            &input_id,
            &session.allocate_id(),
            &operation_id,
            "exhausted",
        ))
        .unwrap();
    let configuration = recovery_configuration(&test_agent(&cwd, "", None));
    let first_attempt_id = session.allocate_id();
    let exhausted_step_id = session.allocate_id();
    session
        .append(vec![tiny_agent_rust::session_runtime::step_attempt(
            &session.allocate_id(),
            &operation_id,
            &exhausted_step_id,
            &first_attempt_id,
            "assistant",
            1,
            &input_id,
            &configuration,
        )])
        .unwrap();
    session
        .append(vec![tiny_agent_rust::session_runtime::step_attempt(
            &session.allocate_id(),
            &operation_id,
            &exhausted_step_id,
            &session.allocate_id(),
            "assistant",
            2,
            &input_id,
            &configuration,
        )])
        .unwrap();
    let before = std::fs::read(&session.path).unwrap();
    let mut agent = test_agent(&cwd, "http://127.0.0.1:1", Some(session));
    assert_eq!(
        agent.resume_session().unwrap_err(),
        "Session recovery blocked: attempts_exhausted"
    );
    assert_eq!(
        std::fs::read(&agent.session.as_ref().unwrap().path).unwrap(),
        before
    );
}

#[test]
fn pending_safe_read_replays_once_then_closes_and_finishes_idempotently() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    std::fs::write(format!("{cwd}/input.txt"), "recovered contents").unwrap();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let seed_agent = test_agent(&cwd, "", None);
    let prefix = append_tool_prefix(
        &session,
        &seed_agent,
        vec![tool_call("read-crash", "read", r#"{"path":"input.txt"}"#)],
    );
    let started_id = session.allocate_id();
    let result_id = session.allocate_id();
    let read = prefix
        .configuration
        .tools
        .iter()
        .find(|tool| tool.name == "read")
        .unwrap();
    session
        .append(vec![tiny_agent_rust::session_runtime::tool_started(
            &started_id,
            &prefix.operation_id,
            &prefix.step_id,
            &prefix.assistant_id,
            0,
            "read-crash",
            "read",
            serde_json::json!({"path":"input.txt"})
                .as_object()
                .unwrap()
                .clone(),
            read,
            &tiny_agent_rust::session::environment_identity(std::path::Path::new(&cwd)).unwrap(),
            &result_id,
        )])
        .unwrap();
    let id = session.id.clone();
    session.close().unwrap();

    let server = start_serving(vec![
        r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"finished"}}],"usage":{}}"#.into(),
    ]);
    let reopened = Session::open(&id, std::path::Path::new(&cwd)).unwrap();
    let mut agent = test_agent(&cwd, &server.url, Some(reopened));
    let tool_events = Arc::new(Mutex::new(Vec::new()));
    let captured_tools = tool_events.clone();
    agent.on_tool = Arc::new(move |event| captured_tools.lock().unwrap().push(event.phase));
    let lifecycle = Arc::new(Mutex::new(Vec::new()));
    let captured_lifecycle = lifecycle.clone();
    agent.on_event = Arc::new(move |event| {
        captured_lifecycle
            .lock()
            .unwrap()
            .push(event["type"].as_str().unwrap().to_string());
    });
    agent.resume_session().unwrap();
    assert_eq!(*tool_events.lock().unwrap(), ["start", "end"]);
    assert_eq!(
        *lifecycle.lock().unwrap(),
        ["tool.started", "tool.completed", "model.completed"]
    );
    let state = agent.session.as_ref().unwrap().load().unwrap();
    assert!(matches!(
        state.operation,
        tiny_agent_rust::session_reducer::OperationState::Idle
    ));
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let tool_messages = state
        .transcript
        .iter()
        .filter(|message| message["role"] == "tool")
        .collect::<Vec<_>>();
    assert_eq!(tool_messages.len(), 1);
    assert_eq!(tool_messages[0]["tool_call_id"], "read-crash");
    assert_eq!(tool_messages[0]["content"], "recovered contents");
    let before = std::fs::read(&agent.session.as_ref().unwrap().path).unwrap();
    agent.resume_session().unwrap();
    assert_eq!(
        std::fs::read(&agent.session.as_ref().unwrap().path).unwrap(),
        before
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

/// Regression lock for the exact sequence that corrupts the TypeScript port's
/// reducer: a pending "safe"-replay tool call is recovered (replayed and
/// closed), and the very next model attempt settles with a plain "stop" (no
/// further tool calls). In TypeScript this throws INVALID_TRANSITION because
/// recovery starts a stray extra stepAttempt whose contextThroughEntryId no
/// longer matches the now-advanced activeContextThroughEntryId. This test
/// pins down that the Rust reducer/recovery planner does NOT hit that bug:
/// resume_session() must return Ok, the session must end Idle, and the
/// model's plain-stop answer must be the final transcript entry.
#[test]
fn safe_replay_then_plain_stop_attempt_does_not_corrupt_the_session() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    std::fs::write(format!("{cwd}/input.txt"), "recovered contents").unwrap();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let seed_agent = test_agent(&cwd, "", None);
    let prefix = append_tool_prefix(
        &session,
        &seed_agent,
        vec![tool_call("read-crash", "read", r#"{"path":"input.txt"}"#)],
    );
    let read = prefix
        .configuration
        .tools
        .iter()
        .find(|tool| tool.name == "read")
        .unwrap();
    session
        .append(vec![tiny_agent_rust::session_runtime::tool_started(
            &session.allocate_id(),
            &prefix.operation_id,
            &prefix.step_id,
            &prefix.assistant_id,
            0,
            "read-crash",
            "read",
            serde_json::json!({"path":"input.txt"})
                .as_object()
                .unwrap()
                .clone(),
            read,
            &tiny_agent_rust::session::environment_identity(std::path::Path::new(&cwd)).unwrap(),
            &session.allocate_id(),
        )])
        .unwrap();
    let id = session.id.clone();
    session.close().unwrap();

    // The safe replay itself needs no model call; the attempt that follows
    // it (to close out the run) settles plain "stop" with no tool calls —
    // exactly the sequence that corrupts the TypeScript reducer.
    let server = start_serving(vec![
        r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"done"}}],"usage":{}}"#.into(),
    ]);
    let reopened = Session::open(&id, std::path::Path::new(&cwd)).unwrap();
    let mut agent = test_agent(&cwd, &server.url, Some(reopened));
    agent.resume_session().unwrap();

    let state = agent.session.as_ref().unwrap().load().unwrap();
    assert!(matches!(
        state.operation,
        tiny_agent_rust::session_reducer::OperationState::Idle
    ));
    assert_eq!(
        agent.messages.last().unwrap().content.as_deref(),
        Some("done")
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[test]
fn pending_never_replay_tool_is_interrupted_without_effect_then_run_continues() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let seed_agent = test_agent(&cwd, "", None);
    let prefix = append_tool_prefix(
        &session,
        &seed_agent,
        vec![
            tool_call(
                "write-crash",
                "write",
                r#"{"path":"must-not-exist.txt","content":"bad"}"#,
            ),
            tool_call(
                "write-later",
                "write",
                r#"{"path":"later.txt","content":"recovered"}"#,
            ),
        ],
    );
    let write = prefix
        .configuration
        .tools
        .iter()
        .find(|tool| tool.name == "write")
        .unwrap();
    session
        .append(vec![tiny_agent_rust::session_runtime::tool_started(
            &session.allocate_id(),
            &prefix.operation_id,
            &prefix.step_id,
            &prefix.assistant_id,
            0,
            "write-crash",
            "write",
            serde_json::json!({"path":"must-not-exist.txt","content":"bad"})
                .as_object()
                .unwrap()
                .clone(),
            write,
            &tiny_agent_rust::session::environment_identity(std::path::Path::new(&cwd)).unwrap(),
            &session.allocate_id(),
        )])
        .unwrap();
    let server = start_serving(vec![
        r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"continued"}}],"usage":{}}"#.into(),
    ]);
    let mut agent = test_agent(&cwd, &server.url, Some(session));
    agent.resume_session().unwrap();
    assert!(!std::path::Path::new(&format!("{cwd}/must-not-exist.txt")).exists());
    assert_eq!(
        std::fs::read_to_string(format!("{cwd}/later.txt")).unwrap(),
        "recovered"
    );
    let state = agent.session.as_ref().unwrap().load().unwrap();
    assert!(matches!(
        state.operation,
        tiny_agent_rust::session_reducer::OperationState::Idle
    ));
    let interrupted = state
        .transcript
        .iter()
        .find(|message| message["tool_call_id"] == "write-crash")
        .unwrap();
    assert_eq!(
        interrupted["content"],
        tiny_agent_rust::session_recovery::SYNTHETIC_INTERRUPTED
    );
    let tool_ids = state
        .transcript
        .iter()
        .filter_map(|message| message["tool_call_id"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(tool_ids, ["write-crash", "write-later"]);
    assert_eq!(
        agent.messages.last().unwrap().content.as_deref(),
        Some("continued")
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[test]
fn abort_recovery_orders_current_interrupted_before_remaining_aborted() {
    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let seed_agent = test_agent(&cwd, "", None);
    let calls = vec![
        tool_call(
            "current",
            "write",
            r#"{"path":"current.txt","content":"bad"}"#,
        ),
        tool_call(
            "remaining",
            "write",
            r#"{"path":"remaining.txt","content":"bad"}"#,
        ),
    ];
    let prefix = append_tool_prefix(&session, &seed_agent, calls);
    let write = prefix
        .configuration
        .tools
        .iter()
        .find(|tool| tool.name == "write")
        .unwrap();
    session
        .append(vec![tiny_agent_rust::session_runtime::tool_started(
            &session.allocate_id(),
            &prefix.operation_id,
            &prefix.step_id,
            &prefix.assistant_id,
            0,
            "current",
            "write",
            serde_json::json!({"path":"current.txt","content":"bad"})
                .as_object()
                .unwrap()
                .clone(),
            write,
            &tiny_agent_rust::session::environment_identity(std::path::Path::new(&cwd)).unwrap(),
            &session.allocate_id(),
        )])
        .unwrap();
    session
        .append(vec![tiny_agent_rust::session_runtime::abort_requested(
            &session.allocate_id(),
            &prefix.operation_id,
            "run",
            "tool",
            Some("current"),
        )])
        .unwrap();
    let mut agent = test_agent(&cwd, "http://127.0.0.1:1", Some(session));
    agent.resume_session().unwrap();
    let state = agent.session.as_ref().unwrap().load().unwrap();
    assert!(matches!(
        state.operation,
        tiny_agent_rust::session_reducer::OperationState::Idle
    ));
    let results = state
        .transcript
        .iter()
        .filter(|message| message["role"] == "tool")
        .collect::<Vec<_>>();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0]["tool_call_id"], "current");
    assert_eq!(
        results[0]["content"],
        tiny_agent_rust::session_recovery::SYNTHETIC_INTERRUPTED
    );
    assert_eq!(results[1]["tool_call_id"], "remaining");
    assert_eq!(
        results[1]["content"],
        tiny_agent_rust::session_recovery::SYNTHETIC_ABORTED
    );
    assert!(!std::path::Path::new(&format!("{cwd}/current.txt")).exists());
    assert!(!std::path::Path::new(&format!("{cwd}/remaining.txt")).exists());
}

#[test]
fn recovery_mismatches_append_nothing_and_execute_nothing() {
    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let input_id = session.allocate_id();
    let operation_id = session.allocate_id();
    session
        .append(tiny_agent_rust::session_runtime::start_run(
            &input_id,
            &session.allocate_id(),
            &operation_id,
            "configuration mismatch",
        ))
        .unwrap();
    let configuration = recovery_configuration(&test_agent(&cwd, "", None));
    session
        .append(vec![tiny_agent_rust::session_runtime::step_attempt(
            &session.allocate_id(),
            &operation_id,
            &session.allocate_id(),
            &session.allocate_id(),
            "assistant",
            1,
            &input_id,
            &configuration,
        )])
        .unwrap();
    let before = std::fs::read(&session.path).unwrap();
    let mut changed = new_agent(
        Vec::new(),
        Some(session),
        "changed instructions".into(),
        &cwd,
    );
    changed.endpoint = "http://127.0.0.1:1".into();
    assert_eq!(
        changed.resume_session().unwrap_err(),
        "Session recovery blocked: configuration_changed"
    );
    assert_eq!(
        std::fs::read(&changed.session.as_ref().unwrap().path).unwrap(),
        before
    );

    let cwd = temp_dir();
    let other_cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let seed_agent = test_agent(&cwd, "", None);
    let prefix = append_tool_prefix(
        &session,
        &seed_agent,
        vec![tool_call(
            "read-env",
            "read",
            r#"{"path":"would-read.txt"}"#,
        )],
    );
    let read = prefix
        .configuration
        .tools
        .iter()
        .find(|tool| tool.name == "read")
        .unwrap();
    session
        .append(vec![tiny_agent_rust::session_runtime::tool_started(
            &session.allocate_id(),
            &prefix.operation_id,
            &prefix.step_id,
            &prefix.assistant_id,
            0,
            "read-env",
            "read",
            serde_json::json!({"path":"would-read.txt"})
                .as_object()
                .unwrap()
                .clone(),
            read,
            &tiny_agent_rust::session::environment_identity(std::path::Path::new(&cwd)).unwrap(),
            &session.allocate_id(),
        )])
        .unwrap();
    let before = std::fs::read(&session.path).unwrap();
    let mut moved = test_agent(&other_cwd, "http://127.0.0.1:1", Some(session));
    assert_eq!(
        moved.resume_session().unwrap_err(),
        "Session recovery blocked: environment_changed"
    );
    assert_eq!(
        std::fs::read(&moved.session.as_ref().unwrap().path).unwrap(),
        before
    );

    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let seed_agent = test_agent(&cwd, "", None);
    append_tool_prefix(
        &session,
        &seed_agent,
        vec![tool_call(
            "write-unstarted",
            "write",
            r#"{"path":"must-not-start.txt","content":"bad"}"#,
        )],
    );
    let before = std::fs::read(&session.path).unwrap();
    let mut changed = test_agent(&cwd, "http://127.0.0.1:1", Some(session));
    changed.local_tools.retain(|name| name != "write");
    assert_eq!(
        changed.resume_session().unwrap_err(),
        "Session recovery blocked: configuration_changed"
    );
    assert_eq!(
        std::fs::read(&changed.session.as_ref().unwrap().path).unwrap(),
        before
    );
    assert!(!std::path::Path::new(&format!("{cwd}/must-not-start.txt")).exists());
}

#[test]
fn durable_tool_loop_closes_started_tool_before_next_model() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let server = start_serving(vec![
        tool_args("read-1", "read", r#"{"path":"input.txt"}"#),
        r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"done"}}],"usage":{}}"#.into(),
    ]);
    std::fs::write(format!("{cwd}/input.txt"), "contents").unwrap();
    let mut agent = test_agent(&cwd, &server.url, Some(session));
    assert_eq!(agent.run_agent_loop("inspect").unwrap(), "done");
    let state = agent.session.as_ref().unwrap().load().unwrap();
    assert!(matches!(
        state.operation,
        tiny_agent_rust::session_reducer::OperationState::Idle
    ));
    assert_eq!(
        state
            .transcript
            .iter()
            .map(|message| message["role"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["user", "assistant", "tool", "assistant"]
    );
}

// ---------------------------------------------------------------------------
#[test]
fn abort_handle_persists_once_before_cancellation() {
    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let input_id = session.allocate_id();
    let operation_id = session.allocate_id();
    session
        .append(tiny_agent_rust::session_runtime::start_run(
            &input_id,
            &session.allocate_id(),
            &operation_id,
            "wait",
        ))
        .unwrap();
    let agent = test_agent(&cwd, "", Some(session));
    let abort = agent.abort_handle();
    assert!(!agent.cancel.load(Ordering::SeqCst));
    abort.request().unwrap();
    abort.request().unwrap();
    assert!(!agent.cancel.load(Ordering::SeqCst));
    assert!(matches!(
        agent.session.as_ref().unwrap().load().unwrap().operation,
        tiny_agent_rust::session_reducer::OperationState::Run {
            abort_requested: true,
            ..
        }
    ));
    let records = std::fs::read_to_string(&agent.session.as_ref().unwrap().path)
        .unwrap()
        .matches("abortRequested")
        .count();
    assert_eq!(records, 1);

    let concurrent = agent.abort_handle();
    let requests = (0..8)
        .map(|_| {
            let concurrent = concurrent.clone();
            thread::spawn(move || concurrent.request())
        })
        .collect::<Vec<_>>();
    for request in requests {
        request.join().unwrap().unwrap();
    }
    let records = std::fs::read_to_string(&agent.session.as_ref().unwrap().path)
        .unwrap()
        .matches("abortRequested")
        .count();
    assert_eq!(records, 1);
}

#[test]
fn durable_abort_before_tool_start_prevents_write_effect() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let server = start_serving_with_delay(
        vec![tool_args(
            "write-aborted",
            "write",
            r#"{"path":"must-not-write.txt","content":"bad"}"#,
        )],
        Duration::from_millis(200),
    );
    let mut agent = test_agent(&cwd, &server.url, Some(session));
    let abort = agent.abort_handle();
    let run = thread::spawn(move || agent.run_agent_loop("write"));
    while server.requests.lock().unwrap().is_empty() {
        thread::sleep(Duration::from_millis(5));
    }
    abort.request().unwrap();
    assert_eq!(run.join().unwrap().unwrap(), "Operation aborted.");
    assert!(!std::path::Path::new(&format!("{cwd}/must-not-write.txt")).exists());
}

#[test]
fn abort_request_racing_completed_operation_is_harmless() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let server = start_serving(vec![
        r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"done"}}],"usage":{}}"#.into(),
    ]);
    let mut agent = test_agent(&cwd, &server.url, Some(session));
    let abort = agent.abort_handle();
    assert_eq!(agent.run_agent_loop("finish").unwrap(), "done");
    abort.request().unwrap();
    assert!(matches!(
        agent.session.as_ref().unwrap().load().unwrap().operation,
        tiny_agent_rust::session_reducer::OperationState::Idle
    ));
}

#[test]
fn direct_agent_can_run_again_after_abort() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    let hanging = start_hanging();
    let mut agent = test_agent(&cwd, &hanging.url, None);
    let cancel = agent.cancel.clone();
    let first = thread::spawn(move || {
        let result = agent.run_agent_loop("wait");
        (agent, result)
    });
    while hanging.requests.lock().unwrap().is_empty() {
        thread::sleep(Duration::from_millis(5));
    }
    cancel.store(true, Ordering::SeqCst);
    let (mut agent, result) = first.join().unwrap();
    assert_eq!(result.unwrap(), "Operation aborted.");

    let server = start_serving(vec![
        r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"second"}}],"usage":{}}"#.into(),
    ]);
    agent.endpoint = server.url;
    assert_eq!(agent.run_agent_loop("again").unwrap(), "second");
}

#[test]
fn esc_aborts_model_request_and_persists_interruption() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let sid = session.id.clone();
    let server = start_hanging();
    let mut agent = test_agent(&cwd, &server.url, Some(session));
    let cancel = agent.cancel.clone();
    let handle = thread::spawn(move || agent.run_agent_loop("wait"));
    thread::sleep(Duration::from_millis(200));
    cancel.store(true, Ordering::SeqCst);
    let answer = handle.join().unwrap().unwrap();
    assert_eq!(answer, "Operation aborted.");
    let reloaded = Session::open(&sid, std::path::Path::new(&cwd)).unwrap();
    assert!(matches!(
        reloaded.load().unwrap().operation,
        tiny_agent_rust::session_reducer::OperationState::Idle
    ));
}

// ---------------------------------------------------------------------------
#[test]
fn runs_tool_loop_and_compacts_through_mock() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    // 1. tool call -> write
    // 2. assistant "done"
    // 3. compact summary
    let replies = vec![
        r#"{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"1","type":"function","function":{"name":"write","arguments":"{\"path\":\"made.txt\",\"content\":\"yes\"}"}}]}}],"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":25}}}"#.to_string(),
        r#"{"choices":[{"message":{"role":"assistant","content":"done"}}],"usage":{"prompt_tokens":120,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":60}}}"#.to_string(),
        r#"{"choices":[{"message":{"role":"assistant","content":"answer 1"}}],"usage":{}}"#.to_string(),
        r#"{"choices":[{"message":{"role":"assistant","content":"answer 2"}}],"usage":{}}"#.to_string(),
        r#"{"choices":[{"message":{"role":"assistant","content":"answer 3"}}],"usage":{}}"#.to_string(),
        r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"summary"}}],"usage":{"prompt_tokens":80,"completion_tokens":8,"prompt_tokens_details":{"cached_tokens":20}}}"#.to_string(),
    ];
    let server = start_serving(replies);
    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let mut agent = test_agent(&cwd, &server.url, Some(session));
    let events = Arc::new(Mutex::new(Vec::new()));
    let ev = events.clone();
    agent.on_tool = Arc::new(move |e| ev.lock().unwrap().push((e.phase, e.name, e.result)));
    let answer = agent.run_agent_loop("make it").unwrap();
    assert_eq!(answer, "done");
    // tool events
    let e = events.lock().unwrap();
    assert_eq!(e.len(), 2, "events: {:?}", *e);
    assert_eq!(e[1].0, "end", "end event: {:?}", e[1]);
    assert!(
        e[1].2.starts_with("Successfully wrote"),
        "write result: {:?}",
        e[1].2
    );
    drop(e);
    // tool wrote the file
    assert_eq!(
        std::fs::read_to_string(format!("{}/made.txt", cwd)).unwrap(),
        "yes"
    );
    // uses usage accounting with cache
    assert_eq!(agent.usage.input, 135);
    assert_eq!(agent.usage.output, 15);
    assert_eq!(agent.usage.cache_read, 85);
    assert!(agent.usage.cache_hit_rate > 49.9 && agent.usage.cache_hit_rate < 50.1); // latest assistant request
    agent.run_agent_loop("question 1").unwrap();
    agent.run_agent_loop("question 2").unwrap();
    agent.run_agent_loop("question 3").unwrap();
    let result = agent.compact().unwrap();
    assert_eq!(result, "Compacted 4 messages (kept last 6).");
    assert_eq!(
        agent.messages[1].content.as_deref(),
        Some("[Compacted history]\nsummary")
    );
    let log = std::fs::read_to_string(&agent.session.as_ref().unwrap().path).unwrap();
    let started = log.rfind("\"type\":\"compactionStarted\"").unwrap();
    let attempt = log.rfind("\"stepKind\":\"compaction\"").unwrap();
    let usage = log.rfind("\"kind\":\"usage\"").unwrap();
    let entry = log.rfind("\"type\":\"compaction\"").unwrap();
    let finished = log.rfind("\"type\":\"operationFinished\"").unwrap();
    assert!(started < attempt && attempt < usage && usage < entry && entry < finished);
    assert!(log.contains("\"compactedEntryIds\""));
    assert!(log.contains("\"retainedEntryIds\""));
    assert!(log.contains("\"sourceDigest\":\"sha256:"));
    // requests captured include tools on first two, none on compact
    // tool definitions match tiny-ts's four tools
    let defs: serde_json::Value = serde_json::from_str(tool_definitions_json()).unwrap();
    let arr = defs.as_array().unwrap();
    let by_name = |name: &str| arr.iter().find(|t| t["function"]["name"] == name).unwrap();
    let bash = by_name("bash");
    assert!(
        bash["function"]["description"]
            .as_str()
            .unwrap()
            .contains("last 2,000 lines or 50KB")
    );
    assert_eq!(
        bash["function"]["parameters"]["required"],
        serde_json::json!(["command"])
    );
    assert!(
        bash["function"]["parameters"]["properties"]["timeout"]["description"]
            .as_str()
            .unwrap()
            .contains("Defaults to 120")
    );
    let read = by_name("read");
    assert!(
        read["function"]["description"]
            .as_str()
            .unwrap()
            .contains("2,000 complete lines or 50KB")
    );
    assert_eq!(
        read["function"]["parameters"]["properties"]["offset"]["minimum"],
        1
    );
    assert_eq!(
        read["function"]["parameters"]["required"],
        serde_json::json!(["path"])
    );
    let write = by_name("write");
    assert!(
        write["function"]["description"]
            .as_str()
            .unwrap()
            .contains("Parent directories are created automatically")
    );
    let edit = by_name("edit");
    assert!(
        edit["function"]["description"]
            .as_str()
            .unwrap()
            .contains("must not overlap")
    );
    assert_eq!(
        edit["function"]["parameters"]["properties"]["edits"]["minItems"],
        1
    );
    assert_eq!(
        edit["function"]["parameters"]["required"],
        serde_json::json!(["path", "edits"])
    );
    assert_eq!(defs.as_array().unwrap().len(), 5);
}

// ---------------------------------------------------------------------------
// tool behaviors
// ---------------------------------------------------------------------------
fn args() -> ToolArgs {
    ToolArgs {
        command: String::new(),
        r#type: "function".into(),
        timeout: 120.0,
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

#[test]
fn bg_manages_lifecycle_fast_failure_and_stale_metadata() {
    let cwd = temp_dir();
    std::fs::write(
        format!("{cwd}/server.sh"),
        "echo ready; while true; do echo tick; sleep 0.1; done\n",
    )
    .unwrap();
    let agent = test_agent(&cwd, "", None);
    let mut start = args();
    start.action = "start".to_string();
    start.command = "sh server.sh".to_string();
    let started_text = agent.execute_tool("bg", &start).unwrap();
    let started: serde_json::Value =
        serde_json::from_str(started_text.lines().next().unwrap()).unwrap();
    let id = started["id"].as_str().unwrap().to_string();
    let pid = started["pid"].as_u64().unwrap() as i32;
    assert_eq!(id, pid.to_string());
    assert_eq!(started["status"], "running");
    assert!(!started["processStartedAt"].as_str().unwrap().is_empty());
    thread::sleep(Duration::from_millis(250));
    let mut logs = args();
    logs.action = "logs".to_string();
    logs.id = id.clone();
    logs.tail = 5;
    assert!(agent.execute_tool("bg", &logs).unwrap().contains("tick"));
    let mut list = args();
    list.action = "list".to_string();
    let running: serde_json::Value =
        serde_json::from_str(&agent.execute_tool("bg", &list).unwrap()).unwrap();
    assert_eq!(running[0]["id"], id);

    let meta_path = format!("{cwd}/.tiny-agent/bg/{id}.json");
    let original = std::fs::read_to_string(&meta_path).unwrap();
    let mut stale_meta: serde_json::Value = serde_json::from_str(&original).unwrap();
    stale_meta["processStartedAt"] = serde_json::json!("different process");
    std::fs::write(
        &meta_path,
        serde_json::to_string_pretty(&stale_meta).unwrap() + "\n",
    )
    .unwrap();
    let mut stop = args();
    stop.action = "stop".to_string();
    stop.id = id.clone();
    let stale: serde_json::Value =
        serde_json::from_str(&agent.execute_tool("bg", &stop).unwrap()).unwrap();
    assert_eq!(stale["status"], "stale");
    assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
    let running: serde_json::Value =
        serde_json::from_str(&agent.execute_tool("bg", &list).unwrap()).unwrap();
    assert_eq!(running, serde_json::json!([]));
    list.status = "stale".to_string();
    let stale_list: serde_json::Value =
        serde_json::from_str(&agent.execute_tool("bg", &list).unwrap()).unwrap();
    assert_eq!(stale_list[0]["id"], id);

    std::fs::write(&meta_path, original).unwrap();
    let stopped: serde_json::Value =
        serde_json::from_str(&agent.execute_tool("bg", &stop).unwrap()).unwrap();
    assert_eq!(stopped["status"], "stopped");
    list.status = String::new();
    let running: serde_json::Value =
        serde_json::from_str(&agent.execute_tool("bg", &list).unwrap()).unwrap();
    assert_eq!(running, serde_json::json!([]));
    list.status = "all".to_string();
    let all: serde_json::Value =
        serde_json::from_str(&agent.execute_tool("bg", &list).unwrap()).unwrap();
    assert_eq!(all[0]["id"], id);

    let mut fail = args();
    fail.action = "start".to_string();
    fail.command = "echo boom >&2; exit 7".to_string();
    let failed_text = agent.execute_tool("bg", &fail).unwrap();
    let failed: serde_json::Value =
        serde_json::from_str(failed_text.lines().next().unwrap()).unwrap();
    assert_eq!(failed["status"], "exited");
    assert_eq!(failed["exitCode"], 7);
    assert!(failed_text.contains("boom"));
    list.status = String::new();
    let running: serde_json::Value =
        serde_json::from_str(&agent.execute_tool("bg", &list).unwrap()).unwrap();
    assert_eq!(running, serde_json::json!([]));
    list.status = "exited".to_string();
    let exited: serde_json::Value =
        serde_json::from_str(&agent.execute_tool("bg", &list).unwrap()).unwrap();
    assert!(
        exited
            .as_array()
            .unwrap()
            .iter()
            .any(|meta| meta["id"] == failed["id"])
    );
    close_background_processes(&cwd);
}

#[test]
fn matches_shared_local_tool_contract() {
    let contract: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../schemas/tools/local-tool-contract.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let cwd = temp_dir();
    let agent = test_agent(&cwd, "", None);

    let write = &contract["write"];
    let mut write_args = args();
    write_args.path = write["path"].as_str().unwrap().into();
    write_args.content = write["content"].as_str().unwrap().into();
    assert_eq!(
        agent.execute_tool("write", &write_args).unwrap(),
        write["result"].as_str().unwrap()
    );

    let read = &contract["read"];
    std::fs::write(
        format!("{}/{}", cwd, read["path"].as_str().unwrap()),
        read["content"].as_str().unwrap(),
    )
    .unwrap();
    let mut read_args = args();
    read_args.path = read["path"].as_str().unwrap().into();
    read_args.offset = read["arguments"]["offset"].as_i64().unwrap();
    read_args.limit = read["arguments"]["limit"].as_i64().unwrap();
    assert_eq!(
        agent.execute_tool("read", &read_args).unwrap(),
        read["result"].as_str().unwrap()
    );
    read_args.offset = read["beyondOffset"].as_i64().unwrap();
    read_args.limit = 2000;
    assert_eq!(
        agent.execute_tool("read", &read_args).unwrap_err(),
        read["beyondError"].as_str().unwrap()
    );

    let edit = &contract["edit"];
    let edit_path = format!("{}/{}", cwd, edit["path"].as_str().unwrap());
    std::fs::write(&edit_path, edit["content"].as_str().unwrap()).unwrap();
    let mut edit_args = args();
    edit_args.path = edit["path"].as_str().unwrap().into();
    edit_args.edits = serde_json::from_value(edit["edits"].clone()).unwrap();
    assert_eq!(
        agent.execute_tool("edit", &edit_args).unwrap(),
        edit["result"].as_str().unwrap()
    );
    assert_eq!(
        std::fs::read_to_string(&edit_path).unwrap(),
        edit["contentAfter"].as_str().unwrap()
    );
    for failure in edit["failures"].as_array().unwrap() {
        let before = std::fs::read(&edit_path).unwrap();
        edit_args.edits = serde_json::from_value(failure["edits"].clone()).unwrap();
        assert_eq!(
            agent.execute_tool("edit", &edit_args).unwrap_err(),
            failure["error"].as_str().unwrap()
        );
        assert_eq!(std::fs::read(&edit_path).unwrap(), before);
    }
}

#[test]
fn write_reports_bytes_and_edit_applies_atomic_replacements() {
    let cwd = temp_dir();
    let agent = test_agent(&cwd, "", None);
    let mut w = args();
    w.path = "a.txt".to_string();
    w.content = "你好".to_string();
    let wrote = agent.execute_tool("write", &w).unwrap();
    assert_eq!(
        wrote,
        format!("Successfully wrote {} bytes to a.txt.", "你好".len())
    );
    // edit two blocks
    std::fs::write(format!("{}/edit.txt", cwd), "alpha\nbeta\ngamma\n").unwrap();
    let mut e = args();
    e.path = "edit.txt".to_string();
    e.edits = vec![
        ToolEdit {
            old_text: "alpha".into(),
            new_text: "one".into(),
        },
        ToolEdit {
            old_text: "gamma".into(),
            new_text: "three".into(),
        },
    ];
    let res = agent.execute_tool("edit", &e).unwrap();
    assert_eq!(res, "Successfully replaced 2 block(s) in edit.txt.");
    assert_eq!(
        std::fs::read_to_string(format!("{}/edit.txt", cwd)).unwrap(),
        "one\nbeta\nthree\n"
    );
    // failing edits leave file unchanged
    for edits in [
        vec![ToolEdit {
            old_text: "".into(),
            new_text: "x".into(),
        }],
        vec![ToolEdit {
            old_text: "missing".into(),
            new_text: "x".into(),
        }],
        vec![ToolEdit {
            old_text: "e".into(),
            new_text: "x".into(),
        }],
    ] {
        let before = std::fs::read_to_string(format!("{}/edit.txt", cwd)).unwrap();
        let mut ed = args();
        ed.path = "edit.txt".to_string();
        ed.edits = edits;
        assert!(agent.execute_tool("edit", &ed).is_err());
        assert_eq!(
            std::fs::read_to_string(format!("{}/edit.txt", cwd)).unwrap(),
            before
        );
    }
    // Unicode before match, BOM, CRLF, and untouched mixed endings.
    std::fs::write(
        format!("{}/windows.txt", cwd),
        "\u{FEFF}你好😀\r\nfirst\nsecond\r\ntail\n",
    )
    .unwrap();
    let mut ed = args();
    ed.path = "windows.txt".to_string();
    ed.edits = vec![ToolEdit {
        old_text: "first\nsecond".into(),
        new_text: "third\nfourth".into(),
    }];
    agent.execute_tool("edit", &ed).unwrap();
    assert_eq!(
        std::fs::read_to_string(format!("{}/windows.txt", cwd)).unwrap(),
        "\u{FEFF}你好😀\r\nthird\r\nfourth\r\ntail\n"
    );
    let outside = std::env::temp_dir().join(format!("tiny-agent-outside-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&outside);
    std::fs::create_dir_all(&outside).unwrap();
    let outside_file = outside.join("secret.txt");
    std::fs::write(&outside_file, "outside").unwrap();
    let mut outside_read = args();
    outside_read.path = outside_file.to_string_lossy().to_string();
    assert_eq!(
        agent.execute_tool("read", &outside_read).unwrap(),
        "outside"
    );
    let mut outside_write = args();
    outside_write.path = outside.join("nested/new.txt").to_string_lossy().to_string();
    outside_write.content = "new".into();
    agent.execute_tool("write", &outside_write).unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&outside, format!("{}/outside", cwd)).unwrap();
        let mut outside_edit = args();
        outside_edit.path = "outside/secret.txt".into();
        outside_edit.edits = vec![ToolEdit {
            old_text: "outside".into(),
            new_text: "edited".into(),
        }];
        agent.execute_tool("edit", &outside_edit).unwrap();
        assert_eq!(std::fs::read_to_string(&outside_file).unwrap(), "edited");
    }
    std::fs::remove_dir_all(outside).unwrap();
}

#[test]
fn read_paginates_lines_with_actionable_errors() {
    let cwd = temp_dir();
    let agent = test_agent(&cwd, "", None);
    std::fs::write(format!("{}/read.txt", cwd), "one\ntwo\nthree\nfour\n").unwrap();
    let mut r = args();
    r.path = "read.txt".to_string();
    r.limit = 2;
    assert_eq!(
        agent.execute_tool("read", &r).unwrap(),
        "one\ntwo\n\n[Showing lines 1-2 of 4. Use offset=3 to continue.]"
    );
    let mut r2 = args();
    r2.path = "read.txt".to_string();
    r2.offset = 2;
    r2.limit = 2;
    assert_eq!(
        agent.execute_tool("read", &r2).unwrap(),
        "two\nthree\n\n[Showing lines 2-3 of 4. Use offset=4 to continue.]"
    );
    let mut r3 = args();
    r3.path = "read.txt".to_string();
    r3.offset = 5;
    assert!(
        agent
            .execute_tool("read", &r3)
            .unwrap_err()
            .contains("beyond end")
    );
    // wide line exceeds 50KB
    std::fs::write(
        format!("{}/wide.txt", cwd),
        format!("{}\nnext\n", "你".repeat(30_000)),
    )
    .unwrap();
    let mut w = args();
    w.path = "wide.txt".to_string();
    assert!(
        agent
            .execute_tool("read", &w)
            .unwrap()
            .contains("exceeds 50KB")
    );
    // many lines
    std::fs::write(
        format!("{}/many.txt", cwd),
        (1..=2001)
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();
    let mut m = args();
    m.path = "many.txt".to_string();
    assert!(
        agent
            .execute_tool("read", &m)
            .unwrap()
            .ends_with("[Showing lines 1-2000 of 2001. Use offset=2001 to continue.]")
    );
}

#[test]
fn matches_shared_bash_contract() {
    let contract: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../schemas/tools/bash-contract.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let cwd = temp_dir();
    let agent = test_agent(&cwd, "", None);
    for scenario in contract["cases"].as_array().unwrap() {
        let mut arguments = args();
        arguments.command = scenario["command"].as_str().unwrap().into();
        if let Some(timeout) = scenario["timeout"].as_f64() {
            arguments.timeout = timeout;
        }
        assert_eq!(
            agent.execute_tool("bash", &arguments).unwrap(),
            scenario["result"].as_str().unwrap(),
            "{}",
            scenario["name"]
        );
    }
    let expected = &contract["lineTruncation"];
    let mut arguments = args();
    arguments.command = expected["command"].as_str().unwrap().into();
    let result = agent.execute_tool("bash", &arguments).unwrap();
    assert!(result.starts_with(&format!(
        "{}\n",
        expected["firstTailLine"].as_str().unwrap()
    )));
    assert!(result.contains(&format!(
        "{}{}[Showing lines 2-{} of {}. {}: ",
        expected["lastTailLine"].as_str().unwrap(),
        "\n".repeat(expected["separatorNewlines"].as_u64().unwrap() as usize),
        expected["totalLines"].as_u64().unwrap(),
        expected["totalLines"].as_u64().unwrap(),
        expected["label"].as_str().unwrap(),
    )));
    let path = result
        .split("Full output: ")
        .nth(1)
        .unwrap()
        .trim_end_matches(']');
    assert_eq!(
        std::fs::read_to_string(path).unwrap().lines().count(),
        expected["totalLines"].as_u64().unwrap() as usize
    );
}

#[test]
fn bash_preserves_failures_short_and_long() {
    let cwd = temp_dir();
    let agent = test_agent(&cwd, "", None);
    let mut b = args();
    b.command = "printf 'stdout'; printf 'stderr' >&2; exit 7".to_string();
    let failed = agent.execute_tool("bash", &b).unwrap();
    assert!(
        failed.ends_with("Command exited with code 7"),
        "failed: {}",
        failed
    );
    assert!(failed.contains("stdoutstderr"));
    // no output success
    let mut nb = args();
    nb.command = "true".to_string();
    assert_eq!(agent.execute_tool("bash", &nb).unwrap(), "(no output)");
    // long output truncated with full log stored
    let mut big = args();
    big.command = "printf 'begin\\n'; yes x | head -n 3000; printf 'end\\n'".to_string();
    let result = agent.execute_tool("bash", &big).unwrap();
    assert!(result.contains("Full output:"), "result: {}", result);
    assert!(result.len() <= 2_002 * 8);
    // The reader keeps draining after its 10MB capture cap, so the producer exits quickly.
    let mut capped = args();
    capped.command = "head -c 11000000 /dev/zero | tr '\\0' x".into();
    capped.timeout = 10.0;
    let start = std::time::Instant::now();
    let result = agent.execute_tool("bash", &capped).unwrap();
    assert!(start.elapsed() < Duration::from_secs(10));
    assert!(result.contains("complete output was not captured"));
    assert!(!result.contains("Full output:"));
}

#[test]
fn bash_cancellation_returns_operation_aborted() {
    let cwd = temp_dir();
    let agent = test_agent(&cwd, "", None);
    let cancel = agent.cancel.clone();
    let mut b = args();
    b.command = "sleep 5".to_string();
    let handle = thread::spawn(move || {
        let a = agent;
        a.execute_tool("bash", &b)
    });
    thread::sleep(Duration::from_millis(100));
    cancel.store(true, Ordering::SeqCst);
    let r = handle.join().unwrap();
    assert!(r.is_err());
}
