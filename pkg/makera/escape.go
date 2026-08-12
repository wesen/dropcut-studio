package makera

import "strings"

// Argument escaping.
//
// The firmware's line parser is whitespace-sensitive, and '?', '!' and '~' are
// realtime control bytes that must never appear literally inside a command
// line. Paths are therefore escaped before being embedded in a command.
//
// Note the asymmetry, which is easy to get wrong: SPACE is escaped per-argument
// (only inside a path), because the spaces separating a command from its flags
// must survive. The other four are escaped across the whole command line.
const (
	escSpace = '\x01'
	escQuest = '\x02'
	escAmp   = '\x03'
	escBang  = '\x04'
	escTilde = '\x05'
)

var (
	lineEscaper = strings.NewReplacer(
		"?", string(rune(escQuest)),
		"&", string(rune(escAmp)),
		"!", string(rune(escBang)),
		"~", string(rune(escTilde)),
	)
	unescaper = strings.NewReplacer(
		string(rune(escSpace)), " ",
		string(rune(escQuest)), "?",
		string(rune(escAmp)), "&",
		string(rune(escBang)), "!",
		string(rune(escTilde)), "~",
	)
)

// EscapePath prepares a single path argument: backslashes become forward
// slashes (the machine only understands '/') and spaces become 0x01.
func EscapePath(path string) string {
	return strings.ReplaceAll(strings.ReplaceAll(path, "\\", "/"), " ", string(rune(escSpace)))
}

// EscapeLine escapes the realtime characters across a whole command line.
// Apply it last, after paths have been escaped and the line assembled.
func EscapeLine(line string) string {
	return lineEscaper.Replace(line)
}

// Unescape reverses both transformations, for text coming back from the machine.
func Unescape(value string) string {
	return unescaper.Replace(value)
}
