// SPDX-License-Identifier: GPL-2.0-only

package makera

import (
	"strconv"
	"strings"
	"time"
)

// Parsers for the machine's line-oriented replies.
//
// Every format here was captured verbatim from a Makera Z1 running firmware
// 1.0.15.0.1.11 on 2026-08-11. Several differ from what published clients
// assume; those differences are called out at each parser.

// ParseKeyValueLine extracts the value from a `key = value` line.
func ParseKeyValueLine(line, key string) (string, bool) {
	prefix := key + " ="
	idx := strings.Index(line, prefix)
	if idx < 0 {
		return "", false
	}
	return strings.TrimSpace(line[idx+len(prefix):]), true
}

// ParseVersionLine extracts the firmware version.
//
// Real firmware reports SIX dotted components: `version = 1.0.15.0.1.11`.
// Published clients match `\d+\.\d+\.\d+` and silently truncate to `1.0.15`,
// so any version comparison they perform is done on a partial string. This
// parser keeps the whole value.
func ParseVersionLine(line string) (string, bool) {
	return ParseKeyValueLine(line, "version")
}

// ModelInfo is the decoded `model` line.
type ModelInfo struct {
	Model       string
	ModelID     int
	FuncSetting int
	Extra       int
	State       string
}

// ParseModelLine decodes `model = Z1, 3, 1, 0, Idle`.
//
// Real firmware sends FIVE comma-separated fields; published clients match four
// and discard the trailing machine state.
func ParseModelLine(line string) (ModelInfo, bool) {
	value, ok := ParseKeyValueLine(line, "model")
	if !ok {
		return ModelInfo{}, false
	}
	parts := strings.Split(value, ",")
	if len(parts) < 2 {
		return ModelInfo{}, false
	}
	info := ModelInfo{Model: strings.TrimSpace(parts[0])}
	if len(parts) > 1 {
		info.ModelID, _ = strconv.Atoi(strings.TrimSpace(parts[1]))
	}
	if len(parts) > 2 {
		info.FuncSetting, _ = strconv.Atoi(strings.TrimSpace(parts[2]))
	}
	if len(parts) > 3 {
		info.Extra, _ = strconv.Atoi(strings.TrimSpace(parts[3]))
	}
	if len(parts) > 4 {
		info.State = strings.TrimSpace(parts[4])
	}
	return info, true
}

// DirEntry is one row of an `ls -e -s` listing.
type DirEntry struct {
	Name    string
	Size    int64
	ModTime time.Time
	RawTime string
	IsDir   bool
}

// ParseListing decodes the lines of an `ls -e -s <dir>` reply.
//
// Format, captured verbatim:
//
//	.md5/ 0 20260516120042
//	Examples/ 0 20260516120042
//	goto-pack-pos-z1.nc  54 20260522094322
//	MakeraBadge.nc  328417 20260731185808
//
// Three things published clients get wrong or do not handle:
//
//   - Directories are marked ONLY by a trailing '/' and a size of 0. There is
//     no type column.
//   - Files are separated from their size by TWO spaces, directories by one.
//     This is in the raw bytes, not a display artefact. Splitting on runs of
//     whitespace handles both; relying on a single space does not.
//   - The timestamp is YYYYMMDDHHMMSS in local time, not a Unix epoch. It is
//     only meaningful if the machine's clock has been synced — a Z1 boots with
//     its clock near zero.
//
// Names may contain escaped spaces (0x01), which is not ASCII whitespace, so
// taking the last two whitespace-separated tokens as size and timestamp is
// safe even for names with spaces.
func ParseListing(lines []string) []DirEntry {
	out := make([]DirEntry, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" || strings.Contains(line, "Load directory finished") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		name := Unescape(strings.Join(fields[:len(fields)-2], " "))
		size, err := strconv.ParseInt(fields[len(fields)-2], 10, 64)
		if err != nil {
			continue
		}
		rawTime := fields[len(fields)-1]
		e := DirEntry{
			Name:    strings.TrimSuffix(name, "/"),
			Size:    size,
			RawTime: rawTime,
			IsDir:   strings.HasSuffix(name, "/"),
		}
		if t, err := time.ParseInLocation("20060102150405", rawTime, time.Local); err == nil {
			e.ModTime = t
		}
		out = append(out, e)
	}
	return out
}

// ParseMD5 decodes an `md5sum <path> -e` reply.
//
// The digest and the path are concatenated with NO separator:
//
//	b66caa6121c39f971ff5d97b5158b57e/sd/gcodes/goto-pack-pos-z1.nc
//
// A whitespace split returns one token. The digest is the first 32 characters,
// and it must be validated as hex rather than merely as 32 characters long:
// some Z1 firmware answers with the literal placeholder
// `default_md5_hash_value_32_bytes_`, which is exactly 32 characters and is not
// a digest. Firmware 1.0.15.0.1.11 returns a genuine digest for this command,
// but the check costs nothing and the download path remains unverified.
func ParseMD5(line string) (digest, path string, ok bool) {
	line = strings.TrimSpace(line)
	if len(line) < 32 {
		return "", "", false
	}
	digest = strings.ToLower(line[:32])
	if !IsHexDigest(digest) {
		return "", "", false
	}
	return digest, strings.TrimSpace(line[32:]), true
}

// IsHexDigest reports whether s is exactly 32 lowercase hex characters.
func IsHexDigest(s string) bool {
	if len(s) != 32 {
		return false
	}
	for _, r := range s {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

// WCS holds the decoded `get wcs` reply.
//
// This command is not a convenience: stock Z1 firmware does NOT report the
// active coordinate system in its status report (there is no `G:` key), so it
// is the only way to learn which work offset is in effect.
type WCS struct {
	Current string
	Offsets map[string][]float64
}

// ParseWCS decodes the `get wcs` reply.
//
// Captured verbatim:
//
//	[current WCS: G54]
//	[G54:-190.5200,-193.7300,-78.2153,90.0000,0.0000]
//	[G28:0.0000,0.0000,0.0000]
//	[Tool Offset:0.0000,0.0000,0.0544]
//	[PRB:0.0000,0.0000,0.0000:0]
//
// Work offsets carry five components (X, Y, Z, A, B) on stock firmware;
// community firmware appends a sixth for WCS rotation.
func ParseWCS(lines []string) WCS {
	w := WCS{Offsets: map[string][]float64{}}
	for _, line := range lines {
		for _, chunk := range bracketChunks(line) {
			if rest, ok := strings.CutPrefix(chunk, "current WCS:"); ok {
				w.Current = strings.TrimSpace(rest)
				continue
			}
			key, values, found := strings.Cut(chunk, ":")
			if !found {
				continue
			}
			// PRB carries a trailing ":0" success flag; keep only the numbers.
			if i := strings.IndexByte(values, ':'); i >= 0 {
				values = values[:i]
			}
			nums := make([]float64, 0, 6)
			ok := true
			for _, tok := range strings.Split(values, ",") {
				v, err := strconv.ParseFloat(strings.TrimSpace(tok), 64)
				if err != nil {
					ok = false
					break
				}
				nums = append(nums, v)
			}
			if ok && len(nums) > 0 {
				w.Offsets[strings.TrimSpace(key)] = nums
			}
		}
	}
	return w
}

// ParseModalState decodes the `get state` reply, e.g.
//
//	[G0 G54 G17 G21 G90 G94 M0 M5 M9 T0 F2000.0000 S1.0000]
//
// Returned as words in order. Note the modal tool word (T0) and the physically
// loaded tool reported by the status report can differ; they are tracked
// separately by the firmware.
func ParseModalState(lines []string) []string {
	for _, line := range lines {
		for _, chunk := range bracketChunks(line) {
			if strings.HasPrefix(chunk, "G") || strings.HasPrefix(chunk, "M") {
				return strings.Fields(chunk)
			}
		}
	}
	return nil
}

// bracketChunks returns the contents of each [...] group in a line.
func bracketChunks(line string) []string {
	var out []string
	for {
		start := strings.IndexByte(line, '[')
		if start < 0 {
			return out
		}
		end := strings.IndexByte(line[start:], ']')
		if end < 0 {
			return out
		}
		out = append(out, line[start+1:start+end])
		line = line[start+end+1:]
	}
}

func parseInt64(s string) int64 {
	v, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	return v
}
