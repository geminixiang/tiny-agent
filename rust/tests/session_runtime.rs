use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, json};
use tiny_agent_rust::session::Session;
use tiny_agent_rust::session_reducer::OperationState;
use tiny_agent_rust::session_runtime::{
    RuntimeTool, abort_requested, assistant_entry, operation_finished, project_idle,
    runtime_configuration, start_run, step_attempt, step_failed, tool_declaration, tool_result,
    tool_started, usage,
};
use tiny_agent_rust::{Message, ToolCall, ToolFunction, UsageJSON};

const USER: &str = "018f1000-0000-7000-8000-000000000001";
const RUN_RECORD: &str = "018f1000-0000-7000-8000-000000000002";
const OPERATION: &str = "018f1000-0000-7000-8000-000000000003";
const STEP: &str = "018f1000-0000-7000-8000-000000000004";
const ATTEMPT: &str = "018f1000-0000-7000-8000-000000000005";
const ATTEMPT_RECORD: &str = "018f1000-0000-7000-8000-000000000006";
const ASSISTANT: &str = "018f1000-0000-7000-8000-000000000007";

fn workspace() -> PathBuf {
    let root =
        std::env::temp_dir().join(format!("tiny-session-runtime-{}", tiny_agent_rust::uuid7()));
    fs::create_dir_all(&root).unwrap();
    root
}

fn read_tool() -> RuntimeTool {
    RuntimeTool {
        name: "read".into(),
        definition: json!({
            "type":"function",
            "function":{"name":"read","description":"Read a file","parameters":{"type":"object"}}
        }),
        replay: "safe".into(),
        replay_key: "builtin:read:v1".into(),
    }
}

fn configuration() -> tiny_agent_rust::session_runtime::RuntimeConfiguration {
    runtime_configuration(
        "test/model",
        "system",
        vec![read_tool()],
        "openrouter:chat-completions:v1",
        "openrouter:test/model",
    )
}

fn create() -> (PathBuf, Session) {
    let root = workspace();
    let store = Session::create_new(&root, "test/model").unwrap();
    (root, store)
}

fn begin(store: &Session) {
    store
        .append(start_run(USER, RUN_RECORD, OPERATION, "inspect"))
        .unwrap();
    store
        .append(vec![step_attempt(
            ATTEMPT_RECORD,
            OPERATION,
            STEP,
            ATTEMPT,
            "assistant",
            1,
            USER,
            &configuration(),
        )])
        .unwrap();
}

fn reopen(root: &Path, store: Session) -> Session {
    let id = store.id.clone();
    store.close().unwrap();
    Session::open(&id, root).unwrap()
}

fn assistant(content: Option<&str>, calls: Vec<ToolCall>) -> Message {
    Message {
        role: "assistant".into(),
        content: content.map(str::to_string),
        tool_call_id: String::new(),
        tool_calls: calls,
    }
}

#[test]
fn commits_normal_run_and_projects_idle_transcript_and_usage() {
    let (root, store) = create();
    begin(&store);
    store
        .append(vec![assistant_entry(
            ASSISTANT,
            STEP,
            ATTEMPT,
            "stop",
            &assistant(Some("done"), vec![]),
        )])
        .unwrap();
    store
        .append(vec![operation_finished(
            "018f1000-0000-7000-8000-000000000008",
            OPERATION,
            "run",
            "completed",
            Some(ASSISTANT),
            None,
        )])
        .unwrap();
    store
        .append(vec![usage(
            "018f1000-0000-7000-8000-000000000009",
            OPERATION,
            Some(ATTEMPT),
            None,
            UsageJSON {
                input: 10,
                output: 2,
                cache_read: 3,
                cache_write: 0,
            },
        )])
        .unwrap();

    let reopened = reopen(&root, store);
    let state = reopened.load().unwrap();
    let projection = project_idle(&state, "system").unwrap();
    assert_eq!(projection.messages.len(), 3);
    assert_eq!(projection.messages[1].content.as_deref(), Some("inspect"));
    assert_eq!(projection.messages[2].content.as_deref(), Some("done"));
    assert_eq!(projection.usage.input, 10);
    assert_eq!(projection.usage.output, 2);
    assert_eq!(projection.usage.cache_read, 3);
    assert_eq!(projection.usage.cache_hit_rate, -1.0);
    assert_eq!(
        reopened
            .latest_assistant_usage()
            .unwrap()
            .unwrap()
            .cache_read,
        3
    );
    reopened.close().unwrap();
}

#[test]
fn commits_failed_and_aborted_model_lifecycles() {
    let (root, store) = create();
    begin(&store);
    store
        .append(vec![step_failed(
            "018f1000-0000-7000-8000-000000000010",
            OPERATION,
            STEP,
            ATTEMPT,
            "model_error",
            "provider failed",
        )])
        .unwrap();
    store
        .append(vec![operation_finished(
            "018f1000-0000-7000-8000-000000000011",
            OPERATION,
            "run",
            "failed",
            None,
            Some(("model_error", "provider failed")),
        )])
        .unwrap();
    let reopened = reopen(&root, store);
    assert!(matches!(
        reopened.load().unwrap().operation,
        OperationState::Idle
    ));
    reopened.close().unwrap();

    let (root, store) = create();
    begin(&store);
    store
        .append(vec![abort_requested(
            "018f1000-0000-7000-8000-000000000012",
            OPERATION,
            "run",
            "model",
            None,
        )])
        .unwrap();
    store
        .append(vec![step_failed(
            "018f1000-0000-7000-8000-000000000013",
            OPERATION,
            STEP,
            ATTEMPT,
            "aborted",
            "Operation aborted",
        )])
        .unwrap();
    store
        .append(vec![operation_finished(
            "018f1000-0000-7000-8000-000000000014",
            OPERATION,
            "run",
            "aborted",
            None,
            None,
        )])
        .unwrap();
    let reopened = reopen(&root, store);
    assert!(matches!(
        reopened.load().unwrap().operation,
        OperationState::Idle
    ));
    reopened.close().unwrap();
}

#[test]
fn commits_length_settlement_without_executing_tool() {
    let (root, store) = create();
    begin(&store);
    let call = ToolCall {
        id: "call_1".into(),
        r#type: "function".into(),
        function: ToolFunction {
            name: "read".into(),
            arguments: "{\"path\":\"README.md\"}".into(),
        },
    };
    store
        .append(vec![assistant_entry(
            ASSISTANT,
            STEP,
            ATTEMPT,
            "length",
            &assistant(None, vec![call]),
        )])
        .unwrap();
    let reopened = reopen(&root, store);
    let state = reopened.load().unwrap();
    assert!(matches!(state.operation, OperationState::Run { .. }));
    assert_eq!(state.transcript.len(), 2);
    reopened.close().unwrap();
}

#[test]
fn commits_tool_intent_result_and_followup_completion() {
    let (root, store) = create();
    begin(&store);
    let call = ToolCall {
        id: "call_1".into(),
        r#type: "function".into(),
        function: ToolFunction {
            name: "read".into(),
            arguments: "{\"path\":\"README.md\"}".into(),
        },
    };
    store
        .append(vec![assistant_entry(
            ASSISTANT,
            STEP,
            ATTEMPT,
            "toolUse",
            &assistant(None, vec![call]),
        )])
        .unwrap();
    let declaration = tool_declaration(&configuration(), "read").unwrap().clone();
    let started = "018f1000-0000-7000-8000-000000000020";
    let result = "018f1000-0000-7000-8000-000000000021";
    store
        .append(vec![tool_started(
            started,
            OPERATION,
            STEP,
            ASSISTANT,
            0,
            "call_1",
            "read",
            Map::from_iter([("path".into(), json!("README.md"))]),
            &declaration,
            &store.load().unwrap().header.environment_identity,
            result,
        )])
        .unwrap();
    store
        .append(vec![tool_result(
            result, STEP, started, "call_1", "read", "contents", "success",
        )])
        .unwrap();
    store
        .append(vec![usage(
            "018f1000-0000-7000-8000-000000000022",
            OPERATION,
            None,
            Some(started),
            UsageJSON {
                input: 1,
                output: 0,
                cache_read: 0,
                cache_write: 0,
            },
        )])
        .unwrap();
    let second_step = "018f1000-0000-7000-8000-000000000023";
    let second_attempt = "018f1000-0000-7000-8000-000000000024";
    store
        .append(vec![step_attempt(
            "018f1000-0000-7000-8000-000000000025",
            OPERATION,
            second_step,
            second_attempt,
            "assistant",
            1,
            result,
            &configuration(),
        )])
        .unwrap();
    let final_entry = "018f1000-0000-7000-8000-000000000026";
    store
        .append(vec![assistant_entry(
            final_entry,
            second_step,
            second_attempt,
            "stop",
            &assistant(Some("done"), vec![]),
        )])
        .unwrap();
    store
        .append(vec![operation_finished(
            "018f1000-0000-7000-8000-000000000027",
            OPERATION,
            "run",
            "completed",
            Some(final_entry),
            None,
        )])
        .unwrap();

    let reopened = reopen(&root, store);
    let state = reopened.load().unwrap();
    let projection = project_idle(&state, "system").unwrap();
    assert_eq!(projection.messages.len(), 5);
    assert_eq!(projection.messages[3].content.as_deref(), Some("contents"));
    assert_eq!(projection.usage.input, 1);
    reopened.close().unwrap();
}
