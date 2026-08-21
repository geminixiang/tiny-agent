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
        if let Some(v) = line.strip_prefix("Content-Length:") {
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
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let reqs = requests.clone();
    let handle = thread::spawn(move || {
        for resp in responses {
            let (mut stream, _) = listener.accept().unwrap();
            let body = read_request(&mut stream);
            reqs.lock().unwrap().push(body);
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
    assert!(system.contains("<project_context>"));
    assert!(system.contains("<name>teach</name>"));
    assert!(system.contains("<description>Teaches tiny agents.</description>"));
    assert!(system.contains(&skills[0].path));
    assert!(!system.contains("SECRET"));
    assert!(
        system.contains("inspect only what is needed, then make the changes and run focused tests")
    );
    assert!(system.contains("If repeated experiments fail, reconsider the approach"));
}

// ---------------------------------------------------------------------------
#[test]
fn session_create_open_records() {
    let cwd = temp_dir();
    let session = Session::create(&cwd).unwrap();
    assert!(session.id.len() == 36);
    assert!(session.path.contains(".tiny-agent/sessions/"));
    assert!(session.path.ends_with(&format!("_{}.jsonl", session.id)));
    assert!(Session::open(&session.id, &cwd).unwrap().path == session.path);
    let fixed = uuid7_at(0x019f_c5c3_79ae);
    assert_eq!(&fixed[..13], "019fc5c3-79ae");
    assert_eq!(fixed.as_bytes()[14], b'7');
    assert!(matches!(fixed.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
    assert!(Session::open("bad", &cwd).is_err());
    let mut map = serde_json::Map::new();
    map.insert("type".into(), serde_json::Value::String("message".into()));
    map.insert(
        "message".into(),
        serde_json::to_value(Message {
            role: "user".into(),
            content: Some("hi".into()),
            tool_call_id: String::new(),
            tool_calls: Vec::new(),
        })
        .unwrap(),
    );
    session.append_value(&map).unwrap();
    let records = session.records().unwrap();
    assert_eq!(records[0]["type"], "session");
    assert_eq!(records[1]["type"], "message");
    assert_eq!(records[1]["message"]["content"], "hi");
}

// ---------------------------------------------------------------------------
#[test]
fn resume_restores_messages_compact_and_usage() {
    let cwd = temp_dir();
    let session = Session::create(&cwd).unwrap();
    let m = Message {
        role: "user".into(),
        content: Some("old".into()),
        tool_call_id: String::new(),
        tool_calls: Vec::new(),
    };
    let mut map = serde_json::Map::new();
    map.insert("type".into(), serde_json::Value::String("message".into()));
    map.insert("message".into(), serde_json::to_value(m).unwrap());
    session.append_value(&map).unwrap();
    let mut map = serde_json::Map::new();
    map.insert("type".into(), serde_json::Value::String("message".into()));
    map.insert(
        "message".into(),
        serde_json::to_value(Message {
            role: "assistant".into(),
            content: Some("answer".into()),
            tool_call_id: String::new(),
            tool_calls: Vec::new(),
        })
        .unwrap(),
    );
    map.insert(
        "usage".into(),
        serde_json::json!({"input":80,"output":5,"cacheRead":20,"cacheWrite":0}),
    );
    session.append_value(&map).unwrap();
    // compaction
    let mut c = serde_json::Map::new();
    c.insert(
        "type".into(),
        serde_json::Value::String("compaction".into()),
    );
    c.insert(
        "summary".into(),
        serde_json::Value::String("summary".into()),
    );
    c.insert(
        "compactedMessages".into(),
        serde_json::Value::Number(2.into()),
    );
    c.insert("keptMessages".into(), serde_json::Value::Number(0.into()));
    c.insert(
        "usage".into(),
        serde_json::json!({"input":40,"output":4,"cacheRead":0,"cacheWrite":0}),
    );
    session.append_value(&c).unwrap();
    // new user message
    let mut m2 = serde_json::Map::new();
    m2.insert("type".into(), serde_json::Value::String("message".into()));
    m2.insert(
        "message".into(),
        serde_json::to_value(Message {
            role: "user".into(),
            content: Some("new".into()),
            tool_call_id: String::new(),
            tool_calls: Vec::new(),
        })
        .unwrap(),
    );
    session.append_value(&m2).unwrap();

    let mut agent = test_agent(&cwd, "", Some(session));
    agent.resume_session().unwrap();
    assert_eq!(
        agent.messages[1].content.as_deref(),
        Some("[Compacted history]\nsummary")
    );
    assert_eq!(agent.messages[2].content.as_deref(), Some("new"));
    assert_eq!(agent.usage.input, 120);
    assert_eq!(agent.usage.output, 9);
    assert_eq!(agent.usage.cache_read, 20);
    assert!(agent.usage.cache_hit_rate > 19.9 && agent.usage.cache_hit_rate < 20.1);
}

// ---------------------------------------------------------------------------
#[test]
fn esc_aborts_model_request_and_persists_interruption() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    let session = Session::create(&cwd).unwrap();
    let sid = session.id.clone();
    let server = start_hanging();
    let mut agent = test_agent(&cwd, &server.url, Some(session));
    let cancel = agent.cancel.clone();
    let handle = thread::spawn(move || agent.run_agent_loop("wait"));
    thread::sleep(Duration::from_millis(200));
    cancel.store(true, Ordering::SeqCst);
    let answer = handle.join().unwrap().unwrap();
    assert_eq!(answer, "Operation aborted.");
    let reloaded = Session::open(&sid, &cwd).unwrap();
    let records = reloaded.records().unwrap();
    let last = records.last().unwrap();
    assert_eq!(last["type"], "interruption");
    assert_eq!(last["phase"], "model");
}

// ---------------------------------------------------------------------------
#[test]
fn runs_tool_loop_and_compacts_through_mock() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    let session = Session::create(&cwd).unwrap();
    // 1. tool call -> write
    // 2. assistant "done"
    // 3. compact summary
    let replies = vec![
        r#"{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"1","type":"function","function":{"name":"write","arguments":"{\"path\":\"made.txt\",\"content\":\"yes\"}"}}]}}],"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":25}}}"#.to_string(),
        r#"{"choices":[{"message":{"role":"assistant","content":"done"}}],"usage":{"prompt_tokens":120,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":60}}}"#.to_string(),
        r#"{"choices":[{"message":{"role":"assistant","content":"summary"}}],"usage":{"prompt_tokens":80,"completion_tokens":8,"prompt_tokens_details":{"cached_tokens":20}}}"#.to_string(),
    ];
    let server = start_serving(replies);
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
    assert!(agent.usage.cache_hit_rate > 49.9 && agent.usage.cache_hit_rate < 50.1); // compact
    let mut recent = Vec::new();
    for i in 0..8 {
        recent.push(Message {
            role: if i % 2 == 0 { "user" } else { "assistant" }.to_string(),
            content: Some(format!("m{}", i)),
            tool_call_id: String::new(),
            tool_calls: Vec::new(),
        });
    }
    let recent_clone = recent.clone();
    agent.messages.extend(recent.iter().cloned());
    let result = agent.compact().unwrap();
    assert_eq!(result, "Compacted 6 messages (kept last 6).");
    assert_eq!(
        agent.messages[1].content.as_deref(),
        Some("[Compacted history]\nsummary")
    );
    let _ = recent_clone;
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
    assert_eq!(defs.as_array().unwrap().len(), 4);
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
    // path guard
    let mut g = args();
    g.path = "../secret".to_string();
    assert!(
        agent
            .execute_tool("read", &g)
            .unwrap_err()
            .contains("inside cwd")
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(std::env::temp_dir(), format!("{}/outside", cwd)).unwrap();
        for name in ["read", "write", "edit"] {
            let mut escaped = args();
            escaped.path = "outside/tiny-agent-secret".into();
            escaped.content = "secret".into();
            escaped.edits = vec![ToolEdit {
                old_text: "x".into(),
                new_text: "y".into(),
            }];
            assert!(
                agent
                    .execute_tool(name, &escaped)
                    .unwrap_err()
                    .contains("inside cwd")
            );
        }
    }
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
