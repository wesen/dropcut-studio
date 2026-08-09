import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import * as THREE from "three";

/* ============================================================
   Z1 G-CODE CHECK · LEVEL 2 — stock-removal simulator
   Backplot + Z1 profile checks (Level 1) plus:
     · rectangular stock definition
     · flat / ball / V-bit tool geometry per tool number
     · heightmap material-removal simulation with playback
     · rapid-through-stock and spoilboard-penetration detection
   ============================================================ */

const C = {
  bg: "#0E1216",
  panel: "#151B21",
  panel2: "#10151A",
  edge: "#242E38",
  text: "#DEE6EE",
  dim: "#77828E",
  cut: "#3DDC97",
  rapid: "#5B9DFF",
  warn: "#FFB020",
  err: "#FF5C5C",
};

const MONO = "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const COND = "'Barlow Condensed', 'Arial Narrow', ui-sans-serif, sans-serif";

const Z1 = {
  name: "MAKERA Z1",
  travel: { x: 200, y: 200, z: 100 },
  maxRPM: 13000,
  rapidRate: 3000, // mm/min, for time estimates
};

const KNOWN_G = new Set([0, 1, 2, 3, 4, 10, 17, 18, 19, 20, 21, 28, 30, 43, 49, 53, 54, 55, 56, 57, 58, 59, 90, 91, 92, 94]);
const KNOWN_M = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 30, 321, 322, 323, 324, 325, 331, 490, 495]);

/* ---------------- sample program ---------------- */

const SAMPLE = `; Z1 sample — 60x40 pocket + cut-out contour in 6mm stock
; Origin: stock top, front-left corner. Stock: 90 x 60 x 6 mm
; (two issues left in on purpose, near the end)
G21 G90 G17
G94
T1 M6           ; 3mm flat end mill
S12000 M3
G0 Z5.0
G0 X10.0 Y10.0
; --- pocket, 3 stepdowns ---
G1 Z-1.5 F300
G1 X70.0 F800
G1 Y40.0
G1 X10.0
G1 Y10.0
G1 X12.0 Y12.0
G1 Z-3.0 F300
G1 X68.0 F800
G1 Y38.0
G1 X12.0
G1 Y12.0
G1 X14.0 Y14.0
G1 Z-4.5 F300
G1 X66.0 F800
G1 Y36.0
G1 X14.0
G1 Y14.0
G0 Z5.0
; --- outer contour with arc corners, through-cut ---
G0 X5.0 Y15.0
G1 Z-6.2 F250
G1 Y45.0 F600
G2 X15.0 Y55.0 I10.0 J0.0
G1 X75.0
G2 X85.0 Y45.0 I0.0 J-10.0
G1 Y15.0
G2 X75.0 Y5.0 I-10.0 J0.0
G1 X15.0
G2 X5.0 Y15.0 I0.0 J10.0
G0 Z5.0
; --- engraving pass (issue: spindle gets stopped first) ---
M5
G0 X30.0 Y28.0
G1 Z-0.4 F200
G1 X60.0 F900
G0 Z5.0
; --- issue: rapid plows through uncut stock ---
G0 X78.0 Y50.0 Z-0.5
G0 X78.0 Y10.0
G0 Z5.0
G0 X0 Y0
M5
M2`;

/* ---------------- G-code parser (Level 1 core) ---------------- */

function parseGcode(text) {
  const rawLines = text.split(/\r?\n/);
  const segments = [];
  const issues = [];
  const toolChanges = [];
  const toolsUsed = new Set();
  let firstMotionSeen = false;

  const st = {
    x: 0, y: 0, z: 0,
    feed: 0, rpm: 0, tool: 1,
    abs: true, inch: false, spindle: false,
    motion: null, plane: 17,
  };

  const push = (sev, line, msg) => issues.push({ sev, line, msg });
  const u = (v) => (st.inch ? v * 25.4 : v);
  let time = 0; // minutes

  for (let li = 0; li < rawLines.length; li++) {
    const lineNo = li + 1;
    let s = rawLines[li];
    s = s.replace(/\(.*?\)/g, " ").replace(/;.*$/, "").trim();
    if (!s) continue;

    const words = [...s.matchAll(/([A-Za-z])\s*([+-]?\d*\.?\d+)/g)].map((m) => [m[1].toUpperCase(), parseFloat(m[2])]);
    if (!words.length) continue;

    let motion = null;
    let hasCoord = false;
    const nxt = {};
    const ijk = {};
    let rWord = null;
    let dwell = 0;

    for (const [w, v] of words) {
      if (w === "G") {
        const g = Math.round(v * 10) / 10;
        const gi = Math.floor(g);
        if (!KNOWN_G.has(gi)) push("warn", lineNo, `G${g} isn't in the Z1's supported code list`);
        if (gi <= 3) { motion = gi; st.motion = gi; }
        else if (gi === 20) { if (firstMotionSeen && !st.inch) push("warn", lineNo, "Units switch to inches (G20) after motion started"); st.inch = true; }
        else if (gi === 21) { if (firstMotionSeen && st.inch) push("warn", lineNo, "Units switch to mm (G21) after motion started"); st.inch = false; }
        else if (gi === 90) st.abs = true;
        else if (gi === 91) { st.abs = false; if (firstMotionSeen) push("warn", lineNo, "Switch to incremental mode (G91) mid-program — verify this is intended"); }
        else if (gi === 17 || gi === 18 || gi === 19) {
          st.plane = gi;
          if (gi !== 17) push("warn", lineNo, `Arc plane G${gi} — preview renders XY-plane (G17) arcs only`);
        }
        else if (gi === 28) push("info", lineNo, "G28 homing move — position after this depends on machine state, not shown in preview");
        else if (gi === 53) push("info", lineNo, "G53 machine-coordinate move — previewed in program coordinates");
      } else if (w === "M") {
        const m = Math.round(v);
        if (!KNOWN_M.has(m)) push("warn", lineNo, `M${m} isn't in the Z1's supported code list`);
        if (m === 3 || m === 4) st.spindle = true;
        else if (m === 5) st.spindle = false;
        else if (m === 6) toolChanges.push({ line: lineNo, tool: st.tool });
      } else if (w === "T") {
        st.tool = Math.round(v);
        toolsUsed.add(st.tool);
      } else if (w === "S") {
        st.rpm = v;
        if (v > Z1.maxRPM) push("err", lineNo, `S${v} exceeds the Z1's ${Z1.maxRPM.toLocaleString()} RPM spindle limit`);
      } else if (w === "F") {
        st.feed = u(v);
      } else if (w === "X" || w === "Y" || w === "Z") {
        nxt[w.toLowerCase()] = u(v); hasCoord = true;
      } else if (w === "I" || w === "J" || w === "K") {
        ijk[w.toLowerCase()] = u(v);
      } else if (w === "R") {
        rWord = u(v);
      } else if (w === "P") {
        dwell = v;
      }
    }

    if (words.some(([w, v]) => w === "G" && Math.floor(v) === 4)) {
      time += (dwell || 0) / 60;
      continue;
    }
    if (!hasCoord) continue;
    const mo = motion !== null ? motion : st.motion;
    if (mo === null) continue;
    firstMotionSeen = true;
    toolsUsed.add(st.tool);

    const from = [st.x, st.y, st.z];
    const to = [
      nxt.x !== undefined ? (st.abs ? nxt.x : st.x + nxt.x) : st.x,
      nxt.y !== undefined ? (st.abs ? nxt.y : st.y + nxt.y) : st.y,
      nxt.z !== undefined ? (st.abs ? nxt.z : st.z + nxt.z) : st.z,
    ];

    let pts = null;
    let len = 0;
    if ((mo === 2 || mo === 3) && st.plane === 17) {
      pts = arcPoints(from, to, ijk, rWord, mo === 2);
      for (let i = 1; i < pts.length; i++) len += dist3(pts[i - 1], pts[i]);
    } else {
      len = dist3(from, to);
    }

    if (len > 500) push("warn", lineNo, `Very large single move (${len.toFixed(0)} mm) — check for a missing decimal or unit mixup`);
    const isCut = mo !== 0;
    if (isCut && st.feed <= 0) push("err", lineNo, "Cutting move with no feed rate set");
    if (isCut && !st.spindle && len > 0.001) push("err", lineNo, "Cutting move while spindle is off (no M3 active)");

    const rate = isCut ? (st.feed > 0 ? st.feed : 100) : Z1.rapidRate;
    const t0 = time;
    time += len / rate;

    segments.push({
      type: isCut ? "cut" : "rapid",
      from, to, pts, line: lineNo,
      feed: st.feed, rpm: st.rpm, tool: st.tool, spindle: st.spindle,
      len, t0, t1: time,
    });

    st.x = to[0]; st.y = to[1]; st.z = to[2];
  }

  const bb = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const sg of segments) {
    const P = sg.pts || [sg.from, sg.to];
    for (const p of P) {
      bb.minX = Math.min(bb.minX, p[0]); bb.maxX = Math.max(bb.maxX, p[0]);
      bb.minY = Math.min(bb.minY, p[1]); bb.maxY = Math.max(bb.maxY, p[1]);
      bb.minZ = Math.min(bb.minZ, p[2]); bb.maxZ = Math.max(bb.maxZ, p[2]);
    }
  }
  if (!segments.length) Object.keys(bb).forEach((k) => (bb[k] = 0));

  return { segments, issues, bb, totalTime: time, totalLines: rawLines.length, toolChanges, toolsUsed: [...toolsUsed].sort((a, b) => a - b) };
}

function dist3(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function arcPoints(from, to, ijk, r, cw) {
  let cx, cy;
  if (ijk.i !== undefined || ijk.j !== undefined) {
    cx = from[0] + (ijk.i || 0);
    cy = from[1] + (ijk.j || 0);
  } else if (r !== null && r !== undefined) {
    const mx = (from[0] + to[0]) / 2, my = (from[1] + to[1]) / 2;
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const d = Math.hypot(dx, dy);
    if (d < 1e-9 || Math.abs(r) < d / 2 - 1e-6) return [from, to];
    const h = Math.sqrt(Math.max(0, r * r - (d * d) / 4));
    const ux = -dy / d, uy = dx / d;
    const sign = cw === r > 0 ? -1 : 1;
    cx = mx + sign * ux * h;
    cy = my + sign * uy * h;
  } else return [from, to];

  const a0 = Math.atan2(from[1] - cy, from[0] - cx);
  const a1 = Math.atan2(to[1] - cy, to[0] - cx);
  const radius = Math.hypot(from[0] - cx, from[1] - cy);
  let sweep = a1 - a0;
  if (cw) { if (sweep >= -1e-9) sweep -= Math.PI * 2; } else { if (sweep <= 1e-9) sweep += Math.PI * 2; }
  const steps = Math.max(4, Math.ceil((Math.abs(sweep) * Math.max(radius, 0.5)) / 0.4));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = a0 + sweep * t;
    pts.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a), from[2] + (to[2] - from[2]) * t]);
  }
  return pts;
}

/* ---------------- tool geometry ---------------- */

// z of cutter surface above the tip, at radius r from the axis. null outside the cutter.
function toolProfile(tool, r) {
  const R = Math.max(0.05, tool.dia / 2);
  if (r > R + 1e-9) return null;
  if (tool.type === "ball") return R - Math.sqrt(Math.max(0, R * R - r * r));
  if (tool.type === "v") {
    const t = Math.tan(((tool.angle || 60) * Math.PI) / 360);
    return t > 1e-6 ? r / t : 0;
  }
  return 0; // flat
}

const DEFAULT_TOOL = () => ({ type: "flat", dia: 3, angle: 60 });

/* ---------------- heightmap stock simulator ---------------- */

class StockSim {
  // stock: { w, d, h, ox, oy, topZ }  (min corner at ox,oy; occupies topZ-h .. topZ)
  constructor(stock, targetCells) {
    this.stock = stock;
    const maxDim = Math.max(stock.w, stock.d, 1);
    this.nx = Math.max(12, Math.round((targetCells * stock.w) / maxDim));
    this.ny = Math.max(12, Math.round((targetCells * stock.d) / maxDim));
    this.cw = stock.w / this.nx;
    this.ch = stock.d / this.ny;
    this.hm = new Float32Array((this.nx + 1) * (this.ny + 1));
    this.bottom = stock.topZ - stock.h;
    this.floor = this.bottom - Math.min(2, stock.h * 0.4); // render clamp for gouges
    this.reset();
  }
  reset() {
    this.hm.fill(this.stock.topZ);
    this.dirty = true;
  }
  // stamps the cutter at (x, y, tipZ). Returns max engagement depth (0 = touched nothing).
  stamp(x, y, tipZ, tool, remove) {
    const { stock, cw, ch, nx, ny, hm } = this;
    const R = tool.dia / 2;
    const lx = x - stock.ox, ly = y - stock.oy;
    if (lx < -R || lx > stock.w + R || ly < -R || ly > stock.d + R) return 0;
    if (tipZ >= this.stock.topZ - 1e-6 && tipZ >= this._maxIn(lx, ly, R)) {
      // above every reachable cell — cheap early-out for most rapids
    }
    const i0 = Math.max(0, Math.floor((lx - R) / cw));
    const i1 = Math.min(nx, Math.ceil((lx + R) / cw));
    const j0 = Math.max(0, Math.floor((ly - R) / ch));
    const j1 = Math.min(ny, Math.ceil((ly + R) / ch));
    let maxCut = 0;
    for (let j = j0; j <= j1; j++) {
      const gy = j * ch;
      const row = j * (nx + 1);
      for (let i = i0; i <= i1; i++) {
        const gx = i * cw;
        const r = Math.hypot(gx - lx, gy - ly);
        const prof = toolProfile(tool, r);
        if (prof === null) continue;
        const surf = tipZ + prof;
        const cur = hm[row + i];
        if (surf < cur - 1e-6) {
          const cut = cur - surf;
          if (cut > maxCut) maxCut = cut;
          if (remove) {
            hm[row + i] = Math.max(surf, this.floor);
            this.dirty = true;
          }
        }
      }
    }
    return maxCut;
  }
  _maxIn() { return -Infinity; } // placeholder (kept simple; bounds check above suffices)

  // apply a fraction range [f0..f1] of a segment. onRapidCut(depth) fires if a rapid removes material.
  sweep(seg, tool, f0, f1, onRapidCut) {
    if (seg.len <= 1e-9) {
      if (f1 >= 1) {
        const d = this.stamp(seg.to[0], seg.to[1], seg.to[2], tool, true);
        if (d > 0.01 && seg.type === "rapid" && onRapidCut) onRapidCut(d);
      }
      return;
    }
    const P = seg.pts || [seg.from, seg.to];
    if (!seg._cum) {
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + dist3(P[i - 1], P[i]));
      seg._cum = cum;
    }
    const cum = seg._cum;
    const L = cum[cum.length - 1];
    const step = Math.min(this.cw, this.ch) * 0.55;
    const s0 = f0 * L, s1 = f1 * L;
    const n = Math.max(1, Math.ceil((s1 - s0) / step));
    let k0 = 1;
    let rapidDepth = 0;
    for (let k = 0; k <= n; k++) {
      const s = s0 + ((s1 - s0) * k) / n;
      while (k0 < cum.length - 1 && cum[k0] < s) k0++;
      const a = P[k0 - 1], b = P[k0];
      const segLen = cum[k0] - cum[k0 - 1];
      const t = segLen > 1e-9 ? (s - cum[k0 - 1]) / segLen : 0;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const z = a[2] + (b[2] - a[2]) * t;
      const d = this.stamp(x, y, z, tool, true);
      if (seg.type === "rapid" && d > rapidDepth) rapidDepth = d;
    }
    if (rapidDepth > 0.02 && onRapidCut) onRapidCut(rapidDepth);
  }
}

/* ---------------- whole-program analysis ---------------- */

function runGlobalChecks(parsed, settings, stock, tools) {
  const out = [];
  const { bb, segments } = parsed;
  if (!segments.length) return out;

  const spanX = bb.maxX - bb.minX, spanY = bb.maxY - bb.minY, spanZ = bb.maxZ - bb.minZ;
  if (spanX > Z1.travel.x) out.push({ sev: "err", line: null, msg: `X span ${spanX.toFixed(1)} mm exceeds the Z1's ${Z1.travel.x} mm travel` });
  if (spanY > Z1.travel.y) out.push({ sev: "err", line: null, msg: `Y span ${spanY.toFixed(1)} mm exceeds the Z1's ${Z1.travel.y} mm travel` });
  if (spanZ > Z1.travel.z) out.push({ sev: "err", line: null, msg: `Z span ${spanZ.toFixed(1)} mm exceeds the Z1's ${Z1.travel.z} mm travel` });

  const bottom = stock.topZ - stock.h;
  const seen = new Set();
  for (const sg of segments) {
    if (sg.type === "rapid") {
      const xy = Math.hypot(sg.to[0] - sg.from[0], sg.to[1] - sg.from[1]);
      const lowZ = Math.min(sg.from[2], sg.to[2]);
      if (xy > 0.01 && lowZ < settings.safeZ && !seen.has("r" + sg.line)) {
        seen.add("r" + sg.line);
        out.push({ sev: "warn", line: sg.line, msg: `Rapid travels in XY at Z=${lowZ.toFixed(2)} — below your ${settings.safeZ.toFixed(1)} mm safe height` });
      }
    }
    const minZ = Math.min(sg.from[2], sg.to[2]);
    if (minZ < bottom - 1e-6 && !seen.has("b" + sg.line)) {
      seen.add("b" + sg.line);
      out.push({ sev: "warn", line: sg.line, msg: `Tool reaches ${(bottom - minZ).toFixed(2)} mm below stock bottom (Z=${bottom.toFixed(1)}) — cutting into the spoilboard` });
    }
  }

  // coarse full simulation for rapid-through-stock detection
  const sim = new StockSim(stock, 150);
  const rapidHits = new Map();
  for (const sg of segments) {
    const tool = tools[sg.tool] || DEFAULT_TOOL();
    sim.sweep(sg, tool, 0, 1, (depth) => {
      const cur = rapidHits.get(sg.line) || 0;
      if (depth > cur) rapidHits.set(sg.line, depth);
    });
  }
  for (const [line, depth] of rapidHits) {
    out.push({ sev: "err", line, msg: `Rapid move cuts through stock — up to ${depth.toFixed(2)} mm of material in its way` });
  }
  return out;
}

/* ---------------- Three.js viewport ---------------- */

function useViewport(containerRef, parsed, api, vis) {
  const three = useRef(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(C.bg);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
    camera.up.set(0, 0, 1);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 0.75);
    key.position.set(120, -140, 260);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x8fb8ff, 0.25);
    fill.position.set(-160, 120, 80);
    scene.add(fill);

    const pathGroup = new THREE.Group();
    const staticGroup = new THREE.Group();
    const stockGroup = new THREE.Group();
    scene.add(pathGroup, staticGroup, stockGroup);

    const markerGrp = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(0, 1.6, 6, 16), new THREE.MeshBasicMaterial({ color: C.warn }));
    cone.rotation.x = Math.PI / 2;
    cone.position.z = 3;
    markerGrp.add(cone);
    const shank = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 10, 12), new THREE.MeshBasicMaterial({ color: "#8B97A4" }));
    shank.rotation.x = Math.PI / 2;
    shank.position.z = 11;
    markerGrp.add(shank);
    scene.add(markerGrp);

    const ctl = { target: new THREE.Vector3(0, 0, 0), theta: -Math.PI / 4, phi: Math.PI / 3.2, dist: 300 };
    const applyCam = () => {
      const { target, theta, phi, dist } = ctl;
      camera.position.set(
        target.x + dist * Math.sin(phi) * Math.cos(theta),
        target.y + dist * Math.sin(phi) * Math.sin(theta),
        target.z + dist * Math.cos(phi)
      );
      camera.lookAt(target);
    };

    let dragging = null;
    let last = [0, 0];
    const dom = renderer.domElement;
    const onDown = (e) => { dragging = e.button === 2 || e.shiftKey ? "pan" : "orbit"; last = [e.clientX, e.clientY]; dom.setPointerCapture(e.pointerId); };
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - last[0], dy = e.clientY - last[1];
      last = [e.clientX, e.clientY];
      if (dragging === "orbit") {
        ctl.theta -= dx * 0.006;
        ctl.phi = Math.min(Math.PI - 0.05, Math.max(0.05, ctl.phi - dy * 0.006));
      } else {
        const scale = ctl.dist * 0.0016;
        const right = new THREE.Vector3().subVectors(camera.position, ctl.target).cross(camera.up).normalize();
        ctl.target.addScaledVector(right, dx * scale);
        ctl.target.addScaledVector(camera.up, dy * scale);
      }
      applyCam();
    };
    const onUp = () => (dragging = null);
    const onWheel = (e) => {
      e.preventDefault();
      ctl.dist = Math.min(3000, Math.max(20, ctl.dist * (e.deltaY > 0 ? 1.12 : 0.89)));
      applyCam();
    };
    dom.addEventListener("pointerdown", onDown);
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("pointerup", onUp);
    dom.addEventListener("wheel", onWheel, { passive: false });
    dom.addEventListener("contextmenu", (e) => e.preventDefault());

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let raf;
    const loop = () => { raf = requestAnimationFrame(loop); renderer.render(scene, camera); };
    loop();

    three.current = { scene, camera, renderer, pathGroup, staticGroup, stockGroup, markerGrp, ctl, applyCam };
    applyCam();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerup", onUp);
      dom.removeEventListener("wheel", onWheel);
      renderer.dispose();
      el.removeChild(dom);
    };
  }, []);

  // rebuild static + toolpath when parsed changes
  useEffect(() => {
    const t = three.current;
    if (!t || !parsed) return;
    const { pathGroup, staticGroup, ctl, applyCam } = t;
    [pathGroup, staticGroup].forEach((g) => {
      while (g.children.length) {
        const c = g.children.pop();
        c.geometry?.dispose();
        c.material?.dispose();
      }
    });

    const { segments, bb } = parsed;
    const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;

    const grid = new THREE.GridHelper(Z1.travel.x, 20, "#2C3742", "#1C242D");
    grid.rotation.x = Math.PI / 2;
    grid.position.set(cx, cy, Math.min(0, bb.minZ) - 0.05);
    staticGroup.add(grid);

    const env = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(Z1.travel.x, Z1.travel.y, Z1.travel.z)),
      new THREE.LineBasicMaterial({ color: "#2C3742", transparent: true, opacity: 0.7 })
    );
    env.position.set(cx, cy, Math.min(0, bb.minZ) + Z1.travel.z / 2);
    staticGroup.add(env);

    const axis = (dir, color) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), dir]);
      staticGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color })));
    };
    axis(new THREE.Vector3(14, 0, 0), "#E05A5A");
    axis(new THREE.Vector3(0, 14, 0), "#4CBB6C");
    axis(new THREE.Vector3(0, 0, 14), "#4C86D8");

    const cutPos = [], rapidPos = [];
    for (const sg of segments) {
      const P = sg.pts || [sg.from, sg.to];
      const arr = sg.type === "cut" ? cutPos : rapidPos;
      for (let i = 1; i < P.length; i++) arr.push(...P[i - 1], ...P[i]);
    }
    if (cutPos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(cutPos, 3));
      const ln = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: C.cut, transparent: true, opacity: 0.9 }));
      ln.name = "cuts";
      pathGroup.add(ln);
    }
    if (rapidPos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(rapidPos, 3));
      const m = new THREE.LineDashedMaterial({ color: C.rapid, dashSize: 2.2, gapSize: 1.6, transparent: true, opacity: 0.55 });
      const ln = new THREE.LineSegments(g, m);
      ln.computeLineDistances();
      ln.name = "rapids";
      pathGroup.add(ln);
    }

    const hg = new THREE.BufferGeometry();
    hg.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
    const hl = new THREE.Line(hg, new THREE.LineBasicMaterial({ color: C.warn }));
    hl.renderOrder = 3;
    hl.name = "highlight";
    pathGroup.add(hl);
    t.highlight = hl;

    const size = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY, bb.maxZ - bb.minZ, 40);
    ctl.target.set(cx, cy, (bb.minZ + bb.maxZ) / 2);
    ctl.dist = size * 2.1;
    applyCam();
  }, [parsed]);

  // visibility toggles
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    t.pathGroup.children.forEach((c) => {
      if (c.name === "rapids") c.visible = vis.rapids && vis.path;
      if (c.name === "cuts") c.visible = vis.path;
    });
    t.stockGroup.visible = vis.stock;
  }, [vis]);

  // imperative API
  useEffect(() => {
    api.current = {
      setMarker(p) { three.current?.markerGrp.position.set(p[0], p[1], p[2]); },
      setHighlight(seg) {
        const t = three.current;
        if (!t || !t.highlight) return;
        const P = seg ? (seg.pts || [seg.from, seg.to]) : [];
        const flat = [];
        for (const p of P) flat.push(p[0], p[1], p[2] + 0.03);
        t.highlight.geometry.dispose();
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(flat, 3));
        t.highlight.geometry = g;
      },
      view(name) {
        const t = three.current;
        if (!t) return;
        const c = t.ctl;
        if (name === "top") { c.theta = -Math.PI / 2; c.phi = 0.06; }
        if (name === "front") { c.theta = -Math.PI / 2; c.phi = Math.PI / 2 - 0.001; }
        if (name === "right") { c.theta = 0; c.phi = Math.PI / 2 - 0.001; }
        if (name === "iso") { c.theta = -Math.PI / 4; c.phi = Math.PI / 3.2; }
        t.applyCam();
      },
      // build stock mesh for a StockSim instance
      buildStock(sim) {
        const t = three.current;
        if (!t) return;
        const g = t.stockGroup;
        while (g.children.length) {
          const c = g.children.pop();
          c.geometry?.dispose();
          c.material?.dispose();
        }
        const { nx, ny, cw, ch, stock } = sim;
        const nvx = nx + 1, nvy = ny + 1;
        const pos = new Float32Array(nvx * nvy * 3);
        const col = new Float32Array(nvx * nvy * 3);
        for (let j = 0; j < nvy; j++) {
          for (let i = 0; i < nvx; i++) {
            const k = (j * nvx + i) * 3;
            pos[k] = stock.ox + i * cw;
            pos[k + 1] = stock.oy + j * ch;
            pos[k + 2] = stock.topZ;
          }
        }
        const idx = [];
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) {
            const a = j * nvx + i, b = a + 1, c2 = a + nvx, d = c2 + 1;
            idx.push(a, b, d, a, d, c2);
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
        geo.setIndex(idx);
        const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
        mesh.name = "surface";
        g.add(mesh);

        // original stock block, ghosted
        const box = new THREE.Mesh(
          new THREE.BoxGeometry(stock.w, stock.d, stock.h),
          new THREE.MeshBasicMaterial({ color: "#7C8894", transparent: true, opacity: 0.06, depthWrite: false })
        );
        box.position.set(stock.ox + stock.w / 2, stock.oy + stock.d / 2, stock.topZ - stock.h / 2);
        g.add(box);
        const boxEdges = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(stock.w, stock.d, stock.h)),
          new THREE.LineBasicMaterial({ color: "#3A4753", transparent: true, opacity: 0.8 })
        );
        boxEdges.position.copy(box.position);
        g.add(boxEdges);

        // bottom plate
        const bot = new THREE.Mesh(
          new THREE.PlaneGeometry(stock.w, stock.d),
          new THREE.MeshLambertMaterial({ color: "#5A6570", side: THREE.DoubleSide })
        );
        bot.position.set(stock.ox + stock.w / 2, stock.oy + stock.d / 2, stock.topZ - stock.h + 0.01);
        g.add(bot);

        t.stockMesh = mesh;
        this.updateStock(sim);
      },
      updateStock(sim) {
        const t = three.current;
        if (!t || !t.stockMesh) return;
        const mesh = t.stockMesh;
        const posAttr = mesh.geometry.getAttribute("position");
        const colAttr = mesh.geometry.getAttribute("color");
        const { hm, nx, ny, stock } = sim;
        const bottom = stock.topZ - stock.h;
        const cTop = new THREE.Color("#6E7A86");
        const cCut = new THREE.Color("#C4D0DC");
        const cDeep = new THREE.Color("#9AB4C8");
        const cGouge = new THREE.Color(C.err);
        const nvx = nx + 1;
        for (let j = 0; j <= ny; j++) {
          for (let i = 0; i <= nx; i++) {
            const v = j * nvx + i;
            const z = hm[v];
            posAttr.array[v * 3 + 2] = z;
            let cc;
            if (z >= stock.topZ - 1e-4) cc = cTop;
            else if (z < bottom - 1e-4) cc = cGouge;
            else {
              const f = Math.min(1, (stock.topZ - z) / Math.max(stock.h, 0.001));
              cc = cCut.clone().lerp(cDeep, f);
            }
            colAttr.array[v * 3] = cc.r;
            colAttr.array[v * 3 + 1] = cc.g;
            colAttr.array[v * 3 + 2] = cc.b;
          }
        }
        posAttr.needsUpdate = true;
        colAttr.needsUpdate = true;
        mesh.geometry.computeVertexNormals();
        sim.dirty = false;
      },
    };
  }, [api]);
}

/* ---------------- playback position lookup ---------------- */

function positionAt(segments, totalTime, frac) {
  const t = frac * totalTime;
  if (!segments.length) return { pos: [0, 0, 0], seg: null, idx: -1 };
  let lo = 0, hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].t1 < t) lo = mid + 1;
    else hi = mid;
  }
  const sg = segments[lo];
  const local = sg.t1 > sg.t0 ? Math.min(1, Math.max(0, (t - sg.t0) / (sg.t1 - sg.t0))) : 1;
  let pos;
  if (sg.pts) {
    const n = sg.pts.length - 1;
    const f = local * n;
    const i = Math.min(n - 1, Math.floor(f));
    const ft = f - i;
    const a = sg.pts[i], b = sg.pts[i + 1];
    pos = [a[0] + (b[0] - a[0]) * ft, a[1] + (b[1] - a[1]) * ft, a[2] + (b[2] - a[2]) * ft];
  } else {
    const a = sg.from, b = sg.to;
    pos = [a[0] + (b[0] - a[0]) * local, a[1] + (b[1] - a[1]) * local, a[2] + (b[2] - a[2]) * local];
  }
  return { pos, seg: sg, idx: lo, localFrac: local, time: t };
}

/* ---------------- small UI bits ---------------- */

const Label = ({ children, style }) => (
  <div style={{ fontFamily: COND, fontSize: 12, letterSpacing: "0.14em", textTransform: "uppercase", color: C.dim, fontWeight: 600, ...style }}>
    {children}
  </div>
);

const Dro = ({ label, value, unit, color }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 84 }}>
    <span style={{ fontFamily: COND, fontSize: 11, letterSpacing: "0.16em", color: C.dim, fontWeight: 600 }}>{label}</span>
    <span style={{ fontFamily: MONO, fontSize: 19, fontWeight: 600, color: color || C.text, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>
      {value}
      {unit && <span style={{ fontSize: 11, color: C.dim, marginLeft: 3 }}>{unit}</span>}
    </span>
  </div>
);

const numInput = {
  width: 58, background: C.bg, border: `1px solid ${C.edge}`, color: C.text,
  fontFamily: MONO, fontSize: 12, padding: "3px 6px", borderRadius: 3,
};

const sevColor = { err: C.err, warn: C.warn, info: C.rapid };
const sevGlyph = { err: "✕", warn: "▲", info: "○" };

function fmtTime(min) {
  const s = Math.round(min * 60);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/* ---------------- main app ---------------- */

export default function Z1GcodeCheckL2() {
  const [source, setSource] = useState(SAMPLE);
  const [fileName, setFileName] = useState("sample_pocket.nc");
  const [settings, setSettings] = useState({ safeZ: 1.0 });
  const [stockDef, setStockDef] = useState({ w: 90, d: 60, h: 6, ox: 0, oy: 0, topZ: 0 });
  const [tools, setTools] = useState({ 1: DEFAULT_TOOL() });
  const [drawer, setDrawer] = useState("stock"); // null | 'stock'
  const [vis, setVis] = useState({ path: true, rapids: true, stock: true });
  const [progress, setProgress] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(5);
  const [activeSeg, setActiveSeg] = useState(null);

  const containerRef = useRef(null);
  const api = useRef(null);
  const codeRef = useRef(null);
  const fileInput = useRef(null);
  const rafRef = useRef(null);
  const progRef = useRef(1);
  const simRef = useRef(null); // { sim, simTime }

  const parsed = useMemo(() => parseGcode(source), [source]);

  // make sure every tool number in the program has an entry
  useEffect(() => {
    setTools((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const tn of parsed.toolsUsed) if (!next[tn]) { next[tn] = DEFAULT_TOOL(); changed = true; }
      return changed ? next : prev;
    });
  }, [parsed]);

  const globalIssues = useMemo(
    () => runGlobalChecks(parsed, settings, stockDef, tools),
    [parsed, settings, stockDef, tools]
  );
  const allIssues = useMemo(() => {
    const all = [...parsed.issues, ...globalIssues];
    const order = { err: 0, warn: 1, info: 2 };
    return all.sort((a, b) => order[a.sev] - order[b.sev] || (a.line || 0) - (b.line || 0));
  }, [parsed, globalIssues]);
  const errCount = allIssues.filter((i) => i.sev === "err").length;
  const warnCount = allIssues.filter((i) => i.sev === "warn").length;

  useViewport(containerRef, parsed, api, vis);

  /* --- simulation-aware progress --- */
  const setSimTo = useCallback((frac) => {
    const S = simRef.current;
    if (!S) return;
    const targetT = frac * parsed.totalTime;
    if (targetT < S.simTime - 1e-9) {
      S.sim.reset();
      S.simTime = 0;
    }
    // apply segments between simTime and targetT
    for (const sg of parsed.segments) {
      if (sg.t1 <= S.simTime + 1e-9) continue;
      if (sg.t0 >= targetT - 1e-9) break;
      const dur = sg.t1 - sg.t0;
      const f0 = dur > 0 ? Math.max(0, (S.simTime - sg.t0) / dur) : 0;
      const f1 = dur > 0 ? Math.min(1, (targetT - sg.t0) / dur) : 1;
      const tool = tools[sg.tool] || DEFAULT_TOOL();
      S.sim.sweep(sg, tool, f0, f1, null);
    }
    S.simTime = Math.max(S.simTime, targetT);
    if (S.sim.dirty) api.current?.updateStock(S.sim);
  }, [parsed, tools]);

  const applyProgress = useCallback((frac) => {
    progRef.current = frac;
    const { pos, seg } = positionAt(parsed.segments, parsed.totalTime, frac);
    api.current?.setMarker(pos);
    api.current?.setHighlight(seg);
    setSimTo(frac);
    setActiveSeg(seg);
    setProgress(frac);
  }, [parsed, setSimTo]);

  // (re)build the display simulation when program / stock / tools change
  useEffect(() => {
    const sim = new StockSim(stockDef, 240);
    simRef.current = { sim, simTime: 0 };
    api.current?.buildStock(sim);
    setPlaying(false);
    applyProgress(parsed.segments.length ? 1 : 0);
  }, [parsed, stockDef, tools]); // eslint-disable-line

  // playback loop
  useEffect(() => {
    if (!playing) { cancelAnimationFrame(rafRef.current); return; }
    let lastT = performance.now();
    const tick = (now) => {
      const dtMin = ((now - lastT) / 1000 / 60) * speed;
      lastT = now;
      let f = progRef.current + (parsed.totalTime > 0 ? dtMin / parsed.totalTime : 1);
      if (f >= 1) { f = 1; setPlaying(false); }
      applyProgress(f);
      if (f < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, speed, parsed, applyProgress]);

  // auto-scroll code
  useEffect(() => {
    if (!activeSeg || !codeRef.current) return;
    const el = codeRef.current.querySelector(`[data-line="${activeSeg.line}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [activeSeg?.line]);

  const seekToLine = useCallback((line) => {
    const idx = parsed.segments.findIndex((s) => s.line >= line);
    if (idx === -1) return;
    const sg = parsed.segments[idx];
    setPlaying(false);
    applyProgress(parsed.totalTime > 0 ? sg.t1 / parsed.totalTime : 0);
  }, [parsed, applyProgress]);

  const loadFile = (f) => {
    const r = new FileReader();
    r.onload = () => { setSource(String(r.result)); setFileName(f.name); };
    r.readAsText(f);
  };

  const lines = useMemo(() => source.split(/\r?\n/), [source]);
  const issuesByLine = useMemo(() => {
    const m = new Map();
    for (const i of allIssues) if (i.line) {
      if (!m.has(i.line) || (m.get(i.line) === "warn" && i.sev === "err")) m.set(i.line, i.sev);
    }
    return m;
  }, [allIssues]);

  const bb = parsed.bb;
  const dro = positionAt(parsed.segments, parsed.totalTime, progress);
  const capped = lines.length > 6000;
  const shownLines = capped ? lines.slice(0, 6000) : lines;

  const btn = (active) => ({
    fontFamily: COND, fontSize: 13, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 600,
    padding: "5px 12px", borderRadius: 3, cursor: "pointer",
    border: `1px solid ${active ? C.cut : C.edge}`,
    background: active ? "rgba(61,220,151,0.12)" : "transparent",
    color: active ? C.cut : C.dim,
  });

  const setTool = (tn, patch) => setTools((p) => ({ ...p, [tn]: { ...p[tn], ...patch } }));
  const setStock = (patch) => setStockDef((p) => ({ ...p, ...patch }));

  return (
    <div
      style={{ height: "100vh", display: "flex", flexDirection: "column", background: C.bg, color: C.text, overflow: "hidden" }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) loadFile(f); }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 9px; height: 9px; }
        ::-webkit-scrollbar-track { background: ${C.panel2}; }
        ::-webkit-scrollbar-thumb { background: ${C.edge}; border-radius: 4px; }
        input[type=range] { -webkit-appearance: none; background: transparent; }
        input[type=range]::-webkit-slider-runnable-track { height: 4px; background: ${C.edge}; border-radius: 2px; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: ${C.warn}; margin-top: -5px; cursor: pointer; }
        select { outline: none; }
        button:hover { filter: brightness(1.25); }
        @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
      `}</style>

      {/* ---------- header ---------- */}
      <header style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 16px", borderBottom: `1px solid ${C.edge}`, background: C.panel, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontFamily: COND, fontWeight: 700, fontSize: 22, letterSpacing: "0.06em" }}>Z1 G-CODE CHECK</span>
          <span style={{ fontFamily: COND, fontWeight: 600, fontSize: 13, letterSpacing: "0.12em", color: C.cut, border: `1px solid ${C.cut}55`, borderRadius: 3, padding: "1px 7px" }}>LEVEL 2 · STOCK SIM</span>
          <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>{Z1.travel.x}×{Z1.travel.y}×{Z1.travel.z} mm · {Z1.maxRPM.toLocaleString()} RPM max</span>
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: MONO, fontSize: 12, color: C.dim, overflow: "hidden", textOverflow: "ellipsis", maxWidth: 200 }}>{fileName}</span>
        <button style={btn(false)} onClick={() => fileInput.current?.click()}>Open file</button>
        <button style={btn(false)} onClick={() => { setSource(SAMPLE); setFileName("sample_pocket.nc"); setStockDef({ w: 90, d: 60, h: 6, ox: 0, oy: 0, topZ: 0 }); }}>Sample</button>
        <button style={btn(drawer === "stock")} onClick={() => setDrawer((d) => (d === "stock" ? null : "stock"))}>Stock &amp; tools</button>
        <input ref={fileInput} type="file" accept=".nc,.gcode,.tap,.txt,.cnc,.ngc" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ""; }} />
      </header>

      {/* ---------- stock & tools drawer ---------- */}
      {drawer === "stock" && (
        <div style={{ display: "flex", gap: 32, alignItems: "flex-start", padding: "12px 16px", background: C.panel2, borderBottom: `1px solid ${C.edge}`, flexWrap: "wrap" }}>
          <div>
            <Label style={{ marginBottom: 8 }}>Stock · mm</Label>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontFamily: MONO, fontSize: 12, color: C.dim, alignItems: "center" }}>
              {[["w", "W"], ["d", "D"], ["h", "H"]].map(([k, lab]) => (
                <label key={k} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  {lab}<input type="number" step="1" min="1" value={stockDef[k]} style={numInput}
                    onChange={(e) => setStock({ [k]: Math.max(0.5, parseFloat(e.target.value) || 1) })} />
                </label>
              ))}
              <span style={{ color: C.edge }}>│</span>
              <label style={{ display: "flex", alignItems: "center", gap: 5 }}>
                min X<input type="number" step="1" value={stockDef.ox} style={numInput} onChange={(e) => setStock({ ox: parseFloat(e.target.value) || 0 })} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 5 }}>
                min Y<input type="number" step="1" value={stockDef.oy} style={numInput} onChange={(e) => setStock({ oy: parseFloat(e.target.value) || 0 })} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 5 }}>
                top Z<input type="number" step="0.5" value={stockDef.topZ} style={numInput} onChange={(e) => setStock({ topZ: parseFloat(e.target.value) || 0 })} />
              </label>
              <button style={btn(false)} onClick={() => setStock({ ox: 0, oy: 0 })}>Zero at corner</button>
              <button style={btn(false)} onClick={() => setStock({ ox: -stockDef.w / 2, oy: -stockDef.d / 2 })}>Zero at center</button>
            </div>
            <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim, marginTop: 8 }}>
              stock bottom Z = {(stockDef.topZ - stockDef.h).toFixed(1)} · anything deeper is flagged as spoilboard cutting
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: MONO, fontSize: 12, color: C.dim, marginTop: 8 }}>
              Safe rapid height Z ≥
              <input type="number" step="0.5" value={settings.safeZ} style={numInput}
                onChange={(e) => setSettings((s) => ({ ...s, safeZ: parseFloat(e.target.value) || 0 }))} /> mm
            </label>
          </div>
          <div>
            <Label style={{ marginBottom: 8 }}>Tool table</Label>
            {parsed.toolsUsed.length === 0 && <div style={{ fontFamily: MONO, fontSize: 12, color: C.dim }}>No T numbers in this program — T1 assumed.</div>}
            {(parsed.toolsUsed.length ? parsed.toolsUsed : [1]).map((tn) => {
              const t = tools[tn] || DEFAULT_TOOL();
              return (
                <div key={tn} style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: MONO, fontSize: 12, color: C.dim, marginBottom: 6 }}>
                  <span style={{ color: C.text, minWidth: 28 }}>T{tn}</span>
                  <select value={t.type} onChange={(e) => setTool(tn, { type: e.target.value })}
                    style={{ background: C.bg, color: C.text, border: `1px solid ${C.edge}`, fontFamily: MONO, fontSize: 12, padding: "3px 6px", borderRadius: 3 }}>
                    <option value="flat">flat end mill</option>
                    <option value="ball">ball end mill</option>
                    <option value="v">V-bit</option>
                  </select>
                  <label style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    ⌀<input type="number" step="0.5" min="0.1" value={t.dia} style={numInput}
                      onChange={(e) => setTool(tn, { dia: Math.max(0.1, parseFloat(e.target.value) || 1) })} /> mm
                  </label>
                  {t.type === "v" && (
                    <label style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      ∠<input type="number" step="5" min="10" max="170" value={t.angle} style={numInput}
                        onChange={(e) => setTool(tn, { angle: Math.min(170, Math.max(10, parseFloat(e.target.value) || 60)) })} />°
                    </label>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ---------- main split ---------- */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* code panel */}
        <div style={{ width: 310, minWidth: 230, display: "flex", flexDirection: "column", borderRight: `1px solid ${C.edge}`, background: C.panel2 }}>
          <div style={{ padding: "8px 12px", borderBottom: `1px solid ${C.edge}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Label>Program</Label>
            <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>{parsed.totalLines} lines</span>
          </div>
          <div ref={codeRef} style={{ flex: 1, overflowY: "auto", fontFamily: MONO, fontSize: 12, lineHeight: 1.55, padding: "6px 0" }}>
            {shownLines.map((ln, i) => {
              const n = i + 1;
              const isActive = activeSeg?.line === n;
              const sev = issuesByLine.get(n);
              return (
                <div key={n} data-line={n} onClick={() => seekToLine(n)}
                  style={{
                    display: "flex", gap: 10, padding: "0 12px", cursor: "pointer", whiteSpace: "pre",
                    background: isActive ? "rgba(255,176,32,0.13)" : "transparent",
                    borderLeft: `3px solid ${isActive ? C.warn : sev ? sevColor[sev] : "transparent"}`,
                  }}>
                  <span style={{ color: C.dim, minWidth: 34, textAlign: "right", userSelect: "none", opacity: 0.7 }}>{n}</span>
                  <span style={{ color: sev === "err" ? C.err : ln.trim().startsWith(";") || ln.trim().startsWith("(") ? "#4E5A66" : C.text, overflow: "hidden", textOverflow: "ellipsis" }}>{ln || " "}</span>
                </div>
              );
            })}
            {capped && <div style={{ padding: 12, color: C.dim, fontSize: 11 }}>… listing capped at 6,000 lines (full program is still simulated and checked)</div>}
          </div>
        </div>

        {/* viewport + DRO */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
            <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
            <div style={{ position: "absolute", top: 10, left: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
              {["iso", "top", "front", "right"].map((v) => (
                <button key={v} style={btn(false)} onClick={() => api.current?.view(v)}>{v}</button>
              ))}
              <span style={{ width: 8 }} />
              <button style={btn(vis.stock)} onClick={() => setVis((v) => ({ ...v, stock: !v.stock }))}>Stock</button>
              <button style={btn(vis.path)} onClick={() => setVis((v) => ({ ...v, path: !v.path }))}>Path</button>
              <button style={btn(vis.rapids)} onClick={() => setVis((v) => ({ ...v, rapids: !v.rapids }))}>Rapids</button>
            </div>
            <div style={{ position: "absolute", top: 10, right: 10, background: "rgba(14,18,22,0.85)", border: `1px solid ${C.edge}`, borderRadius: 4, padding: "8px 12px", display: "flex", flexDirection: "column", gap: 5 }}>
              {[["cut", C.cut, "cutting", "solid"], ["rapid", C.rapid, "rapid", "dashed"], ["sel", C.warn, "current move", "solid"]].map(([k, col, txt, styl]) => (
                <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: MONO, fontSize: 11, color: C.dim }}>
                  <span style={{ width: 18, height: 0, borderTop: `2px ${styl} ${col}` }} />{txt}
                </div>
              ))}
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: MONO, fontSize: 11, color: C.dim }}>
                <span style={{ width: 18, height: 8, background: "#C4D0DC", borderRadius: 1 }} />machined
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: MONO, fontSize: 11, color: C.dim }}>
                <span style={{ width: 18, height: 8, background: C.err, borderRadius: 1 }} />below stock
              </div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: "#4E5A66", marginTop: 2 }}>drag orbit · shift-drag pan · wheel zoom</div>
            </div>
          </div>

          {/* DRO + transport */}
          <div style={{ borderTop: `1px solid ${C.edge}`, background: C.panel, padding: "10px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-end" }}>
              <Dro label="X" value={dro.pos[0].toFixed(3)} />
              <Dro label="Y" value={dro.pos[1].toFixed(3)} />
              <Dro label="Z" value={dro.pos[2].toFixed(3)} color={dro.pos[2] < stockDef.topZ ? C.cut : C.text} />
              <Dro label="Feed" value={activeSeg ? activeSeg.feed.toFixed(0) : "—"} unit="mm/min" />
              <Dro label="Spindle" value={activeSeg ? activeSeg.rpm.toLocaleString() : "—"} unit="rpm"
                color={activeSeg && activeSeg.rpm > Z1.maxRPM ? C.err : undefined} />
              <Dro label="Tool" value={activeSeg ? `T${activeSeg.tool}` : "—"} />
              <Dro label="Line" value={activeSeg ? activeSeg.line : "—"} />
              <div style={{ flex: 1 }} />
              <Dro label="Elapsed" value={fmtTime(progress * parsed.totalTime)} />
              <Dro label="Est. total" value={fmtTime(parsed.totalTime)} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button style={{ ...btn(playing), minWidth: 68 }}
                onClick={() => {
                  if (!playing && progRef.current >= 1) applyProgress(0);
                  setPlaying((p) => !p);
                }}>
                {playing ? "Pause" : "Run"}
              </button>
              <input type="range" min="0" max="1000" value={Math.round(progress * 1000)}
                onChange={(e) => { setPlaying(false); applyProgress(parseInt(e.target.value, 10) / 1000); }}
                style={{ flex: 1 }} />
              <span style={{ fontFamily: MONO, fontSize: 12, color: C.dim, minWidth: 44, textAlign: "right" }}>{(progress * 100).toFixed(0)}%</span>
              <select value={speed} onChange={(e) => setSpeed(parseFloat(e.target.value))}
                style={{ background: C.bg, color: C.dim, border: `1px solid ${C.edge}`, fontFamily: MONO, fontSize: 12, padding: "4px 6px", borderRadius: 3 }}>
                {[1, 2, 5, 20, 100].map((s) => <option key={s} value={s}>{s}× time</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* checks panel */}
        <div style={{ width: 300, minWidth: 240, display: "flex", flexDirection: "column", borderLeft: `1px solid ${C.edge}`, background: C.panel2 }}>
          <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.edge}` }}>
            <Label>Safe to run?</Label>
            <div style={{ fontFamily: COND, fontWeight: 700, fontSize: 26, letterSpacing: "0.03em", marginTop: 2, color: errCount ? C.err : warnCount ? C.warn : C.cut }}>
              {errCount ? `${errCount} error${errCount > 1 ? "s" : ""}` : warnCount ? `${warnCount} warning${warnCount > 1 ? "s" : ""}` : "No issues found"}
            </div>
            {errCount > 0 && warnCount > 0 && (
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.warn }}>+ {warnCount} warning{warnCount > 1 ? "s" : ""}</div>
            )}
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {allIssues.length === 0 && (
              <div style={{ padding: 14, fontFamily: MONO, fontSize: 12, color: C.dim, lineHeight: 1.6 }}>
                Every line parsed cleanly, no rapid touches stock, and every check passed. Still verify your work zero and clamp positions on the machine.
              </div>
            )}
            {allIssues.map((iss, i) => (
              <div key={i} onClick={() => iss.line && seekToLine(iss.line)}
                style={{ display: "flex", gap: 10, padding: "9px 14px", borderBottom: `1px solid ${C.edge}44`, cursor: iss.line ? "pointer" : "default" }}>
                <span style={{ color: sevColor[iss.sev], fontFamily: MONO, fontSize: 12, lineHeight: 1.5 }}>{sevGlyph[iss.sev]}</span>
                <div>
                  {iss.line && <div style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>line {iss.line}</div>}
                  <div style={{ fontFamily: MONO, fontSize: 12, lineHeight: 1.5, color: iss.sev === "err" ? C.err : C.text }}>{iss.msg}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ borderTop: `1px solid ${C.edge}`, padding: "10px 14px" }}>
            <Label style={{ marginBottom: 6 }}>Program extents · mm</Label>
            <table style={{ fontFamily: MONO, fontSize: 12, borderSpacing: 0, width: "100%", fontVariantNumeric: "tabular-nums" }}>
              <tbody>
                {[
                  ["X", bb.minX, bb.maxX, Z1.travel.x],
                  ["Y", bb.minY, bb.maxY, Z1.travel.y],
                  ["Z", bb.minZ, bb.maxZ, Z1.travel.z],
                ].map(([ax, mn, mx, lim]) => {
                  const span = mx - mn;
                  const over = span > lim;
                  return (
                    <tr key={ax}>
                      <td style={{ color: C.dim, padding: "2px 0", width: 20 }}>{ax}</td>
                      <td style={{ textAlign: "right", padding: "2px 6px" }}>{mn.toFixed(1)}</td>
                      <td style={{ color: C.dim }}>→</td>
                      <td style={{ textAlign: "right", padding: "2px 6px" }}>{mx.toFixed(1)}</td>
                      <td style={{ textAlign: "right", color: over ? C.err : C.dim }}>{span.toFixed(1)} / {lim}</td>
                      <td style={{ paddingLeft: 6, color: over ? C.err : C.cut }}>{over ? "✕" : "✓"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim, marginTop: 6 }}>
              {parsed.segments.length.toLocaleString()} moves · {parsed.toolChanges.length} tool change{parsed.toolChanges.length === 1 ? "" : "s"} · stock {stockDef.w}×{stockDef.d}×{stockDef.h} mm
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
