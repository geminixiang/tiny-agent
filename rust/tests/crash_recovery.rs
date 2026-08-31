//! Real crash-recovery tests: these fork() a genuine OS process running the
//! agent loop against a mock OpenRouter server, SIGKILL it mid-tool-execution
//! (not a graceful abort/exit), then reopen the on-disk session in the parent
//! and drive recovery. This exercises the actual byte-level JSONL log left
//! behind by a hard crash rather than a hand-assembled fixture.
//!
//! fork() only duplicates the calling thread; any lock/socket/background
//! thread already alive in this process at fork time is not duplicated and
//! can leave the child in an inconsistent state. Run this file in isolation
//! (`cargo test --test crash_recovery`), not interleaved with other test
//! binaries that spin up background threads of their own.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tiny_agent_rust::*;

fn temp_dir() -> String {
    let id = uuid7();
    let dir = std::env::temp_dir().join(format!("tiny-rs-crash-{}", id));
    std::fs::create_dir_all(&dir).unwrap();
    dir.to_string_lossy().to_string()
}

fn read_request(stream: &mut TcpStream) -> String {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2000)));
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

/// A mock server that serves one fixed response for every request it
/// receives (so the never-terminating child process can call it any number
/// of times before it is killed).
struct MockServer {
    url: String,
    handle: Option<thread::JoinHandle<()>>,
}

fn start_serving_forever(response: String) -> MockServer {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let handle = thread::spawn(move || {
        loop {
            let Ok((mut stream, _)) = listener.accept() else {
                break;
            };
            let _ = read_request(&mut stream);
            let out = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.len(),
                response
            );
            let _ = stream.write_all(out.as_bytes());
            let _ = stream.flush();
        }
    });
    MockServer {
        url,
        handle: Some(handle),
    }
}

fn tool_call_response(call_id: &str, name: &str, arguments: &str) -> String {
    format!(
        r#"{{"choices":[{{"finish_reason":"tool_calls","message":{{"role":"assistant","content":null,"tool_calls":[{{"id":"{}","type":"function","function":{{"name":"{}","arguments":{}}}}}]}}}}],"usage":{{"prompt_tokens":10,"completion_tokens":1}}}}"#,
        call_id,
        name,
        serde_json::to_string(arguments).unwrap()
    )
}

fn test_agent(cwd: &str, endpoint: &str, session: Option<Session>) -> Agent {
    let mut agent = new_agent(Vec::new(), session, String::new(), cwd);
    agent.endpoint = endpoint.to_string();
    agent
}

/// Wait until `predicate` is true or `timeout` elapses, polling every 10ms.
fn wait_until(timeout: Duration, mut predicate: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if predicate() {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    predicate()
}

fn session_log_contains(path: &std::path::Path, needle: &str) -> bool {
    std::fs::read_to_string(path)
        .map(|text| text.contains(needle))
        .unwrap_or(false)
}

fn find_session_log_path(cwd: &str, session_id: &str) -> std::path::PathBuf {
    let directory = std::path::Path::new(cwd).join(".tiny-agent/sessions");
    let suffix = format!("_{session_id}.jsonl");
    std::fs::read_dir(&directory)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().ends_with(&suffix))
        })
        .expect("session log file must exist")
}

/// Runs `agent.run_agent_loop(prompt)` in a real forked child process, waits
/// until `ready` is observed against the session file, then sends a true
/// SIGKILL to the child (no graceful shutdown, no drop handlers, no unwind).
/// Returns once the child has actually been reaped as killed-by-signal.
fn crash_mid_run(cwd: &str, endpoint: &str, session_id: &str, prompt: &str, ready_needle: &str) {
    let log_path = find_session_log_path(cwd, session_id);

    match unsafe { libc::fork() } {
        -1 => panic!("fork failed"),
        0 => {
            // Child: run the real agent loop against the mock server.
            let session = Session::open(session_id, std::path::Path::new(cwd)).unwrap();
            let mut agent = test_agent(cwd, endpoint, Some(session));
            let _ = agent.run_agent_loop(prompt);
            std::process::exit(0);
        }
        pid => {
            let found = wait_until(Duration::from_secs(10), || {
                session_log_contains(&log_path, ready_needle)
            });
            assert!(
                found,
                "child never reached the expected intermediate state before timeout"
            );
            // A tiny grace period so the write syscall for the intent record
            // is fully durable before we cut the process off mid-effect.
            thread::sleep(Duration::from_millis(50));
            let rc = unsafe { libc::kill(pid, libc::SIGKILL) };
            assert_eq!(rc, 0, "failed to send SIGKILL to child {pid}");
            let mut status: i32 = 0;
            let waited = unsafe { libc::waitpid(pid, &mut status, 0) };
            assert_eq!(waited, pid);
            assert!(
                libc::WIFSIGNALED(status),
                "child should have died from a signal, status={status}"
            );
            assert_eq!(
                libc::WTERMSIG(status),
                libc::SIGKILL,
                "child should have died specifically from SIGKILL"
            );
        }
    }
}

/// Scenario 1: a "never"-replay tool (bash) is mid-flight when the process is
/// SIGKILLed. The external effect must not have completed, the log must show
/// a started record with no result, and recovery must synthesize an
/// "interrupted" result without calling the model or re-running the command.
///
/// This is a real-crash sanity check, not a merge gate: this project's
/// recovery guarantees are meant to be provable from deterministic pure-
/// function fixtures over fixed JSONL bytes (see docs/session-design.md and
/// the equivalent scenario locked in deterministically in
/// tests/tiny.rs::pending_never_replay_tool_is_interrupted_without_effect_then_run_continues).
/// A fork()-based SIGKILL test additionally forks a process that already has
/// live background threads (mock HTTP server threads) which is inherently
/// unsafe per POSIX fork() semantics, so it can flake when run concurrently
/// with other test binaries. Keep it as an opt-in real-world confidence
/// check, run explicitly with:
///   cargo test --test crash_recovery -- --ignored --test-threads=1
#[test]
#[ignore = "real fork()+SIGKILL process test; run explicitly and in isolation, not part of the default merge gate"]
fn never_replay_tool_crash_leaves_no_effect_and_recovery_does_not_replay() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();
    let marker = format!("{cwd}/should-not-exist.txt");
    let cwd_for_cmd = cwd.clone();

    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let session_id = session.id.clone();
    session.close().unwrap();

    let bash_call =
        format!(r#"{{"command":"sleep 5 && echo hi > {cwd_for_cmd}/should-not-exist.txt"}}"#);
    let response = tool_call_response("crash-bash", "bash", &bash_call);
    let server = start_serving_forever(response);

    // The tool-started record is committed durably before the bash command
    // runs, so the presence of "toolStarted" in the log is our signal that
    // the intent has landed but the 5s sleep has not finished yet.
    crash_mid_run(&cwd, &server.url, &session_id, "run it", "\"toolStarted\"");

    assert!(
        !std::path::Path::new(&marker).exists(),
        "the bash effect must not have completed before the kill"
    );

    let log_path = find_session_log_path(&cwd, &session_id);
    let log_text = std::fs::read_to_string(&log_path).unwrap();
    assert!(log_text.contains("\"toolStarted\""));
    assert!(
        !log_text.contains("\"toolResult\""),
        "no result record should have been written before the kill: {log_text}"
    );

    // Recovery: reopen the session and resume. Since the crashed run still
    // has a pending assistant turn, recovery writes a synthetic interrupted
    // result for the crashed tool call (without re-running it) and then, to
    // finish the operation, does go on to ask the model for the next step —
    // that follow-up call is served by a fresh mock server that never saw
    // the crashed run's requests, so any request landing on it necessarily
    // happens strictly after the synthetic interrupted result was written.
    let finish_server = start_serving_forever(
        r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"continued"}}],"usage":{}}"#
            .to_string(),
    );
    let reopened = Session::open(&session_id, std::path::Path::new(&cwd)).unwrap();
    let mut agent = test_agent(&cwd, &finish_server.url, Some(reopened));
    agent.resume_session().unwrap();

    let state = agent.session.as_ref().unwrap().load().unwrap();
    let interrupted = state
        .transcript
        .iter()
        .find(|message| message["tool_call_id"] == "crash-bash")
        .expect("interrupted tool result must be present in the transcript");
    assert_eq!(
        interrupted["content"],
        tiny_agent_rust::session_recovery::SYNTHETIC_INTERRUPTED
    );
    assert!(
        !std::path::Path::new(&marker).exists(),
        "recovery must not have re-executed the bash command"
    );
    assert_eq!(
        agent.messages.last().unwrap().content.as_deref(),
        Some("continued")
    );

    drop(finish_server.handle);
    drop(server.handle);
}

/// Scenario 2: a "safe"-replay tool (read) is mid-flight when the process is
/// SIGKILLed. Recovery must actually re-execute the read and recover the
/// real file content into the transcript. Also covers scenario 3: the safe
/// replay's success is immediately followed by a plain "stop" model attempt.
///
/// Same real-crash caveat as the bash scenario above: this is an opt-in
/// sanity check, not a merge gate. The deterministic version of this exact
/// sequence lives in
/// tests/tiny.rs::pending_safe_read_replays_once_then_closes_and_finishes_idempotently.
/// Run explicitly with: cargo test --test crash_recovery -- --ignored --test-threads=1
#[test]
#[ignore = "real fork()+SIGKILL process test; run explicitly and in isolation, not part of the default merge gate"]
fn safe_replay_tool_crash_is_replayed_on_recovery() {
    unsafe { std::env::set_var("OPENROUTER_API_KEY", "test") };
    let cwd = temp_dir();

    // A read against a FIFO with no writer blocks forever inside the actual
    // fs::read_to_string effect, which is what lets us reliably observe the
    // toolStarted intent record on disk before the read effect can possibly
    // complete, then kill the process while it's truly stuck inside the read.
    let fifo_path = format!("{cwd}/input.txt");
    let fifo_cstr = std::ffi::CString::new(fifo_path.clone()).unwrap();
    let rc = unsafe { libc::mkfifo(fifo_cstr.as_ptr(), 0o600) };
    assert_eq!(rc, 0, "mkfifo failed");

    let session = Session::create_new(std::path::Path::new(&cwd), &model_name()).unwrap();
    let session_id = session.id.clone();
    session.close().unwrap();

    let read_call = r#"{"path":"input.txt"}"#;
    let response = tool_call_response("crash-read", "read", read_call);
    let server = start_serving_forever(response);

    crash_mid_run(&cwd, &server.url, &session_id, "read it", "\"toolStarted\"");

    // The child died while blocked inside the fs read against the FIFO.
    // Swap the FIFO out for a real file so recovery's replay of the "safe"
    // read tool call observes real content, mirroring a crash where the
    // effect never got far enough to matter and is safe to redo from scratch.
    std::fs::remove_file(&fifo_path).unwrap();
    std::fs::write(&fifo_path, "recovered contents").unwrap();

    let log_path = find_session_log_path(&cwd, &session_id);
    let log_text = std::fs::read_to_string(&log_path).unwrap();
    assert!(log_text.contains("\"toolStarted\""));
    assert!(!log_text.contains("\"toolResult\""));

    let finish_server = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(0usize));
        let reqs = requests.clone();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut stream);
            *reqs.lock().unwrap() += 1;
            let body = r#"{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"finished"}}],"usage":{}}"#;
            let out = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(out.as_bytes());
            let _ = stream.flush();
        });
        (url, handle, requests)
    };

    let reopened = Session::open(&session_id, std::path::Path::new(&cwd)).unwrap();
    let mut agent = test_agent(&cwd, &finish_server.0, Some(reopened));
    agent.resume_session().unwrap();

    let state = agent.session.as_ref().unwrap().load().unwrap();
    let tool_messages: Vec<_> = state
        .transcript
        .iter()
        .filter(|message| message["role"] == "tool")
        .collect();
    assert_eq!(tool_messages.len(), 1);
    assert_eq!(tool_messages[0]["tool_call_id"], "crash-read");
    assert_eq!(tool_messages[0]["content"], "recovered contents");
    assert_eq!(*finish_server.2.lock().unwrap(), 1);

    // Scenario 3 (regression): after the safe replay succeeds, the very next
    // model attempt settles with a plain "stop" (no tool calls). In the
    // TypeScript port this exact sequence corrupts the reducer with an
    // INVALID_TRANSITION error because a stray extra stepAttempt is started
    // whose contextThroughEntryId no longer matches the now-advanced
    // activeContextThroughEntryId. Verify the Rust port does NOT reproduce
    // this: resume_session() above already drove the replay-then-stop
    // sequence end to end and must have returned Ok with a finished, idle
    // session and the "finished" answer appended.
    assert!(matches!(
        state.operation,
        tiny_agent_rust::session_reducer::OperationState::Idle
    ));
    assert_eq!(
        agent.messages.last().unwrap().content.as_deref(),
        Some("finished")
    );

    drop(finish_server.1);
    drop(server.handle);
}
