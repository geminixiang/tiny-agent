use std::sync::{Arc, Mutex};

use tiny_agent_rust::mcp::{LoadedMcp, display_tool_name, load_mcp_configs, load_mcp_tools};
use tiny_agent_rust::terminal::{TermError, Terminal};
use tiny_agent_rust::{
    Session, format_tool_event, format_usage, load_project_instructions, load_skills, model_name,
    new_agent,
};

struct CliArgs {
    session_id: String,
    extras: Vec<String>,
    mcp: Vec<String>,
    prompt: String,
}

fn parse_args(args: Vec<String>) -> Result<CliArgs, String> {
    let mut session_id = String::new();
    let mut extras = Vec::new();
    let mut mcp = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--session" || args[i] == "--skill" || args[i] == "--mcp" {
            if i + 1 >= args.len() {
                return Err(format!("{} requires a value", args[i]));
            }
            if args[i] == "--session" {
                session_id = args[i + 1].clone();
            } else if args[i] == "--skill" {
                extras.push(args[i + 1].clone());
            } else {
                for alias in args[i + 1]
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if !mcp.iter().any(|existing| existing == alias) {
                        mcp.push(alias.to_string());
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
        extras,
        mcp,
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

struct ActiveMcp(Vec<LoadedMcp>);

impl Drop for ActiveMcp {
    fn drop(&mut self) {
        for loaded in self.0.iter().rev() {
            loaded.close();
        }
    }
}

fn run_cli(args: Vec<String>) -> Result<i32, String> {
    let parsed = parse_args(args)?;
    let configs = load_mcp_configs(&parsed.mcp)?;
    let mut loaded_mcp = ActiveMcp(Vec::new());
    for config in configs {
        let alias = config.alias.clone();
        let loaded =
            load_mcp_tools(config).map_err(|error| format!("MCP {alias} failed: {error}"))?;
        loaded_mcp.0.push(loaded);
    }
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let cwd = cwd.to_string_lossy().to_string();
    let skills = load_skills(parsed.extras.clone(), &cwd)?;
    let instructions = load_project_instructions(&cwd);

    let session = if parsed.session_id.is_empty() {
        Session::create(&cwd)?
    } else {
        Session::open(&parsed.session_id, &cwd)?
    };
    let session_id = session.id.clone();
    let session_path = session.path.clone();
    let is_restored = !parsed.session_id.is_empty();

    let mut agent = new_agent(skills, Some(session), instructions, &cwd);
    agent.mcp_tools = loaded_mcp
        .0
        .iter()
        .flat_map(|loaded| loaded.tools.clone())
        .collect();
    let agent = Arc::new(Mutex::new(agent));
    if is_restored {
        agent.lock().unwrap().resume_session()?;
    }

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

    let tool_names = {
        let agent = agent.lock().unwrap();
        let mut names = vec![
            "bash".to_string(),
            "read".to_string(),
            "write".to_string(),
            "edit".to_string(),
        ];
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
        "\x1b[36mtiny-agent\x1b[0m\nprovider: openrouter\nmodel: {}\nsession: {}\npath: {}\ntools: {}\nmcp: {}{}\n",
        model_name(),
        session_id,
        session_path,
        tool_names,
        if parsed.mcp.is_empty() { "(none)".to_string() } else { parsed.mcp.join(", ") },
        if is_restored { "\nrestored: yes" } else { "" }
    ));

    if !parsed.prompt.is_empty() {
        let cancel = { agent.lock().unwrap().cancel.clone() };
        let a3 = agent.clone();
        let prompt = parsed.prompt.clone();
        let result = term.run(&cancel, move || a3.lock().unwrap().run_agent_loop(&prompt));
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
        let answer: Result<String, String> = if input == "/compact" {
            let a3 = agent.clone();
            term.run(&cancel, move || a3.lock().unwrap().compact())
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
            term.run(&cancel, move || a3.lock().unwrap().run_agent_loop(&prompt))
                .map_err(term_err_to_string)
        } else {
            let a3 = agent.clone();
            term.run(&cancel, move || a3.lock().unwrap().run_agent_loop(&input))
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
