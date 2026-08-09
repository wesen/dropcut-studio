import React, { useState, useRef, useEffect } from "react";
import * as THREE from "three";

/* ================================================================
   DROPCUT v3 — 3-axis drop-cutter CAM
   NEW IN v3:
   - HELIX / RAMP ENTRIES for roughing (auto: helix -> ramp -> plunge,
     validated against the inflated CL surface)
   - HYBRID FINISHING: raster on shallow regions + Z-level waterline
     contours (marching squares on the CL field) on steep regions
   - CONSTANT SCALLOP: Eikonal |grad T| = sqrt(1+|grad f|^2)/s0 solved
     by fast sweeping; passes = level sets of T (research section 8)
   - DEXEL VERIFICATION: heightmap material-removal simulation swept
     along the job, diffed against the rasterized target surface,
     rendered as a gouge/excess heatmap
   - G17 arc fitting for constant-Z waterline contours (in addition
     to G18/G19 vertical-plane arcs on raster rows)
   ================================================================ */

/* ---------------- preset heightfield geometry ---------------- */

const PRESETS = {
  sprite: {
    label: "Soot sprite (blob + eyes)",
    half: 22, n: 110,
    f: (x, y) => {
      const a = 16, H = 9.5;
      const r = Math.hypot(x, y);
      let z = r < a ? H * Math.pow(Math.max(0, 1 - (r / a) * (r / a)), 0.55) : 0;
      const eye = (cx, cy, rad, h) =>
        h * Math.exp(-(((x - cx) ** 2 + (y - cy) ** 2) / (2 * rad * rad)));
      z += eye(-5.2, 4.2, 2.6, 2.4) + eye(5.2, 4.2, 2.6, 2.4);
      return z;
    },
  },
  star: {
    label: "Star magnet (5 lobes)",
    half: 20, n: 110,
    f: (x, y) => {
      const th = Math.atan2(y, x);
      const a = 12.5 * (1 + 0.3 * Math.cos(5 * th));
      const t = Math.hypot(x, y) / a;
      if (t >= 1) return 0;
      return 8.5 * Math.pow(Math.cos((t * Math.PI) / 2), 0.85);
    },
  },
  dome: {
    label: "Hemisphere (benchmark)",
    half: 18, n: 96,
    f: (x, y) => {
      const R0 = 14, r2 = x * x + y * y;
      return r2 < R0 * R0 ? Math.sqrt(R0 * R0 - r2) : 0;
    },
  },
  hills: {
    label: "Gaussian hills",
    half: 22, n: 100,
    f: (x, y) => {
      const g = (cx, cy, s2, h) =>
        h * Math.exp(-(((x - cx) ** 2 + (y - cy) ** 2) / (2 * s2)));
      return g(-8, -6, 36, 6) + g(7, 2, 20, 8) + g(2, -9, 12, 4.5);
    },
  },
};

function heightfieldTris(preset) {
  const { half, n, f } = preset;
  const step = (2 * half) / n;
  const Z = new Float64Array((n + 1) * (n + 1));
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++)
      Z[j * (n + 1) + i] = Math.max(0, f(-half + i * step, -half + j * step));
  const T = new Float64Array(n * n * 2 * 9);
  let o = 0;
  for (let j = 0; j < n; j++) {
    const y0 = -half + j * step, y1 = y0 + step;
    for (let i = 0; i < n; i++) {
      const x0 = -half + i * step, x1 = x0 + step;
      const z00 = Z[j * (n + 1) + i], z10 = Z[j * (n + 1) + i + 1];
      const z01 = Z[(j + 1) * (n + 1) + i], z11 = Z[(j + 1) * (n + 1) + i + 1];
      T[o++] = x0; T[o++] = y0; T[o++] = z00;
      T[o++] = x1; T[o++] = y0; T[o++] = z10;
      T[o++] = x1; T[o++] = y1; T[o++] = z11;
      T[o++] = x0; T[o++] = y0; T[o++] = z00;
      T[o++] = x1; T[o++] = y1; T[o++] = z11;
      T[o++] = x0; T[o++] = y1; T[o++] = z01;
    }
  }
  return T;
}

/* ---------------- STL ---------------- */

function parseSTL(buf) {
  if (buf.byteLength >= 84) {
    const dv = new DataView(buf);
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === buf.byteLength) {
      const T = new Float64Array(n * 9);
      let o = 84;
      for (let i = 0; i < n; i++) {
        o += 12;
        for (let k = 0; k < 9; k++) { T[i * 9 + k] = dv.getFloat32(o, true); o += 4; }
        o += 2;
      }
      return T;
    }
  }
  const txt = new TextDecoder().decode(buf);
  const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  const v = [];
  let m;
  while ((m = re.exec(txt))) v.push(+m[1], +m[2], +m[3]);
  const nt = Math.floor(v.length / 9);
  if (nt === 0) throw new Error("No triangles found in STL");
  return new Float64Array(v.slice(0, nt * 9));
}

function buildModel(rawTris, scale, name) {
  const n = rawTris.length / 9;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity,
    minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < rawTris.length; i += 3) {
    const x = rawTris[i], y = rawTris[i + 1], z = rawTris[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const T = new Float64Array(rawTris.length);
  for (let i = 0; i < rawTris.length; i += 3) {
    T[i] = (rawTris[i] - cx) * scale;
    T[i + 1] = (rawTris[i + 1] - cy) * scale;
    T[i + 2] = (rawTris[i + 2] - minZ) * scale;
  }
  const bbox = {
    minX: (minX - cx) * scale, maxX: (maxX - cx) * scale,
    minY: (minY - cy) * scale, maxY: (maxY - cy) * scale,
    minZ: 0, maxZ: (maxZ - minZ) * scale,
  };
  return { tris: T, nTri: n, bbox, name };
}

/* ---------------- spatial hash + exact drop-cutter ---------------- */

function buildGrid(model, R) {
  const { tris: T, nTri, bbox } = model;
  const spanX = Math.max(1e-6, bbox.maxX - bbox.minX);
  const spanY = Math.max(1e-6, bbox.maxY - bbox.minY);
  const cs = Math.max(R, Math.hypot(spanX, spanY) / 256, 0.25);
  const nx = Math.max(1, Math.ceil(spanX / cs));
  const ny = Math.max(1, Math.ceil(spanY / cs));
  const cells = new Array(nx * ny);
  const triBB = new Float64Array(nTri * 4);
  for (let t = 0; t < nTri; t++) {
    const o = t * 9;
    const x0 = Math.min(T[o], T[o + 3], T[o + 6]);
    const x1 = Math.max(T[o], T[o + 3], T[o + 6]);
    const y0 = Math.min(T[o + 1], T[o + 4], T[o + 7]);
    const y1 = Math.max(T[o + 1], T[o + 4], T[o + 7]);
    triBB[t * 4] = x0; triBB[t * 4 + 1] = x1; triBB[t * 4 + 2] = y0; triBB[t * 4 + 3] = y1;
    const i0 = Math.max(0, Math.floor((x0 - bbox.minX) / cs));
    const i1 = Math.min(nx - 1, Math.floor((x1 - bbox.minX) / cs));
    const j0 = Math.max(0, Math.floor((y0 - bbox.minY) / cs));
    const j1 = Math.min(ny - 1, Math.floor((y1 - bbox.minY) / cs));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        (cells[k] || (cells[k] = [])).push(t);
      }
  }
  return { cs, nx, ny, cells, triBB, minX: bbox.minX, minY: bbox.minY, stamp: new Uint32Array(nTri), qid: 0 };
}

function pointInTri(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9;
  const hasPos = d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9;
  return !(hasNeg && hasPos);
}

function edgeBall(px, py, R, x1, y1, z1, x2, y2, z2) {
  const ex = x2 - x1, ey = y2 - y1;
  const L2 = ex * ex + ey * ey;
  if (L2 < 1e-12) return -Infinity;
  const L = Math.sqrt(L2), ux = ex / L, uy = ey / L;
  const wx = px - x1, wy = py - y1;
  const tf = wx * ux + wy * uy;
  const dperp = Math.abs(wx * uy - wy * ux);
  if (dperp >= R) return -Infinity;
  const rp = Math.sqrt(R * R - dperp * dperp);
  const m = (z2 - z1) / L;
  const zf = z1 + m * tf;
  const sLo = Math.max(-rp, -tf), sHi = Math.min(rp, L - tf);
  if (sLo > sHi) return -Infinity;
  let s = (m * rp) / Math.sqrt(1 + m * m);
  s = Math.min(Math.max(s, sLo), sHi);
  return zf + m * s + Math.sqrt(Math.max(0, rp * rp - s * s));
}

function makeEvaluator(model, grid, tool, floorZ) {
  const T = model.tris;
  const R = tool.diameter / 2;
  const R2 = R * R;
  const isBall = tool.type === "ball";
  const { cs, nx, ny, cells, triBB, minX, minY, stamp } = grid;

  return function evalTipZ(X, Y) {
    let best = isBall ? floorZ + R : floorZ;
    const qid = ++grid.qid;
    const i0 = Math.max(0, Math.floor((X - R - minX) / cs));
    const i1 = Math.min(nx - 1, Math.floor((X + R - minX) / cs));
    const j0 = Math.max(0, Math.floor((Y - R - minY) / cs));
    const j1 = Math.min(ny - 1, Math.floor((Y + R - minY) / cs));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cell = cells[j * nx + i];
        if (!cell) continue;
        for (let ci = 0; ci < cell.length; ci++) {
          const t = cell[ci];
          if (stamp[t] === qid) continue;
          stamp[t] = qid;
          const b4 = t * 4;
          if (X < triBB[b4] - R || X > triBB[b4 + 1] + R ||
              Y < triBB[b4 + 2] - R || Y > triBB[b4 + 3] + R) continue;
          const o = t * 9;
          const ax = T[o], ay = T[o + 1], az = T[o + 2];
          const bx = T[o + 3], by = T[o + 4], bz = T[o + 5];
          const cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];

          if (isBall) {
            let dx = ax - X, dy = ay - Y, d2 = dx * dx + dy * dy;
            if (d2 < R2) { const z = az + Math.sqrt(R2 - d2); if (z > best) best = z; }
            dx = bx - X; dy = by - Y; d2 = dx * dx + dy * dy;
            if (d2 < R2) { const z = bz + Math.sqrt(R2 - d2); if (z > best) best = z; }
            dx = cx - X; dy = cy - Y; d2 = dx * dx + dy * dy;
            if (d2 < R2) { const z = cz + Math.sqrt(R2 - d2); if (z > best) best = z; }
            let z = edgeBall(X, Y, R, ax, ay, az, bx, by, bz); if (z > best) best = z;
            z = edgeBall(X, Y, R, bx, by, bz, cx, cy, cz); if (z > best) best = z;
            z = edgeBall(X, Y, R, cx, cy, cz, ax, ay, az); if (z > best) best = z;
            const ux = bx - ax, uy = by - ay, uz = bz - az;
            const vx = cx - ax, vy = cy - ay, vz = cz - az;
            const nzc = ux * vy - uy * vx;
            if (Math.abs(nzc) > 1e-9) {
              const nxc = uy * vz - uz * vy, nyc = uz * vx - ux * vz;
              const A = -nxc / nzc, B = -nyc / nzc;
              const C = az - A * ax - B * ay;
              const gl = Math.sqrt(1 + A * A + B * B);
              const px = X + (R * A) / gl, py = Y + (R * B) / gl;
              if (pointInTri(px, py, ax, ay, bx, by, cx, cy)) {
                const Zc = A * X + B * Y + C + R * gl;
                if (Zc > best) best = Zc;
              }
            }
          } else {
            let dx = ax - X, dy = ay - Y;
            if (dx * dx + dy * dy <= R2 && az > best) best = az;
            dx = bx - X; dy = by - Y;
            if (dx * dx + dy * dy <= R2 && bz > best) best = bz;
            dx = cx - X; dy = cy - Y;
            if (dx * dx + dy * dy <= R2 && cz > best) best = cz;
            const edges = [[ax, ay, az, bx, by, bz], [bx, by, bz, cx, cy, cz], [cx, cy, cz, ax, ay, az]];
            for (let e = 0; e < 3; e++) {
              const [x1, y1, z1, x2, y2, z2] = edges[e];
              const ex = x2 - x1, ey = y2 - y1;
              const a2 = ex * ex + ey * ey;
              if (a2 < 1e-12) continue;
              const wx = x1 - X, wy = y1 - Y;
              const bq = ex * wx + ey * wy;
              const cq = wx * wx + wy * wy - R2;
              const disc = bq * bq - a2 * cq;
              if (disc < 0) continue;
              const sq = Math.sqrt(disc);
              let tLo = Math.max(0, (-bq - sq) / a2), tHi = Math.min(1, (-bq + sq) / a2);
              if (tLo > tHi) continue;
              const mz = z2 - z1;
              const tt = mz > 0 ? tHi : tLo;
              const z = z1 + mz * tt;
              if (z > best) best = z;
            }
            const ux = bx - ax, uy = by - ay, uz = bz - az;
            const vx = cx - ax, vy = cy - ay, vz = cz - az;
            const nzc = ux * vy - uy * vx;
            if (Math.abs(nzc) > 1e-9) {
              const nxc = uy * vz - uz * vy, nyc = uz * vx - ux * vz;
              const A = -nxc / nzc, B = -nyc / nzc;
              const C = az - A * ax - B * ay;
              const gl = Math.hypot(A, B);
              if (gl > 1e-9) {
                const px = X + (R * A) / gl, py = Y + (R * B) / gl;
                if (pointInTri(px, py, ax, ay, bx, by, cx, cy)) {
                  const z = A * px + B * py + C;
                  if (z > best) best = z;
                }
              }
              if (pointInTri(X, Y, ax, ay, bx, by, cx, cy)) {
                const z = A * X + B * Y + C;
                if (z > best) best = z;
              }
            }
          }
        }
      }
    }
    return isBall ? best - R : best;
  };
}

/* ---------------- CL field (sampled cutter-location surface) ---------------- */

async function buildCLField(evalF, x0, x1, y0, y1, gs, onProg, cancelRef) {
  const nx = Math.max(4, Math.ceil((x1 - x0) / gs));
  const ny = Math.max(4, Math.ceil((y1 - y0) / gs));
  const F = new Float64Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j++) {
    const y = y0 + j * gs;
    for (let i = 0; i <= nx; i++) F[j * (nx + 1) + i] = evalF(x0 + i * gs, y);
    if (j % 8 === 7) {
      onProg(j / ny);
      await new Promise((r) => setTimeout(r, 0));
      if (cancelRef.current) return null;
    }
  }
  // slope |grad F| per node (central differences)
  const G = new Float64Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) {
      const ip = Math.min(nx, i + 1), im = Math.max(0, i - 1);
      const jp = Math.min(ny, j + 1), jm = Math.max(0, j - 1);
      const gx = (F[j * (nx + 1) + ip] - F[j * (nx + 1) + im]) / ((ip - im) * gs);
      const gy = (F[jp * (nx + 1) + i] - F[jm * (nx + 1) + i]) / ((jp - jm) * gs);
      G[j * (nx + 1) + i] = Math.hypot(gx, gy);
    }
  const fld = { nx, ny, gs, x0, y0, F, G };
  fld.sampleF = (x, y) => bilin(fld, F, x, y);
  fld.sampleG = (x, y) => bilin(fld, G, x, y);
  return fld;
}

function bilin(fld, A, x, y) {
  const { nx, ny, gs, x0, y0 } = fld;
  let u = (x - x0) / gs, v = (y - y0) / gs;
  u = Math.min(nx - 1e-6, Math.max(0, u));
  v = Math.min(ny - 1e-6, Math.max(0, v));
  const i = Math.floor(u), j = Math.floor(v);
  const fu = u - i, fv = v - j;
  const a = A[j * (nx + 1) + i], b = A[j * (nx + 1) + i + 1];
  const c = A[(j + 1) * (nx + 1) + i], d = A[(j + 1) * (nx + 1) + i + 1];
  return a * (1 - fu) * (1 - fv) + b * fu * (1 - fv) + c * (1 - fu) * fv + d * fu * fv;
}

/* ---------------- marching squares + chaining ---------------- */

function marchSquares(A, nx, ny, x0, y0, gs, level) {
  const segs = [];
  const ip = (va, vb) => va / (va - vb); // va,vb opposite signs
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v00 = A[j * (nx + 1) + i] - level;
      const v10 = A[j * (nx + 1) + i + 1] - level;
      const v11 = A[(j + 1) * (nx + 1) + i + 1] - level;
      const v01 = A[(j + 1) * (nx + 1) + i] - level;
      const c = (v00 > 0 ? 1 : 0) | (v10 > 0 ? 2 : 0) | (v11 > 0 ? 4 : 0) | (v01 > 0 ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const X = (t) => x0 + t * gs, Y = (t) => y0 + t * gs;
      // edge points: 0 bottom, 1 right, 2 top, 3 left
      const E = [];
      E[0] = [X(i + ip(v00, v10)), Y(j)];
      E[1] = [X(i + 1), Y(j + ip(v10, v11))];
      E[2] = [X(i + ip(v01, v11)), Y(j + 1)];
      E[3] = [X(i), Y(j + ip(v00, v01))];
      const put = (a, b) => segs.push([E[a][0], E[a][1], E[b][0], E[b][1]]);
      switch (c) {
        case 1: case 14: put(3, 0); break;
        case 2: case 13: put(0, 1); break;
        case 3: case 12: put(3, 1); break;
        case 4: case 11: put(1, 2); break;
        case 6: case 9: put(0, 2); break;
        case 7: case 8: put(3, 2); break;
        case 5: {
          const vc = (v00 + v10 + v11 + v01) / 4;
          if (vc > 0) { put(0, 1); put(2, 3); } else { put(3, 0); put(1, 2); }
          break;
        }
        case 10: {
          const vc = (v00 + v10 + v11 + v01) / 4;
          if (vc > 0) { put(3, 0); put(1, 2); } else { put(0, 1); put(2, 3); }
          break;
        }
        default: break;
      }
    }
  }
  // chain segments into polylines
  const key = (x, y) => `${Math.round(x * 256)},${Math.round(y * 256)}`;
  const ends = new Map(); // key -> [{s, e}] seg index + which end
  segs.forEach((sg, si) => {
    for (const e of [0, 1]) {
      const k = key(sg[e * 2], sg[e * 2 + 1]);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push({ si, e });
    }
  });
  const used = new Uint8Array(segs.length);
  const polys = [];
  for (let si = 0; si < segs.length; si++) {
    if (used[si]) continue;
    used[si] = 1;
    let pts = [segs[si][0], segs[si][1], segs[si][2], segs[si][3]];
    // extend forward from tail, then backward from head
    for (const dir of [1, 0]) {
      for (;;) {
        const n = pts.length / 2;
        const hx = dir ? pts[(n - 1) * 2] : pts[0];
        const hy = dir ? pts[(n - 1) * 2 + 1] : pts[1];
        const cand = (ends.get(key(hx, hy)) || []).find((c) => !used[c.si]);
        if (!cand) break;
        used[cand.si] = 1;
        const sg = segs[cand.si];
        const ox = sg[(1 - cand.e) * 2], oy = sg[(1 - cand.e) * 2 + 1];
        if (dir) { pts.push(ox, oy); } else { pts = [ox, oy, ...pts]; }
      }
    }
    const n = pts.length / 2;
    const closed = key(pts[0], pts[1]) === key(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1]);
    if (n >= 2) polys.push({ pts, closed });
  }
  return polys;
}

function splitByMask(poly, keep) {
  const out = [];
  const n = poly.pts.length / 2;
  let cur = null;
  const idx = poly.closed ? n - 1 : n; // skip duplicate closing point
  for (let i = 0; i < idx; i++) {
    const x = poly.pts[i * 2], y = poly.pts[i * 2 + 1];
    if (keep(x, y)) {
      if (!cur) cur = [];
      cur.push(x, y);
    } else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  // whole loop kept -> keep closed
  if (out.length === 1 && poly.closed && out[0].length / 2 === idx)
    return [{ pts: out[0], closed: true }];
  return out.filter((p) => p.length >= 4).map((p) => ({ pts: p, closed: false }));
}

/* ---------------- Eikonal fast sweeping (constant scallop, section 8) ---------------- */

function solveEikonal(fRHS, nx, ny, h) {
  const N = (nx + 1) * (ny + 1);
  const T = new Float64Array(N).fill(1e30);
  for (let i = 0; i <= nx; i++) { T[i] = 0; T[ny * (nx + 1) + i] = 0; }
  for (let j = 0; j <= ny; j++) { T[j * (nx + 1)] = 0; T[j * (nx + 1) + nx] = 0; }
  const upd = (i, j) => {
    const k = j * (nx + 1) + i;
    const a = Math.min(i > 0 ? T[k - 1] : 1e30, i < nx ? T[k + 1] : 1e30);
    const b = Math.min(j > 0 ? T[k - (nx + 1)] : 1e30, j < ny ? T[k + (nx + 1)] : 1e30);
    const f = fRHS[k] * h;
    let t;
    if (Math.abs(a - b) >= f) t = Math.min(a, b) + f;
    else t = (a + b + Math.sqrt(2 * f * f - (a - b) * (a - b))) / 2;
    if (t < T[k]) T[k] = t;
  };
  for (let it = 0; it < 4; it++) {
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) upd(i, j);
    for (let j = 0; j <= ny; j++) for (let i = nx; i >= 0; i--) upd(i, j);
    for (let j = ny; j >= 0; j--) for (let i = 0; i <= nx; i++) upd(i, j);
    for (let j = ny; j >= 0; j--) for (let i = nx; i >= 0; i--) upd(i, j);
  }
  return T;
}

/* ================================================================
   JOB GENERATION
   move kinds: rapid, plunge, ramp (helix/zigzag entry), cut
   ================================================================ */

const KIND_SPEED = (kind, feed) =>
  kind === "rapid" ? 3000 :
  kind === "plunge" ? Math.max(30, feed / 3) :
  kind === "ramp" ? Math.max(30, feed * 0.5) : feed;

/* --- helix / ramp / plunge entry, validated against evalA --- */
function emitEntry(mv, phase, sx, sy, ux, uy, avail, zTop, z, evalA, R, prm) {
  const mode = prm.entryMode;
  const ang = Math.max(0.5, prm.rampAngle) * Math.PI / 180;
  const nxv = -uy, nyv = ux;
  if (mode === "auto") {
    // try helix: tool-center orbit of radius rh, fully inside allowed region
    const rh = Math.max(0.25, R * 0.5);
    if (avail > 2 * rh + 0.2) {
      const cx = sx + rh * ux, cy = sy + rh * uy;
      let ok = true;
      for (let k = 0; k < 12; k++) {
        const th = (k / 12) * 2 * Math.PI;
        const px = cx - rh * Math.cos(th) * ux + rh * Math.sin(th) * nxv;
        const py = cy - rh * Math.cos(th) * uy + rh * Math.sin(th) * nyv;
        if (evalA(px, py) > z + 1e-6) { ok = false; break; }
      }
      if (ok) {
        const pitch = rh * Math.tan(ang); // descent per radian
        const pts = [];
        let th = 0, zc = zTop;
        while (zc > z + 1e-9) {
          th += Math.PI / 8;
          zc = Math.max(z, zTop - th * pitch);
          pts.push(cx - rh * Math.cos(th) * ux + rh * Math.sin(th) * nxv,
                   cy - rh * Math.cos(th) * uy + rh * Math.sin(th) * nyv, zc);
        }
        const thEnd = Math.ceil(th / (2 * Math.PI)) * 2 * Math.PI; // flatten the floor, end at start point
        while (th < thEnd - 1e-9) {
          th = Math.min(thEnd, th + Math.PI / 8);
          pts.push(cx - rh * Math.cos(th) * ux + rh * Math.sin(th) * nxv,
                   cy - rh * Math.cos(th) * uy + rh * Math.sin(th) * nyv, z);
        }
        mv("ramp", phase, pts);
        return;
      }
    }
  }
  if (mode === "auto" || mode === "ramp") {
    // zig-zag ramp along the first-cut direction, inside the interval
    const Lr = Math.min(Math.max(2 * R, 2), Math.max(0, avail * 0.9));
    if (Lr >= 0.8) {
      const drop = Lr * Math.tan(ang);
      const pts = [];
      let zc = zTop, atFar = false;
      while (zc > z + 1e-9) {
        zc = Math.max(z, zc - drop);
        atFar = !atFar;
        pts.push(sx + (atFar ? Lr * ux : 0), sy + (atFar ? Lr * uy : 0), zc);
      }
      if (atFar) pts.push(sx, sy, z);
      mv("ramp", phase, pts);
      return;
    }
  }
  mv("plunge", phase, [sx, sy, z]);
}

async function generateJob(model, tool, prm, onProgress, cancelRef) {
  const R = tool.diameter / 2;
  const b = model.bbox;
  const clearZ = b.maxZ + prm.clearance;
  const m = prm.margin;
  const alongX = prm.direction === "X";
  const aLo = (alongX ? b.minX : b.minY) - m;
  const aHi = (alongX ? b.maxX : b.maxY) + m;
  const bLo = (alongX ? b.minY : b.minX) - m;
  const bHi = (alongX ? b.maxY : b.maxX) + m;
  const W = alongX ? (a, bb) => [a, bb] : (a, bb) => [bb, a];
  const xLo = b.minX - m, xHi = b.maxX + m, yLo = b.minY - m, yHi = b.maxY + m;

  const moves = [];
  const mv = (kind, phase, arr) => moves.push({ kind, phase, pts: arr.slice() });

  /* ================= ROUGHING ================= */
  let roughLevels = 0;
  if (prm.roughOn) {
    const al = prm.allowance;
    const inflTool = { type: tool.type, diameter: tool.diameter + 2 * al };
    const rGrid = buildGrid(model, inflTool.diameter / 2);
    const rawEval = makeEvaluator(model, rGrid, inflTool, prm.floorZ);
    const evalA = (x, y) => rawEval(x, y) + al;
    const evalABr = alongX ? (a, bb) => evalA(a, bb) : (a, bb) => evalA(bb, a);

    const zBottom = prm.floorZ + al;
    const levels = [];
    for (let z = b.maxZ - prm.stepdown; z > zBottom + 1e-6; z -= prm.stepdown) levels.push(z);
    if (b.maxZ > zBottom + 1e-6) levels.push(zBottom);
    roughLevels = levels.length;

    const rs = Math.max(0.1, tool.diameter * (prm.roughStepPct / 100));
    const span = bHi - bLo;
    const nRows = Math.max(1, Math.ceil(span / rs));
    const rstep = span / nRows;
    const da = Math.min(Math.max(R / 2, 0.15), 1);

    let curX = null, curY = null;

    for (let li = 0; li < levels.length; li++) {
      if (cancelRef.current) return null;
      const z = levels[li];
      const zTop = Math.min(clearZ, z + prm.stepdown + 0.4);

      const rows = [];
      const uf = [];
      const find = (x) => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; };
      const uni = (p, q) => { uf[find(p)] = find(q); };
      let nextId = 0;

      for (let j = 0; j <= nRows; j++) {
        const bb = bLo + j * rstep;
        const ivs = [];
        let open = null;
        let prevA = aLo, prevOk = evalABr(aLo, bb) <= z + 1e-6;
        if (prevOk) open = aLo;
        for (let a = aLo + da; a <= aHi + 1e-9; a += da) {
          const aa = Math.min(a, aHi);
          const ok = evalABr(aa, bb) <= z + 1e-6;
          if (ok !== prevOk) {
            let lo = prevA, hi = aa;
            for (let it = 0; it < 5; it++) {
              const mid = (lo + hi) / 2;
              if ((evalABr(mid, bb) <= z + 1e-6) === prevOk) lo = mid; else hi = mid;
            }
            const edge = (lo + hi) / 2;
            if (ok) open = edge;
            else { if (edge - open > 0.05) ivs.push({ a0: open, a1: edge, id: -1 }); open = null; }
          }
          prevA = aa; prevOk = ok;
          if (aa >= aHi) break;
        }
        if (open !== null && aHi - open > 0.05) ivs.push({ a0: open, a1: aHi, id: -1 });
        for (const iv of ivs) {
          iv.id = nextId; uf[nextId] = nextId; nextId++;
          if (j > 0) for (const pv of rows[j - 1])
            if (iv.a0 <= pv.a1 + 1e-6 && iv.a1 >= pv.a0 - 1e-6) uni(iv.id, pv.id);
        }
        rows.push(ivs);
      }

      const groups = new Map();
      for (let j = 0; j <= nRows; j++)
        for (const iv of rows[j]) {
          const r = find(iv.id);
          if (!groups.has(r)) groups.set(r, []);
          groups.get(r).push({ j, iv });
        }
      const comps = [...groups.values()].sort((g1, g2) => g1[0].j - g2[0].j);

      for (const comp of comps) {
        const byRow = new Map();
        for (const e of comp) {
          if (!byRow.has(e.j)) byRow.set(e.j, []);
          byRow.get(e.j).push(e.iv);
        }
        const jList = [...byRow.keys()].sort((x, y) => x - y);
        let dirFwd = true, first = true;
        for (const j of jList) {
          const bb = bLo + j * rstep;
          const ivs = byRow.get(j).sort((p, q) => p.a0 - q.a0);
          const seq = dirFwd ? ivs : [...ivs].reverse();
          for (const iv of seq) {
            const s = dirFwd ? iv.a0 : iv.a1;
            const e = dirFwd ? iv.a1 : iv.a0;
            const [sx, sy] = W(s, bb);
            const [exW, eyW] = W(e, bb);
            const ivLen = Math.abs(iv.a1 - iv.a0);
            let dux = exW - sx, duy = eyW - sy;
            const dl = Math.hypot(dux, duy) || 1;
            dux /= dl; duy /= dl;
            if (first) {
              mv("rapid", "rough", [sx, sy, clearZ, sx, sy, zTop]);
              emitEntry(mv, "rough", sx, sy, dux, duy, ivLen, zTop, z, evalA, R, prm);
              first = false;
            } else {
              const dx = sx - curX, dy = sy - curY;
              const len = Math.hypot(dx, dy);
              let stayDown = len < 4 * rstep;
              if (stayDown) {
                const nS = Math.max(2, Math.ceil(len / Math.max(0.2, R / 2)));
                for (let k = 0; k <= nS; k++) {
                  const t = k / nS;
                  if (evalA(curX + dx * t, curY + dy * t) > z + 1e-6) { stayDown = false; break; }
                }
              }
              if (stayDown) {
                mv("cut", "rough", [sx, sy, z]);
              } else {
                let hMax = z;
                const nS = Math.max(2, Math.ceil(len / Math.max(0.3, R)));
                for (let k = 0; k <= nS; k++) {
                  const t = k / nS;
                  const h = evalA(curX + dx * t, curY + dy * t);
                  if (h > hMax) hMax = h;
                }
                const zl = Math.min(clearZ, Math.max(z + 1, Math.min(b.maxZ, hMax) + prm.stepdown * 0.5 + 1));
                mv("rapid", "rough", [curX, curY, zl, sx, sy, zl, sx, sy, Math.min(zl, zTop)]);
                emitEntry(mv, "rough", sx, sy, dux, duy, ivLen, Math.min(zl, zTop), z, evalA, R, prm);
              }
            }
            mv("cut", "rough", [exW, eyW, z]);
            curX = exW; curY = eyW;
          }
          dirFwd = !dirFwd;
        }
        mv("rapid", "rough", [curX, curY, clearZ]);
      }
      onProgress(0.3 * ((li + 1) / levels.length));
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  /* ================= FINISHING ================= */
  const fGrid = buildGrid(model, R);
  const evalF = makeEvaluator(model, fGrid, tool, prm.floorZ);
  const evalAB = alongX ? (a, bb) => evalF(a, bb) : (a, bb) => evalF(bb, a);

  let s0;
  if (tool.type === "ball") {
    const h = Math.max(1e-5, prm.scallop);
    s0 = 2 * Math.sqrt(Math.max(1e-9, 2 * R * h - h * h));
  } else s0 = tool.diameter * (prm.stepoverPct / 100);
  s0 = Math.min(Math.max(s0, 0.02), 1.8 * R);

  const tol = Math.max(1e-4, prm.chordTol);
  const seg0 = Math.min(Math.max(R, 0.6), 3);
  const minLen = Math.max(0.04, tol * 2);
  const MAXD = 11;

  // finishing cursor + link helpers (used by hybrid + scallop)
  let cur = null; // {x,y,z}
  const finMoves = []; // separate list so all finish cut moves can be arc-fitted
  const fmv = (kind, arr, ops) => finMoves.push({ kind, phase: "finish", pts: arr.slice(), ops: ops || null });

  function refineLine(x0p, y0p, z0p, x1p, y1p, z1p, depth, out) {
    const len = Math.hypot(x1p - x0p, y1p - y0p);
    if (depth <= 0 || len < minLen) { out.push(x1p, y1p, z1p); return; }
    const xm = (x0p + x1p) / 2, ym = (y0p + y1p) / 2;
    const zm = evalF(xm, ym);
    if (len > seg0 || Math.abs(zm - (z0p + z1p) / 2) > tol) {
      refineLine(x0p, y0p, z0p, xm, ym, zm, depth - 1, out);
      refineLine(xm, ym, zm, x1p, y1p, z1p, depth - 1, out);
    } else out.push(x1p, y1p, z1p);
  }

  function finLink(tx, ty, tz) {
    if (!cur) {
      fmv("rapid", [tx, ty, clearZ]);
      fmv("plunge", [tx, ty, tz]);
    } else {
      const d = Math.hypot(tx - cur.x, ty - cur.y);
      if (d <= Math.max(3 * s0, 1.5)) {
        const out = [];
        refineLine(cur.x, cur.y, cur.z, tx, ty, tz, MAXD, out);
        fmv("cut", out); // ride the CL surface across
      } else {
        let hMax = Math.max(cur.z, tz);
        const nS = Math.max(2, Math.ceil(d / Math.max(0.5, R)));
        for (let k = 0; k <= nS; k++) {
          const t = k / nS;
          const h = evalF(cur.x + (tx - cur.x) * t, cur.y + (ty - cur.y) * t);
          if (h > hMax) hMax = h;
        }
        const zl = Math.min(clearZ, hMax + 0.6);
        fmv("rapid", [cur.x, cur.y, zl, tx, ty, zl]);
        fmv("plunge", [tx, ty, tz]);
      }
    }
    cur = { x: tx, y: ty, z: tz };
  }

  let finDesc = "";
  const strategy = prm.strategy;

  if (strategy === "raster") {
    /* --- plain zig-zag raster (v2 behavior) --- */
    const span = bHi - bLo;
    const rows = Math.max(1, Math.ceil(span / s0));
    const step = span / rows;
    const pts = [];
    const push = alongX
      ? (a, bb, z) => { pts.push(a, bb, z); }
      : (a, bb, z) => { pts.push(bb, a, z); };
    function refineA(bF, a0, z0, a1, z1, d) {
      const len = Math.abs(a1 - a0);
      if (d <= 0 || len < minLen) { push(a1, bF, z1); return; }
      const am = (a0 + a1) / 2, zm = evalAB(am, bF);
      if (len > seg0 || Math.abs(zm - (z0 + z1) / 2) > tol) {
        refineA(bF, a0, z0, am, zm, d - 1); refineA(bF, am, zm, a1, z1, d - 1);
      } else push(a1, bF, z1);
    }
    function refineB(aF, b0, z0, b1, z1, d) {
      const len = Math.abs(b1 - b0);
      if (d <= 0 || len < minLen) { push(aF, b1, z1); return; }
      const bm = (b0 + b1) / 2, zm = evalAB(aF, bm);
      if (len > seg0 || Math.abs(zm - (z0 + z1) / 2) > tol) {
        refineB(aF, b0, z0, bm, zm, d - 1); refineB(aF, bm, zm, b1, z1, d - 1);
      } else push(aF, b1, z1);
    }
    let prevB = bLo, prevZ = 0;
    for (let j = 0; j <= rows; j++) {
      if (cancelRef.current) return null;
      const bb = bLo + j * step;
      const fwd = j % 2 === 0;
      const aS = fwd ? aLo : aHi, aE = fwd ? aHi : aLo;
      const zS = evalAB(aS, bb);
      if (j === 0) push(aS, bb, zS);
      else refineB(aS, prevB, prevZ, bb, zS, MAXD);
      const zE = evalAB(aE, bb);
      refineA(bb, aS, zS, aE, zE, MAXD);
      prevB = bb; prevZ = zE;
      if (j % 3 === 2) { onProgress(0.3 + 0.5 * (j / rows)); await new Promise((r) => setTimeout(r, 0)); }
    }
    const P = new Float32Array(pts);
    fmv("rapid", [P[0], P[1], clearZ]);
    fmv("plunge", [P[0], P[1], P[2]]);
    finMoves.push({ kind: "cut", phase: "finish", pts: P, ops: null });
    cur = { x: P[P.length - 3], y: P[P.length - 2], z: P[P.length - 1] };
    finDesc = `raster ${rows + 1} passes @ ${step.toFixed(3)}`;
  } else {
    /* --- shared CL field for hybrid + scallop --- */
    const gs = Math.min(0.6, Math.max(0.25, s0));
    const fld = await buildCLField(evalF, xLo, xHi, yLo, yHi, gs,
      (p) => onProgress(0.3 + 0.12 * p), cancelRef);
    if (!fld) return null;

    if (strategy === "hybrid") {
      /* raster on shallow, waterline contours on steep */
      const tanTh = Math.tan((Math.max(5, prm.steepDeg) * Math.PI) / 180);
      const shallow = (x, y) => fld.sampleG(x, y) <= tanTh * 1.15;
      const steep = (x, y) => fld.sampleG(x, y) >= tanTh * 0.85;

      // 1) shallow raster intervals
      const span = bHi - bLo;
      const rows = Math.max(1, Math.ceil(span / s0));
      const step = span / rows;
      const ds = gs * 0.75;
      let nInt = 0;
      for (let j = 0; j <= rows; j++) {
        if (cancelRef.current) return null;
        const bb = bLo + j * step;
        const fwd = j % 2 === 0;
        // intervals of shallow along the row
        const ivs = [];
        let open = null;
        for (let a = aLo; a <= aHi + 1e-9; a += ds) {
          const aa = Math.min(a, aHi);
          const [wx, wy] = W(aa, bb);
          const ok = shallow(wx, wy);
          if (ok && open === null) open = aa;
          if ((!ok || aa >= aHi) && open !== null) {
            const end = ok ? aa : aa - ds;
            if (end - open > 2 * gs) ivs.push([open, end]);
            open = null;
          }
          if (aa >= aHi) break;
        }
        const seq = fwd ? ivs : [...ivs].reverse();
        for (const iv of seq) {
          const s = fwd ? iv[0] : iv[1], e = fwd ? iv[1] : iv[0];
          const [sx, sy] = W(s, bb), [ex, ey] = W(e, bb);
          const zS = evalF(sx, sy), zE = evalF(ex, ey);
          finLink(sx, sy, zS);
          const out = [];
          refineLine(sx, sy, zS, ex, ey, zE, MAXD, out);
          fmv("cut", out);
          cur = { x: ex, y: ey, z: zE };
          nInt++;
        }
        if (j % 4 === 3) { onProgress(0.42 + 0.22 * (j / rows)); await new Promise((r) => setTimeout(r, 0)); }
      }

      // 2) waterline contours on steep, top-down, constant Z each
      let maxF = -Infinity;
      for (let k = 0; k < fld.F.length; k++) if (fld.F[k] > maxF) maxF = fld.F[k];
      let nWL = 0;
      const zTopWL = maxF - 0.6 * s0;
      const nLev = Math.max(0, Math.floor((zTopWL - (prm.floorZ + 0.05)) / s0) + 1);
      for (let li = 0; li < nLev; li++) {
        if (cancelRef.current) return null;
        const z = zTopWL - li * s0;
        const polys = marchSquares(fld.F, fld.nx, fld.ny, fld.x0, fld.y0, fld.gs, z);
        const runs = [];
        for (const p of polys) runs.push(...splitByMask(p, steep));
        // nearest-first ordering within the level
        while (runs.length) {
          let bi = 0, bd = Infinity, brev = false;
          for (let i = 0; i < runs.length; i++) {
            const p = runs[i].pts, n = p.length / 2;
            const d0 = cur ? Math.hypot(p[0] - cur.x, p[1] - cur.y) : 0;
            const d1 = cur ? Math.hypot(p[(n - 1) * 2] - cur.x, p[(n - 1) * 2 + 1] - cur.y) : 0;
            if (d0 < bd) { bd = d0; bi = i; brev = false; }
            if (!runs[i].closed && d1 < bd) { bd = d1; bi = i; brev = true; }
          }
          const run = runs.splice(bi, 1)[0];
          let p = run.pts;
          if (brev) {
            const q = [];
            for (let i = p.length / 2 - 1; i >= 0; i--) q.push(p[i * 2], p[i * 2 + 1]);
            p = q;
          }
          const n = p.length / 2;
          if (n < 2) continue;
          finLink(p[0], p[1], z);
          const out = [];
          for (let i = 1; i < n; i++) out.push(p[i * 2], p[i * 2 + 1], z);
          if (run.closed) out.push(p[0], p[1], z);
          fmv("cut", out);
          const lx = out[out.length - 3], ly = out[out.length - 2];
          cur = { x: lx, y: ly, z };
          nWL++;
        }
        if (li % 3 === 2) { onProgress(0.64 + 0.16 * (li / Math.max(1, nLev))); await new Promise((r) => setTimeout(r, 0)); }
      }
      finDesc = `hybrid: ${nInt} raster spans + ${nWL} waterline contours`;
    } else {
      /* --- constant scallop: |grad T| = sqrt(1+|grad f|^2)/s0 --- */
      const N = (fld.nx + 1) * (fld.ny + 1);
      const rhs = new Float64Array(N);
      for (let k = 0; k < N; k++) rhs[k] = Math.sqrt(1 + fld.G[k] * fld.G[k]) / s0;
      const Tf = solveEikonal(rhs, fld.nx, fld.ny, fld.gs);
      let Tmax = 0;
      for (let k = 0; k < N; k++) if (Tf[k] < 1e29 && Tf[k] > Tmax) Tmax = Tf[k];
      const nC = Math.floor(Tmax - 0.4);
      let nCS = 0;
      for (let ci = 1; ci <= nC; ci++) {
        if (cancelRef.current) return null;
        const polys = marchSquares(Tf, fld.nx, fld.ny, fld.x0, fld.y0, fld.gs, ci);
        for (const poly of polys) {
          const n = poly.pts.length / 2;
          if (n < 4) continue;
          // pick start nearest to cursor for closed loops
          let start = 0;
          if (cur && poly.closed) {
            let bd = Infinity;
            for (let i = 0; i < n - 1; i++) {
              const d = Math.hypot(poly.pts[i * 2] - cur.x, poly.pts[i * 2 + 1] - cur.y);
              if (d < bd) { bd = d; start = i; }
            }
          }
          const idx = [];
          const nn = poly.closed ? n - 1 : n;
          for (let k = 0; k < nn; k++) idx.push((start + k) % nn);
          if (poly.closed) idx.push(start);
          const x0p = poly.pts[idx[0] * 2], y0p = poly.pts[idx[0] * 2 + 1];
          finLink(x0p, y0p, evalF(x0p, y0p));
          const out = [];
          for (let k = 1; k < idx.length; k++) {
            const x = poly.pts[idx[k] * 2], y = poly.pts[idx[k] * 2 + 1];
            out.push(x, y, evalF(x, y)); // lift onto the CL surface exactly
          }
          fmv("cut", out);
          cur = { x: out[out.length - 3], y: out[out.length - 2], z: out[out.length - 1] };
          nCS++;
        }
        if (ci % 4 === 3) { onProgress(0.42 + 0.38 * (ci / nC)); await new Promise((r) => setTimeout(r, 0)); }
      }
      finDesc = `constant scallop: ${nCS} iso-scallop contours`;
    }
  }

  if (cur) fmv("rapid", [cur.x, cur.y, clearZ]);
  moves.push(...finMoves);

  /* ---------------- arc fitting on finishing cut moves ---------------- */
  let arcStats = null;
  if (prm.arcFit) {
    let nA = 0, nL = 0, raw = 0;
    for (const mo of finMoves) {
      if (mo.kind !== "cut") continue;
      const P = mo.pts instanceof Float32Array ? mo.pts : new Float32Array(mo.pts);
      mo.pts = P;
      const nP = P.length / 3;
      if (nP < 6) continue;
      mo.ops = compressCut(P, nP, Math.max(1e-4, prm.arcTol));
      raw += nP - 1;
      for (const op of mo.ops) op.t === "A" ? nA++ : nL++;
    }
    if (raw > 0) arcStats = { arcs: nA, lines: nL, raw };
  }
  onProgress(1);

  /* ---------------- flatten ---------------- */
  let total = 0;
  for (const mo of moves) total += mo.pts.length / 3;
  const pos = new Float32Array(total * 3);
  const kinds = new Uint8Array(total); // 0 rapid,1 plunge,2 rough-cut,3 finish-cut,4 ramp
  const cumT = new Float64Array(total);
  let idx = 0, t = 0, cx = null, cy = null, cz = null;
  let cutLen = 0, tRough = 0, tFinish = 0;
  let zMin = Infinity, zMax = -Infinity;
  for (const mo of moves) {
    const spd = KIND_SPEED(mo.kind, prm.feed) / 60;
    const k = mo.kind === "rapid" ? 0 : mo.kind === "plunge" ? 1 :
      mo.kind === "ramp" ? 4 : mo.phase === "rough" ? 2 : 3;
    for (let i = 0; i < mo.pts.length; i += 3) {
      const x = mo.pts[i], y = mo.pts[i + 1], z = mo.pts[i + 2];
      if (cx !== null) {
        const d = Math.hypot(x - cx, y - cy, z - cz);
        t += d / spd;
        if (k >= 2 || k === 1) cutLen += d;
        if (mo.phase === "rough") tRough += d / spd; else tFinish += d / spd;
      }
      pos[idx * 3] = x; pos[idx * 3 + 1] = y; pos[idx * 3 + 2] = z;
      kinds[idx] = k; cumT[idx] = t;
      if (k === 3) { if (z < zMin) zMin = z; if (z > zMax) zMax = z; }
      cx = x; cy = y; cz = z; idx++;
    }
  }
  if (!isFinite(zMin)) { zMin = 0; zMax = 1; }

  return {
    moves, pos, kinds, cumT, nPts: total, zMin, zMax, clearZ,
    stats: {
      finDesc, step: s0, roughLevels,
      cutLenMM: cutLen, timeMin: t / 60, roughMin: tRough / 60, finishMin: tFinish / 60,
      arc: arcStats,
    },
  };
}

/* ================================================================
   ARC FITTING — G18 (XZ) / G19 (YZ) vertical arcs + G17 (XY) arcs
   ================================================================ */

function compressCut(P, n, tol) {
  const ops = [];
  let i = 0;
  const segAxis = (k) => {
    const dx = Math.abs(P[(k + 1) * 3] - P[k * 3]);
    const dy = Math.abs(P[(k + 1) * 3 + 1] - P[k * 3 + 1]);
    const dz = Math.abs(P[(k + 1) * 3 + 2] - P[k * 3 + 2]);
    if (dy < 1e-6 && dx >= 1e-6) return "y";           // XZ plane (G18)
    if (dx < 1e-6 && dy >= 1e-6) return "x";           // YZ plane (G19)
    if (dz < 1e-6 && (dx >= 1e-6 || dy >= 1e-6)) return "z"; // XY plane (G17)
    return null;
  };
  while (i < n - 1) {
    const ax = segAxis(i);
    let j = i + 1;
    while (j < n - 1 && segAxis(j) === ax) j++;
    if (ax && j - i >= 5) fitArcsRun(P, i, j, ax, tol, ops);
    else for (let k = i + 1; k <= j; k++) ops.push({ t: "L", i: k });
    i = j;
  }
  return ops;
}

function fitArcsRun(P, i0, i1, constAxis, tol, ops) {
  const U = (k) => (constAxis === "x" ? P[k * 3 + 1] : P[k * 3]);
  const V = (k) => (constAxis === "z" ? P[k * 3 + 1] : P[k * 3 + 2]);
  const plane = constAxis === "y" ? 18 : constAxis === "x" ? 19 : 17;
  const u0 = U(i0), v0 = V(i0);

  let s = i0;
  while (s < i1) {
    let Su = 0, Sv = 0, Suu = 0, Svv = 0, Suv = 0, Suuu = 0, Suvv = 0, Svvv = 0, Svuu = 0, np = 0;
    const add = (k) => {
      const u = U(k) - u0, v = V(k) - v0;
      Su += u; Sv += v; Suu += u * u; Svv += v * v; Suv += u * v;
      Suuu += u * u * u; Suvv += u * v * v; Svvv += v * v * v; Svuu += v * u * u; np++;
    };
    const tryFit = (a, e) => {
      const M11 = Suu, M12 = Suv, M13 = Su, M22 = Svv, M23 = Sv, M33 = np;
      const b1 = -(Suuu + Suvv), b2 = -(Svuu + Svvv), b3 = -(Suu + Svv);
      const det = M11 * (M22 * M33 - M23 * M23) - M12 * (M12 * M33 - M23 * M13) + M13 * (M12 * M23 - M22 * M13);
      if (Math.abs(det) < 1e-9 * Math.max(1, M33 * M11 * M22)) return null;
      const A = (b1 * (M22 * M33 - M23 * M23) - M12 * (b2 * M33 - M23 * b3) + M13 * (b2 * M23 - M22 * b3)) / det;
      const B = (M11 * (b2 * M33 - M23 * b3) - b1 * (M12 * M33 - M23 * M13) + M13 * (M12 * b3 - b2 * M13)) / det;
      let uc = -A / 2, vc = -B / 2;
      const ua = U(a) - u0, va = V(a) - v0, ub = U(e) - u0, vb = V(e) - v0;
      const mx = (ua + ub) / 2, my = (va + vb) / 2;
      let ex = ub - ua, ey = vb - va;
      const el = Math.hypot(ex, ey);
      if (el < 1e-9) return null;
      ex /= el; ey /= el;
      const dpar = (uc - mx) * ex + (vc - my) * ey;
      uc -= dpar * ex; vc -= dpar * ey;
      const Rr = Math.hypot(ua - uc, va - vc);
      if (Rr < 0.2 || Rr > 4000) return null;
      let prevAng = Math.atan2(va - vc, ua - uc), sweep = 0, sgn = 0;
      for (let k = a; k <= e; k++) {
        const du = U(k) - u0 - uc, dv = V(k) - v0 - vc;
        if (Math.abs(Math.hypot(du, dv) - Rr) > tol) return null;
        if (k > a) {
          const ang = Math.atan2(dv, du);
          let dth = ang - prevAng;
          while (dth > Math.PI) dth -= 2 * Math.PI;
          while (dth < -Math.PI) dth += 2 * Math.PI;
          if (Math.abs(dth) > 1e-6) {
            const sg = Math.sign(dth);
            if (sgn === 0) sgn = sg;
            else if (sg !== sgn) return null;
          }
          sweep += dth; prevAng = ang;
        }
      }
      if (Math.abs(sweep) > 2.9) return null;
      if (sgn === 0) return null;
      return { uc: uc + u0, vc: vc + v0, pos: sgn > 0 };
    };

    add(s); add(s + 1);
    let e = s + 1, lastGood = null, misses = 0;
    while (e < i1) {
      e++; add(e);
      if (e - s >= 4) {
        const f = tryFit(s, e);
        if (f) { lastGood = { e, f }; misses = 0; }
        else if (lastGood && ++misses >= 3) break;
        else if (!lastGood && e - s >= 12) break;
      }
    }
    if (lastGood && lastGood.e - s >= 5) {
      ops.push({ t: "A", i: lastGood.e, uc: lastGood.f.uc, vc: lastGood.f.vc, pos: lastGood.f.pos, plane });
      s = lastGood.e;
    } else {
      ops.push({ t: "L", i: s + 1 });
      s = s + 1;
    }
  }
}

/* ================================================================
   G-CODE
   ================================================================ */

function toGcode(job, tool, prm, modelName) {
  const f = (v) => v.toFixed(3);
  const L = [];
  const feed = Math.round(prm.feed);
  const plunge = Math.round(Math.max(30, prm.feed / 3));
  const rampF = Math.round(Math.max(30, prm.feed * 0.5));
  L.push("%");
  L.push(`(DROPCUT - ${modelName})`);
  L.push(`(TOOL: ${tool.type.toUpperCase()} D${f(tool.diameter)} MM)`);
  if (job.stats.roughLevels)
    L.push(`(ROUGHING: ${job.stats.roughLevels} LEVELS, ALLOWANCE ${f(prm.allowance)} MM)`);
  L.push(`(FINISH: ${job.stats.finDesc.toUpperCase()})`);
  L.push("G21 G90 G94 G17");
  L.push(`S${Math.round(prm.rpm)} M3`);
  L.push(`G0 Z${f(job.clearZ)}`);

  let curF = null, curPlane = 17;
  let cx = null, cy = null, cz = null;
  const ensureF = (F) => { if (curF !== F) { L.push(`F${F}`); curF = F; } };
  const ensurePlane = (p) => { if (curPlane !== p) { L.push(`G${p}`); curPlane = p; } };

  for (const mo of job.moves) {
    if (mo.kind === "rapid") {
      ensurePlane(17);
      for (let i = 0; i < mo.pts.length; i += 3) {
        cx = mo.pts[i]; cy = mo.pts[i + 1]; cz = mo.pts[i + 2];
        L.push(`G0 X${f(cx)} Y${f(cy)} Z${f(cz)}`);
      }
    } else if (mo.kind === "plunge" || mo.kind === "ramp") {
      ensurePlane(17); ensureF(mo.kind === "ramp" ? rampF : plunge);
      for (let i = 0; i < mo.pts.length; i += 3) {
        cx = mo.pts[i]; cy = mo.pts[i + 1]; cz = mo.pts[i + 2];
        L.push(`G1 X${f(cx)} Y${f(cy)} Z${f(cz)}`);
      }
    } else if (mo.ops) {
      ensureF(feed);
      const P = mo.pts;
      for (const op of mo.ops) {
        const x = P[op.i * 3], y = P[op.i * 3 + 1], z = P[op.i * 3 + 2];
        if (op.t === "L") {
          ensurePlane(17);
          L.push(`G1 X${f(x)} Y${f(y)} Z${f(z)}`);
        } else if (op.plane === 18) {
          ensurePlane(18);
          const g = op.pos ? "G2" : "G3"; // CCW in (x,z) frame = CW seen from +Y
          L.push(`${g} X${f(x)} Z${f(z)} I${f(op.uc - cx)} K${f(op.vc - cz)}`);
        } else if (op.plane === 19) {
          ensurePlane(19);
          const g = op.pos ? "G3" : "G2";
          L.push(`${g} Y${f(y)} Z${f(z)} J${f(op.uc - cy)} K${f(op.vc - cz)}`);
        } else {
          ensurePlane(17);
          const g = op.pos ? "G3" : "G2"; // CCW in (x,y) frame = CCW seen from +Z
          L.push(`${g} X${f(x)} Y${f(y)} I${f(op.uc - cx)} J${f(op.vc - cy)}`);
        }
        cx = x; cy = y; cz = z;
      }
      ensurePlane(17);
    } else {
      ensurePlane(17); ensureF(feed);
      for (let i = 0; i < mo.pts.length; i += 3) {
        cx = mo.pts[i]; cy = mo.pts[i + 1]; cz = mo.pts[i + 2];
        L.push(`G1 X${f(cx)} Y${f(cy)} Z${f(cz)}`);
      }
    }
  }
  L.push(`G0 Z${f(job.clearZ)}`);
  L.push("M5");
  L.push("M30");
  L.push("%");
  return { text: L.join("\n"), nLines: L.length };
}

/* ================================================================
   DEXEL VERIFICATION — heightmap material removal + deviation
   ================================================================ */

async function verifyJob(job, model, prm, tool, onProg, cancelRef) {
  const b = model.bbox, m = prm.margin;
  const x0 = b.minX - m, x1 = b.maxX + m, y0 = b.minY - m, y1 = b.maxY + m;
  const vs = Math.max(0.1, Math.min(0.35, Math.max(x1 - x0, y1 - y0) / 240));
  const nx = Math.max(4, Math.ceil((x1 - x0) / vs));
  const ny = Math.max(4, Math.ceil((y1 - y0) / vs));
  const NN = (nx + 1) * (ny + 1);
  const H = new Float64Array(NN).fill(b.maxZ);   // machined stock
  const Tg = new Float64Array(NN).fill(prm.floorZ); // target surface

  // rasterize model triangles into the target field (max-z per node)
  const T = model.tris;
  for (let t = 0; t < model.nTri; t++) {
    const o = t * 9;
    const ax = T[o], ay = T[o + 1], az = T[o + 2];
    const bx = T[o + 3], by = T[o + 4], bz = T[o + 5];
    const cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / vs));
    const i1 = Math.min(nx, Math.ceil((Math.max(ax, bx, cx) - x0) / vs));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - y0) / vs));
    const j1 = Math.min(ny, Math.ceil((Math.max(ay, by, cy) - y0) / vs));
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nzc = ux * vy - uy * vx;
    if (Math.abs(nzc) < 1e-12) continue;
    const nxc = uy * vz - uz * vy, nyc = uz * vx - ux * vz;
    const A = -nxc / nzc, B = -nyc / nzc, C = az - A * ax - B * ay;
    for (let j = j0; j <= j1; j++) {
      const py = y0 + j * vs;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + i * vs;
        if (pointInTri(px, py, ax, ay, bx, by, cx, cy)) {
          const z = A * px + B * py + C;
          const k = j * (nx + 1) + i;
          if (z > Tg[k]) Tg[k] = z;
        }
      }
    }
    if (t % 4000 === 3999) {
      onProg(0.25 * (t / model.nTri));
      await new Promise((r) => setTimeout(r, 0));
      if (cancelRef.current) return null;
    }
  }

  // tool footprint offsets (height of cutter surface above tip at radius r)
  const R = tool.diameter / 2;
  const nR = Math.ceil(R / vs);
  const offs = [];
  for (let dj = -nR; dj <= nR; dj++)
    for (let di = -nR; di <= nR; di++) {
      const r = Math.hypot(di, dj) * vs;
      if (r <= R) offs.push(di, dj, tool.type === "ball" ? R - Math.sqrt(Math.max(0, R * R - r * r)) : 0);
    }

  // sweep all cutting moves (plunge, ramp, rough-cut, finish-cut)
  const { pos, kinds, nPts } = job;
  const ds = vs * 0.6;
  for (let i = 1; i < nPts; i++) {
    if (kinds[i] === 0) continue;
    const xA = pos[(i - 1) * 3], yA = pos[(i - 1) * 3 + 1], zA = pos[(i - 1) * 3 + 2];
    const xB = pos[i * 3], yB = pos[i * 3 + 1], zB = pos[i * 3 + 2];
    const len = Math.hypot(xB - xA, yB - yA, zB - zA);
    const nS = Math.max(1, Math.ceil(len / ds));
    for (let k = 0; k <= nS; k++) {
      const t = k / nS;
      const x = xA + (xB - xA) * t, y = yA + (yB - yA) * t, z = zA + (zB - zA) * t;
      const ic = Math.round((x - x0) / vs), jc = Math.round((y - y0) / vs);
      for (let oI = 0; oI < offs.length; oI += 3) {
        const ii = ic + offs[oI], jj = jc + offs[oI + 1];
        if (ii < 0 || ii > nx || jj < 0 || jj > ny) continue;
        const kk = jj * (nx + 1) + ii;
        const fl = z + offs[oI + 2];
        if (fl < H[kk]) H[kk] = fl;
      }
    }
    if (i % 3000 === 2999) {
      onProg(0.25 + 0.7 * (i / nPts));
      await new Promise((r) => setTimeout(r, 0));
      if (cancelRef.current) return null;
    }
  }

  // deviation + stats
  const dev = new Float64Array(NN);
  let minD = Infinity, maxD = -Infinity, sum2 = 0, nPart = 0, nOK = 0;
  const band = prm.scallop + prm.chordTol + 0.05;
  for (let k = 0; k < NN; k++) {
    const d = H[k] - Tg[k];
    dev[k] = d;
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
    if (Tg[k] > prm.floorZ + 0.05) { sum2 += d * d; nPart++; }
    if (d >= -0.02 && d <= band) nOK++;
  }
  onProg(1);
  return {
    nx, ny, vs, x0, y0, H, Tg, dev,
    stats: {
      minDev: minD, maxDev: maxD,
      rms: nPart ? Math.sqrt(sum2 / nPart) : 0,
      pctOK: (100 * nOK) / NN, band,
    },
  };
}

function devColor(d, band) {
  if (d < -0.02) {
    const t = Math.min(1, (-d - 0.02) / 0.2);
    return [0.88, 0.30 - 0.12 * t, 0.24 - 0.08 * t];        // gouge: red
  }
  if (d <= band) {
    const t = Math.max(0, d) / band;
    return [0.22 + 0.4 * t, 0.64 - 0.06 * t, 0.44 + 0.28 * t]; // in-tol: green -> teal
  }
  const t = Math.min(1, (d - band) / 0.5);
  return [0.33 - 0.08 * t, 0.5 - 0.05 * t, 0.72 + 0.2 * t];   // excess stock: blue
}

/* ================================================================
   UI
   ================================================================ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Space+Grotesk:wght@500;700&display=swap');
:root{
  --bg:#14171B; --panel:#1B2026; --panel2:#20262E; --line:#2C333D;
  --text:#D5DBE4; --dim:#8A93A1; --amber:#FFB100; --cyan:#4FC8DD;
  --mono:'IBM Plex Mono',ui-monospace,monospace; --disp:'Space Grotesk',sans-serif;
}
*{box-sizing:border-box;margin:0}
.dc-app{height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text);font-family:var(--mono);font-size:13px;overflow:hidden}
.dc-head{display:flex;align-items:baseline;gap:14px;padding:10px 18px;border-bottom:1px solid var(--line);background:var(--panel)}
.dc-head h1{font-family:var(--disp);font-weight:700;font-size:17px;letter-spacing:.22em}
.dc-head h1 b{color:var(--amber)}
.dc-head span{color:var(--dim);font-size:11px}
.dc-main{flex:1;display:flex;min-height:0}
.dc-side{width:268px;flex-shrink:0;overflow-y:auto;border-right:1px solid var(--line);background:var(--panel);padding:12px 14px 24px}
.dc-grp{margin-bottom:15px}
.dc-grp>h2{font-size:10px;letter-spacing:.18em;color:var(--dim);text-transform:uppercase;border-bottom:1px solid var(--line);padding-bottom:5px;margin-bottom:9px;display:flex;justify-content:space-between;align-items:center}
.dc-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px}
.dc-row label{color:var(--dim);font-size:12px;flex:1}
.dc-row .u{color:var(--dim);font-size:10px;width:26px}
select,input[type=number]{background:var(--panel2);border:1px solid var(--line);color:var(--text);font-family:var(--mono);font-size:12px;padding:5px 7px;border-radius:3px;width:100%}
input[type=number]{width:76px;text-align:right}
input[type=checkbox]{accent-color:var(--amber);width:14px;height:14px}
select:focus,input:focus,button:focus-visible{outline:2px solid var(--amber);outline-offset:1px}
.dc-btn{display:block;width:100%;padding:9px 10px;border-radius:3px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-family:var(--mono);font-size:12px;cursor:pointer;letter-spacing:.06em}
.dc-btn:hover{border-color:var(--dim)}
.dc-btn.primary{background:var(--amber);border-color:var(--amber);color:#1a1206;font-weight:600}
.dc-btn.primary:hover{background:#ffc23d}
.dc-btn:disabled{opacity:.45;cursor:default}
.dc-prog{height:4px;background:var(--panel2);border-radius:2px;margin-top:8px;overflow:hidden}
.dc-prog>div{height:100%;background:var(--amber);transition:width .15s}
.dc-stats{background:var(--panel2);border:1px solid var(--line);border-radius:4px;padding:9px 11px;font-size:11.5px;line-height:1.75}
.dc-stats b{color:var(--amber);font-weight:500}
.dc-stats .bad{color:#E06C5A}
.dc-view{flex:1;position:relative;min-width:0;background:#101318}
.dc-view canvas{display:block}
.dc-ovl{position:absolute;top:10px;left:12px;font-size:11px;color:var(--dim);line-height:1.7;pointer-events:none}
.dc-ovl b{color:var(--text);font-weight:500}
.dc-ovl .sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.dc-hint{position:absolute;bottom:8px;right:12px;font-size:10px;color:#5b6472;pointer-events:none}
.dc-foot{display:flex;align-items:center;gap:14px;padding:8px 16px;border-top:1px solid var(--line);background:var(--panel);flex-wrap:wrap}
.dc-dro{display:flex;gap:14px;background:#0d0f12;border:1px solid var(--line);border-radius:4px;padding:6px 14px}
.dc-dro .c{display:flex;gap:7px;align-items:baseline}
.dc-dro .l{color:var(--dim);font-size:11px}
.dc-dro .v{color:var(--amber);font-weight:600;font-size:15px;min-width:9ch;text-align:right;text-shadow:0 0 8px rgba(255,177,0,.45);font-variant-numeric:tabular-nums}
.dc-sim{display:flex;gap:8px;align-items:center}
.dc-sim button,.dc-sim select{width:auto;padding:6px 12px}
.dc-status{margin-left:auto;color:var(--dim);font-size:11px}
.dc-file{display:none}
@media(max-width:760px){.dc-main{flex-direction:column}.dc-side{width:100%;max-height:44vh}}
`;

function Num({ label, unit, value, set, step = 1, min, max, dis }) {
  return (
    <div className="dc-row">
      <label>{label}</label>
      <input type="number" value={value} step={step} min={min} max={max} disabled={dis}
        onChange={(e) => set(parseFloat(e.target.value) || 0)} />
      <span className="u">{unit}</span>
    </div>
  );
}

export default function DropcutCAM() {
  const [source, setSource] = useState({ type: "preset", id: "sprite" });
  const [scale, setScale] = useState(1);
  const [model, setModel] = useState(null);
  const [tool, setTool] = useState({ type: "ball", diameter: 3 });
  const [prm, setPrm] = useState({
    strategy: "raster", scallop: 0.01, stepoverPct: 40, chordTol: 0.01,
    margin: 2, direction: "X", steepDeg: 45,
    roughOn: true, stepdown: 1.5, roughStepPct: 45, allowance: 0.2,
    entryMode: "auto", rampAngle: 3,
    arcFit: true, arcTol: 0.01, feed: 600, clearance: 5, rpm: 10000, floorZ: 0,
  });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [job, setJob] = useState(null);
  const [verif, setVerif] = useState(null);
  const [showVerif, setShowVerif] = useState(false);
  const [vBusy, setVBusy] = useState(false);
  const [vProg, setVProg] = useState(0);
  const [err, setErr] = useState("");
  const stlRef = useRef(null);
  const cancelRef = useRef(false);
  const fileInput = useRef(null);

  const setP = (k) => (v) => setPrm((s) => ({ ...s, [k]: v }));

  useEffect(() => {
    try {
      setErr("");
      let raw, name;
      if (source.type === "preset") {
        raw = heightfieldTris(PRESETS[source.id]);
        name = PRESETS[source.id].label;
      } else {
        raw = stlRef.current;
        name = source.name;
        if (!raw) return;
      }
      setModel(buildModel(raw, scale || 1, name));
      setJob(null); setVerif(null); setShowVerif(false);
    } catch (e) { setErr(String(e.message || e)); }
  }, [source, scale]);

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const buf = await f.arrayBuffer();
      stlRef.current = parseSTL(buf);
      setSource({ type: "stl", name: f.name });
    } catch (ex) { setErr("STL parse failed: " + ex.message); }
    e.target.value = "";
  };

  const onGenerate = async () => {
    if (!model || busy) return;
    cancelRef.current = false;
    setBusy(true); setJob(null); setVerif(null); setShowVerif(false); setProgress(0);
    try {
      const res = await generateJob(model, tool, prm, setProgress, cancelRef);
      if (res) setJob(res);
    } catch (ex) { setErr("Generation failed: " + ex.message); console.error(ex); }
    setBusy(false);
  };

  const onVerify = async () => {
    if (!job || !model || vBusy) return;
    cancelRef.current = false;
    setVBusy(true); setVerif(null); setVProg(0);
    try {
      const res = await verifyJob(job, model, prm, tool, setVProg, cancelRef);
      if (res) { setVerif(res); setShowVerif(true); }
    } catch (ex) { setErr("Verification failed: " + ex.message); console.error(ex); }
    setVBusy(false);
  };

  const onExport = () => {
    if (!job || !model) return;
    const g = toGcode(job, tool, prm, model.name);
    const blob = new Blob([g.text], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "dropcut.nc";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  /* ---------- three.js viewport ---------- */
  const mountRef = useRef(null);
  const threeRef = useRef({});
  const simRef = useRef({ playing: false, t: 0, mult: 8 });
  const [, forceSim] = useState(0);
  const droX = useRef(null), droY = useRef(null), droZ = useRef(null);

  useEffect(() => {
    const mount = mountRef.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    mount.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101318);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
    camera.up.set(0, 0, 1);

    scene.add(new THREE.HemisphereLight(0x9fb4cc, 0x22262c, 0.9));
    const dl = new THREE.DirectionalLight(0xffffff, 0.85);
    dl.position.set(40, -55, 80);
    scene.add(dl);
    const grid = new THREE.GridHelper(120, 24, 0x2b323c, 0x1c2229);
    grid.rotation.x = Math.PI / 2;
    scene.add(grid);
    const axGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0.02), new THREE.Vector3(14, 0, 0.02),
      new THREE.Vector3(0, 0, 0.02), new THREE.Vector3(0, 14, 0.02),
      new THREE.Vector3(0, 0, 0.02), new THREE.Vector3(0, 0, 14),
    ]);
    axGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array([
      1, .45, .35, 1, .45, .35, .45, .85, .5, .45, .85, .5, .4, .7, 1, .4, .7, 1,
    ]), 3));
    scene.add(new THREE.LineSegments(axGeo, new THREE.LineBasicMaterial({ vertexColors: true })));

    const ctl = { theta: -Math.PI / 3.2, phi: 1.05, radius: 90, target: new THREE.Vector3(0, 0, 5) };
    const applyCam = () => {
      const s = Math.sin(ctl.phi);
      camera.position.set(
        ctl.target.x + ctl.radius * s * Math.cos(ctl.theta),
        ctl.target.y + ctl.radius * s * Math.sin(ctl.theta),
        ctl.target.z + ctl.radius * Math.cos(ctl.phi));
      camera.lookAt(ctl.target);
    };
    applyCam();

    let drag = null;
    const el = renderer.domElement;
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, btn: e.button, shift: e.shiftKey };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.btn === 2 || drag.shift) {
        const k = ctl.radius * 0.0016;
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
        ctl.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
      } else {
        ctl.theta -= dx * 0.008;
        ctl.phi = Math.min(Math.PI - 0.05, Math.max(0.05, ctl.phi - dy * 0.008));
      }
      applyCam();
    });
    el.addEventListener("pointerup", () => (drag = null));
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      ctl.radius = Math.min(600, Math.max(5, ctl.radius * Math.exp(e.deltaY * 0.0011)));
      applyCam();
    }, { passive: false });

    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth, h = mount.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(mount);

    const clock = new THREE.Clock();
    let raf;
    const fmt = (v) => (v < 0 ? "-" : "+") + Math.abs(v).toFixed(3).padStart(7, "0");
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, clock.getDelta());
      const st = threeRef.current;
      const sim = simRef.current;
      if (st.job && st.toolGroup) {
        const { cumT, pos, nPts } = st.job;
        const total = cumT[nPts - 1];
        if (sim.playing) {
          sim.t += sim.mult * dt;
          if (sim.t >= total) { sim.t = total; sim.playing = false; forceSim((n) => n + 1); }
        }
        let lo = 0, hi = nPts - 1;
        while (lo < hi - 1) { const md = (lo + hi) >> 1; (cumT[md] <= sim.t ? (lo = md) : (hi = md)); }
        const segT = cumT[hi] - cumT[lo] || 1;
        const tt = Math.min(1, Math.max(0, (sim.t - cumT[lo]) / segT));
        const x = pos[lo * 3] + (pos[hi * 3] - pos[lo * 3]) * tt;
        const y = pos[lo * 3 + 1] + (pos[hi * 3 + 1] - pos[lo * 3 + 1]) * tt;
        const z = pos[lo * 3 + 2] + (pos[hi * 3 + 2] - pos[lo * 3 + 2]) * tt;
        st.toolGroup.position.set(x, y, z);
        if (droX.current) {
          droX.current.textContent = fmt(x);
          droY.current.textContent = fmt(y);
          droZ.current.textContent = fmt(z);
        }
      }
      renderer.render(scene, camera);
    };
    tick();

    threeRef.current = { renderer, scene, camera, ctl, applyCam };
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  /* ---------- part mesh ---------- */
  useEffect(() => {
    const st = threeRef.current;
    if (!st.scene || !model) return;
    if (st.partMesh) {
      st.scene.remove(st.partMesh);
      st.partMesh.geometry.dispose();
      st.partMesh.material.dispose();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(model.tris), 3));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshPhongMaterial({
      color: 0x33383f, shininess: 42, specular: 0x556070, side: THREE.DoubleSide,
    }));
    st.scene.add(mesh);
    st.partMesh = mesh;
    const bx = model.bbox;
    const diag = Math.hypot(bx.maxX - bx.minX, bx.maxY - bx.minY, bx.maxZ);
    st.ctl.target.set(0, 0, bx.maxZ / 2);
    st.ctl.radius = Math.max(20, diag * 1.7);
    st.applyCam();
  }, [model]);

  /* ---------- verification heatmap mesh ---------- */
  useEffect(() => {
    const st = threeRef.current;
    if (!st.scene) return;
    if (st.verifMesh) {
      st.scene.remove(st.verifMesh);
      st.verifMesh.geometry.dispose();
      st.verifMesh.material.dispose();
      st.verifMesh = null;
    }
    if (!verif) return;
    const { nx, ny, vs, x0, y0, H, dev, stats } = verif;
    const NN = (nx + 1) * (ny + 1);
    const posA = new Float32Array(NN * 3);
    const colA = new Float32Array(NN * 3);
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nx; i++) {
        const k = j * (nx + 1) + i;
        posA[k * 3] = x0 + i * vs;
        posA[k * 3 + 1] = y0 + j * vs;
        posA[k * 3 + 2] = H[k];
        const c = devColor(dev[k], stats.band);
        colA[k * 3] = c[0]; colA[k * 3 + 1] = c[1]; colA[k * 3 + 2] = c[2];
      }
    const idx = [];
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i, bq = a + 1, c = a + nx + 1, d = c + 1;
        idx.push(a, bq, d, a, d, c);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(posA, 3));
    g.setAttribute("color", new THREE.BufferAttribute(colA, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshPhongMaterial({
      vertexColors: true, shininess: 18, side: THREE.DoubleSide,
    }));
    st.scene.add(mesh);
    st.verifMesh = mesh;
  }, [verif]);

  /* visibility toggles */
  useEffect(() => {
    const st = threeRef.current;
    if (st.partMesh) st.partMesh.visible = !showVerif;
    if (st.verifMesh) st.verifMesh.visible = showVerif;
  }, [showVerif, verif, model]);

  /* ---------- job path rendering + tool ---------- */
  useEffect(() => {
    const st = threeRef.current;
    if (!st.scene) return;
    for (const key of ["lineFin", "lineRough", "lineTravel"]) {
      if (st[key]) {
        st.scene.remove(st[key]);
        st[key].geometry.dispose();
        st[key].material.dispose();
        st[key] = null;
      }
    }
    if (st.toolGroup) { st.scene.remove(st.toolGroup); st.toolGroup = null; }
    st.job = null;
    if (!job) return;

    const { pos, kinds, nPts, zMin, zMax } = job;
    const finV = [], finC = [], roughV = [], travV = [];
    const span = Math.max(1e-6, zMax - zMin);
    const colAt = (z) => {
      const t = Math.min(1, Math.max(0, (z - zMin) / span));
      return [0.31 + t * 0.69, 0.78 - t * 0.09, 0.87 - t * 0.87];
    };
    for (let i = 1; i < nPts; i++) {
      const k = kinds[i];
      const x0 = pos[(i - 1) * 3], y0 = pos[(i - 1) * 3 + 1], z0 = pos[(i - 1) * 3 + 2];
      const x1 = pos[i * 3], y1 = pos[i * 3 + 1], z1 = pos[i * 3 + 2];
      if (k === 3) {
        finV.push(x0, y0, z0 + 0.02, x1, y1, z1 + 0.02);
        finC.push(...colAt(z0), ...colAt(z1));
      } else if (k === 2 || k === 4) roughV.push(x0, y0, z0 + 0.02, x1, y1, z1 + 0.02);
      else travV.push(x0, y0, z0, x1, y1, z1);
    }
    const mk = (verts, mat, cols) => {
      if (!verts.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts), 3));
      if (cols) g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(cols), 3));
      const l = new THREE.LineSegments(g, mat);
      st.scene.add(l);
      return l;
    };
    st.lineRough = mk(roughV, new THREE.LineBasicMaterial({ color: 0x5b7089, transparent: true, opacity: 0.55 }));
    st.lineTravel = mk(travV, new THREE.LineBasicMaterial({ color: 0xb4543f, transparent: true, opacity: 0.4 }));
    st.lineFin = mk(finV, new THREE.LineBasicMaterial({ vertexColors: true }), finC);

    const R = tool.diameter / 2;
    const grp = new THREE.Group();
    const mat = new THREE.MeshPhongMaterial({ color: 0xffb100, shininess: 90 });
    if (tool.type === "ball") {
      const s = new THREE.Mesh(new THREE.SphereGeometry(R, 20, 14), mat);
      s.position.z = R;
      grp.add(s);
      const c = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 16, 20), mat);
      c.rotation.x = Math.PI / 2; c.position.z = R + 8;
      grp.add(c);
    } else {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 16, 20), mat);
      c.rotation.x = Math.PI / 2; c.position.z = 8;
      grp.add(c);
    }
    grp.position.set(pos[0], pos[1], pos[2]);
    st.scene.add(grp);
    st.toolGroup = grp;
    st.job = job;
    simRef.current.t = 0;
    simRef.current.playing = false;
  }, [job, tool.type, tool.diameter]); // eslint-disable-line

  const R = tool.diameter / 2;
  const stepPreview = tool.type === "ball"
    ? 2 * Math.sqrt(Math.max(0, tool.diameter * prm.scallop - prm.scallop ** 2))
    : tool.diameter * prm.stepoverPct / 100;
  const sim = simRef.current;
  const bx = model?.bbox;
  const S = job?.stats;
  const VS = verif?.stats;

  return (
    <div className="dc-app">
      <style>{CSS}</style>
      <header className="dc-head">
        <h1>DROP<b>CUT</b></h1>
        <span>rough · finish · verify — hybrid waterline & iso-scallop drop-cutter CAM</span>
      </header>

      <div className="dc-main">
        <aside className="dc-side">
          <div className="dc-grp">
            <h2>Geometry</h2>
            <div className="dc-row">
              <select
                value={source.type === "preset" ? source.id : "__current"}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "__stl") fileInput.current.click();
                  else if (v !== "__current") setSource({ type: "preset", id: v });
                }}>
                {Object.entries(PRESETS).map(([id, p]) => (
                  <option key={id} value={id}>{p.label}</option>
                ))}
                {source.type === "stl" && <option value="__current">{source.name}</option>}
                <option value="__stl">Upload STL…</option>
              </select>
            </div>
            <input ref={fileInput} className="dc-file" type="file" accept=".stl" onChange={onFile} />
            <Num label="Scale" unit="×" value={scale} set={setScale} step={0.1} min={0.01} />
            {bx && (
              <div className="dc-stats">
                {model.nTri.toLocaleString()} triangles<br />
                <b>{(bx.maxX - bx.minX).toFixed(1)}</b> × <b>{(bx.maxY - bx.minY).toFixed(1)}</b> × <b>{bx.maxZ.toFixed(1)}</b> mm
              </div>
            )}
          </div>

          <div className="dc-grp">
            <h2>Tool</h2>
            <div className="dc-row">
              <label>Type</label>
              <select style={{ width: 110 }} value={tool.type}
                onChange={(e) => setTool((t) => ({ ...t, type: e.target.value }))}>
                <option value="ball">Ball nose</option>
                <option value="flat">Flat end</option>
              </select>
            </div>
            <Num label="Diameter" unit="mm" value={tool.diameter} step={0.5} min={0.1}
              set={(v) => setTool((t) => ({ ...t, diameter: v }))} />
          </div>

          <div className="dc-grp">
            <h2>
              Roughing
              <input type="checkbox" checked={prm.roughOn}
                onChange={(e) => setP("roughOn")(e.target.checked)} />
            </h2>
            <Num label="Stepdown" unit="mm" value={prm.stepdown} set={setP("stepdown")} step={0.25} min={0.2} dis={!prm.roughOn} />
            <Num label="Stepover" unit="%D" value={prm.roughStepPct} set={setP("roughStepPct")} step={5} min={10} max={90} dis={!prm.roughOn} />
            <Num label="Allowance" unit="mm" value={prm.allowance} set={setP("allowance")} step={0.05} min={0} dis={!prm.roughOn} />
            <div className="dc-row">
              <label>Entry</label>
              <select style={{ width: 110 }} value={prm.entryMode} disabled={!prm.roughOn}
                onChange={(e) => setP("entryMode")(e.target.value)}>
                <option value="auto">Helix → ramp</option>
                <option value="ramp">Ramp only</option>
                <option value="plunge">Plunge</option>
              </select>
            </div>
            <Num label="Ramp angle" unit="°" value={prm.rampAngle} set={setP("rampAngle")} step={0.5} min={0.5} max={20} dis={!prm.roughOn || prm.entryMode === "plunge"} />
          </div>

          <div className="dc-grp">
            <h2>Finishing</h2>
            <div className="dc-row">
              <label>Strategy</label>
              <select style={{ width: 130 }} value={prm.strategy} onChange={(e) => setP("strategy")(e.target.value)}>
                <option value="raster">Raster</option>
                <option value="hybrid">Hybrid + waterline</option>
                <option value="scallop">Constant scallop</option>
              </select>
            </div>
            {tool.type === "ball" ? (
              <Num label="Max scallop" unit="mm" value={prm.scallop} set={setP("scallop")} step={0.005} min={0.001} />
            ) : (
              <Num label="Stepover" unit="%D" value={prm.stepoverPct} set={setP("stepoverPct")} step={5} min={5} max={90} />
            )}
            <Num label="Chord tol" unit="mm" value={prm.chordTol} set={setP("chordTol")} step={0.005} min={0.001} />
            <Num label="Margin" unit="mm" value={prm.margin} set={setP("margin")} step={0.5} min={0} />
            {prm.strategy === "hybrid" && (
              <Num label="Steep angle" unit="°" value={prm.steepDeg} set={setP("steepDeg")} step={5} min={15} max={80} />
            )}
            {prm.strategy !== "scallop" && (
              <div className="dc-row">
                <label>Direction</label>
                <select style={{ width: 110 }} value={prm.direction} onChange={(e) => setP("direction")(e.target.value)}>
                  <option value="X">Along X</option>
                  <option value="Y">Along Y</option>
                </select>
              </div>
            )}
            <div className="dc-row">
              <label>→ stepover</label>
              <span style={{ color: "var(--amber)" }}>{stepPreview.toFixed(3)}</span>
              <span className="u">mm</span>
            </div>
          </div>

          <div className="dc-grp">
            <h2>
              Arc fitting
              <input type="checkbox" checked={prm.arcFit}
                onChange={(e) => setP("arcFit")(e.target.checked)} />
            </h2>
            <Num label="Arc tol" unit="mm" value={prm.arcTol} set={setP("arcTol")} step={0.005} min={0.001} dis={!prm.arcFit} />
          </div>

          <div className="dc-grp">
            <h2>Cutting</h2>
            <Num label="Feed" unit="mm/m" value={prm.feed} set={setP("feed")} step={50} min={10} />
            <Num label="Spindle" unit="rpm" value={prm.rpm} set={setP("rpm")} step={500} min={0} />
            <Num label="Clearance" unit="mm" value={prm.clearance} set={setP("clearance")} step={1} min={1} />
          </div>

          <div className="dc-grp">
            {!busy ? (
              <button className="dc-btn primary" onClick={onGenerate} disabled={!model}>
                GENERATE JOB
              </button>
            ) : (
              <button className="dc-btn" onClick={() => (cancelRef.current = true)}>
                CANCEL ({Math.round(progress * 100)}%)
              </button>
            )}
            {busy && <div className="dc-prog"><div style={{ width: `${progress * 100}%` }} /></div>}
            {err && <div style={{ color: "#E06C5A", marginTop: 8, fontSize: 11 }}>{err}</div>}
          </div>

          {S && (
            <div className="dc-grp">
              <h2>Result</h2>
              <div className="dc-stats">
                {S.roughLevels > 0 && (<>
                  rough: <b>{S.roughLevels}</b> levels · <b>{S.roughMin.toFixed(1)}</b> min<br />
                </>)}
                {S.finDesc} · <b>{S.finishMin.toFixed(1)}</b> min<br />
                {S.arc && (<>
                  arcs: <b>{S.arc.raw.toLocaleString()}</b> pts → <b>{(S.arc.arcs + S.arc.lines).toLocaleString()}</b> moves
                  {" "}(<b>{S.arc.arcs.toLocaleString()}</b> G2/G3)<br />
                </>)}
                total <b>{S.timeMin.toFixed(1)}</b> min · {(S.cutLenMM / 1000).toFixed(2)} m cut
              </div>
              <button className="dc-btn" style={{ marginTop: 8 }} onClick={onExport}>
                EXPORT G-CODE (.nc)
              </button>
              {!vBusy ? (
                <button className="dc-btn" style={{ marginTop: 6 }} onClick={onVerify}>
                  VERIFY CUT (DEXEL SIM)
                </button>
              ) : (
                <button className="dc-btn" style={{ marginTop: 6 }} onClick={() => (cancelRef.current = true)}>
                  CANCEL VERIFY ({Math.round(vProg * 100)}%)
                </button>
              )}
              {vBusy && <div className="dc-prog"><div style={{ width: `${vProg * 100}%` }} /></div>}
            </div>
          )}

          {VS && (
            <div className="dc-grp">
              <h2>Verification</h2>
              <div className="dc-stats">
                gouge: <b className={VS.minDev < -0.02 ? "bad" : ""}>{VS.minDev.toFixed(3)}</b> mm
                {VS.minDev < -0.02 ? " ⚠" : " ✓"}<br />
                max excess: <b>{VS.maxDev.toFixed(3)}</b> mm<br />
                rms on part: <b>{VS.rms.toFixed(3)}</b> mm<br />
                within tol: <b>{VS.pctOK.toFixed(1)}</b>%
              </div>
              <button className="dc-btn" style={{ marginTop: 8 }} onClick={() => setShowVerif((v) => !v)}>
                {showVerif ? "SHOW PART" : "SHOW MACHINED STOCK"}
              </button>
            </div>
          )}
        </aside>

        <div className="dc-view" ref={mountRef}>
          <div className="dc-ovl">
            {model && (<><b>{model.name}</b><br /></>)}
            {showVerif && verif ? (<>
              <span className="sw" style={{ background: "#E05545" }} />gouge&nbsp;&nbsp;
              <span className="sw" style={{ background: "#3AA675" }} />in&nbsp;tolerance&nbsp;&nbsp;
              <span className="sw" style={{ background: "#5B8CC4" }} />excess&nbsp;stock
            </>) : job ? (<>
              <span className="sw" style={{ background: "#5B7089" }} />roughing&nbsp;&nbsp;
              <span className="sw" style={{ background: "linear-gradient(90deg,#4FC8DD,#FFB100)" }} />finishing&nbsp;&nbsp;
              <span className="sw" style={{ background: "#B4543F" }} />rapids
            </>) : (<>no job — set parameters and generate</>)}
          </div>
          <div className="dc-hint">drag rotate · shift-drag pan · wheel zoom</div>
        </div>
      </div>

      <footer className="dc-foot">
        <div className="dc-dro">
          <div className="c"><span className="l">X</span><span className="v" ref={droX}>+000.000</span></div>
          <div className="c"><span className="l">Y</span><span className="v" ref={droY}>+000.000</span></div>
          <div className="c"><span className="l">Z</span><span className="v" ref={droZ}>+000.000</span></div>
        </div>
        <div className="dc-sim">
          <button className="dc-btn" disabled={!job}
            onClick={() => { sim.playing = !sim.playing; forceSim((n) => n + 1); }}>
            {sim.playing ? "❚❚ PAUSE" : "▶ RUN"}
          </button>
          <button className="dc-btn" disabled={!job}
            onClick={() => { sim.t = 0; sim.playing = false; forceSim((n) => n + 1); }}>
            ⟲
          </button>
          <select style={{ width: 84 }} defaultValue={8}
            onChange={(e) => { sim.mult = +e.target.value; }}>
            {[1, 8, 32, 128].map((m) => <option key={m} value={m}>{m}× time</option>)}
          </select>
        </div>
        <div className="dc-status">
          {busy ? `computing… ${Math.round(progress * 100)}%`
            : vBusy ? `verifying… ${Math.round(vProg * 100)}%`
              : job ? "job ready — simulate, verify, or export"
                : "idle"}
        </div>
      </footer>
    </div>
  );
}
