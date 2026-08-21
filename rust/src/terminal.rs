//! Terminal handling for tiny-rs: raw mode, ANSI-aware line editing, and
//! Esc/Ctrl+C cancellation. Mirrors the Python and Go CLIs.

use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use unicode_width::UnicodeWidthChar;

#[derive(Debug)]
pub enum TermError {
    Exit,
    Eof,
    Error(String),
}

const ARROW_TIMEOUT: Duration = Duration::from_millis(20);

/// Display width in terminal cells: combining/format characters count 0 and
/// fullwidth (CJK) characters count 2, matching `x/term` and Node readline's
/// cell accounting. `None` (control char) is treated as 1.
fn char_width(c: char) -> usize {
    match c.width_cjk() {
        Some(w) => w,
        None => 1,
    }
}

/// Compute the (row, column) at which the cursor lands, given the visible runes
/// of the prompt plus a prefix of the line, assuming wrapping at `columns`.
fn display_position(runes: &[char], columns: usize) -> (usize, usize) {
    let mut offset = 0usize;
    for (i, c) in runes.iter().enumerate() {
        let _ = i;
        let width = char_width(*c);
        if width == 2 && offset % columns == columns - 1 {
            offset += 1;
        }
        offset += width;
    }
    (offset / columns, offset % columns)
}

/// Reposition and repaint the prompt + line at `old_row`, returning the new row.
pub fn redraw<W: Write>(
    out: &mut W,
    prompt: &str,
    prompt_visible: &[char],
    line: &[char],
    cursor: usize,
    old_row: usize,
    columns: usize,
) -> usize {
    if old_row > 0 {
        write!(out, "\x1b[{}A", old_row).unwrap();
    }
    let text: String = line.iter().collect();
    write!(out, "\r\x1b[J{}{}", prompt, text).unwrap();
    let mut all_visible: Vec<char> = prompt_visible.to_vec();
    all_visible.extend(line.iter().copied());
    let (end_row, end_col) = display_position(&all_visible, columns);
    let mut prefix_visible: Vec<char> = prompt_visible.to_vec();
    prefix_visible.extend(line[..cursor].iter().copied());
    let (target_row, target_col) = display_position(&prefix_visible, columns);
    if end_col == 0 {
        write!(out, " ").unwrap();
    }
    if end_row > target_row {
        write!(out, "\x1b[{}A", end_row - target_row).unwrap();
    }
    write!(out, "\r").unwrap();
    if target_col > 0 {
        write!(out, "\x1b[{}C", target_col).unwrap();
    }
    let _ = out.flush();
    target_row
}

pub struct Terminal {
    pub keys: mpsc::Receiver<u8>,
    pub out: Box<dyn Write>,
    fd: i32,
    raw: Option<libc::termios>,
    tty: bool,
    reader: Option<thread::JoinHandle<()>>,
}

impl Terminal {
    /// Interactive terminal bound to real stdin (fd 0). Enters raw mode and
    /// starts a background reader that forwards bytes to the key channel.
    pub fn from_stdin(out: Box<dyn Write>) -> Terminal {
        let fd = 0;
        let tty = unsafe { libc::isatty(fd) != 0 };
        let (tx, rx) = mpsc::channel::<u8>();
        let raw = if tty { make_raw(fd) } else { None };
        let reader = if tty {
            Some(thread::spawn(move || {
                loop {
                    let mut b = [0u8; 1];
                    let n = unsafe { libc::read(fd, b.as_mut_ptr().cast(), 1) };
                    if n <= 0 {
                        break;
                    }
                    if tx.send(b[0]).is_err() {
                        break;
                    }
                }
            }))
        } else {
            None
        };
        Terminal {
            keys: rx,
            out,
            fd,
            raw,
            tty,
            reader,
        }
    }

    /// Testable terminal with an injected key channel and no actual raw mode.
    pub fn from_keys(keys: mpsc::Receiver<u8>, out: Box<dyn Write>, tty: bool) -> Terminal {
        Terminal {
            keys,
            out,
            fd: 0,
            raw: if tty { make_raw(0) } else { None },
            tty,
            reader: None,
        }
    }

    pub fn restore(&mut self) {
        if let Some(original) = self.raw.take() {
            unsafe {
                libc::tcsetattr(self.fd, libc::TCSANOW, &original);
            }
        }
    }

    fn next_key(&self) -> Option<u8> {
        self.keys.recv_timeout(Duration::from_millis(50)).ok()
    }

    /// After reading an initial ESC byte, collect the rest of an ANSI sequence.
    /// Returns `(final_byte, is_arrow)` where a standalone Esc yields false.
    fn escape_sequence(&self) -> (Option<u8>, bool) {
        match self.keys.recv_timeout(ARROW_TIMEOUT) {
            Err(_) => (None, false),
            Ok(b'[') | Ok(b'O') => {
                let mut last = 0u8;
                loop {
                    match self.keys.recv_timeout(ARROW_TIMEOUT) {
                        Ok(b) => {
                            if (64..=126).contains(&b) {
                                return (Some(b), true);
                            }
                            last = b;
                        }
                        Err(_) => return (Some(last), true),
                    }
                }
            }
            Ok(b) => (Some(b), false),
        }
    }

    /// Edit a single line in raw mode. Returns Err(TermError::Exit) on Ctrl+C.
    pub fn read_line(&mut self, prompt: &str) -> Result<String, TermError> {
        let prompt_visible: Vec<char> = strip_ansi(prompt);
        write!(self.out, "{}", prompt).unwrap();
        self.out.flush().unwrap();
        let mut line: Vec<char> = Vec::new();
        let mut cursor = 0usize;
        let mut row = 0usize;
        let columns = terminal_width(self.fd);
        let mut pending: Vec<u8> = Vec::new();
        loop {
            let Some(key) = self.next_key() else { continue };
            if key == 3 {
                return Err(TermError::Exit);
            }
            if key == 0x1b {
                let (arrow, is_arrow) = self.escape_sequence();
                if is_arrow {
                    if arrow == Some(b'D') && cursor > 0 {
                        cursor -= 1;
                        while cursor > 0 && char_width(line[cursor]) == 0 {
                            cursor -= 1;
                        }
                        row = redraw(
                            &mut self.out,
                            prompt,
                            &prompt_visible,
                            &line,
                            cursor,
                            row,
                            columns,
                        );
                    } else if arrow == Some(b'C') && cursor < line.len() {
                        cursor += 1;
                        while cursor < line.len() && char_width(line[cursor]) == 0 {
                            cursor += 1;
                        }
                        row = redraw(
                            &mut self.out,
                            prompt,
                            &prompt_visible,
                            &line,
                            cursor,
                            row,
                            columns,
                        );
                    }
                }
                continue;
            }
            if key == b'\r' || key == b'\n' {
                write!(self.out, "\r\n").unwrap();
                self.out.flush().unwrap();
                return Ok(line.into_iter().collect::<String>().trim().to_string());
            }
            if key == 0x7f || key == 0x08 {
                if cursor > 0 {
                    let mut start = cursor - 1;
                    while start > 0 && char_width(line[start]) == 0 {
                        start -= 1;
                    }
                    line.drain(start..cursor);
                    cursor = start;
                    row = redraw(
                        &mut self.out,
                        prompt,
                        &prompt_visible,
                        &line,
                        cursor,
                        row,
                        columns,
                    );
                }
                continue;
            }
            if key < 0x20 {
                continue;
            }
            pending.push(key);
            if let Ok(decoded) = std::str::from_utf8(&pending) {
                let ch = decoded.chars().next().unwrap();
                line.insert(cursor, ch);
                cursor += 1;
                pending.clear();
                row = redraw(
                    &mut self.out,
                    prompt,
                    &prompt_visible,
                    &line,
                    cursor,
                    row,
                    columns,
                );
            }
        }
    }

    /// Run an operation, giving Esc/Ctrl+C a chance to cancel it on the main
    /// thread while the operation runs on a worker thread.
    pub fn run<F>(&mut self, cancel: &Arc<AtomicBool>, operation: F) -> Result<String, TermError>
    where
        F: FnOnce() -> Result<String, String> + Send + 'static,
    {
        if !self.tty {
            return operation().map_err(TermError::Error);
        }
        let (tx, rx) = mpsc::channel::<Result<String, String>>();
        thread::spawn(move || {
            let _ = tx.send(operation());
        });
        loop {
            if let Ok(result) = rx.try_recv() {
                return result.map_err(TermError::Error);
            }
            let Some(key) = self.next_key() else { continue };
            if key == 0x1b {
                let (_, is_arrow) = self.escape_sequence();
                if !is_arrow {
                    write!(self.out, "\r\n\x1b[33mAborting...\x1b[0m\r\n").unwrap();
                    self.out.flush().unwrap();
                    cancel.store(true, Ordering::SeqCst);
                }
            } else if key == 3 {
                cancel.store(true, Ordering::SeqCst);
                loop {
                    if rx.try_recv().is_ok() {
                        break;
                    }
                    thread::sleep(Duration::from_millis(20));
                }
                return Err(TermError::Exit);
            }
        }
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.restore();
        if let Some(thread) = self.reader.take() {
            let _ = thread.join();
        }
    }
}

fn strip_ansi(s: &str) -> Vec<char> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let n = chars.len();
    let mut i = 0;
    while i < n {
        if chars[i] == '\u{1b}' && i + 1 < n && chars[i + 1] == '[' {
            i += 2;
            while i < n && !(64..=126).contains(&(chars[i] as u32)) {
                i += 1;
            }
            i += 1;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

fn make_raw(fd: i32) -> Option<libc::termios> {
    unsafe {
        let mut original: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(fd, &mut original) != 0 {
            return None;
        }
        let mut raw = original;
        raw.c_iflag &= !(libc::BRKINT | libc::ICRNL | libc::INPCK | libc::ISTRIP | libc::IXON);
        raw.c_oflag &= !libc::OPOST;
        raw.c_cflag |= libc::CS8;
        raw.c_lflag &= !(libc::ECHO | libc::ICANON | libc::IEXTEN | libc::ISIG);
        raw.c_cc[libc::VMIN] = 1;
        raw.c_cc[libc::VTIME] = 0;
        if libc::tcsetattr(fd, libc::TCSANOW, &raw) == 0 {
            Some(original)
        } else {
            None
        }
    }
}

fn terminal_width(fd: i32) -> usize {
    unsafe {
        let mut ws: libc::winsize = std::mem::zeroed();
        if libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_col > 0 {
            ws.ws_col as usize
        } else {
            80
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    use std::sync::mpsc;

    fn keys_from(bytes: &[u8]) -> mpsc::Receiver<u8> {
        let (tx, rx) = mpsc::channel();
        for b in bytes {
            tx.send(*b).unwrap();
        }
        rx
    }

    #[test]
    fn char_width_handles_cjk_combining_and_ascii() {
        assert_eq!(char_width('你'), 2);
        assert_eq!(char_width('a'), 1);
        assert_eq!(char_width('\u{301}'), 0); // combining accent
        assert_eq!(char_width(' '), 1);
    }

    #[test]
    fn display_position_wraps_by_terminal_cells() {
        let runes: Vec<char> = "你a".chars().collect();
        assert_eq!(display_position(&runes, 80), (0, 3));
        let runes: Vec<char> = "abcdefg你".chars().collect();
        assert_eq!(display_position(&runes, 8), (1, 2));
        let runes: Vec<char> = "e\u{301}你".chars().collect();
        assert_eq!(display_position(&runes, 8), (0, 3));
    }

    #[test]
    fn line_editing_inserts_arrows_and_backspace() {
        let mut tty = Terminal::from_keys(
            keys_from(b"\xE4\xBD\xA0a\x1b[Db\x1b[C\x1b[A\x1b[B\x7f\r"),
            Box::new(Vec::new()),
            false,
        );
        let line = tty.read_line("› ").unwrap();
        assert_eq!(line, "你b");
    }

    #[test]
    fn ctrl_c_raises_exit() {
        let mut tty = Terminal::from_keys(keys_from(b"\x03"), Box::new(Vec::new()), false);
        assert!(matches!(tty.read_line("› "), Err(TermError::Exit)));
    }

    #[test]
    fn standalone_esc_aborts_operation() {
        let agent = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let cancel = agent.clone();
        let mut tty = Terminal::from_keys(keys_from(b"\x1b"), Box::new(Vec::new()), false);
        let result = tty.run(&agent, move || {
            // simulate an operation that is cancelled right away
            if cancel.load(Ordering::SeqCst) {
                Err("Operation aborted".to_string())
            } else {
                Ok("finished".to_string())
            }
        });
        // not tty -> should just return operation result
        assert!(result.is_ok());
    }

    #[test]
    fn redraw_moves_cursor_above_cleared_prompt() {
        let mut out = Vec::new();
        let prompt = "\x1b[32m›\x1b[0m ";
        let prompt_visible = strip_ansi(prompt);
        let line: Vec<char> = "你a".chars().collect();
        let row = redraw(&mut out, prompt, &prompt_visible, &line, 1, 0, 80);
        assert_eq!(row, 0);
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("›"));
        assert!(text.contains("你a"));
    }
}
