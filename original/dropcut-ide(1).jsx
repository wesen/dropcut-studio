import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as THREE from "three";

/* ============================================================================
   DROPCUT IDE — semantic CAM playground
   Left: JS DSL editor.  Right: 3D toolpath simulation + G-code / IR / diagnostics.
   Pipeline: DSL → Canonical IR → validate → lower (safe traversal) → G-code
   (modal-compressed). Errors block emission — the post never sees an
   unvalidated program.
   ========================================================================= */

/* ----------------------------- design tokens ----------------------------- */
const C = {
  bed: "#12161C",
  panel: "#1A2028",
  panel2: "#161B22",
  line: "#242D38",
  text: "#C7D0DA",
  dim: "#5F6B79",
  amber: "#FFB454",
  amberDim: "#8A6530",
  teal: "#4FD1B3",
  err: "#F26D5E",
  warn: "#E8C468",
  sel: "#22303F",
};
const MONO =
  'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace';

/* ------------------------------ machine ---------------------------------- */
const MACHINE = {
  name: "XYZ-3018 · 3-axis",
  travels: { x: [-5, 300], y: [-5, 180], z: [-80, 40] },
  spindle: [3000, 24000],
  rapid: 3000, // mm/min, for time estimation
};

/* ----------------------------- default program --------------------------- */
const DEFAULT_CODE = `// Dropcut DSL — you write machining semantics, the
// compiler owns modal state, safe traversal and G-code.
//
// Units are branded: mm(), rpm(), mmPerMin().
// Bare numbers compile, but earn you a warning.

const T1 = tools.flatEndMill({
  name: "4mm flat",
  diameter: mm(4),
});

job.setup({
  stock: { x: mm(60), y: mm(40), z: mm(12) },
  clearance: mm(6),
});

job.toolChange(T1);

job.withSpindle({ speed: rpm(12000) }, () => {

  // Face the top — raster strategy expands to canonical moves
  job.face({
    x: mm(0), y: mm(0),
    w: mm(60), h: mm(40),
    z: mm(-0.5),
    stepover: 0.6,            // fraction of tool diameter
    feed: mmPerMin(900),
  });

  // Pocket — concentric rings, three stepdowns
  job.rectPocket({
    x: mm(14), y: mm(10),
    w: mm(32), h: mm(20),
    depth: mm(6),
    stepdown: mm(2),
    stepover: 0.45,
    feed: mmPerMin(600),
    plungeFeed: mmPerMin(200),
  });

  // Circular finishing pass — arcs survive to G2/G3
  job.traverse(p(mm(36), mm(20), mm(2)));
  job.cut(p(mm(36), mm(20), mm(-6)), { feed: mmPerMin(180) });
  job.arcCut(p(mm(24), mm(20), mm(-6)), {
    center: p(mm(30), mm(20), mm(-6)),
    dir: "ccw",
    feed: mmPerMin(500),
  });
  job.arcCut(p(mm(36), mm(20), mm(-6)), {
    center: p(mm(30), mm(20), mm(-6)),
    dir: "ccw",
  });

  // Manual canonical moves — edge chamfer
  job.traverse(p(mm(0), mm(0), mm(2)));
  job.cut(p(mm(0), mm(0), mm(-1)), { feed: mmPerMin(200) });
  job.cut(p(mm(60), mm(0), mm(-1)), { feed: mmPerMin(700) });
});

job.traverse(p(mm(0), mm(0), mm(10)));
`;

/* ============================================================================
   COMPILER
   ========================================================================= */

function fmt(n) {
  const s = n.toFixed(3);
  return s.replace(/\.?0+$/, "").replace(/^-0$/, "0");
}
function fmtTime(sec) {
  if (!isFinite(sec)) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function compileProgram(code) {
  const diags = [];
  const cmds = []; // canonical IR
  let opCount = { face: 0, pocket: 0 };
  const setup = { stock: { x: 60, y: 40, z: 12 }, clearance: 6 };

  const warnBare = (name) =>
    diags.push({
      level: "warning",
      message: `bare number passed to ${name} — interpreted as its default unit; prefer branded units`,
    });

  const unwrap = (v, unit, ctx) => {
    if (v == null) return null;
    if (typeof v === "number") {
      warnBare(ctx);
      return v;
    }
    if (v.__unit === unit) return v.v;
    throw new Error(
      `${ctx}: expected ${unit}, got ${v.__unit ?? typeof v}`
    );
  };

  // branded units
  const mm = (v) => ({ __unit: "mm", v });
  const rpm = (v) => ({ __unit: "rpm", v });
  const mmPerMin = (v) => ({ __unit: "mm/min", v });
  const deg = (v) => ({ __unit: "deg", v });
  const p = (x, y, z) => ({
    x: unwrap(x, "mm", "p().x"),
    y: unwrap(y, "mm", "p().y"),
    z: unwrap(z, "mm", "p().z"),
  });

  let toolSeq = 0;
  const tools = {
    flatEndMill: (o) => ({
      id: ++toolSeq,
      name: o?.name ?? `T${toolSeq}`,
      diameter: unwrap(o?.diameter, "mm", "tool diameter") ?? 3,
      shape: "flat",
    }),
    ballEndMill: (o) => ({
      id: ++toolSeq,
      name: o?.name ?? `T${toolSeq}`,
      diameter: unwrap(o?.diameter, "mm", "tool diameter") ?? 3,
      shape: "ball",
    }),
  };

  const emit = (c) => cmds.push(c);

  const job = {
    setup(o) {
      if (o?.stock) {
        setup.stock = {
          x: unwrap(o.stock.x, "mm", "stock.x"),
          y: unwrap(o.stock.y, "mm", "stock.y"),
          z: unwrap(o.stock.z, "mm", "stock.z"),
        };
      }
      if (o?.clearance != null)
        setup.clearance = unwrap(o.clearance, "mm", "clearance");
    },
    comment(text) {
      emit({ kind: "comment", text: String(text) });
    },
    toolChange(tool) {
      if (!tool || !tool.diameter)
        throw new Error("toolChange: expected a tool from tools.*");
      emit({ kind: "tool-change", tool, tag: "setup" });
    },
    spindle(o) {
      if (o === "off" || o?.mode === "off")
        return emit({ kind: "spindle", mode: "off" });
      emit({
        kind: "spindle",
        mode: o?.dir === "ccw" ? "ccw" : "cw",
        speed: unwrap(o?.speed, "rpm", "spindle speed"),
      });
    },
    withSpindle(o, body) {
      job.spindle(o);
      body();
      emit({ kind: "spindle", mode: "off" });
    },
    traverse(pt, opts) {
      emit({ kind: "traverse", to: pt, tag: opts?.tag });
    },
    cut(pt, opts) {
      emit({
        kind: "cut",
        to: pt,
        feed:
          opts?.feed != null
            ? unwrap(opts.feed, "mm/min", "cut feed")
            : null,
        tag: opts?.tag,
      });
    },
    arcCut(pt, opts) {
      if (!opts?.center) throw new Error("arcCut: center is required");
      emit({
        kind: "arc",
        to: pt,
        center: opts.center,
        ccw: opts.dir !== "cw",
        feed:
          opts?.feed != null
            ? unwrap(opts.feed, "mm/min", "arc feed")
            : null,
        tag: opts?.tag,
      });
    },
    dwell(seconds) {
      emit({ kind: "dwell", seconds: Number(seconds) || 0 });
    },

    /* ---- strategies: manufacturing intent → canonical moves ---- */
    face(o) {
      const tag = `face#${++opCount.face}`;
      const x0 = unwrap(o.x, "mm", "face.x"),
        y0 = unwrap(o.y, "mm", "face.y");
      const w = unwrap(o.w, "mm", "face.w"),
        h = unwrap(o.h, "mm", "face.h");
      const z = unwrap(o.z, "mm", "face.z");
      const feed = unwrap(o.feed, "mm/min", "face.feed");
      const dia = 4; // resolved at lowering against active tool; nominal here
      const step = (o.stepover ?? 0.5) * dia;
      emit({ kind: "comment", text: `${tag}: raster ${w}×${h} @ z${z}` });
      const xa = x0 - dia,
        xb = x0 + w + dia;
      job.traverse({ x: xa, y: y0, z: setup.clearance }, { tag });
      emit({ kind: "cut", to: { x: xa, y: y0, z }, feed: feed * 0.4, tag });
      let flip = false;
      for (let y = y0; y <= y0 + h + 1e-9; y += step) {
        const yy = Math.min(y, y0 + h);
        emit({
          kind: "cut",
          to: { x: flip ? xa : xb, y: yy, z },
          feed,
          tag,
        });
        if (yy < y0 + h)
          emit({
            kind: "cut",
            to: { x: flip ? xa : xb, y: Math.min(yy + step, y0 + h), z },
            feed,
            tag,
          });
        flip = !flip;
      }
      job.traverse(
        { x: flip ? xa : xb, y: y0 + h, z: setup.clearance },
        { tag }
      );
    },

    rectPocket(o) {
      const tag = `pocket#${++opCount.pocket}`;
      const x0 = unwrap(o.x, "mm", "pocket.x"),
        y0 = unwrap(o.y, "mm", "pocket.y");
      const w = unwrap(o.w, "mm", "pocket.w"),
        h = unwrap(o.h, "mm", "pocket.h");
      const depth = unwrap(o.depth, "mm", "pocket.depth");
      const stepdown = unwrap(o.stepdown, "mm", "pocket.stepdown");
      const feed = unwrap(o.feed, "mm/min", "pocket.feed");
      const plungeFeed =
        o.plungeFeed != null
          ? unwrap(o.plungeFeed, "mm/min", "pocket.plungeFeed")
          : feed * 0.35;
      const dia = 4,
        r = dia / 2;
      const step = (o.stepover ?? 0.4) * dia;
      const cx = x0 + w / 2,
        cy = y0 + h / 2;
      const hw = w / 2 - r,
        hh = h / 2 - r;
      if (hw <= 0 || hh <= 0)
        throw new Error(`${tag}: pocket smaller than the tool`);
      emit({
        kind: "comment",
        text: `${tag}: ${w}×${h} depth ${depth}, stepdown ${stepdown}`,
      });
      job.traverse({ x: cx, y: cy, z: setup.clearance }, { tag });
      const levels = [];
      for (let z = -stepdown; z > -depth - 1e-9; z -= stepdown)
        levels.push(Math.max(z, -depth));
      let first = true;
      for (const z of levels) {
        if (!first)
          emit({ kind: "cut", to: { x: cx, y: cy, z: z + stepdown }, feed, tag });
        emit({ kind: "cut", to: { x: cx, y: cy, z }, feed: plungeFeed, tag });
        first = false;
        let k = 1;
        for (;;) {
          const a = Math.min(k * step, hw);
          const b = Math.min(k * step, hh);
          emit({ kind: "cut", to: { x: cx + a, y: cy + b, z }, feed, tag });
          emit({ kind: "cut", to: { x: cx - a, y: cy + b, z }, feed, tag });
          emit({ kind: "cut", to: { x: cx - a, y: cy - b, z }, feed, tag });
          emit({ kind: "cut", to: { x: cx + a, y: cy - b, z }, feed, tag });
          emit({ kind: "cut", to: { x: cx + a, y: cy + b, z }, feed, tag });
          if (a >= hw - 1e-9 && b >= hh - 1e-9) break;
          k++;
        }
      }
      job.traverse(
        { x: cx + hw, y: cy + hh, z: setup.clearance },
        { tag }
      );
    },
  };

  /* ---- run user code ---- */
  try {
    const fn = new Function(
      "job",
      "tools",
      "p",
      "mm",
      "rpm",
      "mmPerMin",
      "deg",
      '"use strict";\n' + code
    );
    fn(job, tools, p, mm, rpm, mmPerMin, deg);
  } catch (e) {
    return {
      ok: false,
      error: String(e?.message ?? e),
      diagnostics: diags,
      ir: [],
      gcode: [],
      motions: [],
      total: 0,
      setup,
    };
  }

  /* ---- validate + lower canonical IR → motions + gcode ---- */
  const errors = [];
  const motions = [];
  const gcode = [];
  const ir = [];
  const tv = MACHINE.travels;
  let pos = { x: 0, y: 0, z: setup.clearance };
  let curTool = null;
  let spindleOn = false;
  let lastFeed = null;
  let lastMode = null;
  let lastAxes = { x: pos.x, y: pos.y, z: pos.z };
  let time = 0;
  let cutLen = 0,
    rapidLen = 0;

  const pushLine = (text, motionIdx = null) =>
    gcode.push({ n: gcode.length + 1, text, motion: motionIdx });

  const checkTravel = (pt, where) => {
    const out = [];
    if (pt.x < tv.x[0] || pt.x > tv.x[1]) out.push("X");
    if (pt.y < tv.y[0] || pt.y > tv.y[1]) out.push("Y");
    if (pt.z < tv.z[0] || pt.z > tv.z[1]) out.push("Z");
    if (out.length)
      errors.push({
        level: "error",
        message: `${where}: target (${fmt(pt.x)}, ${fmt(pt.y)}, ${fmt(
          pt.z
        )}) exceeds machine ${out.join("/")} travel`,
      });
  };

  const axisWords = (pt) => {
    const parts = [];
    if (Math.abs(pt.x - lastAxes.x) > 1e-9) parts.push("X" + fmt(pt.x));
    if (Math.abs(pt.y - lastAxes.y) > 1e-9) parts.push("Y" + fmt(pt.y));
    if (Math.abs(pt.z - lastAxes.z) > 1e-9) parts.push("Z" + fmt(pt.z));
    lastAxes = { ...pt };
    return parts;
  };

  const dist = (a, b) =>
    Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

  const addLinear = (to, mode, feed, tag) => {
    const from = { ...pos };
    const L = dist(from, to);
    if (L < 1e-9) return;
    const rate = mode === "G0" ? MACHINE.rapid : feed;
    const dt = (L / rate) * 60;
    const mIdx = motions.length;
    motions.push({
      kind: mode === "G0" ? "rapid" : "cut",
      pts: [from, to],
      lens: [0, L],
      t0: time,
      t1: time + dt,
      feed: mode === "G0" ? MACHINE.rapid : feed,
      mode,
      gline: null,
      tag,
    });
    time += dt;
    if (mode === "G0") rapidLen += L;
    else cutLen += L;
    pos = { ...to };
    // gcode
    const words = [];
    if (lastMode !== mode) words.push(mode);
    words.push(...axisWords(to));
    if (mode !== "G0" && feed !== lastFeed) {
      words.push("F" + fmt(feed));
      lastFeed = feed;
    }
    lastMode = mode;
    if (words.length) {
      motions[mIdx].gline = gcode.length;
      pushLine(words.join(" "), mIdx);
    }
  };

  const safeTraverse = (to, where, tag) => {
    checkTravel(to, where);
    const xyMoved =
      Math.abs(to.x - pos.x) > 1e-9 || Math.abs(to.y - pos.y) > 1e-9;
    if (!xyMoved) {
      addLinear(to, "G0", null, tag);
      return;
    }
    const safe = Math.max(setup.clearance, pos.z, to.z);
    if (Math.abs(pos.z - safe) > 1e-9)
      addLinear({ ...pos, z: safe }, "G0", null, tag);
    addLinear({ x: to.x, y: to.y, z: safe }, "G0", null, tag);
    if (Math.abs(to.z - safe) > 1e-9)
      addLinear({ x: to.x, y: to.y, z: to.z }, "G0", null, tag);
  };

  pushLine("G21 G90 G17 G94  (dropcut · semantic CAM)");

  cmds.forEach((c, i) => {
    const where = `${c.kind}${c.tag ? ` [${c.tag}]` : ""} · op ${i + 1}`;
    switch (c.kind) {
      case "comment":
        ir.push({ text: `; ${c.text}`, tag: null });
        pushLine(`(${c.text.replace(/[()]/g, "")})`);
        break;
      case "tool-change":
        ir.push({
          text: `tool-change  →  ${c.tool.name} ⌀${c.tool.diameter}`,
          tag: c.tag,
        });
        if (spindleOn)
          errors.push({
            level: "error",
            message: `${where}: tool change requires spindle off`,
          });
        curTool = c.tool;
        pushLine(`(tool: ${c.tool.name})`);
        pushLine(`T${c.tool.id} M6`);
        break;
      case "spindle":
        if (c.mode === "off") {
          ir.push({ text: "spindle  →  off", tag: null });
          spindleOn = false;
          pushLine("M5");
        } else {
          ir.push({
            text: `spindle  →  ${c.mode} ${c.speed} rpm`,
            tag: null,
          });
          if (c.speed < MACHINE.spindle[0] || c.speed > MACHINE.spindle[1])
            errors.push({
              level: "error",
              message: `${where}: ${c.speed} rpm outside machine range ${MACHINE.spindle[0]}–${MACHINE.spindle[1]}`,
            });
          spindleOn = true;
          pushLine(`S${fmt(c.speed)} ${c.mode === "cw" ? "M3" : "M4"}`);
        }
        break;
      case "traverse":
        ir.push({
          text: `traverse  →  (${fmt(c.to.x)}, ${fmt(c.to.y)}, ${fmt(
            c.to.z
          )})   [safe]`,
          tag: c.tag,
        });
        safeTraverse(c.to, where, c.tag);
        break;
      case "cut": {
        ir.push({
          text: `cut       →  (${fmt(c.to.x)}, ${fmt(c.to.y)}, ${fmt(
            c.to.z
          )})   F${c.feed ?? "?"}`,
          tag: c.tag,
        });
        if (!curTool)
          errors.push({
            level: "error",
            message: `${where}: cut with no tool loaded`,
          });
        if (!spindleOn)
          errors.push({
            level: "error",
            message: `${where}: cut with spindle stopped`,
          });
        if (c.feed == null || c.feed <= 0) {
          errors.push({
            level: "error",
            message: `${where}: cutting move requires a feed rate`,
          });
          break;
        }
        checkTravel(c.to, where);
        addLinear(c.to, "G1", c.feed, c.tag);
        break;
      }
      case "arc": {
        const feed = c.feed ?? lastFeed;
        ir.push({
          text: `arc ${c.ccw ? "ccw" : "cw"}   →  (${fmt(c.to.x)}, ${fmt(
            c.to.y
          )}, ${fmt(c.to.z)})  c(${fmt(c.center.x)}, ${fmt(
            c.center.y
          )})  F${feed ?? "?"}`,
          tag: c.tag,
        });
        if (!curTool || !spindleOn)
          errors.push({
            level: "error",
            message: `${where}: arc requires loaded tool and running spindle`,
          });
        if (feed == null || feed <= 0) {
          errors.push({
            level: "error",
            message: `${where}: arc requires a feed rate (none active)`,
          });
          break;
        }
        checkTravel(c.to, where);
        const from = { ...pos };
        const cx = c.center.x,
          cy = c.center.y;
        const r0 = Math.hypot(from.x - cx, from.y - cy);
        const r1 = Math.hypot(c.to.x - cx, c.to.y - cy);
        if (Math.abs(r0 - r1) > 0.05)
          errors.push({
            level: "error",
            message: `${where}: arc endpoints not equidistant from center (Δr ${fmt(
              Math.abs(r0 - r1)
            )})`,
          });
        let a0 = Math.atan2(from.y - cy, from.x - cx);
        let a1 = Math.atan2(c.to.y - cy, c.to.x - cx);
        let sweep;
        if (c.ccw) {
          sweep = a1 - a0;
          if (sweep <= 1e-9) sweep += Math.PI * 2;
        } else {
          sweep = a1 - a0;
          if (sweep >= -1e-9) sweep -= Math.PI * 2;
        }
        const N = Math.max(8, Math.ceil((Math.abs(sweep) * r0) / 0.5));
        const pts = [];
        const lens = [];
        let L = 0;
        for (let k = 0; k <= N; k++) {
          const a = a0 + (sweep * k) / N;
          const z = from.z + ((c.to.z - from.z) * k) / N;
          const pt = { x: cx + r0 * Math.cos(a), y: cy + r0 * Math.sin(a), z };
          if (k > 0) L += dist(pts[k - 1], pt);
          pts.push(pt);
          lens.push(L);
        }
        const dt = (L / feed) * 60;
        const mode = c.ccw ? "G3" : "G2";
        const mIdx = motions.length;
        motions.push({
          kind: "cut",
          pts,
          lens,
          t0: time,
          t1: time + dt,
          feed,
          mode,
          gline: null,
          tag: c.tag,
        });
        time += dt;
        cutLen += L;
        pos = { ...c.to };
        const words = [mode];
        const I = cx - from.x,
          J = cy - from.y;
        words.push(...axisWords(c.to));
        words.push("I" + fmt(I), "J" + fmt(J));
        if (feed !== lastFeed) {
          words.push("F" + fmt(feed));
          lastFeed = feed;
        }
        lastMode = mode;
        motions[mIdx].gline = gcode.length;
        pushLine(words.join(" "), mIdx);
        break;
      }
      case "dwell":
        ir.push({ text: `dwell     →  ${c.seconds}s`, tag: null });
        time += c.seconds;
        pushLine(`G4 P${fmt(c.seconds)}`);
        break;
      default:
        break;
    }
  });

  if (spindleOn) {
    errors.push({
      level: "warning",
      message: "program ends with spindle running — auto-appending M5",
    });
    pushLine("M5");
  }
  pushLine("M30");

  const allDiags = [...errors, ...diags];
  const hasErrors = allDiags.some((d) => d.level === "error");

  return {
    ok: !hasErrors,
    error: null,
    diagnostics: allDiags,
    ir,
    gcode: hasErrors ? [] : gcode,
    motions: hasErrors ? [] : motions,
    total: hasErrors ? 0 : time,
    setup,
    stats: { cutLen, rapidLen, lines: gcode.length },
  };
}

/* ============================================================================
   EDITOR — textarea + highlight overlay
   ========================================================================= */

const KEYWORDS =
  /\b(const|let|var|function|return|if|else|for|while|of|in|new|true|false|null)\b/;
const DSLIDS = /\b(job|tools|p|mm|rpm|mmPerMin|deg)\b/;

function highlight(code) {
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const tokens = [];
  const re =
    /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_$][\w$]*\b)|([\s\S])/g;
  let m;
  while ((m = re.exec(code))) {
    if (m[1]) tokens.push(`<span style="color:${C.dim};font-style:italic">${esc(m[1])}</span>`);
    else if (m[2]) tokens.push(`<span style="color:#D8B87A">${esc(m[2])}</span>`);
    else if (m[3]) tokens.push(`<span style="color:${C.teal}">${esc(m[3])}</span>`);
    else if (m[4]) {
      const w = m[4];
      if (KEYWORDS.test(w))
        tokens.push(`<span style="color:#8FA8C8">${esc(w)}</span>`);
      else if (DSLIDS.test(w))
        tokens.push(`<span style="color:${C.amber}">${esc(w)}</span>`);
      else tokens.push(esc(w));
    } else tokens.push(esc(m[5]));
  }
  return tokens.join("") + "\n";
}

function Editor({ code, onChange }) {
  const taRef = useRef(null);
  const hlRef = useRef(null);
  const gutRef = useRef(null);
  const lines = useMemo(() => code.split("\n").length, [code]);
  const html = useMemo(() => highlight(code), [code]);

  const sync = () => {
    const ta = taRef.current;
    if (!ta) return;
    if (hlRef.current) {
      hlRef.current.scrollTop = ta.scrollTop;
      hlRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutRef.current) gutRef.current.scrollTop = ta.scrollTop;
  };

  const onKeyDown = (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = taRef.current;
      const { selectionStart: s, selectionEnd: en, value } = ta;
      const next = value.slice(0, s) + "  " + value.slice(en);
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = s + 2;
      });
    }
  };

  const pad = "14px 16px";
  const shared = {
    margin: 0,
    padding: pad,
    fontFamily: MONO,
    fontSize: 12.5,
    lineHeight: "1.6",
    whiteSpace: "pre",
    tabSize: 2,
  };

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0, position: "relative" }}>
      <div
        ref={gutRef}
        style={{
          width: 44,
          overflow: "hidden",
          background: C.panel2,
          borderRight: `1px solid ${C.line}`,
          color: C.dim,
          textAlign: "right",
          userSelect: "none",
          flexShrink: 0,
          ...shared,
          padding: "14px 10px 14px 0",
        }}
      >
        {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
      </div>
      <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
        <pre
          ref={hlRef}
          aria-hidden
          style={{
            ...shared,
            position: "absolute",
            inset: 0,
            overflow: "hidden",
            color: C.text,
            pointerEvents: "none",
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <textarea
          ref={taRef}
          value={code}
          wrap="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onScroll={sync}
          onKeyDown={onKeyDown}
          style={{
            ...shared,
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            resize: "none",
            border: "none",
            outline: "none",
            background: "transparent",
            color: "transparent",
            caretColor: C.amber,
            overflow: "auto",
          }}
        />
      </div>
    </div>
  );
}

/* ============================================================================
   3D VIEWER + DRO
   ========================================================================= */

function Viewer({ compiled, timeRef, playingRef, speedRef, onLine, seekRef }) {
  const hostRef = useRef(null);
  const droX = useRef(null),
    droY = useRef(null),
    droZ = useRef(null),
    droF = useRef(null),
    droM = useRef(null),
    droT = useRef(null);
  const scrubRef = useRef(null);
  const scrubbing = useRef(false);
  const compiledRef = useRef(compiled);
  compiledRef.current = compiled;
  const lastLine = useRef(-1);
  const three = useRef({});

  /* ---- scene bootstrap (once) ---- */
  useEffect(() => {
    const host = hostRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(C.panel2);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 3000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.style.display = "block";
    host.style.overflow = "hidden";
    host.appendChild(renderer.domElement);

    const world = new THREE.Group(); // machine coords: map (x,y,z)→(x,z,-y)
    scene.add(world);
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const dl = new THREE.DirectionalLight(0xffffff, 0.5);
    dl.position.set(80, 200, 120);
    scene.add(dl);

    // orbit state
    const orbit = { theta: -0.9, phi: 1.05, r: 150, tx: 30, ty: 0, tz: 20 };
    const applyCam = () => {
      const { theta, phi, r } = orbit;
      const cx = orbit.tx,
        cy = orbit.tz,
        cz = -orbit.ty; // three coords of target
      camera.position.set(
        cx + r * Math.sin(phi) * Math.cos(theta),
        cy + r * Math.cos(phi),
        cz + r * Math.sin(phi) * Math.sin(theta)
      );
      camera.lookAt(cx, cy, cz);
    };
    applyCam();

    let dragging = false,
      px = 0,
      py = 0;
    const dom = renderer.domElement;
    dom.style.cursor = "grab";
    dom.addEventListener("pointerdown", (e) => {
      dragging = true;
      px = e.clientX;
      py = e.clientY;
      dom.setPointerCapture(e.pointerId);
      dom.style.cursor = "grabbing";
    });
    dom.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      orbit.theta += (e.clientX - px) * 0.006;
      orbit.phi = Math.min(
        Math.PI - 0.15,
        Math.max(0.15, orbit.phi - (e.clientY - py) * 0.006)
      );
      px = e.clientX;
      py = e.clientY;
      applyCam();
    });
    dom.addEventListener("pointerup", (e) => {
      dragging = false;
      dom.releasePointerCapture(e.pointerId);
      dom.style.cursor = "grab";
    });
    dom.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        orbit.r = Math.min(600, Math.max(30, orbit.r * (1 + e.deltaY * 0.001)));
        applyCam();
      },
      { passive: false }
    );

    const resize = () => {
      const w = host.clientWidth,
        h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    // tool marker
    const marker = new THREE.Group();
    const tipGeo = new THREE.ConeGeometry(1.4, 4, 16);
    const tip = new THREE.Mesh(
      tipGeo,
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    tip.rotation.x = Math.PI;
    tip.position.y = 2;
    const shank = new THREE.Mesh(
      new THREE.CylinderGeometry(1.2, 1.2, 22, 12),
      new THREE.MeshStandardMaterial({
        color: 0x9fb2c4,
        metalness: 0.7,
        roughness: 0.35,
      })
    );
    shank.position.y = 15;
    marker.add(tip, shank);
    scene.add(marker);

    three.current = { scene, camera, renderer, world, marker, applyCam };

    // rAF loop
    let raf;
    let prev = performance.now();
    const posAt = (t) => {
      const ms = compiledRef.current?.motions ?? [];
      if (!ms.length) return null;
      let lo = 0,
        hi = ms.length - 1;
      if (t <= ms[0].t0) return { m: ms[0], pt: ms[0].pts[0], i: 0 };
      if (t >= ms[hi].t1) {
        const m = ms[hi];
        return { m, pt: m.pts[m.pts.length - 1], i: hi, done: true };
      }
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ms[mid].t1 < t) lo = mid + 1;
        else hi = mid;
      }
      const m = ms[lo];
      const f = (t - m.t0) / Math.max(m.t1 - m.t0, 1e-9);
      const L = m.lens[m.lens.length - 1] * f;
      let k = 1;
      while (k < m.lens.length && m.lens[k] < L) k++;
      const a = m.pts[k - 1],
        b = m.pts[Math.min(k, m.pts.length - 1)];
      const segL = m.lens[Math.min(k, m.lens.length - 1)] - m.lens[k - 1];
      const g = segL > 1e-9 ? (L - m.lens[k - 1]) / segL : 0;
      return {
        m,
        i: lo,
        pt: {
          x: a.x + (b.x - a.x) * g,
          y: a.y + (b.y - a.y) * g,
          z: a.z + (b.z - a.z) * g,
        },
      };
    };

    const setNum = (ref, v, w = 8) => {
      if (ref.current) ref.current.textContent = v.toFixed(3).padStart(w);
    };

    const updateVisuals = () => {
      const cur = compiledRef.current;
      const t = timeRef.current;
      const r = posAt(t);
      if (r) {
        marker.visible = true;
        marker.position.set(r.pt.x, r.pt.z, -r.pt.y);
        setNum(droX, r.pt.x);
        setNum(droY, r.pt.y);
        setNum(droZ, r.pt.z);
        if (droF.current)
          droF.current.textContent = String(Math.round(r.m.feed)).padStart(5);
        if (droM.current) droM.current.textContent = r.m.mode;
        // trail drawRange
        const tr = three.current.trail;
        if (tr) {
          let count = 0;
          const ms = cur.motions;
          for (let i = 0; i < r.i; i++) count += ms[i].pts.length;
          count += 1; // at least start of current
          tr.geometry.setDrawRange(0, r.done ? Infinity : count);
        }
        const gl = r.m.gline;
        if (gl != null && gl !== lastLine.current) {
          lastLine.current = gl;
          onLine(gl);
        }
      } else {
        marker.visible = false;
      }
      if (scrubRef.current && !scrubbing.current && cur?.total > 0)
        scrubRef.current.value = String(
          Math.round((t / cur.total) * 1000)
        );
      if (droT.current)
        droT.current.textContent = `${fmtTime(t)} / ${fmtTime(
          cur?.total ?? 0
        )}`;
    };
    three.current.updateVisuals = updateVisuals;
    if (seekRef) seekRef.current = updateVisuals;

    const loop = (now) => {
      raf = requestAnimationFrame(loop);
      const dt = (now - prev) / 1000;
      prev = now;
      const cur = compiledRef.current;
      if (playingRef.current && cur?.total > 0) {
        timeRef.current += dt * speedRef.current;
        if (timeRef.current >= cur.total) {
          timeRef.current = cur.total;
          playingRef.current = false;
        }
      }
      updateVisuals();
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- rebuild geometry when program changes ---- */
  useEffect(() => {
    const { world } = three.current;
    if (!world) return;
    while (world.children.length) {
      const c = world.children.pop();
      c.traverse?.((o) => {
        o.geometry?.dispose?.();
        o.material?.dispose?.();
      });
      world.remove(c);
    }
    if (three.current.trail) three.current.trail = null;
    lastLine.current = -1;

    const stock = compiled?.setup?.stock ?? { x: 60, y: 40, z: 12 };
    const v3 = (x, y, z) => new THREE.Vector3(x, z, -y);

    // grid at stock bottom
    const grid = new THREE.GridHelper(240, 24, 0x2a3542, 0x1f2732);
    grid.position.set(stock.x / 2, -stock.z - 0.01, -stock.y / 2);
    world.add(grid);

    // stock
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(stock.x, stock.z, stock.y),
      new THREE.MeshStandardMaterial({
        color: 0x33404f,
        transparent: true,
        opacity: 0.22,
        metalness: 0.2,
        roughness: 0.8,
      })
    );
    box.position.set(stock.x / 2, -stock.z / 2, -stock.y / 2);
    world.add(box);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(box.geometry),
      new THREE.LineBasicMaterial({ color: 0x46566a })
    );
    edges.position.copy(box.position);
    world.add(edges);

    // origin axes
    const mkAxis = (to, color) => {
      const g = new THREE.BufferGeometry().setFromPoints([
        v3(0, 0, 0.01),
        to,
      ]);
      world.add(
        new THREE.Line(g, new THREE.LineBasicMaterial({ color }))
      );
    };
    mkAxis(v3(14, 0, 0), 0xdf6a5a);
    mkAxis(v3(0, 14, 0), 0x6fbf6f);
    mkAxis(v3(0, 0, 14), 0x6a9adf);

    const motions = compiled?.motions ?? [];
    if (motions.length) {
      const rapidPts = [];
      const cutPts = [];
      const allPts = [];
      for (const m of motions) {
        for (let i = 0; i < m.pts.length - 1; i++) {
          const a = v3(m.pts[i].x, m.pts[i].y, m.pts[i].z);
          const b = v3(m.pts[i + 1].x, m.pts[i + 1].y, m.pts[i + 1].z);
          (m.kind === "rapid" ? rapidPts : cutPts).push(a, b);
        }
        for (const pt of m.pts) allPts.push(v3(pt.x, pt.y, pt.z));
      }
      const cutGeo = new THREE.BufferGeometry().setFromPoints(cutPts);
      world.add(
        new THREE.LineSegments(
          cutGeo,
          new THREE.LineBasicMaterial({
            color: new THREE.Color(C.teal),
            transparent: true,
            opacity: 0.55,
          })
        )
      );
      const rapidGeo = new THREE.BufferGeometry().setFromPoints(rapidPts);
      const rapidLine = new THREE.LineSegments(
        rapidGeo,
        new THREE.LineDashedMaterial({
          color: new THREE.Color(C.amber),
          dashSize: 1.6,
          gapSize: 1.6,
          transparent: true,
          opacity: 0.5,
        })
      );
      rapidLine.computeLineDistances();
      world.add(rapidLine);

      // completed trail
      const trailGeo = new THREE.BufferGeometry().setFromPoints(allPts);
      trailGeo.setDrawRange(0, 0);
      const trail = new THREE.Line(
        trailGeo,
        new THREE.LineBasicMaterial({ color: 0xf2f6fa })
      );
      world.add(trail);
      three.current.trail = trail;
    }
    timeRef.current = 0;
    three.current.updateVisuals?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiled]);

  const droRow = (label, ref, unit) => (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
      <span style={{ color: C.dim, width: 12 }}>{label}</span>
      <span
        ref={ref}
        style={{
          color: C.amber,
          fontSize: 15,
          fontWeight: 600,
          whiteSpace: "pre",
          textShadow: `0 0 8px ${C.amber}33`,
        }}
      >
        {"   0.000"}
      </span>
      <span style={{ color: C.dim, fontSize: 10 }}>{unit}</span>
    </div>
  );

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
      {/* DRO — the readout */}
      <div
        style={{
          position: "absolute",
          top: 10,
          right: 10,
          background: "#10141Ad9",
          border: `1px solid ${C.line}`,
          borderRadius: 4,
          padding: "10px 14px",
          fontFamily: MONO,
          fontSize: 13,
          lineHeight: 1.5,
          pointerEvents: "none",
          minWidth: 168,
        }}
      >
        {droRow("X", droX, "mm")}
        {droRow("Y", droY, "mm")}
        {droRow("Z", droZ, "mm")}
        <div
          style={{
            borderTop: `1px solid ${C.line}`,
            marginTop: 6,
            paddingTop: 6,
            display: "flex",
            justifyContent: "space-between",
            fontSize: 11,
            color: C.dim,
          }}
        >
          <span>
            <span ref={droM} style={{ color: C.text }}>
              G0
            </span>
          </span>
          <span>
            F
            <span ref={droF} style={{ color: C.text, whiteSpace: "pre" }}>
              {"    0"}
            </span>
          </span>
        </div>
      </div>
      {/* transport */}
      <div
        style={{
          position: "absolute",
          left: 10,
          right: 10,
          bottom: 10,
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: "#10141Ad9",
          border: `1px solid ${C.line}`,
          borderRadius: 4,
          padding: "8px 12px",
          fontFamily: MONO,
        }}
      >
        <button
          onClick={() => {
            if (!compiled?.total) return;
            if (timeRef.current >= compiled.total) timeRef.current = 0;
            playingRef.current = !playingRef.current;
          }}
          style={{
            background: C.amber,
            color: "#1A1408",
            border: "none",
            borderRadius: 3,
            width: 30,
            height: 24,
            fontSize: 11,
            fontWeight: 700,
            cursor: "pointer",
            fontFamily: MONO,
          }}
        >
          ▶︎⏸
        </button>
        <input
          ref={scrubRef}
          type="range"
          min={0}
          max={1000}
          defaultValue={0}
          onPointerDown={() => (scrubbing.current = true)}
          onPointerUp={() => (scrubbing.current = false)}
          onInput={(e) => {
            const cur = compiledRef.current;
            if (!cur?.total) return;
            timeRef.current = (Number(e.target.value) / 1000) * cur.total;
            three.current.updateVisuals?.();
          }}
          style={{ flex: 1, accentColor: C.amber }}
        />
        <select
          defaultValue={"8"}
          onChange={(e) => (speedRef.current = Number(e.target.value))}
          style={{
            background: C.panel,
            color: C.text,
            border: `1px solid ${C.line}`,
            borderRadius: 3,
            fontFamily: MONO,
            fontSize: 11,
            padding: "3px 4px",
          }}
        >
          {[1, 4, 8, 32, 128].map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <span ref={droT} style={{ color: C.dim, fontSize: 11, whiteSpace: "nowrap" }}>
          00:00 / 00:00
        </span>
      </div>
    </div>
  );
}

/* ============================================================================
   APP
   ========================================================================= */

export default function DropcutIDE() {
  const [code, setCode] = useState(DEFAULT_CODE);
  const [compiled, setCompiled] = useState(() => compileProgram(DEFAULT_CODE));
  const [tab, setTab] = useState("gcode");
  const [activeLine, setActiveLine] = useState(-1);
  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef(8);
  const seekRef = useRef(null);
  const gcodeScroll = useRef(null);

  // debounce compile
  useEffect(() => {
    const id = setTimeout(() => {
      playingRef.current = false;
      timeRef.current = 0;
      setActiveLine(-1);
      setCompiled(compileProgram(code));
    }, 600);
    return () => clearTimeout(id);
  }, [code]);

  const onLine = useCallback((gl) => setActiveLine(gl), []);

  // auto-scroll active gcode line
  useEffect(() => {
    if (tab !== "gcode") return;
    const el = gcodeScroll.current?.querySelector('[data-active="1"]');
    el?.scrollIntoView({ block: "nearest" });
  }, [activeLine, tab]);

  const errCount = compiled.diagnostics.filter((d) => d.level === "error")
    .length + (compiled.error ? 1 : 0);
  const warnCount = compiled.diagnostics.filter((d) => d.level === "warning")
    .length;

  const seekToMotion = (mIdx) => {
    const m = compiled.motions[mIdx];
    if (!m) return;
    timeRef.current = m.t0;
    playingRef.current = false;
    seekRef.current?.();
  };

  const tabBtn = (id, label, badge) => (
    <button
      key={id}
      onClick={() => setTab(id)}
      style={{
        background: tab === id ? C.panel : "transparent",
        color: tab === id ? C.text : C.dim,
        border: "none",
        borderTop:
          tab === id ? `2px solid ${C.amber}` : "2px solid transparent",
        padding: "7px 14px 8px",
        fontFamily: MONO,
        fontSize: 11.5,
        letterSpacing: "0.04em",
        cursor: "pointer",
      }}
    >
      {label}
      {badge ? (
        <span
          style={{
            marginLeft: 6,
            color: badge.color,
            fontWeight: 700,
          }}
        >
          {badge.n}
        </span>
      ) : null}
    </button>
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: C.bed,
        color: C.text,
        fontFamily: MONO,
        overflow: "hidden",
      }}
    >
      {/* header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "0 16px",
          height: 46,
          borderBottom: `1px solid ${C.line}`,
          background: C.panel2,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            fontFamily:
              '"Avenir Next Condensed", "Arial Narrow", system-ui, sans-serif',
            fontWeight: 800,
            fontSize: 17,
            letterSpacing: "0.22em",
            color: C.text,
          }}
        >
          DROP<span style={{ color: C.amber }}>CUT</span>
        </div>
        <div style={{ width: 1, height: 18, background: C.line }} />
        <div style={{ fontSize: 11, color: C.dim }}>
          semantic CAM → RS-274 · {MACHINE.name}
        </div>
        <div style={{ flex: 1 }} />
        {compiled.ok ? (
          <div style={{ fontSize: 11, color: C.dim }}>
            <span style={{ color: C.teal }}>● compiled</span>
            {"  "}· {compiled.stats?.lines ?? 0} lines · cut{" "}
            {Math.round(compiled.stats?.cutLen ?? 0)} mm · est{" "}
            {fmtTime(compiled.total)}
            {warnCount ? (
              <span style={{ color: C.warn }}> · {warnCount} warn</span>
            ) : null}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: C.err }}>
            ● {compiled.error ? "runtime error" : `${errCount} error${errCount > 1 ? "s" : ""}`} — G-code emission blocked
          </div>
        )}
      </div>

      {/* body */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* left: editor */}
        <div
          style={{
            width: "44%",
            minWidth: 340,
            display: "flex",
            flexDirection: "column",
            borderRight: `1px solid ${C.line}`,
            background: C.panel,
          }}
        >
          <div
            style={{
              padding: "6px 14px",
              fontSize: 10.5,
              letterSpacing: "0.08em",
              color: C.dim,
              borderBottom: `1px solid ${C.line}`,
              textTransform: "uppercase",
            }}
          >
            program.cam.js — recompiles as you type
          </div>
          <Editor code={code} onChange={setCode} />
        </div>

        {/* right */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          <Viewer
            compiled={compiled}
            timeRef={timeRef}
            playingRef={playingRef}
            speedRef={speedRef}
            onLine={onLine}
            seekRef={seekRef}
          />

          {/* bottom tabs */}
          <div
            style={{
              height: "42%",
              minHeight: 180,
              display: "flex",
              flexDirection: "column",
              borderTop: `1px solid ${C.line}`,
              background: C.panel,
            }}
          >
            <div
              style={{
                display: "flex",
                borderBottom: `1px solid ${C.line}`,
                background: C.panel2,
                flexShrink: 0,
              }}
            >
              {tabBtn("gcode", "G-CODE")}
              {tabBtn("ir", "CANONICAL IR")}
              {tabBtn(
                "diag",
                "DIAGNOSTICS",
                errCount
                  ? { n: errCount, color: C.err }
                  : warnCount
                  ? { n: warnCount, color: C.warn }
                  : null
              )}
            </div>

            <div
              ref={gcodeScroll}
              style={{
                flex: 1,
                overflow: "auto",
                fontSize: 12,
                lineHeight: 1.55,
                padding: "8px 0",
              }}
            >
              {tab === "gcode" &&
                (!compiled.ok ? (
                  <EmptyNote
                    title="No G-code emitted"
                    body="The postprocessor only accepts a validated program. Fix the diagnostics and the compiler will emit again."
                  />
                ) : (
                  compiled.gcode.map((l, i) => {
                    const active = i === activeLine;
                    return (
                      <div
                        key={i}
                        data-active={active ? "1" : "0"}
                        onClick={() =>
                          l.motion != null && seekToMotion(l.motion)
                        }
                        style={{
                          display: "flex",
                          gap: 14,
                          padding: "0 14px",
                          background: active ? C.sel : "transparent",
                          cursor: l.motion != null ? "pointer" : "default",
                          borderLeft: active
                            ? `2px solid ${C.amber}`
                            : "2px solid transparent",
                        }}
                      >
                        <span
                          style={{
                            color: C.dim,
                            width: 34,
                            textAlign: "right",
                            flexShrink: 0,
                            userSelect: "none",
                          }}
                        >
                          {l.n}
                        </span>
                        <span
                          style={{
                            whiteSpace: "pre",
                            color: l.text.startsWith("(")
                              ? C.dim
                              : /^G0\b/.test(l.text)
                              ? C.amber
                              : /^G[123]\b/.test(l.text)
                              ? C.teal
                              : C.text,
                          }}
                        >
                          {l.text}
                        </span>
                      </div>
                    );
                  })
                ))}

              {tab === "ir" &&
                (compiled.ir.length === 0 ? (
                  <EmptyNote
                    title="No canonical IR"
                    body="The program produced no operations — call job.* to build one."
                  />
                ) : (
                  compiled.ir.map((c, i) => (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        gap: 14,
                        padding: "0 14px",
                        color: c.text.startsWith(";") ? C.dim : C.text,
                      }}
                    >
                      <span
                        style={{
                          color: C.dim,
                          width: 34,
                          textAlign: "right",
                          flexShrink: 0,
                        }}
                      >
                        {i + 1}
                      </span>
                      <span style={{ whiteSpace: "pre", flex: 1 }}>
                        {c.text}
                      </span>
                      {c.tag && (
                        <span style={{ color: C.amberDim, flexShrink: 0 }}>
                          {c.tag}
                        </span>
                      )}
                    </div>
                  ))
                ))}

              {tab === "diag" && (
                <div style={{ padding: "0 14px" }}>
                  {compiled.error && (
                    <DiagRow level="error" message={compiled.error} />
                  )}
                  {compiled.diagnostics.map((d, i) => (
                    <DiagRow key={i} level={d.level} message={d.message} />
                  ))}
                  {!compiled.error && compiled.diagnostics.length === 0 && (
                    <EmptyNote
                      title="Clean pass"
                      body="Validation ran: travels, spindle interlocks, feed presence, arc geometry, unit brands. Nothing to report."
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyNote({ title, body }) {
  return (
    <div style={{ padding: "18px 20px", maxWidth: 520 }}>
      <div style={{ color: C.text, fontSize: 12.5, marginBottom: 4 }}>
        {title}
      </div>
      <div style={{ color: C.dim, fontSize: 11.5, lineHeight: 1.6 }}>
        {body}
      </div>
    </div>
  );
}

function DiagRow({ level, message }) {
  const color = level === "error" ? C.err : C.warn;
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        padding: "3px 0",
        alignItems: "baseline",
      }}
    >
      <span
        style={{
          color,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.06em",
          width: 52,
          flexShrink: 0,
          textTransform: "uppercase",
        }}
      >
        {level}
      </span>
      <span style={{ color: C.text, fontSize: 12, lineHeight: 1.5 }}>
        {message}
      </span>
    </div>
  );
}
