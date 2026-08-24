package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/term"
)

var errExit = errors.New("exit")

type keyEvent struct {
	key byte
	err error
}
type operationResult struct {
	answer string
	err    error
}

type crlfWriter struct{ io.Writer }

func (w crlfWriter) Write(p []byte) (int, error) {
	out := make([]byte, 0, len(p)+bytes.Count(p, []byte("\n")))
	for i, b := range p {
		if b == '\n' && (i == 0 || p[i-1] != '\r') {
			out = append(out, '\r')
		}
		out = append(out, b)
	}
	_, err := w.Writer.Write(out)
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

type terminal struct {
	reader *bufio.Reader
	keys   chan keyEvent
	out    io.Writer
	fd     int
	old    *term.State
}

func newTerminal(in *os.File, out io.Writer) (*terminal, error) {
	t := &terminal{reader: bufio.NewReader(in), out: out, fd: int(in.Fd())}
	if !term.IsTerminal(t.fd) {
		return t, nil
	}
	old, err := term.MakeRaw(t.fd)
	if err != nil {
		return nil, err
	}
	t.old, t.keys, t.out = old, make(chan keyEvent), crlfWriter{out}
	go func() {
		b := make([]byte, 1)
		for {
			_, err := in.Read(b)
			t.keys <- keyEvent{b[0], err}
			if err != nil {
				return
			}
		}
	}()
	return t, nil
}

func (t *terminal) close() error {
	if t.old == nil {
		return nil
	}
	return term.Restore(t.fd, t.old)
}

func (t *terminal) escapeSequence() (byte, bool, error) {
	timer := time.NewTimer(20 * time.Millisecond)
	defer timer.Stop()
	select {
	case event := <-t.keys:
		if event.err != nil {
			return 0, false, event.err
		}
		if event.key != '[' && event.key != 'O' {
			return 0, false, nil
		}
		for {
			event = <-t.keys
			if event.err != nil {
				return 0, false, event.err
			}
			if event.key >= 64 && event.key <= 126 {
				return event.key, false, nil
			}
		}
	case <-timer.C:
		return 0, true, nil
	}
}

func runeWidth(r rune) int {
	if unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Me, r) || unicode.Is(unicode.Cf, r) {
		return 0
	}
	if r >= 0x1100 && (r <= 0x115f || r == 0x2329 || r == 0x232a || r >= 0x2e80 && r <= 0xa4cf || r >= 0xac00 && r <= 0xd7a3 || r >= 0xf900 && r <= 0xfaff || r >= 0xfe10 && r <= 0xfe6f || r >= 0xff00 && r <= 0xff60 || r >= 0xffe0 && r <= 0xffe6 || r >= 0x1f300 && r <= 0x1faff || r >= 0x20000 && r <= 0x3fffd) {
		return 2
	}
	return 1
}

func visibleRunes(text []rune) []rune {
	visible := []rune{}
	for i := 0; i < len(text); i++ {
		if text[i] != 27 || i+1 >= len(text) || text[i+1] != '[' {
			visible = append(visible, text[i])
			continue
		}
		i += 2
		for i < len(text) && (text[i] < 64 || text[i] > 126) {
			i++
		}
	}
	return visible
}

func displayPosition(text []rune, columns int) (int, int) {
	offset := 0
	for _, r := range visibleRunes(text) {
		width := runeWidth(r)
		if width == 2 && offset%columns == columns-1 {
			offset++
		}
		offset += width
	}
	return offset / columns, offset % columns
}

func (t *terminal) redraw(prompt string, line []rune, cursor, oldRow int) int {
	width := 80
	if columns, _, err := term.GetSize(t.fd); err == nil && columns > 0 {
		width = columns
	}
	if oldRow > 0 {
		fmt.Fprintf(t.out, "\x1b[%dA", oldRow)
	}
	fmt.Fprintf(t.out, "\r\x1b[J%s%s", prompt, string(line))
	promptRunes := []rune(prompt)
	endRow, endColumn := displayPosition(slices.Concat(promptRunes, line), width)
	targetRow, targetColumn := displayPosition(slices.Concat(promptRunes, line[:cursor]), width)
	if endColumn == 0 {
		fmt.Fprint(t.out, " ")
	}
	if endRow > targetRow {
		fmt.Fprintf(t.out, "\x1b[%dA", endRow-targetRow)
	}
	fmt.Fprint(t.out, "\r")
	if targetColumn > 0 {
		fmt.Fprintf(t.out, "\x1b[%dC", targetColumn)
	}
	return targetRow
}

func (t *terminal) readLine(prompt string) (string, error) {
	fmt.Fprint(t.out, prompt)
	if t.old == nil {
		line, err := t.reader.ReadString('\n')
		return strings.TrimSpace(line), err
	}
	line, cursor, row, pending := []rune{}, 0, 0, []byte{}
	for {
		event := <-t.keys
		if event.err != nil {
			return "", event.err
		}
		if event.key == 3 {
			return "", errExit
		}
		if event.key == 27 {
			key, _, err := t.escapeSequence()
			if err != nil {
				return "", err
			}
			if key == 'D' && cursor > 0 {
				cursor--
				for cursor > 0 && runeWidth(line[cursor]) == 0 {
					cursor--
				}
				row = t.redraw(prompt, line, cursor, row)
			}
			if key == 'C' && cursor < len(line) {
				cursor++
				for cursor < len(line) && runeWidth(line[cursor]) == 0 {
					cursor++
				}
				row = t.redraw(prompt, line, cursor, row)
			}
			continue
		}
		if event.key == '\r' || event.key == '\n' {
			fmt.Fprint(t.out, "\r\n")
			return strings.TrimSpace(string(line)), nil
		}
		if event.key == 8 || event.key == 127 {
			if cursor == 0 {
				continue
			}
			start := cursor - 1
			for start > 0 && runeWidth(line[start]) == 0 {
				start--
			}
			line = append(line[:start], line[cursor:]...)
			cursor = start
			row = t.redraw(prompt, line, cursor, row)
			continue
		}
		if event.key < 32 || event.key == 127 {
			continue
		}
		pending = append(pending, event.key)
		if !utf8.FullRune(pending) {
			continue
		}
		r, _ := utf8.DecodeRune(pending)
		line = append(line, 0)
		copy(line[cursor+1:], line[cursor:])
		line[cursor], cursor = r, cursor+1
		pending = pending[:0]
		row = t.redraw(prompt, line, cursor, row)
	}
}

func (t *terminal) run(agent *Agent, operation func() (string, error)) (string, error) {
	if t.old == nil {
		return operation()
	}
	done := make(chan operationResult, 1)
	go func() {
		answer, err := operation()
		done <- operationResult{answer, err}
	}()
	for {
		select {
		case result := <-done:
			return result.answer, result.err
		case event := <-t.keys:
			if event.err != nil {
				agent.abort()
				<-done
				return "", event.err
			}
			if event.key == 27 {
				_, standalone, err := t.escapeSequence()
				if err != nil {
					agent.abort()
					<-done
					return "", err
				}
				if standalone {
					fmt.Fprint(t.out, "\r\n\x1b[33mAborting...\x1b[0m\r\n")
					agent.abort()
				}
			}
			if event.key == 3 {
				agent.abort()
				<-done
				return "", errExit
			}
		}
	}
}
