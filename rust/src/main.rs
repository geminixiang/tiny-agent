use std::sync::{Arc, Mutex};

use tiny_agent_rust::terminal::{TermError, Terminal};
use tiny_agent_rust::{
    Session, ToolEvent, format_tool_event, format_usage, load_project_instructions, load_skills,
    model_name, new_agent,
};

struct CliArgs {
    session_id: String,
    extras: Vec<String>,
    prompt: String,
}

fn parse_args(args: Vec<String>) -> Result<CliArgs, String> {
    let mut session_id = String::new();
    let mut extras = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--session" || args[i] == "--skill" {
            if i + 1 >= args.len() {
                return Err(format!("{} requires a value", args[i]));
            }
            if args[i] == "--session" {
                session_id = args[i + 1].clone();
            } else {
                extras.push(args[i + 1].clone());
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
        prompt: words.join(" "),
    })
}

fn show_tool(event: ToolEvent) {
    let color = if event.phase == "start" { "33" } else { "2" };
    println!("\x1b[{}m{}\x1b[0m", color, format_tool_event(event));
}

fn resume_line(id: &str) {
    println!("\nResume: tiny-rs --session {}", id);
}

fn term_err_to_string(e: TermError) -> String {
    match e {
        TermError::Error(s) => s,
        TermError::Exit | TermError::Eof => String::new(),
    }
}

fn run_cli(args: Vec<String>) -> Result<i32, String> {
    let parsed = parse_args(args)?;
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

    let agent = new_agent(skills, Some(session), instructions, &cwd);
    let agent = Arc::new(Mutex::new(agent));
    if is_restored {
        agent.lock().unwrap().resume_session()?;
    }
    agent.lock().unwrap().on_tool = Arc::new(show_tool);

    println!(
        "\x1b[36mtiny-agent\x1b[0m\nprovider: openrouter\nmodel: {}\nsession: {}\npath: {}{}",
        model_name(),
        session_id,
        session_path,
        if is_restored { "\nrestored: yes" } else { "" }
    );

    let mut term = Terminal::from_stdin(Box::new(std::io::stdout()));

    if !parsed.prompt.is_empty() {
        let cancel = { agent.lock().unwrap().cancel.clone() };
        let a3 = agent.clone();
        let prompt = parsed.prompt.clone();
        let result = term.run(&cancel, move || a3.lock().unwrap().run_agent_loop(&prompt));
        let answer = match result {
            Ok(a) => a,
            Err(TermError::Exit) | Err(TermError::Eof) => {
                resume_line(&session_id);
                return Ok(0);
            }
            Err(TermError::Error(e)) => return Err(e),
        };
        println!(
            "\n{}\n\x1b[2m{}\x1b[0m",
            answer,
            format_usage(agent.lock().unwrap().usage)
        );
        resume_line(&session_id);
        return Ok(0);
    }

    println!("Esc aborts the active operation; Ctrl+C exits.\n/compact  /skill:name  /exit");
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
        } else if input.starts_with("/skill:") {
            let rest = input[7..].to_string();
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
                println!("Unknown skill: {}", name);
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
        println!(
            "\x1b[36m{}\x1b[0m\n\x1b[2m{}\x1b[0m",
            answer,
            format_usage(usage)
        );
    }
    resume_line(&session_id);
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
