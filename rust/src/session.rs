use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use crate::session_reducer::{SessionState, reduce_session};
use crate::{model_name, uuid7, uuid7_at};

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

pub struct SessionStore {
    pub id: String,
    pub path: PathBuf,
    inner: Mutex<StoreInner>,
}

struct StoreInner {
    file: Option<File>,
    bytes: Vec<u8>,
    next_seq: u64,
    state: SessionState,
    closed: bool,
}

impl SessionStore {
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
            inner: Mutex::new(StoreInner {
                file: Some(file),
                bytes,
                next_seq: 1,
                state,
                closed: false,
            }),
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
                inner: Mutex::new(StoreInner {
                    file: Some(file),
                    bytes,
                    next_seq,
                    state,
                    closed: false,
                }),
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
        if facts.is_empty() {
            return Err("Session transaction must not be empty".into());
        }
        let mut inner = self.inner.lock().unwrap();
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

impl Drop for SessionStore {
    fn drop(&mut self) {
        if let Ok(inner) = self.inner.get_mut()
            && !inner.closed
        {
            writers().lock().unwrap().remove(&self.path);
        }
    }
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
