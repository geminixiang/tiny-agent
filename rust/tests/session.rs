use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{Value, json};
use tiny_agent_rust::session::{Session, SessionFact, environment_identity};
use tiny_agent_rust::session_recovery::{CurrentConfiguration, plan_recovery};
use tiny_agent_rust::session_reducer::reduce_session;

const USER_ID: &str = "018f0000-0000-7000-8000-000000000002";
const OPERATION_ID: &str = "018f0000-0000-7000-8000-000000000004";

fn workspace() -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("tiny-session-store-{}", tiny_agent_rust::uuid7()));
    fs::create_dir_all(&path).unwrap();
    path
}

fn fact(value: Value) -> SessionFact {
    value.as_object().unwrap().clone()
}

fn accepted_run() -> Vec<SessionFact> {
    vec![
        fact(json!({
            "kind":"entry","id":USER_ID,
            "entry":{"type":"message","message":{"role":"user","content":"inspect"}}
        })),
        fact(json!({
            "kind":"record",
            "record":{"type":"runStarted","operationId":OPERATION_ID,"operationKind":"run","inputEntryId":USER_ID}
        })),
    ]
}

#[test]
fn store_creates_exclusive_0600_file_and_closes_idempotently() {
    let root = workspace();
    let now = UNIX_EPOCH + Duration::from_millis(1_787_953_750_062);
    let store = Session::create_at(&root, "test/model", now).unwrap();
    let mode = fs::metadata(&store.path).unwrap().permissions();
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(mode.mode() & 0o777, 0o600);
    let error = match Session::open(&store.id, &root) {
        Ok(_) => panic!("second writer opened"),
        Err(error) => error,
    };
    assert!(error.contains("already open"));
    store.close().unwrap();
    store.close().unwrap();
    assert!(store.append(accepted_run()).unwrap_err().contains("closed"));
}

#[test]
fn store_rejects_identity_mismatch_and_symlink_and_repairs_permissions() {
    let root = workspace();
    let store = Session::create_new(&root, "test/model").unwrap();
    let id = store.id.clone();
    let path = store.path.clone();
    store.close().unwrap();
    let data = fs::read(&path).unwrap();
    let mut header: Value =
        serde_json::from_slice(data.split(|byte| *byte == b'\n').next().unwrap()).unwrap();
    header["id"] = json!(tiny_agent_rust::uuid7());
    fs::write(
        &path,
        format!("{}\n", serde_json::to_string(&header).unwrap()),
    )
    .unwrap();
    let error = match Session::open(&id, &root) {
        Ok(_) => panic!("mismatched header opened"),
        Err(error) => error,
    };
    assert!(error.contains("filename does not match header"));
    header["id"] = json!(id);
    fs::write(
        &path,
        format!("{}\n", serde_json::to_string(&header).unwrap()),
    )
    .unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
    let reopened = Session::open(&id, &root).unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    reopened.close().unwrap();

    let link_id = tiny_agent_rust::uuid7();
    let outside = root.join("outside.jsonl");
    fs::write(
        &outside,
        format!("{}\n", serde_json::to_string(&header).unwrap()),
    )
    .unwrap();
    symlink(
        &outside,
        root.join(".tiny-agent/sessions")
            .join(format!("only_{link_id}.jsonl")),
    )
    .unwrap();
    let error = match Session::open(&link_id, &root) {
        Ok(_) => panic!("symlink session opened"),
        Err(error) => error,
    };
    assert!(error.contains("Session not found"));
}

#[test]
fn store_validates_before_append_and_preserves_bytes() {
    let root = workspace();
    let store = Session::create_new(&root, "test/model").unwrap();
    let before = fs::read(&store.path).unwrap();
    assert!(
        store
            .append(vec![fact(
                json!({"kind":"record","record":{"type":"runStarted"}})
            )])
            .is_err()
    );
    assert_eq!(fs::read(&store.path).unwrap(), before);
    assert!(matches!(
        store.load().unwrap().operation,
        tiny_agent_rust::session_reducer::OperationState::Idle
    ));
    assert!(
        store
            .append(Vec::new())
            .unwrap_err()
            .contains("must not be empty")
    );
    let committed = store
        .append(vec![fact(json!({"kind":"entry","entry":{"type":"message","message":{"role":"user","content":"valid"}}}))])
        .unwrap();
    assert_eq!(committed[0]["seq"], json!(1));
    store.close().unwrap();
}

#[test]
fn store_repairs_torn_tail_before_append() {
    let root = workspace();
    let store = Session::create_new(&root, "test/model").unwrap();
    store.append(accepted_run()).unwrap();
    let id = store.id.clone();
    let path = store.path.clone();
    store.close().unwrap();
    OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"{\"kind\":\"record\"")
        .unwrap();
    let reopened = Session::open(&id, &root).unwrap();
    assert!(fs::read(&path).unwrap().ends_with(b"\n"));
    reopened
        .append(vec![fact(json!({
            "kind":"record",
            "record":{"type":"abortRequested","operationId":OPERATION_ID,"operationKind":"run","phase":"model","reason":"escape"}
        }))])
        .unwrap();
    reopened.close().unwrap();
}

#[test]
fn store_serializes_concurrent_candidate_validated_commits() {
    let root = workspace();
    let store = Arc::new(Session::create_new(&root, "test/model").unwrap());
    let mut threads = Vec::new();
    for index in 0..8 {
        let store = Arc::clone(&store);
        threads.push(thread::spawn(move || {
            store.append(vec![fact(json!({
                "kind":"entry",
                "entry":{"type":"message","message":{"role":"user","content":index.to_string()}}
            }))])
        }));
    }
    let mut sequences = threads
        .into_iter()
        .map(|thread| thread.join().unwrap().unwrap()[0]["seq"].as_u64().unwrap())
        .collect::<Vec<_>>();
    sequences.sort_unstable();
    assert_eq!(sequences, (1..=8).collect::<Vec<_>>());
    assert_eq!(store.load().unwrap().transcript.len(), 8);
    store.close().unwrap();
}

#[test]
fn environment_identity_prefers_override() {
    let root = workspace();
    unsafe { std::env::set_var("TINY_AGENT_ENVIRONMENT_IDENTITY", " job-123 ") };
    assert_eq!(environment_identity(&root).unwrap(), "job-123");
    unsafe { std::env::remove_var("TINY_AGENT_ENVIRONMENT_IDENTITY") };
    assert_eq!(
        environment_identity(&root).unwrap(),
        fs::canonicalize(&root).unwrap().to_string_lossy()
    );
}

#[derive(Deserialize)]
struct Manifest {
    fixtures: Vec<PlannerFixture>,
}

#[derive(Deserialize)]
struct PlannerFixture {
    name: String,
    input: String,
    expected: String,
}

#[test]
fn matches_all_shared_recovery_planner_fixtures() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../schemas/session");
    let planner = root.join("planner-fixtures");
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(planner.join("manifest.json")).unwrap()).unwrap();
    for fixture in manifest.fixtures {
        let input: Value =
            serde_json::from_slice(&fs::read(planner.join(&fixture.input)).unwrap()).unwrap();
        let bytes = fs::read(
            root.join("fixtures")
                .join(input["sessionFile"].as_str().unwrap()),
        )
        .unwrap();
        let state = reduce_session(&bytes).unwrap();
        let current: CurrentConfiguration =
            serde_json::from_value(input["current"].clone()).unwrap();
        let expected: Value =
            serde_json::from_slice(&fs::read(planner.join(&fixture.expected)).unwrap()).unwrap();
        assert_eq!(
            plan_recovery(&state, &current),
            expected,
            "fixture {}",
            fixture.name
        );
    }
}
