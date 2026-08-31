use std::sync::{Arc, Mutex};
use std::time::Instant;

use tiny_agent_rust::mcp::{LoadedMcp, display_tool_name, load_mcp_configs, load_mcp_tools};
use tiny_agent_rust::terminal::{TermError, Terminal};
use tiny_agent_rust::{
    Session, close_background_processes, endpoint, format_tool_event, format_usage,
    load_project_instructions, load_skills, local_tool_names, model_name, new_agent, timestamp,
};

struct CliArgs {
    session_id: String,
    cwd: String,
    extras: Vec<String>,
    mcp: Vec<String>,
    plugins: Vec<String>,
    json: bool,
    prompt: String,
}

fn parse_args(args: Vec<String>) -> Result<CliArgs, String> {
    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut extras = Vec::new();
    let mut mcp = Vec::new();
    let mut plugins: Option<Vec<String>> = None;
    let mut json = false;
    let mut words: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--json" {
            json = true;
            i += 1;
        } else if args[i] == "--session"
            || args[i] == "--cwd"
            || args[i] == "--skill"
            || args[i] == "--mcp"
            || args[i] == "--plugin"
        {
            if i + 1 >= args.len() {
                return Err(format!("{} requires a value", args[i]));
            }
            if args[i] == "--session" {
                session_id = args[i + 1].clone();
            } else if args[i] == "--cwd" {
                cwd = args[i + 1].clone();
            } else if args[i] == "--skill" {
                extras.push(args[i + 1].clone());
            } else if args[i] == "--mcp" {
                for alias in args[i + 1]
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if !mcp.iter().any(|existing| existing == alias) {
                        mcp.push(alias.to_string());
                    }
                }
            } else {
                let selected = plugins.get_or_insert_with(Vec::new);
                for plugin in args[i + 1]
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if !local_tool_names().contains(&plugin) {
                        return Err(format!(
                            "Unknown plugin: {plugin}. Available plugins: {}",
                            local_tool_names().join(", ")
                        ));
                    }
                    if !selected.iter().any(|existing| existing == plugin) {
                        selected.push(plugin.to_string());
                    }
                }
            }
            i += 2;
        } else {
            words.push(args[i].clone());
            i += 1;
        }
    }
    Ok(CliArgs {
        session_id,
        cwd,
        extras,
        mcp,
        plugins: plugins
            .filter(|selected| !selected.is_empty())
            .unwrap_or_else(|| {
                local_tool_names()
                    .iter()
                    .map(|name| (*name).to_string())
                    .collect()
            }),
        json,
        prompt: words.join(" "),
    })
}

fn resume_line(out: &tiny_agent_rust::terminal::Output, id: &str) {
    out.print(&format!("\nResume: tiny-rs --session {}\n", id));
}

fn term_err_to_string(e: TermError) -> String {
    match e {
        TermError::Error(s) => s,
        TermError::Exit | TermError::Eof => String::new(),
    }
}

fn emit_json(event: serde_json::Value) {
    println!("{}", serde_json::to_string(&event).unwrap());
}

fn usage_json(usage: tiny_agent_rust::UsageState) -> serde_json::Value {
    serde_json::json!({
        "input":usage.input, "output":usage.output,
        "cacheRead":usage.cache_read, "cacheWrite":usage.cache_write,
    })
}

fn mcp_failure_cause(error: &str) -> &'static str {
    if error.to_ascii_lowercase().contains("timeout") {
        return "timeout";
    }
    "connection_failed"
}

struct ActiveMcp(Vec<LoadedMcp>);

impl Drop for ActiveMcp {
    fn drop(&mut self) {
        for loaded in self.0.iter().rev() {
            loaded.close();
        }
    }
}

struct ActiveBg {
    cwd: String,
}

impl Drop for ActiveBg {
    fn drop(&mut self) {
        close_background_processes(&self.cwd);
    }
}

fn run_json_cli(parsed: CliArgs) -> Result<i32, String> {
    if parsed.prompt.is_empty() {
        return Err("--json requires a one-shot prompt.".into());
    }
    let configs = load_mcp_configs(&parsed.mcp)?;
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let cwd = cwd.to_string_lossy().to_string();
    let _active_bg = ActiveBg { cwd: cwd.clone() };
    let session = if parsed.session_id.is_empty() {
        Session::create_new(std::path::Path::new(&cwd), &model_name())?
    } else {
        Session::open(&parsed.session_id, std::path::Path::new(&cwd))?
    };
    let session_id = session.id.clone();
    let started = Instant::now();
    emit_json(serde_json::json!({
        "type":"run.started", "timestamp":timestamp(), "sessionId":session_id,
        "model":model_name(), "endpoint":endpoint(), "plugins":parsed.plugins, "mcp":parsed.mcp,
    }));

    let mut loaded_mcp = ActiveMcp(Vec::new());
    for config in configs {
        let alias = config.alias().to_string();
        let connection_started = Instant::now();
        match load_mcp_tools(config) {
            Ok(loaded) => {
                emit_json(serde_json::json!({
                    "type":"mcp.connected", "timestamp":timestamp(), "server":alias,
                    "protocolVersion":loaded.protocol_version, "toolCount":loaded.tools.len(),
                    "durationMs":connection_started.elapsed().as_secs_f64() * 1000.0,
                }));
                loaded_mcp.0.push(loaded);
            }
            Err(error) => {
                let cause = mcp_failure_cause(&error);
                emit_json(serde_json::json!({
                    "type":"mcp.failed", "timestamp":timestamp(), "server":alias,
                    "stage":"connect", "cause":cause,
                }));
                emit_json(serde_json::json!({
                    "type":"run.completed", "timestamp":timestamp(),
                    "durationMs":started.elapsed().as_secs_f64() * 1000.0,
                    "result":{
                        "status":"failed", "cause":"mcp_setup_error",
                        "message":format!("MCP {alias} failed: {cause}"), "sessionId":session_id,
                        "usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},
                    },
                }));
                return Ok(1);
            }
        }
    }

    let skills = load_skills(parsed.extras, &cwd)?;
    let instructions = load_project_instructions(&cwd);
    let mut agent = new_agent(skills, Some(session), instructions, &cwd);
    agent.local_tools = parsed.plugins;
    agent.mcp_tools = loaded_mcp
        .0
        .iter()
        .flat_map(|loaded| loaded.tools.clone())
        .collect();
    agent.on_event = Arc::new(emit_json);
    let outcome = (|| {
        if !parsed.session_id.is_empty() {
            agent.resume_session()?;
        }
        agent.run_agent_loop(&parsed.prompt)
    })();
    let usage = usage_json(agent.usage);
    let result = match outcome {
        Ok(answer) => serde_json::json!({
            "status":if answer == "Operation aborted." { "cancelled" } else { "succeeded" },
            "answer":answer, "sessionId":session_id, "usage":usage,
        }),
        Err(error) => serde_json::json!({
            "status":"failed", "cause":"agent_error", "message":error,
            "sessionId":session_id, "usage":usage,
        }),
    };
    let failed = result["status"] == "failed";
    emit_json(serde_json::json!({
        "type":"run.completed", "timestamp":timestamp(),
        "durationMs":started.elapsed().as_secs_f64() * 1000.0, "result":result,
    }));
    Ok(if failed { 1 } else { 0 })
}

fn run_cli(args: Vec<String>) -> Result<i32, String> {
    let parsed = parse_args(args)?;
    if !parsed.cwd.is_empty() {
        let path = std::path::Path::new(&parsed.cwd);
        if !path.is_dir() {
            return Err(format!("--cwd must be a directory: {}", parsed.cwd));
        }
        std::env::set_current_dir(path).map_err(|error| error.to_string())?;
    }
    if parsed.json {
        return run_json_cli(parsed);
    }
    let configs = load_mcp_configs(&parsed.mcp)?;
    let mut loaded_mcp = ActiveMcp(Vec::new());
    for config in configs {
        let alias = config.alias().to_string();
        let loaded =
            load_mcp_tools(config).map_err(|error| format!("MCP {alias} failed: {error}"))?;
        loaded_mcp.0.push(loaded);
    }
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let cwd = cwd.to_string_lossy().to_string();
    let _active_bg = ActiveBg { cwd: cwd.clone() };
    let skills = load_skills(parsed.extras.clone(), &cwd)?;
    let instructions = load_project_instructions(&cwd);

    let session = if parsed.session_id.is_empty() {
        Session::create_new(std::path::Path::new(&cwd), &model_name())?
    } else {
        Session::open(&parsed.session_id, std::path::Path::new(&cwd))?
    };
    let session_id = session.id.clone();
    let session_path = session.path.to_string_lossy().into_owned();
    let is_restored = !parsed.session_id.is_empty();

    let mut agent = new_agent(skills, Some(session), instructions, &cwd);
    agent.local_tools = parsed.plugins.clone();
    agent.mcp_tools = loaded_mcp
        .0
        .iter()
        .flat_map(|loaded| loaded.tools.clone())
        .collect();
    let agent = Arc::new(Mutex::new(agent));
    let mut term = Terminal::from_stdin(Box::new(std::io::stdout()));
    let out = term.output();
    let tool_out = out.clone();
    agent.lock().unwrap().on_tool = Arc::new(move |event| {
        let color = if event.phase == "start" { "33" } else { "2" };
        tool_out.print(&format!(
            "\x1b[{}m{}\x1b[0m\n",
            color,
            format_tool_event(tiny_agent_rust::ToolEvent {
                name: display_tool_name(&event.name),
                ..event
            })
        ));
    });
    if is_restored {
        agent.lock().unwrap().resume_session()?;
    }

    let tool_names = {
        let agent = agent.lock().unwrap();
        let mut names = agent.local_tools.clone();
        names.extend(agent.mcp_tools.iter().map(|tool| tool.display_name.clone()));
        names.join(", ")
    };
    for loaded in &loaded_mcp.0 {
        out.print(&format!(
            "MCP {}: connected ({}, {} tools)\n",
            loaded.alias,
            loaded.protocol_version,
            loaded.tools.len()
        ));
    }
    out.print(&format!(
        "\x1b[36mtiny-agent\x1b[0m\nprovider: openrouter\nendpoint: {}\nmodel: {}\nsession: {}\npath: {}\ntools: {}\nmcp: {}{}\n",
        endpoint(),
        model_name(),
        session_id,
        session_path,
        tool_names,
        if parsed.mcp.is_empty() { "(none)".to_string() } else { parsed.mcp.join(", ") },
        if is_restored { "\nrestored: yes" } else { "" }
    ));

    if !parsed.prompt.is_empty() {
        let cancel = { agent.lock().unwrap().cancel.clone() };
        let abort = { agent.lock().unwrap().abort_handle() };
        let a3 = agent.clone();
        let prompt = parsed.prompt.clone();
        let result = term.run(
            &cancel,
            move || abort.request(),
            move || a3.lock().unwrap().run_agent_loop(&prompt),
        );
        let answer = match result {
            Ok(a) => a,
            Err(TermError::Exit) | Err(TermError::Eof) => {
                resume_line(&out, &session_id);
                return Ok(0);
            }
            Err(TermError::Error(e)) => return Err(e),
        };
        out.print(&format!(
            "\n{}\n\x1b[2m{}\x1b[0m\n",
            answer,
            format_usage(agent.lock().unwrap().usage)
        ));
        resume_line(&out, &session_id);
        return Ok(0);
    }

    out.print("Esc aborts the active operation; Ctrl+C exits.\n/compact  /skill:name  /exit\n");
    loop {
        let input = match term.read_line("\x1b[32m›\x1b[0m ") {
            Ok(line) => line,
            Err(TermError::Exit) | Err(TermError::Eof) => break,
            Err(TermError::Error(e)) => return Err(e),
        };
        if input.is_empty() {
            continue;
        }
        if input == "/exit" {
            break;
        }
        let cancel = { agent.lock().unwrap().cancel.clone() };
        let abort = { agent.lock().unwrap().abort_handle() };
        let answer: Result<String, String> = if input == "/compact" {
            let a3 = agent.clone();
            term.run(
                &cancel,
                move || abort.request(),
                move || a3.lock().unwrap().compact(),
            )
            .map_err(term_err_to_string)
        } else if let Some(rest) = input.strip_prefix("/skill:") {
            let rest = rest.to_string();
            let mut parts = rest.splitn(2, ' ');
            let name = parts.next().unwrap_or("").to_string();
            let request = parts.next().unwrap_or("").to_string();
            let skill = agent
                .lock()
                .unwrap()
                .skills
                .iter()
                .find(|s| s.name == name)
                .cloned();
            let Some(skill) = skill else {
                out.print(&format!("Unknown skill: {}\n", name));
                continue;
            };
            let text = std::fs::read_to_string(&skill.path).map_err(|e| e.to_string())?;
            let prompt = format!("{}\n\nUser: {}", text, request);
            let a3 = agent.clone();
            let abort = agent.lock().unwrap().abort_handle();
            term.run(
                &cancel,
                move || abort.request(),
                move || a3.lock().unwrap().run_agent_loop(&prompt),
            )
            .map_err(term_err_to_string)
        } else {
            let a3 = agent.clone();
            let abort = agent.lock().unwrap().abort_handle();
            term.run(
                &cancel,
                move || abort.request(),
                move || a3.lock().unwrap().run_agent_loop(&input),
            )
            .map_err(term_err_to_string)
        };
        let answer = answer?;
        let usage = agent.lock().unwrap().usage;
        out.print(&format!(
            "\x1b[36m{}\x1b[0m\n\x1b[2m{}\x1b[0m\n",
            answer,
            format_usage(usage)
        ));
    }
    resume_line(&out, &session_id);
    Ok(0)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run_cli(args) {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            if !e.is_empty() {
                eprintln!("{}", e);
            }
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugins_repeat_split_trim_and_stable_dedupe() {
        let parsed = parse_args(vec![
            "--cwd".into(),
            "/tmp/project".into(),
            "--plugin".into(),
            " read, bash ".into(),
            "--plugin".into(),
            "read,edit".into(),
        ])
        .unwrap();
        assert_eq!(parsed.cwd, "/tmp/project");
        assert_eq!(parsed.plugins, ["read", "bash", "edit"]);
    }

    #[test]
    fn plugins_default_all_and_reject_unknown() {
        assert_eq!(
            parse_args(Vec::new()).unwrap().plugins,
            ["bash", "read", "write", "edit", "bg"]
        );
        assert_eq!(
            parse_args(vec!["--plugin".into(), ",  ,".into()])
                .unwrap()
                .plugins,
            ["bash", "read", "write", "edit", "bg"]
        );
        assert_eq!(
            parse_args(vec!["--plugin".into(), "read,remote".into()])
                .err()
                .unwrap(),
            "Unknown plugin: remote. Available plugins: bash, read, write, edit, bg"
        );
    }
}
