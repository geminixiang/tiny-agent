use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn json_mode_emits_one_shot_lifecycle_without_tui_output() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let cwd = std::env::temp_dir().join(format!("tiny-rs-json-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&cwd).unwrap();
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
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["type"], "run.started");
    assert_eq!(events[1]["type"], "run.completed");
    assert_eq!(events[1]["result"]["status"], "failed");
    assert_eq!(events[1]["result"]["cause"], "agent_error");
}
