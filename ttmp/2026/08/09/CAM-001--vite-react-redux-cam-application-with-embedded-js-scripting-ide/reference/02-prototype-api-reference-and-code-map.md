---
Title: Prototype API reference and code map
Ticket: CAM-001
Status: active
Topics:
    - cam
    - gcode
    - react
    - redux
    - vite
    - ide
    - toolpath
DocType: reference
Intent: long-term
Owners: []
RelatedFiles:
    - Path: repo://original/DESIGN-01-semantic-cam-architecture.md
      Note: Normative architecture this guide implements
    - Path: repo://original/DESIGN-02-kleisli-composition-for-machine-commands.md
      Note: Formal sequencing model for machine commands
    - Path: repo://original/MakeraBadge.nc
      Note: Makera dialect evidence and parser conformance fixture
    - Path: repo://original/dropcut-cam(1).jsx
      Note: 'Drop-cutter CAM prototype: strategies, arc fitting, dexel verification, RS-274 emission'
    - Path: repo://original/dropcut-ide(1).jsx
      Note: 'Scripting IDE prototype: DSL sandbox, canonical IR, validation, modal G-code'
    - Path: repo://original/z1-gcode-checker-l2.jsx
      Note: G-code parser, heightmap stock simulator, static safety checks
ExternalSources: []
Summary: 'Function-by-function reference for the three CAM prototypes: signature, behaviour, invariants, gotchas, and target module for each.'
LastUpdated: 2026-08-09T00:00:00Z
WhatFor: Looking up what a specific prototype function does and where it is going, without re-reading 4,861 lines of JSX.
WhenToUse: While porting a function, or when the design doc references a prototype symbol you have not read.
---


# Prototype API reference and code map

Companion to the design doc
[01-dropcut-studio-architecture-analysis-and-implementation-guide.md](../design-doc/01-dropcut-studio-architecture-analysis-and-implementation-guide.md).
That document explains *why*; this one is the lookup table for *what*.

Every entry gives the signature as it exists today, what it does, any invariant
or gotcha that is not obvious from reading it, and the module it moves to.

Paths are relative to the repository root. All three prototypes are default-export
React components with their computational code as module-level functions above.

---

## 1. `original/dropcut-cam(1).jsx` — 1,971 lines

### 1.1 Geometry input

#### `PRESETS` — line 22

```js
const PRESETS: Record<string, {
  label: string;
  half: number;          // half-extent of the sampling square, mm
  n: number;             // grid subdivisions per axis
  f: (x: number, y: number) => number;   // height function
}>
```

Four analytic test shapes: `sprite` (blob with two Gaussian eyes), `star` (5-lobe
polar rose), `dome` (hemisphere, `R0 = 14`), `hills` (three Gaussians). `dome` is
the useful one for testing because its CL surface has a closed form.

→ `packages/geometry/src/heightfield.ts`, and exposed to scripts as
`geometry.heightfield(fn, { half, n })`.

#### `heightfieldTris(preset) → Float64Array` — line 66

Samples `f` on an `(n+1)²` grid clamped at `z ≥ 0`, then emits two triangles per
cell as a flat array of 9 floats per triangle (`x0,y0,z0, x1,y1,z1, x2,y2,z2`).

**Invariant.** Output length is always `n * n * 2 * 9`. The triangle soup has no
shared-vertex indexing — deliberate, because the drop-cutter kernel wants
independent triangles with no indirection.

→ `packages/geometry/src/heightfield.ts`

#### `parseSTL(buf: ArrayBuffer) → Float64Array` — line 94

Detects binary STL by reading the triangle count at byte 80 and checking
`84 + n*50 === byteLength`; otherwise falls back to regex-scanning for `vertex`
lines in ASCII.

**Gotcha.** The ASCII fallback ignores facet normals entirely and truncates to
whole triangles (`v.slice(0, nt * 9)`). A malformed file with a trailing partial
triangle is silently accepted.

→ `packages/geometry/src/mesh.ts`

#### `buildModel(rawTris, scale, name) → Model` — line 119

```js
{ tris: Float64Array, nTri: number,
  bbox: { minX, maxX, minY, maxY, minZ: 0, maxZ }, name: string }
```

Centres the mesh in XY on the origin, translates so `minZ` becomes exactly 0,
and applies a uniform scale.

**This establishes an unstated frame convention that everything downstream
depends on**: the part is centred at the XY origin and sits on `Z = 0`. Nothing
checks it. In Studio this becomes an explicit `Transform<"mesh", "part">`.

→ `packages/geometry/src/mesh.ts`

### 1.2 Spatial index

#### `buildGrid(model, R) → Grid` — line 146

```js
{ cs: number,            // cell size = max(R, diag/256, 0.25)
  nx, ny: number,
  cells: (number[] | undefined)[],   // triangle indices per cell, sparse
  triBB: Float64Array,   // 4 per triangle: x0,x1,y0,y1
  minX, minY: number,
  stamp: Uint32Array,    // per-triangle query generation
  qid: number }          // current query generation
```

Bins each triangle into every cell its XY bounding box overlaps.

**The `stamp`/`qid` pattern** (used at 212, 223–224) is a generation-counter
deduplication: bump `qid` per query, mark visited triangles with it, skip already
marked. Avoids allocating a `Set` per query — significant at millions of queries.

→ `packages/geometry/src/spatial-index.ts`

### 1.3 Drop-cutter kernel ★

#### `pointInTri(px, py, ax, ay, bx, by, cx, cy) → boolean` — line 175

2D point-in-triangle by consistent sign of three edge cross-products, with a
`1e-9` tolerance band so boundary points count as inside.

#### `edgeBall(px, py, R, x1,y1,z1, x2,y2,z2) → number` — line 184

Highest sphere-centre Z at which a sphere of radius `R` on the vertical axis
through `(px, py)` touches the 3D segment. Returns `-Infinity` for no contact.
Derivation in the design doc, Part IX.1, case 2.

**Gotcha.** Returns *centre* height, not tip height. The caller subtracts `R`
once at the very end (line 307), not per case.

#### `makeEvaluator(model, grid, tool, floorZ) → (X, Y) => number` — line 203

The hot function. Returns a closure computing the CL height at `(X, Y)`.

- Ball path (233–256): vertex, edge (`edgeBall`), and plane cases, maximum taken.
- Flat path (257–302): vertex-in-disc, edge-crossing-disc (quadratic solve at
  270–281), plane-under-disc plus the centre-inside case.
- Floor: starts at `floorZ + R` for ball, `floorZ` for flat, so the tool never
  drops below the floor even over empty space.

**Port constraints.** Keep it monomorphic and allocation-free; do not introduce
a tool interface with virtual dispatch in the inner loop; keep `tris` as a flat
`Float64Array`. See design doc Part IX.1.

→ `packages/geometry/src/drop-cutter.ts`

### 1.4 Fields and contours

#### `buildCLField(evalF, x0, x1, y0, y1, gs, onProg, cancelRef) → Promise<CLField|null>` — line 313

```js
{ nx, ny, gs, x0, y0,
  F: Float64Array,   // CL heights, (nx+1)*(ny+1)
  G: Float64Array,   // |grad F| by central differences
  sampleF: (x, y) => number,   // bilinear
  sampleG: (x, y) => number }
```

Yields to the event loop every 8 rows and returns `null` if cancelled.

**Note.** Boundary gradients use one-sided differences via the `min`/`max`
clamping at 330–331, so `G` is slightly underestimated on the border. Harmless
here because the field is built with a margin.

→ `packages/geometry/src/cl-field.ts`

#### `bilin(fld, A, x, y) → number` — line 342

Bilinear sample of array `A` on the field's grid, with clamping to
`[0, n - 1e-6]` so the top/right edges do not index out of bounds.

#### `marchSquares(A, nx, ny, x0, y0, gs, level) → Poly[]` — line 356

```js
Poly = { pts: number[],   // xy pairs
         closed: boolean }
```

Marching squares with saddle disambiguation by cell-centre average (382–391),
then segment chaining via a hash of endpoints quantised to 1/256 mm (line 397).

**Gotcha.** The 1/256 mm quantum is an undeclared tolerance. Endpoints further
apart than ~0.004 mm will not chain, leaving spurious gaps. Replace the string
key with a packed integer key and name the constant.

→ `packages/geometry/src/contours.ts`

#### `splitByMask(poly, keep) → Poly[]` — line 433

Splits a polyline into runs where `keep(x, y)` holds. Preserves closedness only
if the entire loop survives (447–448).

#### `solveEikonal(fRHS, nx, ny, h) → Float64Array` — line 454

Fast-sweeping solver for `|∇T| = f`, boundary-initialised to `T = 0`, four sweep
directions, four iterations. Godunov upwind update at 464–467.

**Note.** No convergence check — the fixed four iterations are sufficient for
this problem class. If the field ever becomes non-convex or has interior sources,
revisit.

→ `packages/geometry/src/eikonal.ts`

### 1.5 Job generation

#### `KIND_SPEED(kind, feed) → number` — line 483

Rapid → 3000; plunge → `max(30, feed/3)`; ramp → `max(30, feed*0.5)`; cut →
`feed`. Hard-coded rapid rate; in Studio this comes from `MachineProfile`.

#### `emitEntry(mv, phase, sx, sy, ux, uy, avail, zTop, z, evalA, R, prm)` — line 489

Emits the descent into material. Modes:

- `auto`: try a helix of radius `R/2`, validated at 12 sample angles against the
  inflated surface (498–505); the helix ends with a full flattening revolution at
  the target Z (515–520) so the floor is clean.
- `auto`/`ramp`: zig-zag ramp of length `min(max(2R, 2), 0.9·avail)` at the
  configured angle.
- fallback: straight plunge.

**Gotcha.** `avail` is the length of the interval being entered; the helix is
only attempted if `avail > 2·rh + 0.2`. If a pocket is narrow, entry silently
degrades to a plunge with no diagnostic. Studio should emit an `info`
diagnostic when entry degrades.

→ `packages/planner/src/entry.ts`

#### `generateJob(model, tool, prm, onProgress, cancelRef) → Promise<Job|null>` — line 546

The monolith. Six fused stages; see design doc Part II.1 and IX.4. Output:

```js
{ moves: Array<{ kind, phase, pts, ops }>,
  pos: Float32Array, kinds: Uint8Array, cumT: Float64Array, nPts: number,
  zMin, zMax, clearZ,
  stats: { finDesc, step, roughLevels, cutLenMM, timeMin, roughMin, finishMin, arc } }
```

`kinds` encoding: `0` rapid, `1` plunge, `2` rough cut, `3` finish cut, `4` ramp.

**The `W()` axis-swap.** Line 556: `W = alongX ? (a,b)=>[a,b] : (a,b)=>[b,a]`.
Roughing and raster are written in an abstract `(a, b)` frame; `W` maps to world
`(x, y)` and `evalABr`/`evalAB` swap the other way. Compact, correct, and easy to
get backwards on a port. Keep the swap in exactly one place.

→ split across `packages/strategies/*` and `packages/planner/*`; see design doc
Part XII.3.

#### `refineLine(x0,y0,z0, x1,y1,z1, depth, out)` — line 722

Recursive midpoint subdivision until the midpoint's true surface height is within
`tol` of the linear interpolant, or `len < minLen`, or `depth` exhausted
(`MAXD = 11`). `refineA`/`refineB` (771/779) are the 1D variants used by raster.

→ `packages/planner/src/refine.ts`

#### `finLink(tx, ty, tz)` — line 733

Decides how to get from the current finishing position to the next start: ride
the CL surface if within `max(3·s0, 1.5)` mm, otherwise sample the surface along
the link, retract to `maxHeight + 0.6`, rapid across, and plunge.

→ `packages/planner/src/linker.ts`

### 1.6 Arc fitting

#### `compressCut(P, n, tol) → Op[]` — line 1013

```js
Op = { t: "L", i: number }
   | { t: "A", i: number, uc: number, vc: number, pos: boolean, plane: 17|18|19 }
```

Groups runs sharing a constant axis (`segAxis`, 1016) and fits each run of ≥5
points.

#### `fitArcsRun(P, i0, i1, constAxis, tol, ops)` — line 1036

Algebraic (Kåsa) least-squares circle fit over a growing window, with five
rejection criteria: singular normal equations, radius outside `[0.2, 4000]`,
any point off the circle by more than `tol`, sweep direction reversal, total
sweep `> 2.9` rad.

**The centre projection at 1058–1065 is essential**: after fitting, the centre is
projected onto the perpendicular bisector of the chord so the arc passes exactly
through both endpoints. Without it, consecutive arcs leave sub-micron gaps that
some controllers reject.

→ `packages/planner/src/arc-fit.ts`, producing geometric `Segment` values rather
than plane-tagged ops.

### 1.7 Output and verification

#### `toGcode(job, tool, prm, modelName) → { text, nLines }` — line 1115

Walks `job.moves`, emitting RS-274 with modal suppression via `ensureF` and
`ensurePlane` closures.

**Gotcha — arc direction.** The same `op.pos` maps to `G2` in the G18 branch
(1159) but `G3` in the G17 (1167) and G19 (1163) branches, because a positive
sweep in the local `(u, v)` frame has opposite handedness depending on which axis
was eliminated. Correct, but comment-dependent. Cover with per-plane round-trip
tests.

→ `packages/post-rs274/` + `packages/compiler/src/gcode-ir.ts`

#### `verifyJob(job, model, prm, tool, onProg, cancelRef) → Promise<Verification|null>` — line 1192

Rasterises the target mesh to `Tg`, sweeps all cutting moves stamping the tool
footprint into `H`, computes `dev = H - Tg`.

```js
{ nx, ny, vs, x0, y0,
  H: Float64Array,    // machined surface
  Tg: Float64Array,   // target surface
  dev: Float64Array,  // H - Tg
  stats: { minDev, maxDev, rms, pctOK, band } }
```

`band = scallop + chordTol + 0.05` (line 1278) — the tolerance band derived from
the generation parameters. This is the seed of the error-budget concept.

**Note.** `pctOK` is computed over *all* cells including the empty margin
(line 1293 divides by `NN`), so it is optimistic. `rms` correctly restricts to
cells where the target rises above the floor (`nPart`). Fix `pctOK` on port.

→ `packages/analysis/src/dexel.ts`

#### `devColor(d, band) → [r, g, b]` — line 1298

Red below `-0.02` (gouge), green→teal within the band, blue above (excess stock).

→ `packages/analysis/src/deviation.ts`

---

## 2. `original/dropcut-ide(1).jsx` — 1,673 lines

### 2.1 Compiler entry

#### `compileProgram(code: string) → CompileResult` — line 116

```js
{ ok: boolean,
  error: string | null,          // runtime error from the user's script
  diagnostics: Array<{ level: "error"|"warning", message: string }>,
  ir: Array<{ text: string, tag: string|null }>,
  gcode: Array<{ n: number, text: string, motion: number|null }>,
  motions: Array<{ kind, pts, lens, t0, t1, feed, mode, gline, tag }>,
  total: number,                 // seconds
  setup: { stock: {x,y,z}, clearance: number },
  stats: { cutLen, rapidLen, lines } }
```

Three phases in one function: build the sandbox API and run the user's code
(120–355), then validate/lower/emit in a single pass over `cmds` (357–655).

**The invariant that matters** (644–654): if any diagnostic has
`level === "error"`, then `gcode`, `motions` and `total` are emptied. The
postprocessor output cannot exist for an invalid program.

→ split across `apps/studio/src/script-host/`, `packages/compiler/`,
`packages/analysis/src/static-checks.ts`.

### 2.2 Units

#### `unwrap(v, unit, ctx) → number | null` — line 128

Accepts a boxed unit `{__unit, v}`, a bare number (warns via `warnBare`), or
`null`. Throws `TypeError` on brand mismatch.

#### `mm/rpm/mmPerMin/deg` — lines 141–144

```js
const mm = (v) => ({ __unit: "mm", v });
```

Boxed so the brand survives at runtime inside the sandbox, where TypeScript types
do not exist.

#### `p(x, y, z) → {x, y, z}` — line 145

Unwraps three `mm` values into a plain point. In Studio this gains a `frame` tag.

→ `packages/units/` (types) + `apps/studio/src/script-host/api/` (boxed runtime).

### 2.3 The `job` façade — lines 169–329

| Method | Line | Emits |
| --- | --- | --- |
| `setup(o)` | 170 | — (mutates `setup`) |
| `comment(text)` | 181 | `{kind:"comment"}` |
| `toolChange(tool)` | 184 | `{kind:"tool-change"}` |
| `spindle(o)` | 187 | `{kind:"spindle"}` |
| `withSpindle(o, body)` | 198 | spindle-on, body, spindle-off |
| `traverse(pt, opts)` | 203 | `{kind:"traverse"}` |
| `cut(pt, opts)` | 206 | `{kind:"cut"}` |
| `arcCut(pt, opts)` | 217 | `{kind:"arc"}` |
| `dwell(seconds)` | 231 | `{kind:"dwell"}` |
| `face(o)` | 236 | a raster of `cut` commands, tagged `face#N` |
| `rectPocket(o)` | 275 | concentric rings per stepdown, tagged `pocket#N` |

**Gotcha in `face` and `rectPocket`.** Both hard-code `const dia = 4` (lines 244,
288) with the comment "resolved at lowering against active tool; nominal here" —
but no such resolution exists. **The stepover of a face or pocket is currently
computed from a fixed 4 mm diameter regardless of the actual tool.** This is a
real bug, not just a simplification: with a 2 mm tool the passes are twice too
far apart and leave uncut ridges. In Studio, strategies receive the resolved tool
from `PlanningContext`.

→ `apps/studio/src/script-host/api/job.ts` and `packages/strategies/`.

### 2.4 Lowering and validation — lines 357–655

| Helper | Line | Purpose |
| --- | --- | --- |
| `pushLine(text, motionIdx)` | 373 | append a G-code line, recording its motion link |
| `checkTravel(pt, where)` | 376 | machine envelope check |
| `axisWords(pt)` | 390 | emit only changed axis words; updates `lastAxes` |
| `addLinear(to, mode, feed, tag)` | 402 | one linear motion: timing, stats, G-code, modal suppression |
| `safeTraverse(to, where, tag)` | 439 | retract → XY → descend; the "traverse ≠ G0" rule |

`safeTraverse` is the single most important function to carry forward
conceptually: the DSL expresses *safe traversal*, and lowering decides the motion
sequence.

→ `packages/planner/src/clearance.ts`, `packages/compiler/src/gcode-ir.ts`.

### 2.5 Editor and viewer

#### `highlight(code) → string` — line 665

Single-regex tokeniser producing HTML with inline styles. Handles comments,
strings, numbers and identifiers, with `KEYWORDS` and `DSLIDS` sets.

#### `Editor({ code, onChange })` — line 688

Transparent textarea over a highlighted `<pre>`, scroll-synced, with a line
gutter and Tab-to-two-spaces.

→ **deleted**; replaced by CodeMirror 6.

#### `Viewer({ compiled, timeRef, playingRef, speedRef, onLine, seekRef })` — line 794

Three.js scene, orbit camera, tool marker, toolpath lines, trail, DRO, transport.

**Coordinate remap at line 1043:** `v3 = (x,y,z) => new Vector3(x, z, -y)`.
Do not carry this forward — Studio uses Z-up throughout (design doc ADR-008).

**The trail** (1123–1130, 972–980): one `Line` over all points with
`setDrawRange(0, n)` advanced during playback. Keep this.

`posAt(t)` (920) is the binary search over motion times. Keep, in
`viewer-three/playback.ts`.

---

## 3. `original/z1-gcode-checker-l2.jsx` — 1,217 lines

### 3.1 Machine constants

```js
// lines 27-34
const Z1 = { name: "MAKERA Z1", travel: {x:200,y:200,z:100},
             maxRPM: 13000, rapidRate: 3000 };
const KNOWN_G = new Set([0,1,2,3,4,10,17,18,19,20,21,28,30,43,49,53,54,55,56,57,58,59,90,91,92,94]);
const KNOWN_M = new Set([0,1,2,3,4,5,6,7,8,9,30,321,322,323,324,325,331,490,495]);
```

`KNOWN_G`/`KNOWN_M` become `MachineProfile.supportedCodes`. Note `travel` here is
a span, not a range — Studio's profile uses explicit `Range<Mm>`.

### 3.2 Parser

#### `parseGcode(text) → Parsed` — line 97

```js
{ segments: Array<{ type: "cut"|"rapid", from, to, pts, line,
                    feed, rpm, tool, spindle, len, t0, t1 }>,
  issues: Array<{ sev: "err"|"warn"|"info", line, msg }>,
  bb: { minX, maxX, minY, maxY, minZ, maxZ },
  totalTime: number,       // minutes
  totalLines: number,
  toolChanges: Array<{ line, tool }>,
  toolsUsed: number[] }
```

Modal state at 105–110. Word tokenisation with one regex (122). Unit conversion
at read time via `u(v)` (113), so all internal values are millimetres.

**Key modal behaviour** (line 178): `const mo = motion !== null ? motion :
st.motion` — a coordinate-only line inherits the previous motion mode. Any parser
port must preserve this.

**Limitation.** Only `G17` arcs are back-plotted; `G18`/`G19` fall through to the
straight-line branch with a warning (144). Fix on port.

→ `packages/gcode-parser/`

#### `arcPoints(from, to, ijk, r, cw) → number[][]` — line 237

Reconstructs an arc from either I/J centre offsets or an R radius. The R form's
sign convention (line 249, `sign = cw === r > 0 ? -1 : 1`) selects minor versus
major arc. Discretises at ~0.4 mm chord.

### 3.3 Tools and simulation

#### `toolProfile(tool, r) → number | null` — line 272

Height of the cutter surface above the tip at radius `r`; `null` outside the
cutter. The cleanest tool-geometry abstraction in the codebase.

→ `packages/machine/src/tools.ts`

#### `class StockSim` — line 287

```js
new StockSim(stock: {w, d, h, ox, oy, topZ}, targetCells: number)

.reset()
.stamp(x, y, tipZ, tool, remove) → number   // max engagement depth
.sweep(seg, tool, f0, f1, onRapidCut)       // apply fraction range [f0, f1]
```

Grid resolution derives from `targetCells` scaled by the longest stock dimension
(292–293). Sample spacing along a move is `0.55 × min(cellW, cellH)` (360).

**Gouge clamping** at line 333: `hm[k] = Math.max(surf, this.floor)` keeps the
render mesh finite while the *check* uses the unclamped comparison. Preserve both
behaviours — clamp for display, not for detection.

**Dead code.** Lines 311–313 call `this._maxIn(lx, ly, R)` inside an `if` whose
body is an empty comment, and `_maxIn()` (341) is a stub returning `-Infinity`.
No effect. Do not port.

**Segment length caching.** `seg._cum` (353–357) memoises cumulative lengths on
the segment object. Convenient, but it mutates parsed data. In Studio, compute
this in the flatten pass instead.

→ `packages/analysis/src/dexel.ts`

#### `runGlobalChecks(parsed, settings, stock, tools) → Issue[]` — line 383

Envelope spans versus machine travel; rapids below safe Z with XY motion; tool
below stock bottom; and a full coarse simulation (150 cells) purely to detect
rapids that remove material.

**Note.** The rapid-crash detection runs a *second, independent* simulation at
lower resolution from the one used for display (240 cells). Studio should run one
simulation and query it for both.

→ `packages/analysis/src/static-checks.ts`

#### `positionAt(segments, totalTime, frac) → { pos, seg, idx, localFrac, time }` — line 752

Binary search plus interpolation, handling both the polyline (`seg.pts`) and
straight-line cases.

→ `packages/viewer-three/src/playback.ts`

### 3.4 App-level behaviours worth keeping

| Behaviour | Line | Note |
| --- | --- | --- |
| Auto-populate tool table from `toolsUsed` | 836–843 | every T-number in the program gets a default tool entry |
| Issue severity precedence per line | 939–945 | error beats warning when both are on one line |
| Reset-on-rewind simulation | 860–880 | forward is incremental, backward re-runs from zero |
| Line-count cap for rendering | 949–950 | only the first 6,000 source lines are rendered |
| Drag-and-drop file loading | 966–967 | on the root container |

The 6,000-line render cap is a real constraint: `MakeraBadge.nc` is 18,531 lines
and would be truncated. Studio should virtualise the G-code list instead of
capping it.

---

## 4. Cross-file symbol index

| Symbol | File | Line | Target module |
| --- | --- | --- | --- |
| `PRESETS` | cam | 22 | `geometry/heightfield.ts` |
| `heightfieldTris` | cam | 66 | `geometry/heightfield.ts` |
| `parseSTL` | cam | 94 | `geometry/mesh.ts` |
| `buildModel` | cam | 119 | `geometry/mesh.ts` |
| `buildGrid` | cam | 146 | `geometry/spatial-index.ts` |
| `pointInTri` | cam | 175 | `geometry/drop-cutter.ts` |
| `edgeBall` | cam | 184 | `geometry/drop-cutter.ts` |
| `makeEvaluator` ★ | cam | 203 | `geometry/drop-cutter.ts` |
| `buildCLField` | cam | 313 | `geometry/cl-field.ts` |
| `bilin` | cam | 342 | `geometry/cl-field.ts` |
| `marchSquares` | cam | 356 | `geometry/contours.ts` |
| `splitByMask` | cam | 433 | `geometry/contours.ts` |
| `solveEikonal` | cam | 454 | `geometry/eikonal.ts` |
| `KIND_SPEED` | cam | 483 | `machine/profile.ts` (as data) |
| `emitEntry` | cam | 489 | `planner/entry.ts` |
| `generateJob` | cam | 546 | split — `strategies/*`, `planner/*` |
| `refineLine`/`refineA`/`refineB` | cam | 722/771/779 | `planner/refine.ts` |
| `finLink` | cam | 733 | `planner/linker.ts` |
| `compressCut` | cam | 1013 | `planner/arc-fit.ts` |
| `fitArcsRun` | cam | 1036 | `planner/arc-fit.ts` |
| `toGcode` | cam | 1115 | `post-rs274/`, `compiler/gcode-ir.ts` |
| `verifyJob` | cam | 1192 | `analysis/dexel.ts` |
| `devColor` | cam | 1298 | `analysis/deviation.ts` |
| `MACHINE` | ide | 31 | `machine/profiles/xyz3018.ts` |
| `DEFAULT_CODE` | ide | 39 | `apps/studio` sample scripts |
| `compileProgram` | ide | 116 | split — script-host, compiler, analysis |
| `unwrap`/`warnBare` | ide | 128/122 | `script-host/api/units.ts` |
| `mm`/`rpm`/`mmPerMin`/`deg`/`p` | ide | 141–145 | `units/`, `script-host/api/` |
| `tools.*` | ide | 152 | `machine/tools.ts` |
| `job.*` | ide | 169 | `script-host/api/job.ts` |
| `job.face` | ide | 236 | `strategies/face.ts` |
| `job.rectPocket` | ide | 275 | `strategies/rect-pocket.ts` |
| `checkTravel` | ide | 376 | `analysis/static-checks.ts` |
| `axisWords`/`addLinear` | ide | 390/402 | `compiler/gcode-ir.ts` |
| `safeTraverse` | ide | 439 | `planner/clearance.ts` |
| `highlight`/`Editor` | ide | 665/688 | **deleted** (CodeMirror 6) |
| `Viewer`/`posAt` | ide | 794/920 | `viewer-three/` |
| `Z1`/`KNOWN_G`/`KNOWN_M` | z1 | 27–34 | `machine/profiles/makera-z1.ts` |
| `SAMPLE` | z1 | 39 | test fixture (two planted defects) |
| `parseGcode` | z1 | 97 | `gcode-parser/` |
| `dist3` | z1 | 232 | `math/vec.ts` |
| `arcPoints` | z1 | 237 | `gcode-parser/` |
| `toolProfile` | z1 | 272 | `machine/tools.ts` |
| `StockSim` | z1 | 287 | `analysis/dexel.ts` |
| `runGlobalChecks` | z1 | 383 | `analysis/static-checks.ts` |
| `useViewport` | z1 | 429 | `viewer-three/viewport.ts` |
| `positionAt` | z1 | 752 | `viewer-three/playback.ts` |

★ = performance-critical; see design doc Part IX.1 for port constraints.

---

## 5. Defects found while reading

Recorded here so they are fixed rather than faithfully reproduced.

| # | Location | Defect | Severity |
| --- | --- | --- | --- |
| D1 | `dropcut-ide(1).jsx:244, 288` | `face` and `rectPocket` hard-code `dia = 4` instead of using the active tool's diameter, so stepover is wrong for any other tool | **high** — leaves uncut ridges |
| D2 | `dropcut-cam(1).jsx:1293` | `pctOK` divides by all cells including empty margin, inflating the in-tolerance percentage | medium — misleading metric |
| D3 | `z1-gcode-checker-l2.jsx:311-313, 341` | Dead early-out: guard body is an empty comment, `_maxIn()` is a stub | low — no runtime effect |
| D4 | `dropcut-cam(1).jsx:397` | Contour chaining tolerance hidden in a string key quantised to 1/256 mm | medium — silent gaps on fine grids |
| D5 | `z1-gcode-checker-l2.jsx:144` | `G18`/`G19` arcs fall through to a straight line with only a warning | medium — wrong backplot |
| D6 | `z1-gcode-checker-l2.jsx:949-950` | G-code view truncates at 6,000 lines with no indication beyond a flag | low — `MakeraBadge.nc` is 18,531 lines |
| D7 | `dropcut-cam(1).jsx:489` | Entry silently degrades helix → ramp → plunge with no diagnostic | low — surprising tool loads |
| D8 | `z1-gcode-checker-l2.jsx:411-420` | Rapid-crash detection runs a second independent simulation at different resolution from the display sim | low — wasted work, possible disagreement |

D1 is worth calling out to whoever owns the prototypes: it is a live bug in the
IDE demo today, not merely a porting note.

---

## 6. Related

- Design doc: [01-dropcut-studio-architecture-analysis-and-implementation-guide.md](../design-doc/01-dropcut-studio-architecture-analysis-and-implementation-guide.md)
- Diary: [01-diary.md](./01-diary.md)
- Normative architecture: `original/DESIGN-01-semantic-cam-architecture.md`
- DSL sequencing model: `original/DESIGN-02-kleisli-composition-for-machine-commands.md`
