use serde_json::{Map, json};
use tiny_agent_rust::session::facts::{
    assistant_message, operation_finished, step_attempt, tool_result, tool_started, usage_fact,
};
use tiny_agent_rust::session::{Session, environment_identity};
use tiny_agent_rust::session_reducer::OperationState;
use tiny_agent_rust::session_runtime::{
    RuntimeTool, runtime_configuration, start_run, tool_declaration,
};
use tiny_agent_rust::{Message, ToolCall, ToolFunction, UsageJSON, uuid7};

const USAGE: UsageJSON = UsageJSON {
    input: 1,
    output: 1,
    cache_read: 0,
    cache_write: 0,
};

fn assistant(content: Option<&str>, tool_calls: Vec<ToolCall>) -> Message {
    Message {
        role: "assistant".into(),
        content: content.map(str::to_string),
        tool_call_id: String::new(),
        tool_calls,
    }
}

#[test]
fn fact_builders_produce_a_run_the_reducer_accepts_end_to_end() {
    let cwd = std::env::temp_dir().join(format!("tiny-session-facts-{}", uuid7()));
    std::fs::create_dir_all(&cwd).unwrap();
    let session = Session::create_new(&cwd, "test/model").unwrap();
    let tool = RuntimeTool {
        name: "read".into(),
        definition: json!({"type":"function","function":{"name":"read","parameters":{"type":"object"}}}),
        replay: "safe".into(),
        replay_key: "builtin:read:v1".into(),
    };
    let configuration = runtime_configuration(
        "test/model",
        "system",
        vec![tool],
        "openrouter:chat-completions:v1",
        "openrouter:test/model",
    );

    let input_entry_id = session.allocate_id();
    let operation_id = session.allocate_id();
    session
        .append(start_run(
            &input_entry_id,
            &session.allocate_id(),
            &operation_id,
            "inspect",
        ))
        .unwrap();

    let step_id = session.allocate_id();
    let attempt_id = session.allocate_id();
    let assistant_entry_id = session.allocate_id();
    let tool_started_id = session.allocate_id();
    let result_entry_id = session.allocate_id();
    let call = ToolCall {
        id: "call_1".into(),
        r#type: "function".into(),
        function: ToolFunction {
            name: "read".into(),
            arguments: "{}".into(),
        },
    };
    session
        .append(vec![step_attempt(
            &session.allocate_id(),
            &operation_id,
            &step_id,
            &attempt_id,
            "assistant",
            1,
            &input_entry_id,
            &configuration,
        )])
        .unwrap();
    session
        .append(vec![
            assistant_message(
                &assistant_entry_id,
                &step_id,
                &attempt_id,
                "toolUse",
                &assistant(None, vec![call]),
            ),
            usage_fact(
                &session.allocate_id(),
                &operation_id,
                Some(&attempt_id),
                None,
                USAGE,
            ),
        ])
        .unwrap();
    session
        .append(vec![tool_started(
            &tool_started_id,
            &operation_id,
            &step_id,
            &assistant_entry_id,
            0,
            "call_1",
            "read",
            Map::new(),
            tool_declaration(&configuration, "read").unwrap(),
            &environment_identity(&cwd).unwrap(),
            &result_entry_id,
        )])
        .unwrap();
    session
        .append(vec![tool_result(
            &result_entry_id,
            &step_id,
            &tool_started_id,
            "call_1",
            "read",
            "ok",
            "success",
        )])
        .unwrap();

    let final_step_id = session.allocate_id();
    let final_attempt_id = session.allocate_id();
    let answer_id = session.allocate_id();
    session
        .append(vec![step_attempt(
            &session.allocate_id(),
            &operation_id,
            &final_step_id,
            &final_attempt_id,
            "assistant",
            1,
            &result_entry_id,
            &configuration,
        )])
        .unwrap();
    session
        .append(vec![
            assistant_message(
                &answer_id,
                &final_step_id,
                &final_attempt_id,
                "stop",
                &assistant(Some("done"), vec![]),
            ),
            usage_fact(
                &session.allocate_id(),
                &operation_id,
                Some(&final_attempt_id),
                None,
                USAGE,
            ),
        ])
        .unwrap();
    session
        .append(vec![operation_finished(
            &session.allocate_id(),
            &operation_id,
            "run",
            "completed",
            Some(&answer_id),
            None,
        )])
        .unwrap();

    let state = session.load().unwrap();
    assert!(matches!(state.operation, OperationState::Idle));
    let roles = state
        .transcript
        .iter()
        .map(|message| message["role"].as_str().unwrap_or_default())
        .collect::<Vec<_>>();
    assert_eq!(roles, ["user", "assistant", "tool", "assistant"]);
    session.close().unwrap();
}
