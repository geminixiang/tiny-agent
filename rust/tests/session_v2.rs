use std::fs;
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{Value, json};
use tiny_agent_rust::session_v2::reduce_session_v2;

#[derive(Deserialize)]
struct Manifest {
    fixtures: Vec<Fixture>,
}

#[derive(Deserialize)]
struct Fixture {
    name: String,
    file: String,
    expected: String,
}

#[test]
fn reduces_all_session_v2_golden_fixtures() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../schemas/session-v2/fixtures");
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(root.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest.fixtures.len(), 24);

    for fixture in manifest.fixtures {
        let bytes = fs::read(root.join(&fixture.file)).unwrap();
        let expected: Value =
            serde_json::from_slice(&fs::read(root.join(&fixture.expected)).unwrap()).unwrap();
        let actual = match reduce_session_v2(&bytes) {
            Ok(state) => json!({ "ok": true, "state": state }),
            Err(error) => {
                let mut value = json!({ "code": error.code.as_str(), "line": error.line });
                if let Some(seq) = error.seq {
                    value["seq"] = json!(seq);
                }
                json!({ "ok": false, "error": value })
            }
        };
        assert_eq!(actual, expected, "fixture {}", fixture.name);
    }
}
