/**
 * @cam/gcode-parser — a modal RS-274 interpreter.
 *
 * This exists for three reasons, in order of importance:
 *
 *  1. It is the ROUND-TRIP ORACLE. The central architectural bet is that a
 *     non-modal IR can be compressed to modal G-code losslessly. That claim is
 *     only testable if we can parse the result back. See the property test.
 *  2. It is the importer for "check someone else's file".
 *  3. It is the dialect conformance checker: parse an emitted file against the
 *     target machine's supported code set and confirm nothing unsupported got out.
 *
 * The parser is deliberately permissive about what it accepts and precise about
 * what it reports: unknown codes become diagnostics, not exceptions.
 */

import type { Diagnostic } from "@cam/ir";
import { error, info, warning } from "@cam/ir";
import type { Vec3 } from "@cam/math";
import { vec3 } from "@cam/math";

export interface ParsedSegment {
  readonly kind: "rapid" | "cut";
  readonly from: Vec3;
  readonly to: Vec3;
  /** Discretised points for arcs, including both endpoints. Null for lines. */
  readonly points: Vec3[] | null;
  readonly line: number;
  readonly feed: number;
  readonly rpm: number;
  readonly tool: number;
  readonly spindleOn: boolean;
  readonly length: number;
  /** Cumulative seconds at the start and end of this segment. */
  readonly t0: number;
  readonly t1: number;
}

export interface ParseResult {
  readonly segments: readonly ParsedSegment[];
  readonly diagnostics: readonly Diagnostic[];
  readonly bounds: {
    minX: number; maxX: number;
    minY: number; maxY: number;
    minZ: number; maxZ: number;
  };
  readonly totalSeconds: number;
  readonly lineCount: number;
  readonly toolChanges: readonly { line: number; tool: number }[];
  readonly toolsUsed: readonly number[];
  /** Every G and M code encountered, for dialect conformance checks. */
  readonly codesUsed: { readonly g: ReadonlySet<number>; readonly m: ReadonlySet<number> };
  /** Structured metadata harvested from comments, e.g. Makera's `;@MKR|` header. */
  readonly headers: readonly HeaderRecord[];
}

export interface HeaderRecord {
  readonly namespace: string;
  readonly key: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly line: number;
}

export interface ParseOptions {
  /** Rapid rate in mm/min, for time estimation. */
  readonly rapidRate?: number;
  readonly supportedG?: ReadonlySet<number>;
  readonly supportedM?: ReadonlySet<number>;
  /** Max chord deviation when discretising arcs. */
  readonly arcTolerance?: number;
}

const WORD_RE = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g;
/** e.g. `;@MKR|TOOL|number=1|diameter=3.175` */
const HEADER_RE = /^;@([A-Za-z0-9_]+)\|([A-Za-z0-9_]+)(?:\|(.*))?$/;

/** Modal interpreter state. Every field here is a G-code hazard made explicit. */
interface ModalState {
  x: number; y: number; z: number;
  feed: number;
  rpm: number;
  tool: number;
  absolute: boolean;
  inches: boolean;
  spindleOn: boolean;
  motion: 0 | 1 | 2 | 3 | null;
  plane: 17 | 18 | 19;
}

export function parseGcode(text: string, opts: ParseOptions = {}): ParseResult {
  const rapidRate = opts.rapidRate ?? 3000;
  const arcTol = opts.arcTolerance ?? 0.02;

  const rawLines = text.split(/\r?\n/);
  const segments: ParsedSegment[] = [];
  const diagnostics: Diagnostic[] = [];
  const toolChanges: { line: number; tool: number }[] = [];
  const toolsUsed = new Set<number>();
  const gUsed = new Set<number>();
  const mUsed = new Set<number>();
  const headers: HeaderRecord[] = [];

  const st: ModalState = {
    x: 0, y: 0, z: 0,
    feed: 0, rpm: 0, tool: 0,
    absolute: true, inches: false, spindleOn: false,
    motion: null, plane: 17,
  };

  let seenMotion = false;
  let seconds = 0;

  const toMm = (v: number) => (st.inches ? v * 25.4 : v);

  for (let li = 0; li < rawLines.length; li++) {
    const lineNo = li + 1;
    const raw = rawLines[li];

    const header = HEADER_RE.exec(raw.trim());
    if (header) {
      const fields: Record<string, string> = {};
      for (const part of (header[3] ?? "").split("|")) {
        if (!part) continue;
        const eq = part.indexOf("=");
        if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1);
      }
      headers.push({ namespace: header[1], key: header[2], fields, line: lineNo });
      continue;
    }

    // Strip parenthesised and semicolon comments before tokenising.
    const code = raw.replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").trim();
    if (!code) continue;

    WORD_RE.lastIndex = 0;
    const words: [string, number][] = [];
    let m: RegExpExecArray | null;
    while ((m = WORD_RE.exec(code)) !== null) {
      words.push([m[1].toUpperCase(), Number.parseFloat(m[2])]);
    }
    if (words.length === 0) continue;

    let motionThisLine: 0 | 1 | 2 | 3 | null = null;
    let hasCoord = false;
    let dwellSeconds = 0;
    let sawDwell = false;
    const next: { x?: number; y?: number; z?: number } = {};
    const ijk: { i?: number; j?: number; k?: number } = {};
    let rWord: number | null = null;

    for (const [w, v] of words) {
      switch (w) {
        case "G": {
          const gi = Math.floor(v);
          gUsed.add(gi);
          if (opts.supportedG && !opts.supportedG.has(gi)) {
            diagnostics.push(warning("dialect.unknownCode",
              `G${v} is not in this machine's supported code list`,
              { detail: { line: lineNo, code: `G${v}` } }));
          }
          if (gi <= 3) {
            motionThisLine = gi as 0 | 1 | 2 | 3;
            st.motion = motionThisLine;
          } else if (gi === 4) {
            sawDwell = true;
          } else if (gi === 20) {
            if (seenMotion && !st.inches) {
              diagnostics.push(warning("units.lateSwitch",
                "units switch to inches (G20) after motion has started",
                { detail: { line: lineNo } }));
            }
            st.inches = true;
          } else if (gi === 21) {
            if (seenMotion && st.inches) {
              diagnostics.push(warning("units.lateSwitch",
                "units switch to millimetres (G21) after motion has started",
                { detail: { line: lineNo } }));
            }
            st.inches = false;
          } else if (gi === 90) {
            st.absolute = true;
          } else if (gi === 91) {
            st.absolute = false;
            if (seenMotion) {
              diagnostics.push(warning("units.lateSwitch",
                "switch to incremental mode (G91) mid-program — verify this is intended",
                { detail: { line: lineNo } }));
            }
          } else if (gi === 17 || gi === 18 || gi === 19) {
            st.plane = gi as 17 | 18 | 19;
          } else if (gi === 28 || gi === 30) {
            diagnostics.push(info("dialect.unknownCode",
              `G${gi} homing move — the resulting position depends on machine state`,
              { detail: { line: lineNo } }));
          } else if (gi === 53) {
            diagnostics.push(info("dialect.unknownCode",
              "G53 machine-coordinate move — previewed in program coordinates",
              { detail: { line: lineNo } }));
          }
          break;
        }
        case "M": {
          const mi = Math.round(v);
          mUsed.add(mi);
          if (opts.supportedM && !opts.supportedM.has(mi)) {
            diagnostics.push(warning("dialect.unknownCode",
              `M${mi} is not in this machine's supported code list`,
              { detail: { line: lineNo, code: `M${mi}` } }));
          }
          if (mi === 3 || mi === 4) st.spindleOn = true;
          else if (mi === 5) st.spindleOn = false;
          else if (mi === 6) toolChanges.push({ line: lineNo, tool: st.tool });
          break;
        }
        case "T":
          st.tool = Math.round(v);
          toolsUsed.add(st.tool);
          break;
        case "S":
          st.rpm = v;
          break;
        case "F":
          st.feed = toMm(v);
          break;
        case "X": next.x = toMm(v); hasCoord = true; break;
        case "Y": next.y = toMm(v); hasCoord = true; break;
        case "Z": next.z = toMm(v); hasCoord = true; break;
        case "I": ijk.i = toMm(v); break;
        case "J": ijk.j = toMm(v); break;
        case "K": ijk.k = toMm(v); break;
        case "R": rWord = toMm(v); break;
        case "P": dwellSeconds = v; break;
        default:
          break;
      }
    }

    if (sawDwell) {
      seconds += dwellSeconds;
      continue;
    }
    if (!hasCoord) continue;

    const mode = motionThisLine ?? st.motion;
    if (mode === null) continue;

    seenMotion = true;
    toolsUsed.add(st.tool);

    const from = vec3(st.x, st.y, st.z);
    const to = vec3(
      next.x !== undefined ? (st.absolute ? next.x : st.x + next.x) : st.x,
      next.y !== undefined ? (st.absolute ? next.y : st.y + next.y) : st.y,
      next.z !== undefined ? (st.absolute ? next.z : st.z + next.z) : st.z,
    );

    let points: Vec3[] | null = null;
    let length: number;

    if (mode === 2 || mode === 3) {
      points = arcPoints(from, to, ijk, rWord, mode === 2, st.plane, arcTol);
      length = 0;
      for (let i = 1; i < points.length; i++) length += dist(points[i - 1], points[i]);
    } else {
      length = dist(from, to);
    }

    const isCut = mode !== 0;
    if (isCut && st.feed <= 0) {
      diagnostics.push(error("interlock.noFeed", "cutting move with no feed rate set",
        { detail: { line: lineNo } }));
    }
    if (isCut && !st.spindleOn && length > 1e-3) {
      diagnostics.push(error("interlock.spindleOff",
        "cutting move while the spindle is off (no M3/M4 active)",
        { detail: { line: lineNo } }));
    }
    if (length > 500) {
      diagnostics.push(warning("move.suspiciousLength",
        `very large single move (${length.toFixed(0)} mm) — check for a missing decimal or unit mixup`,
        { detail: { line: lineNo, length } }));
    }

    const rate = isCut ? (st.feed > 0 ? st.feed : 100) : rapidRate;
    const t0 = seconds;
    seconds += (length / rate) * 60;

    segments.push({
      kind: isCut ? "cut" : "rapid",
      from, to, points,
      line: lineNo,
      feed: st.feed, rpm: st.rpm, tool: st.tool, spindleOn: st.spindleOn,
      length, t0, t1: seconds,
    });

    st.x = to.x; st.y = to.y; st.z = to.z;
  }

  if (st.spindleOn) {
    diagnostics.push(warning("program.spindleLeftOn",
      "program ends with the spindle still running"));
  }
  if (segments.length === 0) {
    diagnostics.push(info("program.noMotion", "program contains no motion"));
  }

  return {
    segments,
    diagnostics,
    bounds: computeBounds(segments),
    totalSeconds: seconds,
    lineCount: rawLines.length,
    toolChanges,
    toolsUsed: [...toolsUsed].sort((a, b) => a - b),
    codesUsed: { g: gUsed, m: mUsed },
    headers,
  };
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

function computeBounds(segs: readonly ParsedSegment[]): ParseResult["bounds"] {
  if (segs.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  }
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const s of segs) {
    for (const p of s.points ?? [s.from, s.to]) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/**
 * Discretise an arc given either I/J/K centre offsets or an R radius.
 *
 * Handles all three planes, unlike the prototype which only back-plotted G17.
 * For the R form the sign convention selects between the minor and major arc:
 * a positive R takes the short way round, a negative R the long way.
 */
export function arcPoints(
  from: Vec3,
  to: Vec3,
  ijk: { i?: number; j?: number; k?: number },
  r: number | null,
  clockwise: boolean,
  plane: 17 | 18 | 19,
  tolerance = 0.02,
): Vec3[] {
  // Map the plane onto a 2D (u, v) frame plus the out-of-plane axis w.
  const get = (p: Vec3): [number, number, number] =>
    plane === 17 ? [p.x, p.y, p.z]
      : plane === 18 ? [p.z, p.x, p.y]
      : [p.y, p.z, p.x];
  const put = (u: number, v: number, w: number): Vec3 =>
    plane === 17 ? vec3(u, v, w)
      : plane === 18 ? vec3(v, w, u)
      : vec3(w, u, v);

  const [u0, v0, w0] = get(from);
  const [u1, v1, w1] = get(to);

  const offU = plane === 17 ? ijk.i : plane === 18 ? ijk.k : ijk.j;
  const offV = plane === 17 ? ijk.j : plane === 18 ? ijk.i : ijk.k;

  let cu: number;
  let cv: number;

  if (offU !== undefined || offV !== undefined) {
    cu = u0 + (offU ?? 0);
    cv = v0 + (offV ?? 0);
  } else if (r !== null && r !== undefined) {
    const mu = (u0 + u1) / 2;
    const mv = (v0 + v1) / 2;
    const du = u1 - u0;
    const dv = v1 - v0;
    const d = Math.hypot(du, dv);
    if (d < 1e-9 || Math.abs(r) < d / 2 - 1e-6) return [from, to];
    const h = Math.sqrt(Math.max(0, r * r - (d * d) / 4));
    // Perpendicular to the chord; which side depends on direction and sign of R.
    const pu = -dv / d;
    const pv = du / d;
    const sign = clockwise === r > 0 ? -1 : 1;
    cu = mu + sign * pu * h;
    cv = mv + sign * pv * h;
  } else {
    return [from, to];
  }

  const radius = Math.hypot(u0 - cu, v0 - cv);
  if (radius < 1e-9) return [from, to];

  const a0 = Math.atan2(v0 - cv, u0 - cu);
  const a1 = Math.atan2(v1 - cv, u1 - cu);
  let sweep = a1 - a0;
  if (clockwise) {
    if (sweep >= -1e-9) sweep -= Math.PI * 2;
  } else {
    if (sweep <= 1e-9) sweep += Math.PI * 2;
  }

  const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tolerance / radius)));
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / Math.max(maxStep, 1e-3)));

  const out: Vec3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = a0 + sweep * t;
    out.push(put(cu + radius * Math.cos(a), cv + radius * Math.sin(a), w0 + (w1 - w0) * t));
  }
  out[out.length - 1] = to;
  return out;
}

/** Flatten a parse result into a single polyline of motion, for comparison. */
export function motionPolyline(r: ParseResult): Vec3[] {
  const out: Vec3[] = [];
  for (const s of r.segments) {
    const pts = s.points ?? [s.from, s.to];
    if (out.length === 0) out.push(pts[0]);
    for (let i = 1; i < pts.length; i++) out.push(pts[i]);
  }
  return out;
}
