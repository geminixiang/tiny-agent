use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use crate::session_reducer::{SessionState, reduce_session};
use crate::{UsageJSON, model_name, uuid7, uuid7_at};

pub type SessionFact = Map<String, Value>;

static WRITERS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

fn writers() -> &'static Mutex<HashSet<PathBuf>> {
    WRITERS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn environment_identity(cwd: &Path) -> Result<String, String> {
    if let Ok(value) = std::env::var("TINY_AGENT_ENVIRONMENT_IDENTITY")
        && !value.trim().is_empty()
    {
        return Ok(value.trim().to_string());
    }
    fs::canonicalize(cwd)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConditionalAppend {
    Appended,
    Aborted,
    Inactive,
}

#[derive(Debug, Clone)]
pub struct CompactionSource {
    pub messages: Vec<(String, Value)>,
    pub compacted_entry_ids: Vec<String>,
    pub retained_entry_ids: Vec<String>,
}

#[derive(Clone)]
pub struct Session {
    pub id: String,
    pub path: PathBuf,
    inner: Arc<Mutex<StoreInner>>,
}

struct StoreInner {
    file: Option<File>,
    bytes: Vec<u8>,
    next_seq: u64,
    state: SessionState,
    closed: bool,
}

impl Session {
    pub fn create_new(cwd: &Path, model: &str) -> Result<Self, String> {
        Self::create_at(cwd, model, SystemTime::now())
    }

    pub fn create_at(cwd: &Path, model: &str, now: SystemTime) -> Result<Self, String> {
        let millis = now
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis() as u64;
        let id = uuid7_at(millis);
        let directory = cwd.join(".tiny-agent/sessions");
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let directory = fs::canonicalize(directory).map_err(|error| error.to_string())?;
        let stamp = timestamp_filename(millis);
        let path = directory.join(format!("{stamp}_{id}.jsonl"));
        let header = serde_json::json!({
            "kind": "header",
            "version": 2,
            "id": id,
            "createdAt": millis,
            "cwd": fs::canonicalize(cwd).map_err(|error| error.to_string())?,
            "provider": "openrouter",
            "model": model,
            "environmentIdentity": environment_identity(cwd)?,
        });
        let mut bytes = serde_json::to_vec(&header).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .map_err(|error| error.to_string())?;
        if let Err(error) = file.write_all(&bytes) {
            let _ = fs::remove_file(&path);
            return Err(error.to_string());
        }
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
        let state = reduce_session(&bytes).map_err(|error| error.to_string())?;
        writers().lock().unwrap().insert(path.clone());
        Ok(Self {
            id,
            path,
            inner: Arc::new(Mutex::new(StoreInner {
                file: Some(file),
                bytes,
                next_seq: 1,
                state,
                closed: false,
            })),
        })
    }

    pub fn open(id: &str, cwd: &Path) -> Result<Self, String> {
        if !valid_session_id(id) {
            return Err(format!("Invalid session ID: {id}"));
        }
        let directory = fs::canonicalize(cwd.join(".tiny-agent/sessions"))
            .map_err(|_| format!("Session not found: {id}"))?;
        let suffix = format!("_{id}.jsonl");
        let mut matches = fs::read_dir(&directory)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| {
                        entry
                            .file_type()
                            .is_ok_and(|kind| kind.is_file() && !kind.is_symlink())
                    })
                    .map(|entry| entry.path())
                    .filter(|path| {
                        path.file_name()
                            .is_some_and(|name| name.to_string_lossy().ends_with(&suffix))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if matches.len() != 1 {
            return Err(if matches.is_empty() {
                format!("Session not found: {id}")
            } else {
                format!("Duplicate session ID: {id}")
            });
        }
        let path = matches.remove(0);
        let canonical = fs::canonicalize(&path).map_err(|error| error.to_string())?;
        if canonical.parent() != Some(directory.as_path()) {
            return Err(format!("Unsafe session path: {id}"));
        }
        {
            let mut open = writers().lock().unwrap();
            if !open.insert(canonical.clone()) {
                return Err(format!("Session is already open for writing: {id}"));
            }
        }
        let result = (|| {
            let mut file = OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&canonical)
                .map_err(|error| error.to_string())?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            let state = reduce_session(&bytes).map_err(|error| error.to_string())?;
            if state.header.id != id {
                return Err("session filename does not match header".into());
            }
            if state.repaired_length != bytes.len() {
                file.set_len(state.repaired_length as u64)
                    .map_err(|error| error.to_string())?;
                bytes.truncate(state.repaired_length);
            }
            file.seek(SeekFrom::End(0))
                .map_err(|error| error.to_string())?;
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
            let next_seq = count_facts(&bytes)? + 1;
            Ok(Self {
                id: id.to_string(),
                path: canonical.clone(),
                inner: Arc::new(Mutex::new(StoreInner {
                    file: Some(file),
                    bytes,
                    next_seq,
                    state,
                    closed: false,
                })),
            })
        })();
        if result.is_err() {
            writers().lock().unwrap().remove(&canonical);
        }
        result
    }

    pub fn allocate_id(&self) -> String {
        uuid7()
    }

    pub fn append(&self, facts: Vec<SessionFact>) -> Result<Vec<SessionFact>, String> {
        let mut inner = self.inner.lock().unwrap();
        append_locked(&mut inner, facts)
    }

    pub fn append_unless_abort_requested(
        &self,
        facts: Vec<SessionFact>,
        aborted_facts: Vec<SessionFact>,
    ) -> Result<bool, String> {
        let mut inner = self.inner.lock().unwrap();
        let aborted = matches!(
            inner.state.operation,
            crate::session_reducer::OperationState::Run {
                abort_requested: true,
                ..
            } | crate::session_reducer::OperationState::Compaction {
                abort_requested: true,
                ..
            }
        );
        if aborted {
            if !aborted_facts.is_empty() {
                append_locked(&mut inner, aborted_facts)?;
            }
            return Ok(false);
        }
        append_locked(&mut inner, facts)?;
        Ok(true)
    }

    pub fn append_abort_if_active(
        &self,
        operation_id: &str,
        fact: SessionFact,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let should_append = match &inner.state.operation {
            crate::session_reducer::OperationState::Run {
                operation_id: active,
                abort_requested,
                ..
            }
            | crate::session_reducer::OperationState::Compaction {
                operation_id: active,
                abort_requested,
                ..
            } => active == operation_id && !abort_requested,
            crate::session_reducer::OperationState::Idle => false,
        };
        if should_append {
            append_locked(&mut inner, vec![fact])?;
        }
        Ok(())
    }

    pub fn admit_compaction_attempt(
        &self,
        operation_id: &str,
        attempt: SessionFact,
        aborted_finish: SessionFact,
    ) -> Result<ConditionalAppend, String> {
        let mut inner = self.inner.lock().unwrap();
        match &inner.state.operation {
            crate::session_reducer::OperationState::Compaction {
                operation_id: active,
                abort_requested: false,
                ..
            } if active == operation_id => {
                append_locked(&mut inner, vec![attempt])?;
                Ok(ConditionalAppend::Appended)
            }
            crate::session_reducer::OperationState::Compaction {
                operation_id: active,
                abort_requested: true,
                step: None,
                ..
            } if active == operation_id => {
                append_locked(&mut inner, vec![aborted_finish])?;
                Ok(ConditionalAppend::Aborted)
            }
            crate::session_reducer::OperationState::Compaction {
                operation_id: active,
                abort_requested: true,
                ..
            } if active == operation_id => Ok(ConditionalAppend::Aborted),
            _ => Ok(ConditionalAppend::Inactive),
        }
    }

    pub fn settle_compaction_attempt(
        &self,
        operation_id: &str,
        attempt_id: &str,
        completed_facts: Vec<SessionFact>,
        aborted_facts: Vec<SessionFact>,
    ) -> Result<ConditionalAppend, String> {
        let mut inner = self.inner.lock().unwrap();
        let Some((active_operation, abort_requested, active_attempt, attempting)) =
            (match &inner.state.operation {
                crate::session_reducer::OperationState::Compaction {
                    operation_id,
                    abort_requested,
                    step,
                    ..
                } => Some((
                    operation_id,
                    *abort_requested,
                    step.as_ref().map(|step| step.attempt_id.as_str()),
                    step.as_ref()
                        .is_some_and(|step| step.status == "attempting"),
                )),
                _ => None,
            })
        else {
            return Ok(ConditionalAppend::Inactive);
        };
        if active_operation != operation_id || active_attempt != Some(attempt_id) || !attempting {
            return Ok(ConditionalAppend::Inactive);
        }
        if abort_requested {
            append_locked(&mut inner, aborted_facts)?;
            return Ok(ConditionalAppend::Aborted);
        }
        append_locked(&mut inner, completed_facts)?;
        Ok(ConditionalAppend::Appended)
    }

    pub fn finish_compaction(
        &self,
        operation_id: &str,
        final_fact: SessionFact,
    ) -> Result<ConditionalAppend, String> {
        let mut inner = self.inner.lock().unwrap();
        let should_finish = matches!(
            &inner.state.operation,
            crate::session_reducer::OperationState::Compaction {
                operation_id: active,
                step: Some(step),
                ..
            } if active == operation_id && step.status == "settled"
        );
        if should_finish {
            append_locked(&mut inner, vec![final_fact])?;
            return Ok(ConditionalAppend::Appended);
        }
        Ok(ConditionalAppend::Inactive)
    }

    pub fn compaction_source(&self, operation_id: &str) -> Result<CompactionSource, String> {
        let inner = self.inner.lock().unwrap();
        if inner.closed {
            return Err("Session is closed".into());
        }
        let facts = parse_facts(&inner.bytes)?;
        let record = facts
            .iter()
            .rev()
            .filter_map(|fact| fact.get("record")?.as_object())
            .find(|record| {
                record.get("type").and_then(Value::as_str) == Some("compactionStarted")
                    && record.get("operationId").and_then(Value::as_str) == Some(operation_id)
            })
            .ok_or_else(|| "Compaction record missing".to_string())?;
        let input_id = record
            .get("inputThroughEntryId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Compaction input boundary missing".to_string())?;
        let ids = |name: &str| -> Result<Vec<String>, String> {
            record
                .get(name)
                .and_then(Value::as_array)
                .ok_or_else(|| format!("Compaction {name} missing"))?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .ok_or_else(|| format!("Compaction {name} is invalid"))
                })
                .collect()
        };
        let compacted_entry_ids = ids("compactedEntryIds")?;
        let retained_entry_ids = ids("retainedEntryIds")?;
        let input_id = input_id.to_string();
        let mut messages = Vec::new();
        for fact in facts {
            if fact.get("kind").and_then(Value::as_str) == Some("entry")
                && fact
                    .get("entry")
                    .and_then(Value::as_object)
                    .and_then(|entry| entry.get("type"))
                    .and_then(Value::as_str)
                    == Some("message")
            {
                messages.push((
                    fact.get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    fact.get("entry")
                        .and_then(Value::as_object)
                        .and_then(|entry| entry.get("message"))
                        .cloned()
                        .unwrap_or(Value::Null),
                ));
            }
            if fact.get("id").and_then(Value::as_str) == Some(&input_id) {
                break;
            }
        }
        Ok(CompactionSource {
            messages,
            compacted_entry_ids,
            retained_entry_ids,
        })
    }

    pub fn message_source(&self) -> Result<Vec<(String, Value)>, String> {
        let inner = self.inner.lock().unwrap();
        if inner.closed {
            return Err("Session is closed".into());
        }
        Ok(parse_facts(&inner.bytes)?
            .into_iter()
            .filter(|fact| {
                fact.get("kind").and_then(Value::as_str) == Some("entry")
                    && fact
                        .get("entry")
                        .and_then(Value::as_object)
                        .and_then(|entry| entry.get("type"))
                        .and_then(Value::as_str)
                        == Some("message")
            })
            .map(|fact| {
                (
                    fact.get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    fact.get("entry")
                        .and_then(Value::as_object)
                        .and_then(|entry| entry.get("message"))
                        .cloned()
                        .unwrap_or(Value::Null),
                )
            })
            .collect())
    }

    pub fn latest_assistant_usage(&self) -> Result<Option<UsageJSON>, String> {
        let inner = self.inner.lock().unwrap();
        if inner.closed {
            return Err("Session is closed".into());
        }
        let facts = parse_facts(&inner.bytes)?;
        let mut by_attempt = std::collections::HashMap::new();
        for fact in &facts {
            if fact.get("kind").and_then(Value::as_str) != Some("usage") {
                continue;
            }
            let (Some(attempt_id), Some(value)) = (
                fact.get("attemptId").and_then(Value::as_str),
                fact.get("usage"),
            ) else {
                continue;
            };
            if let Ok(usage) = serde_json::from_value::<UsageJSON>(value.clone()) {
                by_attempt.insert(attempt_id.to_string(), usage);
            }
        }
        for fact in facts.iter().rev() {
            let Some(entry) = fact.get("entry").and_then(Value::as_object) else {
                continue;
            };
            let role = entry
                .get("message")
                .and_then(Value::as_object)
                .and_then(|message| message.get("role"))
                .and_then(Value::as_str);
            if fact.get("kind").and_then(Value::as_str) != Some("entry")
                || entry.get("type").and_then(Value::as_str) != Some("message")
                || role != Some("assistant")
            {
                continue;
            }
            return Ok(entry
                .get("attemptId")
                .and_then(Value::as_str)
                .and_then(|attempt_id| by_attempt.get(attempt_id))
                .copied());
        }
        Ok(None)
    }

    pub fn load(&self) -> Result<SessionState, String> {
        let inner = self.inner.lock().unwrap();
        if inner.closed {
            return Err("Session is closed".into());
        }
        Ok(inner.state.clone())
    }

    pub fn close(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.closed {
            return Ok(());
        }
        if let Some(mut file) = inner.file.take() {
            file.flush().map_err(|error| error.to_string())?;
        }
        inner.closed = true;
        writers().lock().unwrap().remove(&self.path);
        Ok(())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if Arc::strong_count(&self.inner) == 1
            && let Ok(inner) = self.inner.lock()
            && !inner.closed
        {
            writers().lock().unwrap().remove(&self.path);
        }
    }
}

fn append_locked(
    inner: &mut StoreInner,
    facts: Vec<SessionFact>,
) -> Result<Vec<SessionFact>, String> {
    if facts.is_empty() {
        return Err("Session transaction must not be empty".into());
    }
    if inner.closed {
        return Err("Session is closed".into());
    }
    let timestamp = now_millis();
    let mut committed = Vec::with_capacity(facts.len());
    for (index, mut fact) in facts.into_iter().enumerate() {
        fact.entry("id").or_insert_with(|| Value::String(uuid7()));
        fact.insert("seq".into(), Value::from(inner.next_seq + index as u64));
        fact.entry("timestamp")
            .or_insert_with(|| Value::from(timestamp));
        committed.push(fact);
    }
    let value = if committed.len() == 1 {
        Value::Object(committed[0].clone())
    } else {
        Value::Array(committed.iter().cloned().map(Value::Object).collect())
    };
    let mut line = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    line.push(b'\n');
    let mut candidate = inner.bytes.clone();
    candidate.extend_from_slice(&line);
    let state = reduce_session(&candidate).map_err(|error| error.to_string())?;
    inner
        .file
        .as_mut()
        .unwrap()
        .write_all(&line)
        .map_err(|error| error.to_string())?;
    inner.bytes = candidate;
    inner.next_seq += committed.len() as u64;
    inner.state = state;
    Ok(committed)
}

fn parse_facts(bytes: &[u8]) -> Result<Vec<Map<String, Value>>, String> {
    let text = std::str::from_utf8(bytes).map_err(|error| error.to_string())?;
    let mut facts = Vec::new();
    for line in text.trim_end_matches('\n').lines().skip(1) {
        let value: Value = serde_json::from_str(line).map_err(|error| error.to_string())?;
        if let Some(transaction) = value.as_array() {
            for fact in transaction {
                facts.push(
                    fact.as_object()
                        .cloned()
                        .ok_or_else(|| "Session fact is not an object".to_string())?,
                );
            }
        } else {
            facts.push(
                value
                    .as_object()
                    .cloned()
                    .ok_or_else(|| "Session fact is not an object".to_string())?,
            );
        }
    }
    Ok(facts)
}

fn count_facts(bytes: &[u8]) -> Result<u64, String> {
    let text = std::str::from_utf8(bytes).map_err(|error| error.to_string())?;
    text.trim_end_matches('\n')
        .lines()
        .skip(1)
        .try_fold(0u64, |count, line| {
            let value: Value = serde_json::from_str(line).map_err(|error| error.to_string())?;
            Ok(count + value.as_array().map_or(1, |facts| facts.len() as u64))
        })
}

fn valid_session_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes[14] == b'7'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn timestamp_filename(millis: u64) -> String {
    let seconds = (millis / 1_000) as i64;
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}-{:02}-{:02}-{:03}Z",
        seconds.rem_euclid(86_400) / 3_600,
        seconds.rem_euclid(3_600) / 60,
        seconds.rem_euclid(60),
        millis % 1_000,
    )
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let doe = days.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

pub fn default_model() -> String {
    model_name()
}
