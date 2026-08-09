/**
 * @cam/geometry/mesh — triangle soup and STL loading.
 *
 * Triangles are stored as a flat Float64Array of 9 numbers each with no shared
 * vertex indexing. That is deliberate: the drop-cutter kernel reads triangles
 * millions of times in a tight loop, and indirection through an index buffer
 * costs more than the memory it saves.
 *
 * The prototype's `buildModel` silently established a frame convention (mesh
 * centred in XY, minZ dropped to 0) that everything downstream depended on with
 * no way to know. Here that placement is returned as an explicit Transform, so
 * the convention is visible and reversible.
 */

import type { Mm } from "@cam/units";
import { mm } from "@cam/units";
import type { Box3, Transform, Vec3 } from "@cam/math";
import { box3, translation, vec3 } from "@cam/math";

export interface Mesh {
  /** 9 floats per triangle: ax, ay, az, bx, by, bz, cx, cy, cz. */
  readonly tris: Float64Array;
  readonly triangleCount: number;
  readonly bounds: Box3;
  readonly name: string;
}

export function meshFromTriangles(tris: Float64Array, name = "mesh"): Mesh {
  if (tris.length % 9 !== 0) {
    throw new Error(`mesh: triangle array length ${tris.length} is not a multiple of 9`);
  }
  return {
    tris,
    triangleCount: tris.length / 9,
    bounds: boundsOf(tris),
    name,
  };
}

export function boundsOf(tris: Float64Array): Box3 {
  if (tris.length === 0) return box3(0, 0, 0, 0, 0, 0);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return box3(minX, minY, minZ, maxX, maxY, maxZ);
}

export interface PlacedMesh {
  readonly mesh: Mesh;
  /** How the raw mesh coordinates were moved to reach the part frame. */
  readonly placement: Transform<"mesh", "part">;
}

/**
 * Place a raw mesh into the part frame: centred in XY, resting on Z = 0.
 *
 * Returning the transform (rather than only the moved mesh) means a later stage
 * can map a machined coordinate back to a point on the original model — useful
 * for "which triangle caused this gouge?" diagnostics.
 */
export function placeMesh(raw: Mesh, scale = 1): PlacedMesh {
  const b = raw.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const cz = b.minZ;

  const out = new Float64Array(raw.tris.length);
  for (let i = 0; i < raw.tris.length; i += 3) {
    out[i] = (raw.tris[i] - cx) * scale;
    out[i + 1] = (raw.tris[i + 1] - cy) * scale;
    out[i + 2] = (raw.tris[i + 2] - cz) * scale;
  }

  return {
    mesh: meshFromTriangles(out, raw.name),
    placement: translation("mesh", "part", vec3(-cx * scale, -cy * scale, -cz * scale)),
  };
}

/**
 * Parse binary or ASCII STL.
 *
 * Binary detection: byte 80 holds a uint32 triangle count, and a well-formed
 * binary file is exactly 84 + 50n bytes. If that identity does not hold, the
 * file is treated as ASCII. This is the standard heuristic — STL has no magic
 * number, and "solid" as a prefix is not reliable because some binary writers
 * emit it in the header.
 */
export function parseStl(buffer: ArrayBuffer, name = "model.stl"): Mesh {
  if (buffer.byteLength >= 84) {
    const dv = new DataView(buffer);
    const count = dv.getUint32(80, true);
    if (84 + count * 50 === buffer.byteLength) {
      const tris = new Float64Array(count * 9);
      let off = 84;
      for (let t = 0; t < count; t++) {
        off += 12; // skip the facet normal; we recompute normals when needed
        for (let k = 0; k < 9; k++) {
          tris[t * 9 + k] = dv.getFloat32(off, true);
          off += 4;
        }
        off += 2; // attribute byte count
      }
      return meshFromTriangles(tris, name);
    }
  }

  const text = new TextDecoder().decode(buffer);
  const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  const values: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    values.push(Number.parseFloat(m[1]), Number.parseFloat(m[2]), Number.parseFloat(m[3]));
  }
  const complete = Math.floor(values.length / 9);
  if (complete === 0) throw new Error("parseStl: no triangles found");
  if (values.length % 9 !== 0) {
    // A trailing partial triangle means the file is malformed. The prototype
    // silently truncated; we truncate too but the caller deserves to know.
    console.warn(`parseStl: ${values.length % 9} trailing vertex components ignored`);
  }
  return meshFromTriangles(new Float64Array(values.slice(0, complete * 9)), name);
}

/** Write a binary STL. Used by tests and by mesh export. */
export function toBinaryStl(mesh: Mesh): ArrayBuffer {
  const n = mesh.triangleCount;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, n, true);
  let off = 84;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const nrm = triangleNormal(mesh.tris, o);
    dv.setFloat32(off, nrm.x, true); off += 4;
    dv.setFloat32(off, nrm.y, true); off += 4;
    dv.setFloat32(off, nrm.z, true); off += 4;
    for (let k = 0; k < 9; k++) { dv.setFloat32(off, mesh.tris[o + k], true); off += 4; }
    dv.setUint16(off, 0, true); off += 2;
  }
  return buf;
}

/**
 * Translate a mesh into a different frame position.
 *
 * Used to place a part inside the machine's work envelope: the built-in presets
 * are centred on the origin, and a machine whose travel starts at zero cannot
 * reach them there.
 */
export function translateMesh(mesh: Mesh, dx: number, dy: number, dz: number): Mesh {
  if (dx === 0 && dy === 0 && dz === 0) return mesh;
  const out = new Float64Array(mesh.tris.length);
  for (let i = 0; i < mesh.tris.length; i += 3) {
    out[i] = mesh.tris[i] + dx;
    out[i + 1] = mesh.tris[i + 1] + dy;
    out[i + 2] = mesh.tris[i + 2] + dz;
  }
  return meshFromTriangles(out, mesh.name);
}

export function triangleNormal(tris: Float64Array, offset: number): Vec3 {
  const ax = tris[offset], ay = tris[offset + 1], az = tris[offset + 2];
  const bx = tris[offset + 3], by = tris[offset + 4], bz = tris[offset + 5];
  const cx = tris[offset + 6], cy = tris[offset + 7], cz = tris[offset + 8];
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const L = Math.hypot(nx, ny, nz) || 1;
  return vec3(nx / L, ny / L, nz / L);
}

/* ----------------------- analytic height fields ----------------------- */

export interface HeightField {
  readonly label: string;
  /** Half-extent of the sampled square, in mm. */
  readonly half: Mm;
  /** Grid subdivisions per axis. */
  readonly n: number;
  readonly f: (x: number, y: number) => number;
}

/**
 * Tessellate a height field into a triangle soup.
 *
 * Two triangles per grid cell. Heights are clamped at zero so the field sits on
 * the Z = 0 plane, matching the part-frame convention.
 */
export function tessellate(field: HeightField, name = field.label): Mesh {
  const { half, n, f } = field;
  const step = (2 * half) / n;
  const stride = n + 1;

  const z = new Float64Array(stride * stride);
  for (let j = 0; j <= n; j++) {
    const y = -half + j * step;
    for (let i = 0; i <= n; i++) {
      z[j * stride + i] = Math.max(0, f(-half + i * step, y));
    }
  }

  const tris = new Float64Array(n * n * 2 * 9);
  let o = 0;
  for (let j = 0; j < n; j++) {
    const y0 = -half + j * step;
    const y1 = y0 + step;
    for (let i = 0; i < n; i++) {
      const x0 = -half + i * step;
      const x1 = x0 + step;
      const z00 = z[j * stride + i];
      const z10 = z[j * stride + i + 1];
      const z01 = z[(j + 1) * stride + i];
      const z11 = z[(j + 1) * stride + i + 1];
      tris[o++] = x0; tris[o++] = y0; tris[o++] = z00;
      tris[o++] = x1; tris[o++] = y0; tris[o++] = z10;
      tris[o++] = x1; tris[o++] = y1; tris[o++] = z11;
      tris[o++] = x0; tris[o++] = y0; tris[o++] = z00;
      tris[o++] = x1; tris[o++] = y1; tris[o++] = z11;
      tris[o++] = x0; tris[o++] = y1; tris[o++] = z01;
    }
  }
  return meshFromTriangles(tris, name);
}

/**
 * Built-in test geometry.
 *
 * `dome` earns its place: a hemisphere is the one shape whose exact cutter-
 * location surface is known in closed form (another hemisphere, radius R0 + R),
 * which makes it the ground truth for testing the drop-cutter kernel.
 */
export const PRESETS: Record<string, HeightField> = {
  dome: {
    label: "Hemisphere (benchmark)",
    half: mm(18), n: 96,
    f: (x, y) => {
      const R0 = 14;
      const r2 = x * x + y * y;
      return r2 < R0 * R0 ? Math.sqrt(R0 * R0 - r2) : 0;
    },
  },
  cone: {
    label: "Cone (contour benchmark)",
    half: mm(18), n: 96,
    f: (x, y) => {
      const R0 = 14, H = 12;
      const r = Math.hypot(x, y);
      return r < R0 ? H * (1 - r / R0) : 0;
    },
  },
  hills: {
    label: "Gaussian hills",
    half: mm(22), n: 100,
    f: (x, y) => {
      const g = (cx: number, cy: number, s2: number, h: number) =>
        h * Math.exp(-(((x - cx) ** 2 + (y - cy) ** 2) / (2 * s2)));
      return g(-8, -6, 36, 6) + g(7, 2, 20, 8) + g(2, -9, 12, 4.5);
    },
  },
  star: {
    label: "Star (5 lobes)",
    half: mm(20), n: 110,
    f: (x, y) => {
      const th = Math.atan2(y, x);
      const a = 12.5 * (1 + 0.3 * Math.cos(5 * th));
      const t = Math.hypot(x, y) / a;
      return t >= 1 ? 0 : 8.5 * Math.pow(Math.cos((t * Math.PI) / 2), 0.85);
    },
  },
};
