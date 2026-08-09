---
Title: DROPCUT Studio — architecture, analysis and implementation guide
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
DocType: design-doc
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
Summary: Intern-oriented analysis of three CAM prototypes and a complete design for consolidating them into one Vite + React + Redux application with an embedded JavaScript scripting IDE.
LastUpdated: 2026-08-09T00:00:00Z
WhatFor: Onboarding an engineer with no CAM background onto the DROPCUT Studio codebase, and specifying what to build.
WhenToUse: Read start to finish before writing code. Use Part XII as the file-by-file build order and Part IV as the API reference.
---


# DROPCUT Studio — architecture, analysis and implementation guide

## How to read this document

This guide is written for an engineer who is comfortable with TypeScript and
React but who has never touched CAM software, G-code, or a CNC machine. It has
three jobs, in order:

1. **Teach you the domain.** Part I is a self-contained primer. If a term in a
   later section is unfamiliar, it is defined there or in the glossary (Part XVI).
2. **Show you what already exists.** Part II dissects the three prototype files
   in `original/`, function by function, with line references you can open. This
   is the code we are consolidating; almost none of it is being thrown away.
3. **Specify what to build.** Parts III–XIII are the design: the layered
   architecture, the data model, the Redux state shape, the scripting host, the
   compute strategy, the repository layout, and a phased build order.

Parts XIV (decision records), XV (risks) and XVI (glossary/references) are
reference material you will come back to rather than read once.

A reading suggestion: read Parts I, II and III in one sitting to get the shape of
the system, then read Part IV (the data model) slowly, because every later part
depends on it. Skim Parts IX and X on first pass — they are the mathematics, and
they will make more sense once you have built something.

**Terminology note.** The existing prototypes are called *Dropcut*. The
consolidated application in this guide is called **DROPCUT Studio**. When this
document says "the prototype" it means one of the three files in `original/`;
when it says "Studio" it means the thing we are designing.

---

## Executive summary

We have three standalone React + Three.js single-file prototypes, totalling 4,861
lines, that between them implement a complete CAM pipeline — but implement it
three times over, fused into monolithic functions, with no shared model and no
way to script anything.

- `original/dropcut-cam(1).jsx` (1,971 lines) generates 3-axis toolpaths from a
  triangle mesh: roughing, three finishing strategies, arc fitting, G-code
  output and a material-removal verifier.
- `original/dropcut-ide(1).jsx` (1,673 lines) is a live-coding environment: a
  JavaScript DSL is executed, lowered to a canonical intermediate
  representation, validated, and compiled to modal G-code — with G-code emission
  *blocked* when validation fails.
- `original/z1-gcode-checker-l2.jsx` (1,217 lines) goes the other direction: it
  parses existing G-code, back-plots it, simulates material removal against a
  defined stock, and reports machine-limit and safety violations.

The user-supplied design notes in `original/DESIGN-01-semantic-cam-architecture.md`
state the organising principle, and this guide adopts it wholesale:

> **Do not make G-code the semantic model. Make machining the semantic model, and
> treat G-code as one serialization backend.**

The proposal is a Vite + React + Redux Toolkit application built on a **layered
compiler**, not on a UI with algorithms bolted underneath. A user writes
JavaScript in an embedded editor; that script builds a *manufacturing plan*; the
plan is planned into *toolpaths*; toolpaths are lowered into a machine-independent
*canonical IR*; the IR is lowered again against a *machine profile*, validated,
and only then emitted as G-code for a specific dialect. Every artefact along the
way — the plan, the toolpaths, the IR, the simulation, the time estimate, the
diagnostics, the G-code — is a different *interpretation of the same semantic
program*, and each is independently inspectable in the UI.

Four decisions carry most of the design's weight, and each is recorded as an ADR
in Part XIV:

- **The canonical IR is non-modal** (ADR-002). Every cut carries its own feed;
  every arc carries its geometry rather than an ambient plane. G-code's modal
  state becomes a compression pass in the postprocessor, not a hazard in the
  model.
- **Heavy compute runs in Web Workers over transferable typed arrays**
  (ADR-005). Toolpath generation on the existing prototypes takes seconds and
  currently blocks the main thread, papered over with `await new Promise(r =>
  setTimeout(r, 0))` yields.
- **Redux holds documents and derived summaries; it does not hold geometry**
  (ADR-004). A 6-million-float toolpath buffer and a Three.js scene graph never
  enter the store.
- **User scripts run in a sandboxed worker with a capability-limited global
  object** (ADR-006). The prototype's `new Function(...)` on the main thread is
  adequate for a demo and unacceptable for a product.

The build is phased over roughly eight milestones (Part XIII), the first of
which — the units/frames/IR core plus a golden-file postprocessor test — is
deliberately UI-free.

---

# PART I — Domain primer

You cannot design this system without a working mental model of what a CNC mill
does. This part is the minimum. It is not a machining course; it is the subset
that shows up in the code.

## I.1 The machine

A 3-axis CNC milling machine holds a rotating cutting tool in a **spindle** and
moves it in three linear axes relative to a workpiece clamped to a bed.

```text
              Z ↑  (up, out of the material)
                │
                │      ┌──────────┐
                │      │ spindle  │   rotates the tool at S rpm
                │      └────┬─────┘
                │           │
                │        ╔══╧══╗  tool (end mill)
                │        ╚═════╝
   ────────────┼──────────────────────────────►  X
        ┌───────────────────────────┐
        │   stock (raw material)    │   clamped to the bed
        └───────────────────────────┘
              ↙
             Y
```

Key physical facts that the software must respect:

- **Travel limits.** Each axis has a finite range. Commanding a position outside
  it is a crash or an alarm. `MACHINE.travels` in `dropcut-ide(1).jsx:33` and
  `Z1.travel` in `z1-gcode-checker-l2.jsx:30` both encode this.
- **The spindle must be running before the tool touches material.** Cutting with
  a stopped spindle breaks tools. Both prototypes check this
  (`dropcut-ide(1).jsx:518`, `z1-gcode-checker-l2.jsx:202`).
- **The tool cannot move sideways through material at rapid speed.** Rapids (see
  below) are uncontrolled-feed moves intended for free space. A rapid that
  passes through uncut stock is a crash. `runGlobalChecks` detects exactly this
  (`z1-gcode-checker-l2.jsx:411-423`).
- **Below the stock is the spoilboard**, the sacrificial bed surface. Cutting
  into it is usually a mistake, and is detected at
  `z1-gcode-checker-l2.jsx:404-408`.

## I.2 Motion vocabulary

| Term | Meaning | In G-code |
| --- | --- | --- |
| **Rapid** / traverse | Move at maximum speed; assumed to be through free space | `G0` |
| **Feed** / cut | Move at a controlled feed rate, in mm/min | `G1` |
| **Arc** | Circular interpolation in a plane | `G2` (CW), `G3` (CCW) |
| **Plunge** | A downward-only feed move into material | `G1` with only Z changing |
| **Ramp** | A shallow-angle descent that cuts on the way down | a sequence of `G1` |
| **Helix** | A ramp on a circular path — the gentlest way into material | a sequence of `G1` or helical `G2/G3` |
| **Retract** | Lift to a safe height | `G0 Z<clearance>` |

Plunging straight down is hard on tools because the centre of an end mill has
zero cutting speed. This is why the prototype has an *entry strategy* that tries
helix, then ramp, then plunge as a last resort (`emitEntry`,
`dropcut-cam(1).jsx:489`).

## I.3 Tools

A tool is described by geometry, and its geometry determines what surface it
leaves behind.

```text
   flat end mill        ball nose (ball end)       V-bit / engraver
   ┌──┐                    ┌──┐                        ┌──┐
   │  │                    │  │                        │  │
   └──┘                    └╮╭┘                        └╮╭┘
   ▔▔▔▔                     ╰╯                          ╲╱
   flat bottom          hemispherical tip           conical point
   good for flats       good for 3D surfaces        good for engraving
```

The function `toolProfile(tool, r)` in `z1-gcode-checker-l2.jsx:272` is the
cleanest statement of tool geometry in the codebase: given a radial distance `r`
from the tool axis, it returns the height of the cutter surface above the tool
tip.

```js
// z1-gcode-checker-l2.jsx:272
function toolProfile(tool, r) {
  const R = Math.max(0.05, tool.dia / 2);
  if (r > R + 1e-9) return null;                       // outside the cutter
  if (tool.type === "ball") return R - Math.sqrt(R*R - r*r);  // sphere
  if (tool.type === "v") { const t = Math.tan(angle/2); return r / t; }  // cone
  return 0;                                            // flat
}
```

That single function is enough to simulate any of the three tool types, and it is
the reason the stock simulator is tool-agnostic.

## I.4 Stepover, stepdown, and scallop

Three parameters govern how much material comes off and how good the finish is.

- **Stepdown** — how deep each roughing layer cuts (Z direction).
- **Stepover** — the lateral distance between adjacent passes (XY direction).
- **Scallop height** — with a ball nose tool, adjacent passes leave a small ridge
  between them. Scallop height is how tall that ridge is.

```text
  cross-section through two adjacent ball-nose passes:

     ╲    ╱ ╲    ╱      the little peak between passes
      ╲__╱   ╲__╱       is the "scallop"
       ●      ●         ← tool centres, separated by the stepover s
       │◄──s──►│
                        scallop height h ≈ s²/(8R)  for small s
```

Inverting that relation gives the stepover needed for a target scallop, which is
exactly what the prototype computes:

```js
// dropcut-cam(1).jsx:706-709
if (tool.type === "ball") {
  const h = Math.max(1e-5, prm.scallop);
  s0 = 2 * Math.sqrt(Math.max(1e-9, 2 * R * h - h * h));  // exact, not the approximation
} else {
  s0 = tool.diameter * (prm.stepoverPct / 100);
}
```

This is the exact chord formula rather than the `s ≈ sqrt(8Rh)` approximation;
for `h << R` they agree.

## I.5 Roughing versus finishing

Machining a 3D shape is done in two phases:

- **Roughing** removes bulk material fast, in flat Z layers, leaving a deliberate
  **allowance** (also called *stock to leave*) of typically 0.2 mm on the
  surface. It uses a big stepover and does not care about surface quality.
- **Finishing** removes that allowance with a small stepover, following the
  actual 3D surface, and determines the final finish.

The prototype implements roughing as Z-level scanline clearing
(`dropcut-cam(1).jsx:564-698`) and offers three finishing strategies.

## I.6 The drop-cutter problem

This is the central geometric problem in 3-axis surface machining, and it is
worth understanding precisely because a third of `dropcut-cam(1).jsx` implements
it.

> **Question.** Given a triangle mesh and a tool, if I position the tool at some
> `(X, Y)` and lower it straight down until it just touches the mesh, what is the
> Z coordinate of the tool tip?

That answer, as a function of `(X, Y)`, is the **cutter-location (CL) surface**.
Driving the tool tip along the CL surface machines the part exactly without
gouging it.

```text
        tool lowered at X                 the CL surface (dashed) sits
             │                             above the part surface by
             ▼                             an amount that depends on
           ╔═╧═╗                           the local slope
           ╚═╤═╝  ← tool tip stops here
    ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  CL surface
      ╱▔▔▔▔▔▔▔╲
     ╱  part    ╲
```

The naive way to compute this is to lower the tool in small steps and test for
intersection. That is slow and inexact. The prototype instead solves it
**analytically per triangle**: for each triangle near `(X, Y)`, it computes the
exact contact height for the vertex case, the edge case, and the face case, and
takes the maximum over all of them. `makeEvaluator` at `dropcut-cam(1).jsx:203`
is that solver; Part IX.1 walks through it.

## I.7 G-code, briefly

G-code (formally RS-274) is a line-oriented language of *blocks*, each a sequence
of letter-number **words**.

```gcode
G21 G90 G17    ; millimetres, absolute coordinates, XY arc plane
T1 M6          ; select tool 1, perform tool change
S12000 M3      ; spindle 12000 rpm, clockwise
G0 Z5.0        ; rapid to safe height
G0 X10 Y10     ; rapid to start position
G1 Z-1.5 F300  ; feed down at 300 mm/min
G1 X70 F800    ; cut in X at 800 mm/min
G2 X15 Y55 I10 J0  ; clockwise arc, centre offset by (10,0) from current point
M5             ; spindle off
M30            ; program end
```

The critical and dangerous property of G-code is that it is **modal**: settings
persist until changed. `G1` stays active, so subsequent lines with only
coordinates are still feed moves. `F800` stays active. `G90` (absolute) stays
active. The current tool, the current plane, the current units — all sticky.

This means **you cannot understand a G-code line in isolation**. `X70` means
"rapid to X=70" or "feed to X=70 at 800 mm/min" or "feed 70 mm further in X"
depending on what came before. The parser in `z1-gcode-checker-l2.jsx:97`
maintains an explicit modal state object (`st`, lines 105–110) for exactly this
reason.

Modality is the single strongest argument for the architecture in this guide: we
refuse to let the source language be modal, and we push modality down into a
compression pass at the very end.

## I.8 Verification: dexels and heightmaps

To check that a program cuts the right shape, we simulate it. The technique used
in both prototypes is a **heightmap** (a degenerate case of a *dexel* model): the
stock is represented as a 2D grid of columns, each storing the current top-of-
material Z at that grid point.

```text
  heightmap columns, seen in cross-section:

   ████████                 the tool sweeps through and lowers
   ████████ ██              the columns it touches; each column
   ██ ██████ ███            keeps only its top surface height
   ██████████████
   ─────────────── grid
```

Cutting is then trivially cheap: for each sample position along a move, for each
grid cell under the tool, lower that cell's height to the tool's surface height
if the tool is lower. That is `StockSim.stamp` at
`z1-gcode-checker-l2.jsx:306`.

Heightmaps cannot represent undercuts (overhangs), which is fine for 3-axis
machining where the tool always comes from above. They also only verify *at the
sampling resolution* — a point the design notes make forcefully, and which Part X
turns into an explicit error budget.

---

# PART II — What we have: the three prototypes dissected

All three files follow the same shape: a large block of pure computational
functions at the top, then a React component at the bottom that owns Three.js
through refs. None of them import anything except React and Three.

```text
 ┌──────────────────────────────────────────────────────────────────┐
 │  dropcut-cam(1).jsx      1,971 lines                             │
 │  "make toolpaths from a mesh"                                    │
 │                                                                  │
 │  mesh → CL surface → strategy → moves → arc fit → G-code         │
 │                              └→ dexel verify → deviation heatmap │
 ├──────────────────────────────────────────────────────────────────┤
 │  dropcut-ide(1).jsx      1,673 lines                             │
 │  "write a script, get validated G-code"                          │
 │                                                                  │
 │  JS DSL → canonical IR → validate → lower → modal G-code         │
 │                                          └→ motions → 3D preview │
 ├──────────────────────────────────────────────────────────────────┤
 │  z1-gcode-checker-l2.jsx 1,217 lines                             │
 │  "check G-code someone else made"                                │
 │                                                                  │
 │  G-code text → parse (modal) → segments → checks                 │
 │                                        └→ StockSim → 3D preview  │
 └──────────────────────────────────────────────────────────────────┘
```

Read together they form a loop: the first produces G-code, the third consumes it,
and the second is the compiler that should sit between them.

## II.1 `dropcut-cam(1).jsx` — the toolpath generator

### Geometry input (lines 22–142)

`PRESETS` (line 22) defines four analytic height fields — a blob, a star, a
hemisphere and Gaussian hills — each as a function `f(x, y) → z` plus a sampling
resolution. `heightfieldTris` (line 66) tessellates one into a triangle soup:
two triangles per grid cell, stored flat in a `Float64Array` of 9 floats per
triangle.

`parseSTL` (line 94) handles both binary and ASCII STL. The binary detection is
a nice trick worth noting: it reads the triangle count from byte 80 and checks
whether `84 + n*50` exactly equals the file length; if not, it falls back to
regex-scanning for `vertex` lines.

`buildModel` (line 119) centres the mesh in XY, drops it so `minZ` becomes 0,
applies a uniform scale, and returns `{ tris, nTri, bbox, name }`. **Everything
downstream assumes the part sits on Z=0 with its centre at the XY origin.** This
is an implicit invariant with no runtime check — a good candidate for the frame
system in Part IV.2.

### Spatial index (lines 146–173)

`buildGrid(model, R)` bins triangles into a uniform 2D grid of cells sized
`max(R, diag/256, 0.25)`. Each triangle is inserted into every cell its XY
bounding box overlaps, so a triangle can appear in many cells.

The query path uses a **generation-stamp deduplication** pattern that is worth
learning because it recurs in this kind of code:

```js
// dropcut-cam(1).jsx:212, 223-224
const qid = ++grid.qid;             // bump a global query counter
// ... for each candidate triangle t:
if (stamp[t] === qid) continue;     // already seen in THIS query
stamp[t] = qid;                     // mark it
```

This avoids allocating a `Set` per query. With hundreds of thousands of queries
during a job, that matters.

### The drop-cutter evaluator (lines 175–309)

`makeEvaluator(model, grid, tool, floorZ)` returns a closure `evalTipZ(X, Y)`.
This is the hot function of the whole application. Part IX.1 explains the
mathematics; structurally:

- It queries the grid for candidate triangles within `R` of `(X, Y)`.
- For a **ball** tool it considers three contact cases: sphere-vertex,
  sphere-edge (`edgeBall`, line 184), and sphere-plane, taking the max.
- For a **flat** tool it considers vertex-in-disc, edge-crossing-disc-boundary,
  and plane-under-disc.
- It returns `best - R` for ball tools, converting from centre height to tip
  height.

### Cutter-location field and contouring (lines 313–450)

`buildCLField` samples `evalTipZ` on a regular grid, yielding `F` (heights) and
`G` (gradient magnitude, i.e. local slope) plus bilinear samplers. `marchSquares`
(line 356) extracts iso-contours from either field and chains the resulting
segments into polylines using a hash of quantised endpoints (line 397). Note the
saddle-point disambiguation at cases 5 and 10 (lines 382–391), which uses the
cell-centre average to decide which way the contour connects — the standard fix
for marching-squares ambiguity.

### `generateJob` — the monolith (lines 546–1007)

This is the function the whole refactor is organised around. In one 460-line body
it performs:

1. **Roughing** (564–698). For each Z level, it walks scanlines, finds intervals
   where the inflated CL surface is below the level, and unions overlapping
   intervals between adjacent rows with a **union-find** structure (`uf`, `find`,
   `uni` at 592–594) to identify connected pockets. Each connected component is
   then machined as a boustrophedon (alternating-direction) pass set.
2. **Entry generation** (via `emitEntry`, 489). Tries a helix validated against
   the inflated surface at 12 sample angles; falls back to a zig-zag ramp; falls
   back to a plunge.
3. **Link decisions** (664–686). Between passes it decides whether to stay down
   (sampling the surface along the link to check clearance) or to retract to a
   computed local safe height.
4. **Finishing** in one of three strategies (762–947), described in Part IX.
5. **Adaptive chord refinement** (`refineLine` at 722, `refineA`/`refineB` at
   771/779) — recursive midpoint subdivision until the surface deviation is
   within `chordTol`, bounded by `MAXD = 11` levels.
6. **Arc fitting** (954–967) and **flattening** into parallel arrays (970–996):
   `pos` (Float32Array of xyz), `kinds` (Uint8Array of move type), `cumT`
   (Float64Array of cumulative time).

The output shape:

```js
{
  moves,                     // array of {kind, phase, pts, ops}
  pos, kinds, cumT, nPts,    // flattened, render- and playback-ready
  zMin, zMax, clearZ,
  stats: { finDesc, step, roughLevels, cutLenMM, timeMin, roughMin, finishMin, arc }
}
```

**This is the representation the design must replace.** It is simultaneously the
plan, the toolpath, the render buffer and the time index, with no separation
between them, and `kind`/`phase` are stringly-typed.

### Arc fitting (lines 1013–1109)

`compressCut` groups consecutive segments that lie in a common axis-aligned plane
(`segAxis`, line 1016), then `fitArcsRun` fits circles by algebraic least squares
over a growing window. The fit is accepted only if every point is within `tol` of
the circle, the sweep direction never reverses, and the total sweep is under 2.9
radians (line 1085) — keeping arcs safely under a half turn.

### G-code emission (lines 1115–1186)

`toGcode` walks `job.moves` and emits text, tracking modal state via
`ensureF`/`ensurePlane` closures (1133–1134) so redundant `F` and `G17/18/19`
words are suppressed. Note the plane-dependent arc direction inversion at
1157–1168 flagged in the diary — the same `op.pos` maps to `G2` in one plane and
`G3` in the others.

### Dexel verification (lines 1192–1309)

`verifyJob` rasterises the target mesh into a height field `Tg`, initialises a
machined field `H` at stock top, sweeps every cutting move stamping the tool
footprint, and computes `dev = H - Tg` per cell. `devColor` (1298) maps deviation
to a red/green/blue heatmap: red for gouge (cut too deep), green-to-teal for
in-tolerance, blue for excess stock left behind.

## II.2 `dropcut-ide(1).jsx` — the scripting IDE

This is the most architecturally interesting prototype, because it already
implements the compiler shape the design wants.

### The DSL surface

The default program at line 39 is the best specification of the intended user
experience:

```js
const T1 = tools.flatEndMill({ name: "4mm flat", diameter: mm(4) });

job.setup({ stock: { x: mm(60), y: mm(40), z: mm(12) }, clearance: mm(6) });
job.toolChange(T1);

job.withSpindle({ speed: rpm(12000) }, () => {
  job.face({ x: mm(0), y: mm(0), w: mm(60), h: mm(40), z: mm(-0.5),
             stepover: 0.6, feed: mmPerMin(900) });
  job.rectPocket({ x: mm(14), y: mm(10), w: mm(32), h: mm(20),
                   depth: mm(6), stepdown: mm(2), feed: mmPerMin(600) });
  job.arcCut(p(mm(24), mm(20), mm(-6)),
             { center: p(mm(30), mm(20), mm(-6)), dir: "ccw" });
});
```

Three features to notice, all of which we keep:

- **Branded units.** `mm(4)` returns `{ __unit: "mm", v: 4 }` (line 141). Passing
  a bare number still works but emits a warning (`warnBare`, line 122); passing
  the wrong brand throws (`unwrap`, line 128). This is a runtime version of the
  type-level branding in DESIGN-01 §14.
- **Scope combinators.** `withSpindle(opts, body)` (line 198) emits the spindle-on
  command, runs the body, and emits spindle-off. The user cannot forget the
  `M5`. This is DESIGN-01 §22.
- **Strategies as functions.** `face` (236) and `rectPocket` (275) expand
  manufacturing intent into canonical moves. They are the seed of the strategy
  plugin system.

### Execution model (lines 332–343)

```js
const fn = new Function("job", "tools", "p", "mm", "rpm", "mmPerMin", "deg",
                        '"use strict";\n' + code);
fn(job, tools, p, mm, rpm, mmPerMin, deg);
```

This runs user code **on the main thread with full DOM access**. `new Function`
is not a sandbox: the script can reach `window`, `fetch`, `localStorage`, and can
hang the UI with an infinite loop. Part VII replaces this.

### Lowering and validation (lines 357–655)

After the script runs, `cmds` holds the canonical IR. A single pass over it does
four things at once:

- **Validates.** Travel limits (`checkTravel`, 376), spindle range (488), tool
  loaded before cut (513), spindle running before cut (518), feed present (523),
  arc endpoints equidistant from centre (562), tool change with spindle running
  (469).
- **Lowers traverses into safe motion.** `safeTraverse` (439) is the key idea:
  a traverse is not a `G0`; it is *retract to a safe Z, move in XY, descend*.
  The DSL never says `G0`.
- **Builds `motions`** — the render/playback representation, with `t0`/`t1`
  timestamps and `lens` cumulative arc lengths per motion.
- **Emits modal G-code** with `lastMode`/`lastFeed`/`lastAxes` suppression
  (390–397, 426–436), and records a bidirectional `motion ↔ gcode line` link
  (`motions[mIdx].gline`, `pushLine(text, mIdx)`).

That bidirectional link is what powers click-a-line-to-seek and highlight-the-
line-as-it-plays in the UI (1518–1533, 981–985). It is a small thing that makes
the tool feel professional, and the design keeps it as a first-class
**provenance** concept (Part IV.7).

### The invariant that matters most

```js
// dropcut-ide(1).jsx:644-654
return {
  ok: !hasErrors,
  gcode:   hasErrors ? [] : gcode,
  motions: hasErrors ? [] : motions,
  total:   hasErrors ? 0 : time,
  ...
};
```

**If validation produced any error, no G-code exists.** The UI then shows
"No G-code emitted — the postprocessor only accepts a validated program"
(1513–1516). This is DESIGN-01 §13's certified-stage idea implemented with a
runtime guard. Part IV.8 upgrades it to a type-level brand so the guard cannot
be forgotten.

### The editor (lines 661–788)

A transparent `<textarea>` overlaid on a syntax-highlighted `<pre>`, with scroll
positions synchronised (`sync`, 695) and a line-number gutter. Highlighting is a
single regex with alternation groups (670). It is about 120 lines and supports
Tab-to-indent and nothing else — no autocomplete, no error squiggles, no
multi-cursor. Part VII replaces it with CodeMirror 6.

## II.3 `z1-gcode-checker-l2.jsx` — the G-code verifier

### The parser (lines 97–230)

`parseGcode(text)` is a faithful modal interpreter. Per line it strips comments
(both `(...)` and `;...` forms, line 119), tokenises words with a single regex
(122), and updates the modal state `st` (105–110: position, feed, rpm, tool,
absolute/incremental, inch/mm, spindle, motion mode, plane).

Points worth internalising:

- **Unit conversion is applied at read time** via `u(v)` (line 113), so all
  internal state is millimetres regardless of `G20`/`G21`. Switching units
  mid-program after motion has started raises a warning (138–139).
- **Motion mode is sticky.** Line 178: `const mo = motion !== null ? motion :
  st.motion` — a line with only coordinates inherits the last motion mode.
- **Arc handling** supports both I/J centre-offset and R radius forms
  (`arcPoints`, 237), including the sign convention that distinguishes the minor
  from the major arc (line 249). Arcs are discretised into points for rendering
  and length computation.
- Only `G17` (XY) arcs are back-plotted; `G18`/`G19` produce a warning (144).

### `StockSim` (lines 287–379)

The heightmap simulator. `stamp(x, y, tipZ, tool, remove)` lowers every grid cell
under the tool footprint; `sweep(seg, tool, f0, f1, onRapidCut)` walks a fraction
range of a segment at a spacing of 0.55 grid cells and stamps along it, reporting
whether a *rapid* removed material — the crash detector.

Two implementation notes:

- Gouges below the stock bottom are clamped to `this.floor` for rendering (line
  333) so the mesh stays finite, while the *check* uses the unclamped comparison.
- The `_maxIn` early-out at 311–313/341 is vestigial: the guard body is an empty
  comment and `_maxIn()` returns `-Infinity`. It has no effect. Do not carry it
  forward.

### Incremental playback (lines 860–880)

`setSimTo(frac)` advances the simulation to a target time. Because heightmap
removal is destructive, **rewinding requires a full reset and re-simulation**
(864–867). This is the correct simple answer and is fast enough for the sizes
involved, but it means scrubbing backwards is O(program) while scrubbing forwards
is O(delta). Part X.4 discusses the snapshot approach if this becomes a problem.

## II.4 The duplication, quantified

| Concern | `dropcut-cam` | `dropcut-ide` | `z1-checker` |
| --- | --- | --- | --- |
| Three.js scene bootstrap | 1472–1587 | 810–1025 | 432–538 |
| Orbit camera (spherical, manual) | 1499–1537 | 829–880 | 468–507 |
| Time→position binary search | 1562–1568 | 920–953 | 752–776 |
| Heightmap material removal | 1192–1296 | — | 287–379 |
| DRO readout | 1943–1947 | 1159–1202 | 786–794 |
| Tool marker mesh | 1708–1725 | 895–913 | 457–466 |
| Playback transport UI | 1948–1961 | 1204–1279 | (in main body) |

Six components, each written three times, each subtly different. Two of the three
use Z-up (`camera.up.set(0,0,1)`); the IDE instead remaps coordinates on insert
with `v3 = (x,y,z) => new Vector3(x, z, -y)` (line 1043). Consolidating this is
the single largest line-count win available and is Milestone 3.

## II.5 Capability matrix

What each prototype can and cannot do, as a summary of the gap:

| Capability | cam | ide | checker | Studio target |
| --- | --- | --- | --- | --- |
| Load STL mesh | ✅ | ❌ | ❌ | ✅ |
| Analytic preset geometry | ✅ | ❌ | ❌ | ✅ (as scripts) |
| Define stock | implicit bbox | ✅ | ✅ | ✅ |
| Roughing strategy | ✅ | ❌ | — | ✅ |
| 3D finishing strategies | ✅ (3) | ❌ | — | ✅ (3+) |
| 2.5D pocket / face | ❌ | ✅ | — | ✅ |
| Scriptable | ❌ | ✅ | ❌ | ✅ |
| Canonical IR | ❌ | ✅ | ❌ | ✅ |
| Validation / diagnostics | ❌ | ✅ | ✅ | ✅ |
| Parse existing G-code | ❌ | ❌ | ✅ | ✅ |
| Material-removal sim | ✅ (batch) | ❌ | ✅ (incremental) | ✅ (both) |
| Deviation vs target | ✅ | ❌ | ❌ | ✅ |
| Arc fitting | ✅ | ❌ | — | ✅ |
| Multiple machine profiles | ❌ | ❌ | ❌ | ✅ |
| Multiple G-code dialects | ❌ | ❌ | — | ✅ |
| Runs off the main thread | ❌ | ❌ | ❌ | ✅ |
| Persistence / project files | ❌ | ❌ | ❌ | ✅ |
| Undo/redo | ❌ | ❌ | ❌ | ✅ |

---

# PART III — Target architecture

## III.1 The five-layer semantic stack

From `original/DESIGN-01-semantic-cam-architecture.md` §1, adopted verbatim:

| Layer | Answers | Example |
| --- | --- | --- |
| **Geometry** | What physical things exist? | stock, part mesh, fixture, cutter |
| **Manufacturing intent** | What should be done? | rough this region; finish this surface |
| **Canonical machining IR** | What physical actions, machine-independently? | traverse, cut along curve, change tool |
| **Machine IR** | How does *this* machine realise them? | coordinated XYZ move, fixture select |
| **G-code** | How is that encoded for *this* controller? | `G1 X10 Y20 F600` |

The corresponding compilation pipeline:

```text
   ┌───────────────┐
   │  user script  │  JavaScript, runs in a sandboxed worker
   └───────┬───────┘
           │ builds
           ▼
   ┌────────────────────┐
   │ ManufacturingPlan  │  declarative: operations + parameters, no motion yet
   └───────┬────────────┘
           │ plan()          ← strategies run here; this is the expensive step
           ▼
   ┌────────────────────┐
   │  ToolpathProgram   │  tool-relative geometry: paths with purposes
   └───────┬────────────┘
           │ link() · entry() · clearance() · refine() · arcFit()
           ▼
   ┌────────────────────┐
   │ CanonicalProgram   │  non-modal, machine-independent, frame-tagged
   └───────┬────────────┘
           │ lower(machineProfile)   ← capability-driven
           ▼
   ┌────────────────────┐
   │  MachineProgram    │  resolved to this machine's kinematics and limits
   └───────┬────────────┘
           │ validate(scene)  →  Result<ValidatedProgram, Diagnostic[]>
           ▼
   ┌────────────────────┐
   │ ValidatedProgram   │  brand-typed: only the validator can construct one
   └───────┬────────────┘
           │ emit(dialect)
           ▼
   ┌────────────────────┐        ┌──────────────────┐
   │     GCodeIR        │───────►│ modal compression│───► .nc text
   └────────────────────┘        └──────────────────┘
```

Every box is a value the UI can display. That is the payoff: the IR tab, the
G-code tab, the diagnostics tab and the 3D view are four renderings of the same
compile.

## III.2 Package layout and dependency direction

```text
                       ┌────────────┐
                       │ @cam/units │  branded scalars, no deps
                       └─────┬──────┘
                             │
                       ┌─────▼──────┐
                       │ @cam/math  │  vec3, mat4, SE(3), ranges
                       └─────┬──────┘
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
      ┌──────────────┐ ┌───────────┐ ┌─────────────┐
      │@cam/geometry │ │ @cam/ir   │ │@cam/machine │
      │ mesh, index, │ │ canonical │ │ profiles,   │
      │ contours,    │ │ commands, │ │ capabilities│
      │ fields       │ │ paths     │ │             │
      └──────┬───────┘ └─────┬─────┘ └──────┬──────┘
             │               │              │
      ┌──────▼───────────────▼──────┐       │
      │ @cam/strategies             │       │
      │ raster · hybrid · scallop · │       │
      │ zlevel-rough · pocket ·face │       │
      └──────────────┬──────────────┘       │
                     │                      │
              ┌──────▼──────┐               │
              │@cam/planner │               │
              │ link, entry,│               │
              │ clearance,  │               │
              │ arcfit      │               │
              └──────┬──────┘               │
                     │                      │
        ┌────────────▼──────────┐    ┌──────▼───────┐
        │ @cam/analysis         │    │@cam/compiler │
        │ dexel sim, deviation, │◄───┤ lower,       │
        │ time, checks          │    │ validate     │
        └───────────────────────┘    └──────┬───────┘
                                            │
                     ┌──────────────────────┼──────────────────┐
                     ▼                      ▼                  ▼
              ┌────────────┐        ┌──────────────┐   ┌──────────────┐
              │@cam/post-  │        │@cam/post-    │   │@cam/post-    │
              │  rs274     │        │  makera      │   │  linuxcnc    │
              └────────────┘        └──────────────┘   └──────────────┘

  ─────────────────────────────────────────────────────────────────────
   application layer (depends on all of the above, depended on by none)
  ┌───────────────┐ ┌───────────────┐ ┌────────────┐ ┌───────────────┐
  │ @cam/script-  │ │ @cam/viewer-  │ │ @studio/   │ │ @studio/      │
  │  host (worker)│ │  three        │ │  state     │ │  ui (React)   │
  └───────────────┘ └───────────────┘ └────────────┘ └───────────────┘
```

Two rules enforce the direction, and both are checkable in CI with
`dependency-cruiser`:

1. **Nothing below the application layer may import React or Three.js.** The CAM
   core must be runnable in Node for tests and in a worker for compute.
2. **`@cam/ir` may not import `@cam/geometry`'s heavy modules or any renderer.**
   The IR is the narrow waist that everything else agrees on.

## III.3 Runtime topology

```text
  ┌─────────────────────── main thread ───────────────────────┐
  │                                                            │
  │  React UI ──dispatch──► Redux store ──selectors──► React   │
  │     │                        │                             │
  │     │                        │ derived summaries only      │
  │     │                        │ (counts, stats, diagnostics)│
  │     ▼                        ▼                             │
  │  Three.js viewport  ◄── geometry cache (module-level Map)  │
  │  (refs, rAF loop — never re-rendered by React)             │
  └──────┬──────────────────────────┬──────────────────────────┘
         │ postMessage              │ postMessage
         │ (structured clone +      │
         │  transferables)          │
  ┌──────▼───────────────┐   ┌──────▼────────────────┐
  │  script worker       │   │  compute worker pool  │
  │  ─ runs user JS      │   │  ─ strategy planning  │
  │  ─ capability globals│   │  ─ dexel simulation   │
  │  ─ hard timeout      │   │  ─ arc fitting        │
  │  → ManufacturingPlan │   │  → typed arrays       │
  └──────────────────────┘   └───────────────────────┘
```

The two-worker split is deliberate. The script worker is *untrusted* and gets
killed on timeout; the compute workers are *trusted* and long-lived. Mixing them
would mean a user's infinite loop takes down the compute pool.

---

# PART IV — The data model

This is the part to read slowly. Everything else is plumbing around these types.

## IV.1 Units (`@cam/units`)

TypeScript brands prevent mixing scalar kinds at compile time; runtime brands
catch it at the DSL boundary where types are erased.

```ts
declare const brand: unique symbol;
type Brand<K extends string> = { readonly [brand]: K };

export type Mm         = number & Brand<"mm">;
export type Inch       = number & Brand<"inch">;
export type Rpm        = number & Brand<"rpm">;
export type MmPerMin   = number & Brand<"mm/min">;
export type Degrees    = number & Brand<"deg">;
export type Radians    = number & Brand<"rad">;
export type Seconds    = number & Brand<"s">;
export type Ratio      = number & Brand<"ratio">;   // 0..1, e.g. stepover fraction

export const mm       = (v: number) => v as Mm;
export const inch     = (v: number) => (v * 25.4) as Mm;   // normalises on construction
export const rpm      = (v: number) => v as Rpm;
export const mmPerMin = (v: number) => v as MmPerMin;
export const deg      = (v: number) => v as Degrees;
```

**Design note.** `inch()` converts to millimetres immediately rather than
carrying an inch-typed value through the system. There is exactly one internal
length unit. This mirrors the checker prototype's `u(v)` normalisation
(`z1-gcode-checker-l2.jsx:113`) and avoids an entire class of conversion bug.
Display formatting converts back at the edge.

At the DSL boundary the brands must be checked at runtime, because
`mm(4)` and `rpm(4)` are the same number after compilation. The script host
therefore uses the *boxed* form the IDE prototype already uses:

```ts
// Inside the script sandbox only — boxed so the brand survives at runtime.
type Boxed<K extends string> = { readonly __unit: K; readonly v: number };

function unwrap<K extends string>(v: Boxed<K> | number | null,
                                  unit: K, ctx: string): number | null {
  if (v == null) return null;
  if (typeof v === "number") { warnBare(ctx); return v; }   // permitted, warned
  if (v.__unit === unit) return v.v;
  throw new TypeError(`${ctx}: expected ${unit}, got ${v.__unit ?? typeof v}`);
}
```

This is `dropcut-ide(1).jsx:128-138` promoted to a package. Keep the
bare-number-with-warning behaviour: it makes the DSL approachable, and the
warning surfaces in the diagnostics panel.

## IV.2 Frames and points (`@cam/math`)

DESIGN-01 §15 argues frames matter more than units, and the prototypes prove it:
`buildModel` silently establishes a part frame (centred XY, `minZ = 0`) that
every downstream function assumes without stating.

```ts
export type FrameId =
  | "machine"        // absolute machine coordinates
  | "work"           // active work offset (G54..G59)
  | "part"           // the part's own coordinate system
  | "stock";         // stock corner origin

export interface Point3<F extends FrameId = FrameId> {
  readonly x: Mm; readonly y: Mm; readonly z: Mm;
  readonly frame: F;
}

export interface Transform<A extends FrameId, B extends FrameId> {
  readonly from: A;
  readonly to: B;
  readonly m: Mat4;             // SE(3): rotation + translation
}

export function apply<A extends FrameId, B extends FrameId>(
  t: Transform<A, B>, p: Point3<A>): Point3<B>;

export function compose<A extends FrameId, B extends FrameId, C extends FrameId>(
  ab: Transform<A, B>, bc: Transform<B, C>): Transform<A, C>;

export function invert<A extends FrameId, B extends FrameId>(
  t: Transform<A, B>): Transform<B, A>;
```

Frame transforms form a **groupoid**: composition is associative, every transform
has an inverse, and `apply(invert(t), apply(t, p)) === p` up to floating point.
That last identity is a property test worth writing on day one.

The practical benefit: `Point3<"part">` and `Point3<"machine">` are different
types, so `subtract(machinePoint, partPoint)` is a compile error rather than a
crashed machine.

Using `SE(3)` (full rigid motion, not just translation) costs nothing now and
means 4- and 5-axis support later does not require replacing the abstraction.

## IV.3 Paths (`@cam/ir`)

DESIGN-01 §3 observes that paths form a category: a path goes from a start pose
to an end pose, and two paths compose only if the first's end equals the second's
start. Encoding that removes an entire class of discontinuity bug — the current
prototype simply concatenates float arrays and hopes.

```ts
export type Segment<F extends FrameId> =
  | { kind: "line";  to: Point3<F> }
  | { kind: "arc";   to: Point3<F>; center: Point3<F>;
                     axis: UnitVec3; sweep: Radians }
  | { kind: "helix"; to: Point3<F>; center: Point3<F>;
                     axis: UnitVec3; turns: number }
  | { kind: "poly";  pts: Float64Array };   // bulk sampled data, xyz-interleaved

export interface Path<F extends FrameId> {
  readonly frame: F;
  readonly start: Point3<F>;
  readonly end: Point3<F>;                  // == last segment's `to`
  readonly segments: readonly Segment<F>[];
}

/** Throws if a.end !== b.start (within EPS). */
export function concat<F extends FrameId>(a: Path<F>, b: Path<F>): Path<F>;
```

Note that `arc` carries **geometry** — centre, axis and sweep — not G-code's
`I`/`J`/`K` offsets and not an ambient plane. Which plane an arc lies in is
derived from its axis at post time. DESIGN-01 §16.

The `poly` segment is a pragmatic escape hatch: strategies like constant-scallop
naturally produce thousands of points, and boxing each as a `line` segment would
be wasteful. It carries a `Float64Array` and is treated as a polyline everywhere.

## IV.4 Canonical IR (`@cam/ir`)

The centrepiece. **Non-modal**: every command is complete in itself.

```ts
export type CanonicalCommand =
  | ToolChange | Spindle | Coolant
  | Traverse | Cut | Probe
  | Dwell | Pause | Comment;

export interface ToolChange {
  kind: "tool-change";
  tool: ToolRef;
  provenance: Provenance;
}

export interface Spindle {
  kind: "spindle";
  state: { mode: "off" } | { mode: "cw" | "ccw"; speed: Rpm };
  provenance: Provenance;
}

export interface Traverse {
  kind: "traverse";
  to: Point3<"work">;
  clearance: ClearanceRequirement;   // "how to get there safely", not "G0"
  provenance: Provenance;
}

export interface Cut {
  kind: "cut";
  path: Path<"work">;
  feed: MmPerMin;                    // ALWAYS present — never inherited
  tolerance: Mm;                     // the chord tolerance this path was built to
  purpose: CuttingPurpose;
  tool: ToolRef;
  provenance: Provenance;
}

export type CuttingPurpose =
  | "rough" | "finish" | "plunge" | "ramp" | "lead-in" | "lead-out";

export interface ClearanceRequirement {
  /** Retract to at least this height before XY motion. */
  safeZ: Mm;
  /** If true, the postprocessor may combine XY and Z into one rapid. */
  allowCoordinated: boolean;
}

export interface Probe {
  kind: "probe";
  direction: UnitVec3;
  maxTravel: Mm;
  feed: MmPerMin;
  onFailure: "abort" | "continue";
  bind: string;                      // name to bind the measured point to
  provenance: Provenance;
}
```

Compare to the prototype's `{ kind, phase, pts, ops }`. The differences:

| Prototype | Canonical IR | Why |
| --- | --- | --- |
| `phase: "rough" \| "finish"` | `purpose` on `Cut` | more cases, typed |
| feed implied by `KIND_SPEED(kind, prm.feed)` | `feed` per command | non-modal |
| `pts: Float32Array` (flat xyz) | `path: Path` (typed segments) | arcs survive |
| `ops` (G-code-flavoured arc ops) | arcs are `Segment`s | post-independent |
| no source link | `provenance` | diagnostics point back to script |
| rapid == `G0` | `Traverse` + clearance | post decides the encoding |

## IV.5 Manufacturing plan (`@cam/planner`)

Above the IR sits the declarative layer the user actually writes.

```ts
export type Operation =
  | FaceOp | PocketOp | ProfileOp | DrillOp
  | RoughSurfaceOp | FinishSurfaceOp | ProbeOp | RawOp;

export interface FinishSurfaceOp {
  kind: "finish-surface";
  target: SurfaceRef;
  tool: ToolRef;
  strategy: StrategySpec;            // discriminated union, see IV.6
  chordTolerance: Mm;
  margin: Mm;
  id: OperationId;                   // stable; provenance points here
}

export interface RoughSurfaceOp {
  kind: "rough-surface";
  target: SurfaceRef;
  tool: ToolRef;
  stepdown: Mm;
  stepover: Ratio;                   // fraction of tool diameter
  stockToLeave: Mm;
  entry: EntrySpec;
  id: OperationId;
}

export interface ManufacturingPlan {
  setup: Setup;                      // stock, part, fixture, work offset
  operations: readonly Operation[];
  tools: ReadonlyMap<ToolId, Tool>;
}
```

A plan is **serialisable JSON**. This is important: it is what gets saved in the
project file, what the script worker returns, and what the compute worker
receives. No functions, no class instances, no typed arrays.

## IV.6 Strategies as plugins (`@cam/strategies`)

DESIGN-01 §23. Each strategy is a self-contained module registered by name.

```ts
export interface PlanningContext {
  readonly geometry: GeometryService;         // mesh access, spatial queries
  readonly signal: AbortSignal;               // cancellation
  progress(fraction: number, note?: string): void;
  /** Memoised: repeated calls with the same args reuse the cached field. */
  cutterLocationField(tool: Tool, bounds: Box2, gridSize: Mm): Promise<CLField>;
}

export interface ToolpathStrategy<P> {
  readonly name: string;
  readonly schema: JSONSchema;                // validates P at the DSL boundary
  plan(ctx: PlanningContext, target: SurfaceRef, params: P): Promise<ToolpathSet>;
}

export function defineStrategy<P>(s: ToolpathStrategy<P>): ToolpathStrategy<P>;
```

The five strategies ported from the prototypes:

| Strategy | Source | Params |
| --- | --- | --- |
| `zlevel-rough` | `dropcut-cam(1).jsx:564-698` | stepdown, stepover, stockToLeave, entry |
| `raster-finish` | `dropcut-cam(1).jsx:762-806` | stepover/scallop, direction, chordTol |
| `hybrid-waterline` | `dropcut-cam(1).jsx:814-902` | scallop, steepAngle |
| `constant-scallop` | `dropcut-cam(1).jsx:904-946` | scallop |
| `rect-pocket` / `face` | `dropcut-ide(1).jsx:236-328` | w, h, depth, stepdown, stepover |

`cutterLocationField` living on the context rather than inside each strategy is
deliberate: hybrid and constant-scallop both need it, and building it costs
seconds. Memoising it on the context lets a plan with both strategies pay once.

## IV.7 Provenance and diagnostics

DESIGN-01 §19 requires diagnostics to point back at the operation that caused
them. Provenance is the chain that makes that possible, and it must be threaded
through every lowering pass.

```ts
export interface Provenance {
  operationId: OperationId;         // which plan operation
  strategyName?: string;            // which strategy produced this
  pathIndex?: number;               // which path within the operation
  segmentIndex?: number;            // which segment within the path
  script?: { line: number; column: number };   // where in the user's source
}

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: Severity;
  code: string;                     // stable, e.g. "travel.exceeded"
  message: string;
  provenance?: Provenance;
  gcodeLine?: number;               // populated after emission
  detail?: Record<string, unknown>; // machine-readable specifics
}
```

The target UX, from DESIGN-01 §19:

```text
finishSurface #2  (script line 34)
  → path 41
    → segment 307
      → exceeds machine X travel by 1.42 mm
```

`script.line` requires mapping DSL calls back to source positions. The cheapest
correct method is to capture `new Error().stack` inside each `job.*` façade
method and parse the frame corresponding to the user's script — the sandbox
compiles the script under a known synthetic filename, so the right frame is
identifiable. This is imperfect across bundlers but adequate, and it degrades to
"no line number" rather than to a wrong one.

## IV.8 Certified stages

DESIGN-01 §13. The prototype enforces "no G-code without validation" with a
runtime `if`; we lift it into the type system so it cannot be bypassed.

```ts
declare const validated: unique symbol;

export interface MachineProgram { /* lowered, not yet checked */ }

export interface ValidatedProgram extends MachineProgram {
  readonly [validated]: true;
  readonly certificate: SafetyCertificate;
}

/** The ONLY function in the codebase that constructs a ValidatedProgram. */
export function validate(p: MachineProgram, scene: Scene):
  | { ok: true;  program: ValidatedProgram }
  | { ok: false; diagnostics: Diagnostic[] };

/** Postprocessors accept nothing else. */
export function emit(p: ValidatedProgram, dialect: Dialect): GCodeDocument;
```

Because `validated` is a non-exported unique symbol, no code outside
`@cam/compiler` can synthesise a `ValidatedProgram` — not even by casting,
without an explicit and greppable `as unknown as`.

This is an API-level proof that the pipeline ran, not a proof of machine safety.
The distinction is the subject of Part X.

## IV.9 Machine profiles (`@cam/machine`)

DESIGN-01 §27: capabilities as data, never `if (machine === "Makera")`.

```ts
export interface MachineProfile {
  id: string;
  name: string;
  axes: readonly ("X" | "Y" | "Z" | "A" | "B" | "C")[];

  travels: Record<"x" | "y" | "z", Range<Mm>>;
  rapidRate: MmPerMin;
  maxFeed: MmPerMin;

  spindle: { range: Range<Rpm>; directions: readonly ("cw" | "ccw")[] };

  interpolation: {
    linear: true;
    arcXY: boolean; arcXZ: boolean; arcYZ: boolean;
    helical: boolean;
  };

  rapidSemantics: "coordinated" | "axis-independent";
  toolChange: "manual" | "automatic";
  coordinateSystems: readonly string[];       // ["G54", ...]
  probe: { kind: "g38" } | { kind: "g31" } | null;

  dialect: DialectId;                          // which postprocessor
}
```

Two concrete profiles, both grounded in the prototypes and the sample file:

```ts
export const xyz3018: MachineProfile = {          // dropcut-ide(1).jsx:31-36
  id: "xyz-3018", name: "XYZ-3018 · 3-axis", axes: ["X","Y","Z"],
  travels: { x: range(mm(-5), mm(300)), y: range(mm(-5), mm(180)),
             z: range(mm(-80), mm(40)) },
  rapidRate: mmPerMin(3000), maxFeed: mmPerMin(3000),
  spindle: { range: range(rpm(3000), rpm(24000)), directions: ["cw","ccw"] },
  interpolation: { linear: true, arcXY: true, arcXZ: true, arcYZ: true, helical: false },
  rapidSemantics: "axis-independent",
  toolChange: "manual", coordinateSystems: ["G54"], probe: null,
  dialect: "rs274",
};

export const makeraZ1: MachineProfile = {         // z1-gcode-checker-l2.jsx:27-31
  id: "makera-z1", name: "MAKERA Z1", axes: ["X","Y","Z"],           //  + MakeraBadge.nc
  travels: { x: range(mm(0), mm(200)), y: range(mm(0), mm(200)),
             z: range(mm(-100), mm(0)) },
  rapidRate: mmPerMin(3000), maxFeed: mmPerMin(3000),
  spindle: { range: range(rpm(0), rpm(13000)), directions: ["cw"] },
  interpolation: { linear: true, arcXY: true, arcXZ: false, arcYZ: false, helical: false },
  rapidSemantics: "axis-independent",
  toolChange: "manual", coordinateSystems: ["G54"], probe: null,
  dialect: "makera",
};
```

**Where the Z1 numbers come from.** Travel and RPM are from the checker
prototype's `Z1` constant. `arcXZ: false`/`arcYZ: false` is from the checker's
warning that only G17 arcs are supported (`z1-gcode-checker-l2.jsx:144`). The
supported-code sets `KNOWN_G` and `KNOWN_M` (lines 33–34) become a
`supportedCodes` field used by the parser to flag unknown words.

## IV.10 Tools

```ts
export type ToolGeometry =
  | { type: "flat"; diameter: Mm }
  | { type: "ball"; diameter: Mm }
  | { type: "vbit"; diameter: Mm; tipDiameter: Mm; includedAngle: Degrees }
  | { type: "bull"; diameter: Mm; cornerRadius: Mm };

export interface Tool {
  id: ToolId;
  number: number;                 // T-word
  name: string;
  geometry: ToolGeometry;
  fluteLength?: Mm;
  shankDiameter?: Mm;
  stickout?: Mm;                  // needed for holder-collision checks later
}

/** Height of the cutter surface above the tip, at radial distance r.
 *  Returns null outside the cutter. Ported from z1-gcode-checker-l2.jsx:272. */
export function profile(g: ToolGeometry, r: Mm): Mm | null;
```

`bull` (a flat mill with a corner radius) is not in the prototypes but is in the
Makera tool table (`cornerradius=0` implies the field exists), and adding it now
costs one case in `profile`.

---

# PART V — Redux state design

This is where most React/Redux CAM applications go wrong, so it gets its own
part. The failure mode is predictable: someone puts the toolpath in the store,
the store serialises a 6-million-element `Float32Array` on every action, Redux
DevTools locks up, and the app becomes unusable at exactly the scale where it
needs to work.

## V.1 The three-tier rule

Every piece of state in Studio belongs to exactly one of three tiers.

```text
 ┌───────────────────────────────────────────────────────────────────┐
 │ TIER 1 — Redux store                                              │
 │ Serialisable, undoable, inspectable, small.                       │
 │   · the project document (script text, setup, tools, machine id)  │
 │   · UI state (active tab, panel sizes, selection)                 │
 │   · compile *results as summaries* (counts, stats, diagnostics)   │
 │   · job status (idle/running/done/error + progress fraction)      │
 └───────────────────────────────────────────────────────────────────┘
 ┌───────────────────────────────────────────────────────────────────┐
 │ TIER 2 — Artifact cache (module-level Map, keyed by hash)         │
 │ Big, immutable, not serialisable, not in Redux.                   │
 │   · CanonicalProgram, MachineProgram, ValidatedProgram            │
 │   · Float32Array position/kind/time buffers                       │
 │   · heightmap simulation grids                                    │
 │   · parsed mesh + spatial index                                   │
 └───────────────────────────────────────────────────────────────────┘
 ┌───────────────────────────────────────────────────────────────────┐
 │ TIER 3 — Imperative refs                                          │
 │ Mutated at 60 Hz, never triggers a React render.                  │
 │   · Three.js scene, camera, renderer, meshes                      │
 │   · playback clock (current time, playing flag, speed)            │
 │   · DRO text nodes (written via ref.textContent)                  │
 └───────────────────────────────────────────────────────────────────┘
```

The bridge between tiers 1 and 2 is a **content hash**. Redux stores
`artifactId: "sha256:ab12…"`; the cache stores the actual object. Components ask
the cache for the artifact named by the id. When the id changes, the viewport
rebuilds; when it does not, nothing happens even if unrelated state changed.

The prototypes already discovered tier 3 empirically. `dropcut-cam(1).jsx` writes
the DRO with `droX.current.textContent = fmt(x)` inside the rAF loop
(lines 1570–1574) rather than with `setState`, precisely because 60 Hz React
renders of a three-digit number are absurd. Make that a rule instead of a trick.

## V.2 Slices

Six slices, using Redux Toolkit's `createSlice`.

```text
store
├── project      the saved document — what a .dropcut file contains
│   ├── script:        string
│   ├── setup:         { stock, partSource, workOffset, clearance }
│   ├── tools:         Record<ToolId, Tool>
│   ├── machineId:     string
│   └── meta:          { name, created, modified }
├── compile      the result of running script → validated program
│   ├── status:        "idle" | "running" | "ok" | "failed"
│   ├── artifactId:    string | null       → tier 2 lookup key
│   ├── diagnostics:   Diagnostic[]
│   ├── stats:         { lines, cutLenMm, rapidLenMm, estSeconds, arcCount, … }
│   ├── irSummary:     IrRow[]             → the "Canonical IR" tab
│   └── gcodePreview:  { lines: string[]; motionOf: (number|null)[] }
├── simulation   material removal + deviation
│   ├── status:        "idle" | "running" | "done"
│   ├── artifactId:    string | null
│   └── stats:         { minDev, maxDev, rms, pctInTolerance, band }
├── playback     transport UI state ONLY (not the 60 Hz clock)
│   ├── playing:       boolean
│   ├── speed:         number
│   ├── scrubFraction: number              → written on pointerup, not per frame
│   └── activeGcodeLine: number | null     → throttled to ~10 Hz
├── viewport     display preferences
│   ├── show:          { part, stock, toolpath, rapids, simulation, deviation }
│   ├── view:          "iso" | "top" | "front" | "right"
│   └── colorBy:       "purpose" | "depth" | "deviation" | "tool"
└── ui           chrome
    ├── bottomTab:     "gcode" | "ir" | "diagnostics" | "stats"
    ├── panelSizes:    { editor: number; bottom: number }
    └── selection:     { operationId?: string; gcodeLine?: number }
```

`project` is the only slice that is persisted and undoable. That is a deliberate
simplification: undoing a compile makes no sense — recompiling from an undone
script does.

## V.3 What must never enter the store

| Value | Size | Where it lives instead |
| --- | --- | --- |
| `Float32Array` of positions | up to ~24 MB | artifact cache |
| `Uint8Array` of move kinds | up to ~2 MB | artifact cache |
| Heightmap grid | ~1–4 MB | artifact cache |
| Parsed mesh + spatial index | 10–100 MB | artifact cache |
| `THREE.Scene` and children | — | ref |
| Current playback time | changes at 60 Hz | ref |
| Compiled `Path` objects | large object graph | artifact cache |

RTK's `serializableCheck` and `immutableCheck` middleware will scream if any of
these land in the store. **Leave both enabled in development.** They are the
enforcement mechanism for this rule, and disabling them to "make the warning go
away" is how the failure mode starts.

## V.4 The compile pipeline as a thunk

```ts
// src/state/compileThunk.ts
export const compile = createAsyncThunk<CompileSummary, void, { state: RootState }>(
  "compile/run",
  async (_, { getState, dispatch, signal, rejectWithValue }) => {
    const { script, setup, tools, machineId } = getState().project;

    // 1. Run the user's script in the sandbox worker → a serialisable plan.
    const planResult = await scriptHost.run(script, { setup, tools, signal });
    if (!planResult.ok) return rejectWithValue(planResult.diagnostics);

    // 2. Plan toolpaths in the compute pool. Progress streams back as actions.
    const toolpaths = await computePool.plan(planResult.plan, {
      signal,
      onProgress: (f, note) => dispatch(compileProgress({ fraction: f, note })),
    });

    // 3–5. Lower, validate, emit. Cheap relative to planning; main thread is fine.
    const machine   = machineRegistry.get(machineId);
    const canonical = link(entry(clearance(refine(toolpaths))));
    const lowered   = lower(canonical, machine);
    const checked   = validate(lowered, sceneFrom(setup));
    if (!checked.ok) return rejectWithValue(checked.diagnostics);

    const gcode = emit(checked.program, machine.dialect);

    // 6. Park the big artifacts in the cache; return only summaries to Redux.
    const artifactId = artifactCache.put({
      canonical, program: checked.program, gcode,
      buffers: flattenForRender(checked.program),
    });

    return {
      artifactId,
      diagnostics: checked.program.certificate.warnings,
      stats: summarise(gcode, checked.program),
      irSummary: canonical.commands.map(describeForUi),
      gcodePreview: { lines: gcode.lines.map(l => l.text),
                      motionOf: gcode.lines.map(l => l.motionIndex) },
    };
  },
);
```

Notes on this shape:

- **`signal` comes free.** `createAsyncThunk` provides an `AbortSignal` and
  `dispatch(compile()).abort()` cancels. This replaces the prototypes'
  `cancelRef.current` boolean polling (`dropcut-cam(1).jsx:1399`, checked at
  lines 323, 587, 789 …).
- **Progress is a separate action**, dispatched at a throttled rate (≤10 Hz).
  Do not dispatch per-row.
- **Only the last step touches Redux with data**, and that data is all small.

## V.5 Selectors

```ts
export const selectHasErrors = (s: RootState) =>
  s.compile.diagnostics.some(d => d.severity === "error");

export const selectCanExport = (s: RootState) =>
  s.compile.status === "ok" && !selectHasErrors(s);

/** Diagnostics grouped by source line, for editor gutter markers. */
export const selectDiagnosticsByLine = createSelector(
  [(s: RootState) => s.compile.diagnostics],
  (diags) => {
    const m = new Map<number, Severity>();
    for (const d of diags) {
      const line = d.provenance?.script?.line;
      if (line == null) continue;
      const prev = m.get(line);
      if (prev !== "error") m.set(line, d.severity);   // error wins
    }
    return m;
  },
);
```

That last selector is the checker prototype's `issuesByLine`
(`z1-gcode-checker-l2.jsx:939-945`) generalised — same "error beats warning"
precedence rule.

## V.6 Middleware

Three custom middlewares carry real weight:

1. **`autoCompileMiddleware`** — debounces `project/scriptChanged` by 600 ms and
   dispatches `compile()`, cancelling any in-flight compile first. 600 ms is the
   prototype's value (`dropcut-ide(1).jsx:1306`) and it feels right: fast enough
   to be live, slow enough not to compile mid-identifier.
2. **`persistMiddleware`** — writes the `project` slice to IndexedDB on change,
   throttled to 2 s. IndexedDB rather than `localStorage` because meshes are
   large and `localStorage` is synchronous and size-capped.
3. **`artifactGcMiddleware`** — evicts cache entries whose `artifactId` no longer
   appears in any slice. Without this, every keystroke-triggered recompile leaks
   a toolpath buffer.

`redux-undo` wraps only the `project` reducer, with `filter` set to ignore
transient actions and `groupBy` set to coalesce consecutive script edits within
~1 s into a single undo entry.

## V.7 Why not just `useState`, or Zustand, or Jotai?

Worth stating explicitly because the question will come up:

- The state is **document-shaped** — a project that is loaded, mutated, undone,
  saved. That is Redux's core competency.
- The **cross-cutting derivations** (diagnostics → editor gutters *and* the
  diagnostics tab *and* the export button's enabled state) are what selectors
  are for.
- **Time-travel debugging is genuinely useful here.** When a compile produces
  wrong G-code, replaying the exact action sequence that produced it is the
  fastest route to a repro.
- The tier-2/tier-3 escape hatches mean Redux's serialisability constraint costs
  us nothing, because the things that violate it were never going to live in a
  store anyway.

---

# PART VI — The compute layer

## VI.1 The problem with the prototypes

All three prototypes run everything on the main thread. `dropcut-cam` mitigates
this with cooperative yielding:

```js
// dropcut-cam(1).jsx:695-696, and the same pattern at 322, 799, 857, 900, 943, 1232, 1270
onProgress(0.3 * ((li + 1) / levels.length));
await new Promise((r) => setTimeout(r, 0));
```

This keeps the browser technically responsive but has three problems: the yields
are placed by hand and unevenly (every 8 rows here, every 3 rows there, every
3,000 points elsewhere); `setTimeout(0)` is clamped to ~4 ms in nested timers, so
frequent yields dominate runtime; and the UI still stutters because the work
between yields can be tens of milliseconds.

## VI.2 The worker pool

```ts
// src/compute/pool.ts
export interface ComputeJob<Req, Res> {
  op: string;                 // "plan" | "simulate" | "arcfit" | "parse"
  payload: Req;
  transfer?: Transferable[];
}

export class ComputePool {
  constructor(size = Math.max(1, Math.min(4, navigator.hardwareConcurrency - 1)));

  run<Req, Res>(job: ComputeJob<Req, Res>, opts: {
    signal?: AbortSignal;
    onProgress?: (fraction: number, note?: string) => void;
  }): Promise<Res>;
}
```

Protocol on the wire, one message shape in each direction:

```ts
// main → worker
type ToWorker =
  | { t: "run"; id: number; op: string; payload: unknown }
  | { t: "cancel"; id: number };

// worker → main
type FromWorker =
  | { t: "progress"; id: number; fraction: number; note?: string }
  | { t: "done"; id: number; result: unknown }
  | { t: "error"; id: number; message: string; stack?: string };
```

Cancellation inside the worker uses a `SharedArrayBuffer` flag when cross-origin
isolation is available (an atomic read costs nothing in a hot loop), and falls
back to checking a message-set boolean at the same yield points the prototypes
already have. Do not require `SharedArrayBuffer` — the COOP/COEP headers it needs
break embedding.

## VI.3 Transferables

The result of planning is typed arrays. Transfer them; do not clone them.

```ts
// in the worker, on completion
const positions = new Float32Array(n * 3);
const kinds     = new Uint8Array(n);
const times     = new Float64Array(n);
self.postMessage(
  { t: "done", id, result: { positions, kinds, times, n } },
  [positions.buffer, kinds.buffer, times.buffer],   // ← zero-copy
);
```

A 200,000-point job is 2.4 MB of positions. Structured-clone would copy it;
transfer moves it. The arrays become unusable in the worker afterwards, which is
correct — the worker is done with them.

**Corollary for the data model:** the boundary between planner and renderer must
be typed arrays, not object graphs. `Path` objects with `Point3` members are the
right *authoring* representation and the wrong *transport* representation. The
compiler therefore has an explicit `flattenForRender(program) → RenderBuffers`
step, which is the prototype's flattening loop (`dropcut-cam(1).jsx:970-996`)
kept as a distinct, testable pass rather than fused into generation.

## VI.4 Progress and time estimation

Progress fractions in the prototype are hand-tuned magic numbers: roughing owns
0→0.3, CL field 0.3→0.42, hybrid raster 0.42→0.64, waterline 0.64→0.8, and so on
(`dropcut-cam(1).jsx:695, 811, 857, 900, 943`). Replace this with a weighted
progress tree:

```ts
const progress = tree([
  { key: "rough",    weight: 3 },
  { key: "clfield",  weight: 1 },
  { key: "finish",   weight: 5 },
  { key: "arcfit",   weight: 1 },
]);
progress.child("finish").report(0.42);   // → overall 0.3 + 0.5*0.42
```

Weights can be tuned from measured runs, and the arithmetic lives in one place
instead of being scattered across seven call sites.

---

# PART VII — The scripting IDE

## VII.1 Threat model

The user's script is *untrusted in the security sense* even when the user is
trusting themselves, because scripts get shared, pasted from forums, and
generated by LLMs. The prototype's `new Function(...)` on the main thread gives
that script:

- full DOM access (`document.cookie`, injecting elements, reading the page);
- network access (`fetch`, `XMLHttpRequest`, `WebSocket`);
- storage access (`localStorage`, IndexedDB);
- the ability to hang the tab with `while(true){}`.

None of these are needed to describe a machining job.

## VII.2 The sandbox

```text
 ┌──────────── main thread ─────────────┐
 │  editor  ──script text──►            │
 │                     scriptHost.run() │
 └───────────────┬──────────────────────┘
                 │ postMessage
                 ▼
 ┌───────── script worker (module worker) ──────────┐
 │  · no DOM by construction (workers have none)    │
 │  · fetch/XHR/WebSocket deleted from globalThis   │
 │  · importScripts deleted                         │
 │  · a hard watchdog: terminate() after N seconds  │
 │  · executes:  new Function(...capabilityNames,   │
 │                            '"use strict";' + src)│
 │  · returns:   ManufacturingPlan (plain JSON)     │
 │               + diagnostics + provenance         │
 └──────────────────────────────────────────────────┘
```

Worker setup:

```ts
// src/script-host/worker.ts
for (const k of ["fetch", "XMLHttpRequest", "WebSocket", "importScripts",
                 "indexedDB", "caches", "Notification"]) {
  try { delete (globalThis as any)[k]; } catch { /* non-configurable: shadow below */ }
}

self.onmessage = (e) => {
  const { src, setup, tools } = e.data;
  const api = buildCapabilityApi({ setup, tools });     // job, tools, p, mm, rpm, …
  try {
    const fn = new Function(...Object.keys(api), '"use strict";\n' + src);
    fn(...Object.values(api));
    self.postMessage({ ok: true, plan: api.__plan(), diagnostics: api.__diags() });
  } catch (err) {
    self.postMessage({ ok: false, diagnostics: [toDiagnostic(err)] });
  }
};
```

The watchdog lives on the main thread: start a timer when the run begins, and
`worker.terminate()` plus spawn a replacement if it expires. **This is the only
reliable way to stop a runaway script** — there is no way to interrupt
synchronous JavaScript from inside.

Two honest limitations to write down:

- `delete globalThis.fetch` is defence in depth, not a security boundary. A
  determined script can reach things through prototype chains. For real
  isolation, serve the worker from a sandboxed `<iframe>` on a null origin and
  talk to it over `postMessage`. That is a Phase-2 hardening item, recorded in
  Part XV.
- A script can still allocate until the tab OOMs. The watchdog does not help
  with that. Accepted risk.

## VII.3 The DSL surface

Carried over from `dropcut-ide(1).jsx` with the additions the design needs.

```ts
// ─── units (boxed at runtime so brands survive) ───────────────────────────
mm(n) · inch(n) · rpm(n) · mmPerMin(n) · deg(n) · percent(n)
p(x, y, z)                       // → Point3<"work">

// ─── tools ────────────────────────────────────────────────────────────────
tools.flatEndMill({ name, diameter, fluteLength? })
tools.ballEndMill({ name, diameter, fluteLength? })
tools.vBit({ name, diameter, tipDiameter, includedAngle })
tools.bullNose({ name, diameter, cornerRadius })

// ─── geometry ─────────────────────────────────────────────────────────────
geometry.box({ x, y, z })
geometry.mesh(source)            // STL by name from the project's assets
geometry.heightfield(fn, { half, n })   // the PRESETS mechanism, exposed
geometry.sketch()                 .rect(w,h) .circle(d) .roundedRect(w,h,r)
                                  .extrude(depth) .pocket({ depth })

// ─── setup ────────────────────────────────────────────────────────────────
job.setup({ stock, part?, clearance, workOffset? })
job.toolChange(tool)
job.comment(text)

// ─── scope combinators ────────────────────────────────────────────────────
job.withSpindle({ speed, dir? }, body)
job.withTool(tool, body)
job.withCoolant("flood" | "mist", body)

// ─── 2.5D operations ──────────────────────────────────────────────────────
job.face({ x, y, w, h, z, stepover, feed })
job.rectPocket({ x, y, w, h, depth, stepdown, stepover, feed, plungeFeed? })
job.profile({ path, depth, stepdown, side: "inside"|"outside"|"on", feed })
job.drill({ points, depth, peck?, feed })

// ─── 3D surface operations ────────────────────────────────────────────────
job.roughSurface({ target, tool, stepdown, stepover, stockToLeave, entry })
job.finishSurface({ target, tool, strategy, chordTolerance, margin })

strategy.raster({ direction: "X"|"Y", scallop? , stepover? })
strategy.hybridWaterline({ scallop, steepAngle })
strategy.constantScallop({ scallop })
entry.auto({ maxRampAngle }) · entry.ramp({ angle }) · entry.plunge()

// ─── canonical escape hatch ───────────────────────────────────────────────
job.canonical(({ move, spindle, dwell }) => {
  spindle.cw(rpm(12000));
  move.traverseTo(p(mm(0), mm(0), mm(5)));
  move.feedTo(p(mm(0), mm(0), mm(-1)), mmPerMin(300));
  move.arcTo(p(mm(10), mm(0), mm(-1)), { center: p(mm(5), mm(0), mm(-1)), dir: "cw" });
});

// ─── raw escape hatch — explicitly unanalysable ───────────────────────────
job.raw("M64 P0", { effects: ["digital-output"] });
```

Design points worth defending:

- **`job.raw` is deliberately ugly.** It requires declaring `effects` so the
  verifier knows it cannot fully analyse the program, and its presence
  downgrades the safety certificate. DESIGN-01 §26.
- **Bare numbers warn, they do not error.** A first-time user typing
  `diameter: 4` should get a working program and a yellow note, not a red wall.
- **Strategies are values, not strings.** `strategy.constantScallop({...})`
  returns a validated spec object, so a typo is caught where it is written
  rather than deep inside the planner.

## VII.4 The editor

Replace the textarea-plus-overlay (`dropcut-ide(1).jsx:661-788`) with
**CodeMirror 6**. Not Monaco: Monaco is ~2 MB gzipped and brings its own worker
architecture that would fight ours; CodeMirror 6 is ~150 KB, tree-shakeable, and
has a first-class extension API.

Extensions required:

| Extension | Purpose | Source |
| --- | --- | --- |
| `@codemirror/lang-javascript` | syntax, brackets, indentation | stock |
| `@codemirror/lint` | diagnostics in the gutter and as squiggles | fed by `selectDiagnosticsByLine` |
| `@codemirror/autocomplete` | completion for the `job.*` / `tools.*` API | custom source from the API schema |
| `hoverTooltip` | parameter docs on hover | custom, from the same schema |
| custom decoration | highlight the line whose motion is currently playing | driven by a ref, not by React state |

The autocomplete source is generated from the same JSON Schema objects the
strategies register (`ToolpathStrategy.schema`), so the editor's completions
cannot drift from what the planner accepts. That is worth the small amount of
plumbing.

**Playback highlighting must not go through Redux.** The active line changes tens
of times a second during playback. Use a CodeMirror `StateEffect` dispatched from
the rAF loop directly, and throttle the *Redux* copy of `activeGcodeLine` to
~10 Hz for the benefit of components that genuinely need it.

## VII.5 Bidirectional navigation

The prototype's `motion ↔ gcode line` link (`dropcut-ide(1).jsx:374, 434, 618`)
generalises into a four-way map that the UI wires up once:

```text
   script line  ◄──provenance──►  operation
        ▲                             │
        │                             ▼
   diagnostic  ◄─────────────►   IR command
                                      │
                                      ▼
                                 motion index ◄──►  G-code line
                                      │
                                      ▼
                              3D toolpath segment
```

Concretely, this buys four interactions that make the tool feel finished:

- Click a G-code line → seek playback to that motion (prototype: 1524–1526).
- Play → the G-code line highlights and scrolls into view (1313–1317).
- Click a diagnostic → jump to the script line that caused it.
- Click a toolpath segment in 3D → select the operation and highlight its script.

Only the first two exist today. The other two fall out of provenance for free.

---

# PART VIII — The 3D viewport

## VIII.1 The imperative shell pattern

React and a 60 Hz WebGL renderer have incompatible update models. The rule:

> **React owns the DOM node. The renderer owns everything inside it. They
> communicate through an imperative handle, never through props on the hot
> path.**

```tsx
export function Viewport() {
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef  = useRef<ViewportApi | null>(null);

  // Mount once. Never re-runs.
  useEffect(() => {
    apiRef.current = createViewport(hostRef.current!);
    return () => apiRef.current!.dispose();
  }, []);

  // Coarse-grained, low-frequency syncs — each keyed on an id or a small object.
  const artifactId = useSelector((s: RootState) => s.compile.artifactId);
  useEffect(() => { apiRef.current?.setToolpath(artifactCache.get(artifactId)); },
            [artifactId]);

  const show = useSelector((s: RootState) => s.viewport.show, shallowEqual);
  useEffect(() => { apiRef.current?.setVisibility(show); }, [show]);

  return <div ref={hostRef} className="viewport" />;
}
```

All three prototypes already do this — see the `threeRef`/`three` ref objects at
`dropcut-cam(1).jsx:1467`, `dropcut-ide(1).jsx:807`,
`z1-gcode-checker-l2.jsx:430`. We are formalising an existing pattern, not
inventing one.

## VIII.2 The API surface

```ts
export interface ViewportApi {
  setPart(mesh: MeshData | null): void;
  setStock(stock: StockDef | null): void;
  setToolpath(buffers: RenderBuffers | null): void;
  setSimulation(grid: HeightGrid | null, mode: "material" | "deviation"): void;
  setVisibility(v: Record<LayerName, boolean>): void;
  setColorMode(m: "purpose" | "depth" | "deviation" | "tool"): void;

  /** Playback — driven by the rAF loop, never by React. */
  seek(seconds: number): void;
  play(): void;  pause(): void;  setSpeed(x: number): void;

  /** Notifications out. Throttle before dispatching to Redux. */
  onActiveMotion(cb: (motionIndex: number, gcodeLine: number | null) => void): () => void;
  onPick(cb: (hit: { operationId: string; segmentIndex: number } | null) => void): () => void;

  view(named: "iso" | "top" | "front" | "right"): void;
  frameAll(): void;
  dispose(): void;
}
```

## VIII.3 Coordinate convention

Pick one and enforce it. **Z-up, matching machine coordinates**, as
`dropcut-cam(1).jsx:1480` and `z1-gcode-checker-l2.jsx:438` do with
`camera.up.set(0, 0, 1)`.

Do *not* follow `dropcut-ide(1).jsx:1043`, which keeps Three's default Y-up and
remaps every point on insertion with `v3 = (x,y,z) => new Vector3(x, z, -y)`.
That mapping has to be remembered at every single call site, and the moment one
is missed the geometry is silently wrong in a way that looks plausible.

## VIII.4 Rendering the toolpath

Three `LineSegments` objects sharing one interleaved buffer, distinguished by
draw range or by material:

```text
  rapids      dashed, amber/blue, low opacity   ← LineDashedMaterial
  rough cuts  flat grey-blue                    ← LineBasicMaterial
  finish cuts vertex-coloured by Z or deviation ← LineBasicMaterial{vertexColors}
  trail       bright white, drawRange-clipped   ← the "already executed" overlay
```

The **trail** is the neatest trick in the prototypes
(`dropcut-ide(1).jsx:1123-1130, 972-980`): build one `Line` over every point in
order, set `drawRange(0, 0)`, and advance the count as playback progresses. No
geometry is rebuilt during playback; a single integer changes per frame.

For very large programs (`MakeraBadge.nc` is 18,231 motion blocks) plain
`LineSegments` with 1-pixel lines is still the right default —
`Line2`/`LineMaterial` gives thick lines but costs 4× the vertices. Offer thick
lines as a preference, not a default.

## VIII.5 Playback clock

```ts
// Inside the viewport module. No React, no Redux, no allocation per frame.
const clock = { t: 0, playing: false, speed: 8 };

function frame(now: number) {
  const dt = (now - prev) / 1000; prev = now;
  if (clock.playing) {
    clock.t = Math.min(clock.t + dt * clock.speed, total);
    if (clock.t >= total) clock.playing = false;
  }
  const { position, motionIndex } = sampleAt(clock.t);   // binary search
  toolMarker.position.set(position.x, position.y, position.z);
  writeDro(position);                                     // ref.textContent
  trail.geometry.setDrawRange(0, pointsBefore(motionIndex));
  if (motionIndex !== lastMotion) { lastMotion = motionIndex; notify(motionIndex); }
  renderer.render(scene, camera);
  raf = requestAnimationFrame(frame);
}
```

`sampleAt` is the binary search over cumulative time that all three prototypes
implement (`dropcut-cam(1).jsx:1562-1568`, `dropcut-ide(1).jsx:920-953`,
`z1-gcode-checker-l2.jsx:752-776`). Write it once, test it once:

```ts
/** Find the motion active at time t, and interpolate within it. */
function sampleAt(t: Seconds): { position: Vec3; motionIndex: number } {
  let lo = 0, hi = motions.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (motions[mid].t1 < t) lo = mid + 1; else hi = mid;
  }
  const m = motions[lo];
  const f = (t - m.t0) / Math.max(m.t1 - m.t0, 1e-9);
  return { position: interpolateAlong(m, f), motionIndex: lo };
}
```

Edge cases the tests must cover, all of which the prototypes get right and which
are easy to get wrong on a rewrite: `t` before the first motion, `t` after the
last, zero-duration motions (a `dwell`, or a move of zero length), and a program
with no motions at all.

---

# PART IX — The algorithms

This part explains the mathematics that the strategies implement. You can build
the application skeleton without reading it, but you cannot port the strategies
without it. Each section says where the reference implementation lives.

## IX.1 The drop-cutter evaluator

**Reference:** `dropcut-cam(1).jsx:203-309` (`makeEvaluator`), with helpers
`pointInTri:175` and `edgeBall:184`.

**Problem.** Given a tool at `(X, Y)`, lowered along −Z onto a triangle mesh, find
the tip height at first contact.

The answer is the maximum over all triangles of the contact height with that
triangle, and contact with a single triangle decomposes into three cases. For a
**ball nose** of radius `R`, working in terms of the sphere centre height:

**Case 1 — sphere touches a vertex.** For vertex `v = (vx, vy, vz)` at planar
distance `d` from the tool axis, the sphere centre sits at

$$z_c = v_z + \sqrt{R^2 - d^2}, \qquad d^2 = (v_x - X)^2 + (v_y - Y)^2 < R^2.$$

```js
// dropcut-cam(1).jsx:234-236
let dx = ax - X, dy = ay - Y, d2 = dx*dx + dy*dy;
if (d2 < R2) { const z = az + Math.sqrt(R2 - d2); if (z > best) best = z; }
```

**Case 2 — sphere touches an edge.** This is `edgeBall` (line 184) and is the
subtlest of the three. Project the tool axis onto the edge; if the perpendicular
distance `dperp ≥ R` there is no contact. Otherwise the sphere can touch anywhere
within `±rp = sqrt(R² − dperp²)` of the projection. Along that interval the edge
rises with slope `m`, so the contact parameter that maximises the centre height
is found by differentiating

$$z_c(s) = z_f + m s + \sqrt{r_p^2 - s^2}$$

giving the stationary point

$$s^\* = \frac{m\,r_p}{\sqrt{1 + m^2}},$$

then clamping `s*` to the portion of the interval that lies within the edge's
extent.

```js
// dropcut-cam(1).jsx:198-200
let s = (m * rp) / Math.sqrt(1 + m * m);
s = Math.min(Math.max(s, sLo), sHi);          // clamp to the edge's extent
return zf + m * s + Math.sqrt(Math.max(0, rp * rp - s * s));
```

**Case 3 — sphere touches the triangle's interior.** For a plane `z = Ax + By +
C`, the sphere resting on it has its centre offset laterally by
`R·(A, B)/√(1+A²+B²)`. If that offset point lands inside the triangle, the
contact is valid and the centre height is `AX + BY + C + R√(1+A²+B²)`.

```js
// dropcut-cam(1).jsx:250-255
const gl = Math.sqrt(1 + A*A + B*B);
const px = X + (R*A)/gl, py = Y + (R*B)/gl;
if (pointInTri(px, py, ax,ay, bx,by, cx,cy)) {
  const Zc = A*X + B*Y + C + R*gl;
  if (Zc > best) best = Zc;
}
```

Finally `return best - R` converts sphere-centre height to tip height (line 307).

For a **flat** end mill the three cases become: vertex inside the tool disc
(contact at the vertex height); edge crossing the disc boundary (solve the
quadratic for the crossing parameter, take the higher end); and plane under the
disc (evaluate at the disc's uphill rim, plus the centre point in case the whole
disc is inside the triangle).

**Complexity.** `O(k)` per query where `k` is the number of triangles within `R`
of the query point — hence the spatial grid. The grid cell size is
`max(R, diag/256, 0.25)` (line 150), sized so that a query touches roughly a 3×3
cell neighbourhood.

**Port note.** This function is called millions of times. Keep it monomorphic:
no polymorphic tool objects in the inner loop, no allocation, flat typed arrays
only. The prototype's structure is already right; do not "clean it up" into
something object-oriented.

## IX.2 The cutter-location field

**Reference:** `dropcut-cam(1).jsx:313-352` (`buildCLField`, `bilin`).

Sampling `evalTipZ` on a regular grid produces two fields:

- `F[i,j]` — the CL height, i.e. the surface the tool tip must follow.
- `G[i,j]` — `|∇F|`, the local slope magnitude, by central differences.

`G` is what distinguishes *shallow* from *steep* regions, and it drives both the
hybrid strategy's region split and the constant-scallop speed function.

```text
   F (CL heights)                 G = |grad F| (slope)
   ┌───────────────┐              ┌───────────────┐
   │   ▁▂▃▅▆▇█▇▆▅  │              │  ░░▒▓██▓▒░░   │  steep flanks bright
   │  ▂▃▅▆▇███▇▆▅  │   ──∇──►     │ ░▒▓██  ██▓▒░  │  flat top and floor dark
   │   ▁▂▃▅▆▇▆▅▃▂  │              │  ░░▒▓██▓▒░░   │
   └───────────────┘              └───────────────┘
```

Grid spacing is `gs = clamp(s0, 0.25, 0.6)` mm (line 809) — tied to the stepover,
so finer finishes get finer fields. This is a heuristic and it belongs in the
error budget (Part X.2).

## IX.3 Marching squares and contour chaining

**Reference:** `dropcut-cam(1).jsx:356-431`.

Standard marching squares: classify the four corners of each cell against the
iso-level into a 4-bit code, look up which cell edges the contour crosses, and
linearly interpolate the crossing point.

```text
     v01 ────────── v11        code = (v00>0) | (v10>0)<<1
      │              │                | (v11>0)<<2 | (v01>0)<<3
      │      ·       │
      │              │         16 cases; 2 of them (5 and 10) are
     v00 ────────── v10        ambiguous saddles
```

The saddle cases 5 and 10 are resolved with the cell-centre average
(lines 382–391): if the average is above the level, connect one way; if below,
the other. Getting this wrong produces contours that cross themselves.

Chaining segments into polylines uses a hash of quantised endpoints:

```js
// dropcut-cam(1).jsx:397
const key = (x, y) => `${Math.round(x * 256)},${Math.round(y * 256)}`;
```

Quantising to 1/256 mm is a tolerance decision hiding in a string key. Two
endpoints that should join but differ by more than ~0.004 mm will not chain,
leaving a spurious gap. **Port note:** replace the string key with an integer
key into a `Map<number, ...>` (pack the two quantised coordinates into a single
number) and make the quantum an explicit named constant, so this tolerance is
visible and tunable.

## IX.4 Roughing: Z-level scanline clearing with union-find

**Reference:** `dropcut-cam(1).jsx:564-698`.

For each Z level, from the top down:

```text
FOR each level z in [maxZ - stepdown, ..., floorZ + allowance]:
    # 1. Find, per scanline, the intervals where the inflated surface is below z
    FOR each scanline row j:
        walk along the row in steps of da
        evaluate the INFLATED CL surface (tool radius + allowance)
        record intervals where surface <= z
        refine each interval boundary with 5 bisection steps

    # 2. Union intervals that overlap between adjacent rows
    FOR each interval iv in row j:
        assign it a fresh union-find id
        FOR each interval pv in row j-1:
            IF iv and pv overlap in the scan direction: union(iv, pv)

    # 3. Each connected component is a separate pocket; machine each in turn
    FOR each component, ordered by its topmost row:
        boustrophedon: alternate scan direction row by row
        FOR each interval, in order:
            IF it is the first cut of this component:
                rapid to clearance, descend, emitEntry(...)
            ELSE:
                d = distance from the current position
                IF d < 4 * rowStep AND the straight link stays below z:
                    stay down: cut across to the new start
                ELSE:
                    sample the surface along the link, retract to a local
                    safe height, rapid across, descend, emitEntry(...)
            cut to the interval's far end
        retract to clearance
```

Three details worth naming:

- **Surface inflation.** Roughing evaluates against a tool inflated by the
  allowance (`inflTool` at line 566, `evalA = rawEval(x,y) + al` at line 569) —
  a mathematically clean way to leave stock: grow the tool, and the resulting CL
  surface is offset outward by exactly the allowance.
- **Bisection refinement** (lines 608–612) finds interval boundaries to ~1/32 of
  the coarse step with five halvings, so pocket walls are accurate without
  sampling the whole row finely.
- **Union-find with path halving** (line 593): `while (uf[x] !== x) { uf[x] =
  uf[uf[x]]; x = uf[x]; }`. Compact and correct.

## IX.5 Finishing strategy A — raster

**Reference:** `dropcut-cam(1).jsx:762-806`.

The simplest strategy: parallel passes at constant XY spacing `s0`, alternating
direction, with the Z at every point read off the CL surface. Adaptive chord
refinement (`refineA`/`refineB`) subdivides each pass until the midpoint
deviation is under `chordTol`:

```text
refine(a0, z0, a1, z1, depth):
    IF depth == 0 OR |a1 - a0| < minLen: emit(a1, z1); return
    am = (a0 + a1) / 2
    zm = evalSurface(am)
    IF |a1 - a0| > seg0 OR |zm - (z0 + z1)/2| > chordTol:
        refine(a0, z0, am, zm, depth-1)
        refine(am, zm, a1, z1, depth-1)
    ELSE:
        emit(a1, z1)
```

This is the standard adaptive-subdivision idiom: subdivide while the linear
interpolant deviates from the true surface by more than tolerance. `MAXD = 11`
bounds the recursion at 2048 points per pass.

**Weakness:** on steep walls, constant *XY* spacing means the passes are far
apart measured *along the surface*, so the finish is poor exactly where it shows.
That is what the next two strategies fix.

## IX.6 Finishing strategy B — hybrid raster + waterline

**Reference:** `dropcut-cam(1).jsx:814-902`.

Split the surface by slope at a threshold angle (default 45°):

- **Shallow** (`|∇F| ≤ tan θ`): raster, which is efficient on near-horizontal
  surfaces.
- **Steep** (`|∇F| ≥ tan θ`): constant-Z waterline contours, which give even
  spacing on near-vertical surfaces.

```text
       raster here (shallow)
      ╭─────────────────╮
     ╱                   ╲
    │  ← waterline here   │   ← contours at constant Z, spaced s0 apart
    │     (steep)         │
   ╱                       ╲
  ╰─────────────────────────╯
```

There is deliberate hysteresis in the classification (lines 817–818):
`shallow` uses `≤ tanθ · 1.15` and `steep` uses `≥ tanθ · 0.85`, so a band near
the threshold is machined by *both* strategies. Overlap is cheap; a gap is a
visible defect.

Waterline contours come from marching squares on the `F` field at each Z level,
then `splitByMask` (line 433) trims each contour to the steep region only.
Contour ordering within a level is nearest-first from the current tool position
(lines 873–888), considering both endpoints of open runs — a greedy travelling-
salesman heuristic.

## IX.7 Finishing strategy C — constant scallop

**Reference:** `dropcut-cam(1).jsx:904-946`, with `solveEikonal:454`.

The most elegant of the three. The goal is passes that are a constant distance
apart **measured along the 3D surface**, not in the XY plane — which gives
uniform scallop height everywhere regardless of slope.

Define a scalar field `T(x, y)` whose level sets are the toolpaths. For the level
sets to be `s₀` apart on the surface, `T` must satisfy the **Eikonal equation**

$$|\nabla T| = \frac{\sqrt{1 + |\nabla f|^2}}{s_0},$$

where the numerator is the surface's area element — the factor by which a step in
XY is stretched when measured on the sloped surface. Steep regions get a larger
`|∇T|`, so level sets bunch closer together in XY, which is exactly right.

```js
// dropcut-cam(1).jsx:905-908
for (let k = 0; k < N; k++) rhs[k] = Math.sqrt(1 + fld.G[k] * fld.G[k]) / s0;
const Tf = solveEikonal(rhs, fld.nx, fld.ny, fld.gs);
```

`solveEikonal` (line 454) uses **fast sweeping**: initialise `T = 0` on the
boundary and `+∞` elsewhere, then relax with the Godunov upwind update

$$T_{ij} = \begin{cases}
\min(a, b) + f h & \text{if } |a - b| \ge f h,\\[4pt]
\dfrac{a + b + \sqrt{2 f^2 h^2 - (a-b)^2}}{2} & \text{otherwise,}
\end{cases}$$

where `a` and `b` are the smaller neighbours in x and y, sweeping in all four
diagonal directions and repeating four times (lines 469–474). Fast sweeping
converges in a fixed number of sweeps for this class of problem, which is why
there is no convergence test.

The toolpaths are then the integer level sets `T = 1, 2, 3, …`, extracted with
marching squares, with each contour point lifted onto the exact CL surface via
`evalF(x, y)` (line 937) rather than using the interpolated field value — the
field is a guide for *where* to cut, the exact evaluator decides *how deep*.

## IX.8 Arc fitting

**Reference:** `dropcut-cam(1).jsx:1013-1109`.

Polylines are large and controllers execute arcs more smoothly, so consecutive
collinear-plane points are refitted to circles.

```text
compressCut(points, tol):
    i = 0
    WHILE i < n-1:
        ax = the constant axis of segment i        # y-const → G18, x-const → G19,
        j = i+1                                    # z-const → G17
        WHILE j < n-1 AND segAxis(j) == ax: j++
        IF ax is defined AND (j - i) >= 5: fitArcsRun(i, j, ax, tol)
        ELSE: emit line segments i+1 .. j
        i = j

fitArcsRun(i0, i1, axis, tol):
    s = i0
    WHILE s < i1:
        grow a window [s, e], accumulating the algebraic least-squares moments
        after each growth, try to fit:
            solve the 3x3 normal equations for the circle
            project the centre onto the chord's perpendicular bisector
            REJECT if radius < 0.2 or > 4000
            REJECT if any point deviates from the circle by more than tol
            REJECT if the sweep direction ever reverses
            REJECT if |total sweep| > 2.9 rad
        keep the last successful fit; stop after 3 consecutive failures
        IF the best fit spans >= 5 points: emit an arc; s = end of that arc
        ELSE: emit one line; s = s + 1
```

The circle fit is the classic algebraic (Kåsa) formulation: minimise
`Σ (u² + v² + Au + Bv + C)²`, which is linear in `(A, B, C)` and solvable by a
3×3 system (lines 1051–1056). It is biased for short arcs, which the sweep and
radius rejections keep in check.

**The centre projection at lines 1058–1065 is the important subtlety.** After
the least-squares fit, the centre is projected onto the perpendicular bisector of
the chord from the first to the last point. This forces the arc to pass exactly
through its endpoints, so consecutive arcs join without a gap. Without it,
accumulated fit error would leave sub-micron discontinuities that some
controllers reject outright.

**Architectural change from the prototype.** In the prototype `compressCut`
directly produces G-code-flavoured ops carrying a `plane: 17|18|19` field
(line 1102). In Studio it produces `Segment` values of kind `arc` with a
geometric axis and sweep; deciding whether the controller can express that arc,
and in which plane word, is the postprocessor's job. DESIGN-01 §17.

## IX.9 Dexel simulation

**Reference:** `dropcut-cam(1).jsx:1192-1296` (`verifyJob`) and
`z1-gcode-checker-l2.jsx:287-379` (`StockSim`).

Two implementations of the same idea; Studio needs one component offering both
modes.

```text
simulate(program, stock, tools, resolution):
    H  = grid filled with stock top Z             # machined surface
    Tg = rasterise target mesh onto the grid      # desired surface (batch mode only)

    footprint = precomputed list of (di, dj, dz) offsets covering the tool disc,
                where dz = toolProfile(tool, radius) is the cutter surface height

    FOR each cutting move:
        FOR each sample point along the move (spacing 0.55 * cell):
            FOR each (di, dj, dz) in footprint:
                surfaceZ = tipZ + dz
                IF surfaceZ < H[i+di, j+dj]:
                    IF the move is a RAPID: report a crash
                    H[i+di, j+dj] = surfaceZ

    deviation = H - Tg                            # batch mode
```

Deviation classification and colouring (`devColor`, line 1298):

| Deviation | Meaning | Colour |
| --- | --- | --- |
| `d < −0.02 mm` | **gouge** — cut into the part | red |
| `−0.02 ≤ d ≤ band` | in tolerance | green → teal |
| `d > band` | excess stock left | blue |

where `band = scallop + chordTol + 0.05` (line 1278) — the tolerance band is
derived from the parameters the job was generated with, which is the seed of the
error-budget idea in Part X.

The two modes to support:

- **Batch verification** (`verifyJob`): simulate the whole program at once,
  compare against the target, report statistics. Runs in a worker, seconds.
- **Incremental playback** (`StockSim` + `setSimTo`): advance the simulation as
  the user scrubs. Forward is incremental; **backward requires a reset and
  re-run** from the start (`z1-gcode-checker-l2.jsx:864-867`), because heightmap
  removal is destructive.

If backward scrubbing becomes slow, the fix is periodic snapshots: keep a copy of
the height grid every N seconds of program time and restart from the nearest
snapshot before the target. At 240×240 `Float32` that is 230 KB per snapshot —
cheap enough to keep twenty of them.

---

# PART X — Verification, error budgets, and honesty

DESIGN-01 §20 makes a point that deserves to be a first-class feature rather than
a caveat in a comment:

> Your `verifyJob()` … is a **numerical approximation**, not a mathematical proof
> that no collision occurs between samples.

## X.1 What the simulator actually proves

The heightmap simulator establishes that **at the sampled grid points, at the
sampled positions along each move, the tool did not go below the target
surface.** It does not establish:

- anything between grid points (spacing `vs`, typically 0.1–0.35 mm);
- anything between samples along a move (spacing `0.55 × cell`);
- anything about the tool holder or spindle nose colliding with fixtures;
- anything about undercuts, which a heightmap cannot represent at all;
- anything about `job.raw(...)` escape-hatch content.

Reporting `safe: true` from that evidence is dishonest. Report what was checked.

## X.2 The error budget

Every stage that introduces geometric approximation declares its contribution,
and the compiler sums them conservatively.

```ts
export interface ErrorContribution {
  stage: string;             // "drop-cutter-sampling" | "arc-fit" | ...
  geometric: Mm;             // worst-case deviation this stage can introduce
  rationale: string;         // human-readable: why this number
}

export interface ErrorBudget {
  contributions: readonly ErrorContribution[];
  /** Conservative sum. Not RSS — we do not assume independence. */
  totalGeometric: Mm;
}
```

For a typical job with the prototypes' defaults:

| Stage | Contribution | Where the number comes from |
| --- | --- | --- |
| CL field sampling | `gs/2 × max|∇F|` | grid spacing `gs = 0.25–0.6 mm`, line 809 |
| chord refinement | `chordTol` = 0.010 mm | `prm.chordTol`, enforced by `refineLine` |
| arc fitting | `arcTol` = 0.010 mm | `prm.arcTol`, enforced by the fit rejection |
| G-code rounding | 0.0005 mm | `toFixed(3)` at line 1116 |
| **Total** | **≈ 0.021 mm + field term** | conservative sum |

Two things fall out of writing this down. First, `toFixed(3)` is a real
contribution that nobody thinks about — three decimal places means ±0.0005 mm of
quantisation on every coordinate. Second, if a user asks for a 0.005 mm scallop
while arc fitting runs at 0.010 mm tolerance, the arc fitting dominates and the
requested finish is not achievable. **The compiler should warn about that**, and
with an explicit budget it can.

## X.3 The safety certificate

```ts
export type CheckStatus =
  | { kind: "verified-exact" }
  | { kind: "verified-to-resolution"; spatial: Mm; temporal: Mm }
  | { kind: "not-checked"; reason: string }
  | { kind: "unverifiable"; reason: string };   // e.g. job.raw present

export interface SafetyCertificate {
  travel:      CheckStatus;   // exact — interval arithmetic on endpoints
  spindle:     CheckStatus;   // exact — range comparison
  feedLimits:  CheckStatus;   // exact
  interlocks:  CheckStatus;   // exact — tool loaded, spindle on, feed present
  gouge:       CheckStatus;   // sampled
  rapidCrash:  CheckStatus;   // sampled
  fixture:     CheckStatus;   // not-checked in v1
  holder:      CheckStatus;   // not-checked in v1
  errorBudget: ErrorBudget;
  warnings:    readonly Diagnostic[];
}
```

Rendered in the UI as a checklist rather than a green tick:

```text
  SAFETY CERTIFICATE                    machine: MAKERA Z1
  ─────────────────────────────────────────────────────────
  ✓ travel limits          exact
  ✓ spindle range          exact
  ✓ interlocks             exact
  ✓ gouge                  verified to 0.15 mm grid, 0.01 mm tolerance
  ✓ rapid-through-stock    verified to 0.15 mm grid
  ○ fixture collision      not checked — no fixture model defined
  ○ holder collision       not checked — tool stickout unknown
  ─────────────────────────────────────────────────────────
  error budget             0.021 mm  (arc-fit 0.010 · chord 0.010 · round 0.001)
```

This is more useful *and* more honest than `safe: true`, and it makes the
"not checked" items into a visible backlog rather than an invisible gap.

## X.4 Static checks (exact, cheap, always run)

These come from `dropcut-ide(1).jsx` and `z1-gcode-checker-l2.jsx` and are all
`O(n)` over commands:

| Check | Code | Source |
| --- | --- | --- |
| Target within travel | `travel.exceeded` | `dropcut-ide:376-388` |
| Spindle speed in range | `spindle.outOfRange` | `dropcut-ide:488-492` |
| Cut with no tool loaded | `interlock.noTool` | `dropcut-ide:513-517` |
| Cut with spindle stopped | `interlock.spindleOff` | `dropcut-ide:518-522`, `z1:202` |
| Cut with no feed rate | `interlock.noFeed` | `dropcut-ide:523-529`, `z1:201` |
| Tool change with spindle on | `interlock.toolChangeSpindle` | `dropcut-ide:469-473` |
| Arc endpoints not equidistant | `arc.radiusMismatch` | `dropcut-ide:562-568` |
| Rapid below safe Z with XY motion | `rapid.belowSafeZ` | `z1:399-402` |
| Tool below stock bottom | `stock.spoilboard` | `z1:404-408` |
| Implausibly long single move | `move.suspiciousLength` | `z1:199` |
| Units switched after motion began | `units.lateSwitch` | `z1:138-139` |
| Unknown G/M code for this machine | `dialect.unknownCode` | `z1:136,150` |
| Program ends with spindle running | `program.spindleLeftOn` | `dropcut-ide:632-638` |

Every one carries provenance, so the editor can put a marker on the right line.

---

# PART XI — Postprocessors and dialects

## XI.1 Two-stage emission

DESIGN-01 §29: never generate strings directly. Go through a structured block IR
so that block semantics can be tested independently of formatting.

```text
  ValidatedProgram
        │  dialect lowering  (capability-driven: can this machine do arcs? which planes?)
        ▼
    GCodeBlock[]            structured: motion word, axis words, feed, spindle, misc
        │  modal compression (drop redundant words)
        ▼
    GCodeBlock[]            same semantics, fewer words
        │  formatting        (decimals, spacing, comment style, line endings)
        ▼
      .nc text
```

```ts
export interface GCodeBlock {
  motion?: "G0" | "G1" | "G2" | "G3";
  plane?: "G17" | "G18" | "G19";
  axes?: Partial<Record<"X" | "Y" | "Z" | "I" | "J" | "K" | "R", number>>;
  feed?: MmPerMin;
  spindle?: { speed?: Rpm; code?: "M3" | "M4" | "M5" };
  tool?: number;
  misc?: string[];
  comment?: string;
  provenance?: Provenance;
  motionIndex?: number;      // links back to the playback timeline
}
```

## XI.2 Modal compression

The compression pass is the *only* place in the codebase that thinks about
modality:

```ts
function compress(blocks: GCodeBlock[]): GCodeBlock[] {
  let mode: string | null = null, feed: number | null = null;
  let plane: string | null = null;
  const last: Partial<Record<Axis, number>> = {};

  return blocks.map(b => {
    const out: GCodeBlock = { ...b };
    if (b.motion === mode) delete out.motion; else mode = b.motion ?? mode;
    if (b.plane  === plane) delete out.plane;  else plane = b.plane ?? plane;
    if (b.feed   === feed)  delete out.feed;   else feed = b.feed ?? feed;
    for (const ax of ["X","Y","Z"] as const) {
      const v = b.axes?.[ax];
      if (v !== undefined && near(v, last[ax])) delete out.axes![ax];
      else if (v !== undefined) last[ax] = v;
    }
    return out;
  });
}
```

This is exactly what the prototypes do inline — `ensureF`/`ensurePlane` at
`dropcut-cam(1).jsx:1133-1134` and `axisWords`/`lastMode`/`lastFeed` at
`dropcut-ide(1).jsx:390-436` — extracted into one testable function.

The property test writes itself, and is the single most valuable test in the
whole suite:

> **For any program, parsing the emitted text back with the G-code parser must
> reproduce the same motion sequence as the pre-compression blocks, to within
> formatting tolerance.**

Because we own a parser (`z1-gcode-checker-l2.jsx:97`), this round-trip is
directly testable, and it catches the entire class of "the modal compressor
dropped a word it should have kept".

## XI.3 Dialect differences, with evidence

`original/MakeraBadge.nc` is a real Makera Studio export and makes the
abstraction concrete. From inspecting it:

| Aspect | RS-274 generic | Makera Z1 (observed) |
| --- | --- | --- |
| Header | `%`, then comments | `;@MKR\|` structured metadata block |
| Units/mode preamble | `G21 G90 G94 G17` | `G90 G21` |
| Arcs | `G2`/`G3` with I/J | **none emitted** — 17,439 `G1`, 0 arcs |
| Spindle off | `M5` | both `M5` and `M05` appear |
| Program end | `M30` | `M02`, preceded by `G28` |
| Operation markers | comments | `;@MKR\|TOOLPATH_START\|toolpath_number=N` |
| Thumbnail | — | base64 PNG in trailing comment lines |
| Tool table | `(TOOL: …)` comment | `;@MKR\|TOOL\|number=…\|diameter=…\|halfAngle=…` |

The observed header grammar:

```text
;@MKR|BEGIN
;@MKR|SCHEMA|v=1.0.0
;@MKR|MACHINE|id=Z1|name=Makera Z1
;@MKR|MATERIAL|id=…|name1=Plastic|name2=ABS
;@MKR|STOCK|id=cuboid|length=100|width=100|height=1.3|diameter=1
;@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-50|y=-50|z=0.65
;@MKR|UNIT|value=mm
;@MKR|TOOL|number=1|name=3.175*12mm Flat End(Metal)|type=Flat End|
      diameter=3.175|tipdiameter=3.175|cornerradius=0|halfAngle=0
;@MKR|TIME|seconds=1800
;@MKR|TOOLPATH|number=1|tool_number=2|name=[T2]2D Pocket
;@MKR|END
```

**The consequence for the architecture is direct.** Because Makera emits no arcs,
a Makera-targeted compile must *linearize fitted arcs back out*. If arc fitting
had produced G-code-flavoured ops (as in the prototype), that would be a
backwards step through a lossy transform. Because our arc fitting produces
geometric `Segment`s, linearization is just another capability-driven lowering:

```ts
function lowerArcs(path: Path, caps: MachineCapabilities): Path {
  return mapSegments(path, seg => {
    if (seg.kind !== "arc") return seg;
    const plane = planeOf(seg.axis);
    if (plane === "XY" && caps.interpolation.arcXY) return seg;
    if (plane === "XZ" && caps.interpolation.arcXZ) return seg;
    if (plane === "YZ" && caps.interpolation.arcYZ) return seg;
    return linearize(seg, chordToleranceFor(seg));     // fall back to lines
  });
}
```

This is DESIGN-01 §27 and §28 paying off in a case we can actually test against
a real file.

## XI.4 The parser as a conformance tool

The G-code parser is not only for the "check someone else's file" feature. It is:

- the **round-trip oracle** for the property test in XI.2;
- the **importer** that lets a user load `MakeraBadge.nc` and inspect it;
- the **dialect conformance checker**: parse an emitted file against the target
  machine's `supportedCodes` and confirm nothing unsupported was emitted.

`MakeraBadge.nc` at 18,531 lines is also a reasonable performance floor: parse
plus back-plot should stay under ~200 ms.

---

# PART XII — Repository layout

## XII.1 Tooling choices

| Concern | Choice | Why |
| --- | --- | --- |
| Bundler / dev server | **Vite 5** | required by the brief; native worker and ESM support |
| Language | **TypeScript, `strict`** | the branded-type design depends on it |
| State | **Redux Toolkit** + `redux-undo` | required by the brief; document-shaped state |
| Editor | **CodeMirror 6** | small, extensible; see VII.4 |
| 3D | **Three.js** | already used by all three prototypes |
| Monorepo | **pnpm workspaces** | package boundaries are load-bearing here |
| Unit tests | **Vitest** | shares the Vite config; runs worker code in Node |
| Property tests | **fast-check** | for the algebraic laws in IV.2/IV.3 and XI.2 |
| E2E | **Playwright** | canvas screenshot diffing for the viewport |
| Boundary enforcement | **dependency-cruiser** | mechanically enforces III.2 |

Vite specifics that matter:

- Workers are imported as `new Worker(new URL("./worker.ts", import.meta.url),
  { type: "module" })`. Vite handles the bundling; no plugin required.
- Enable `build.target: "es2022"` so `Atomics` and top-level `await` are
  available in workers.
- Do **not** enable `optimizeDeps` prebundling for `three` — its ESM entry
  tree-shakes better when Vite handles it directly.

## XII.2 Directory tree

```text
dropcut-studio/
├─ package.json                    pnpm workspace root
├─ pnpm-workspace.yaml
├─ .dependency-cruiser.cjs         enforces the layering in III.2
├─ packages/
│  ├─ units/
│  │  └─ src/index.ts              Mm, Rpm, MmPerMin, brands, constructors   ← IV.1
│  ├─ math/
│  │  └─ src/
│  │     ├─ vec.ts                 Vec3, UnitVec3, Box2, Box3
│  │     ├─ frames.ts              Point3<F>, Transform<A,B>, compose, invert ← IV.2
│  │     └─ range.ts
│  ├─ geometry/
│  │  └─ src/
│  │     ├─ mesh.ts                ← dropcut-cam:94-142   parseSTL, buildModel
│  │     ├─ spatial-index.ts       ← dropcut-cam:146-173  buildGrid
│  │     ├─ drop-cutter.ts         ← dropcut-cam:175-309  makeEvaluator        ★ hot
│  │     ├─ cl-field.ts            ← dropcut-cam:313-352  buildCLField, bilin
│  │     ├─ contours.ts            ← dropcut-cam:356-450  marchSquares, splitByMask
│  │     ├─ eikonal.ts             ← dropcut-cam:454-476  solveEikonal
│  │     └─ heightfield.ts         ← dropcut-cam:22-90    presets, tessellation
│  ├─ ir/
│  │  └─ src/
│  │     ├─ path.ts                Segment, Path, concat                       ← IV.3
│  │     ├─ commands.ts            CanonicalCommand union                      ← IV.4
│  │     ├─ provenance.ts          Provenance, Diagnostic                      ← IV.7
│  │     └─ program.ts             CanonicalProgram, MachineProgram, brands    ← IV.8
│  ├─ machine/
│  │  └─ src/
│  │     ├─ profile.ts             MachineProfile, MachineCapabilities         ← IV.9
│  │     ├─ tools.ts               Tool, ToolGeometry, profile()               ← IV.10
│  │     └─ profiles/{xyz3018,makera-z1,grbl-generic}.ts
│  ├─ strategies/
│  │  └─ src/
│  │     ├─ registry.ts            defineStrategy, lookup by name
│  │     ├─ zlevel-rough.ts        ← dropcut-cam:564-698
│  │     ├─ raster-finish.ts       ← dropcut-cam:762-806
│  │     ├─ hybrid-waterline.ts    ← dropcut-cam:814-902
│  │     ├─ constant-scallop.ts    ← dropcut-cam:904-946
│  │     ├─ rect-pocket.ts         ← dropcut-ide:275-328
│  │     └─ face.ts                ← dropcut-ide:236-273
│  ├─ planner/
│  │  └─ src/
│  │     ├─ plan.ts                ManufacturingPlan types                     ← IV.5
│  │     ├─ entry.ts               ← dropcut-cam:489-544   helix/ramp/plunge
│  │     ├─ linker.ts              ← dropcut-cam:664-686, 733-757  stay-down logic
│  │     ├─ clearance.ts           ← dropcut-ide:439-453   safeTraverse
│  │     ├─ refine.ts              ← dropcut-cam:722-731   adaptive subdivision
│  │     └─ arc-fit.ts             ← dropcut-cam:1013-1109 compressCut
│  ├─ analysis/
│  │  └─ src/
│  │     ├─ dexel.ts               ← dropcut-cam:1192-1296 + z1:287-379  (merged)
│  │     ├─ deviation.ts           ← dropcut-cam:1276-1309 devColor, statistics
│  │     ├─ static-checks.ts       ← the table in X.4
│  │     ├─ time.ts                feed-based time estimation
│  │     └─ certificate.ts         SafetyCertificate, ErrorBudget              ← X.2/X.3
│  ├─ compiler/
│  │  └─ src/
│  │     ├─ lower.ts               canonical → machine, capability-driven
│  │     ├─ validate.ts            the ONLY constructor of ValidatedProgram
│  │     ├─ flatten.ts             ← dropcut-cam:970-996   → RenderBuffers
│  │     └─ gcode-ir.ts            GCodeBlock, modal compression               ← XI.2
│  ├─ post-rs274/src/index.ts      ← dropcut-cam:1115-1186
│  ├─ post-makera/src/index.ts     ← MakeraBadge.nc header grammar             ← XI.3
│  ├─ post-linuxcnc/src/index.ts
│  ├─ gcode-parser/
│  │  └─ src/index.ts              ← z1:97-267  parseGcode, arcPoints
│  └─ viewer-three/
│     └─ src/
│        ├─ viewport.ts            createViewport → ViewportApi                ← VIII.2
│        ├─ orbit.ts               ← the three duplicated orbit controllers
│        ├─ toolpath-lines.ts      ← dropcut-cam:1663-1729
│        ├─ stock-mesh.ts          ← z1:650-745
│        ├─ tool-marker.ts         ← three duplicates
│        └─ playback.ts            ← sampleAt, the trail                       ← VIII.5
└─ apps/
   └─ studio/
      ├─ index.html
      ├─ vite.config.ts
      └─ src/
         ├─ main.tsx
         ├─ state/
         │  ├─ store.ts            configureStore, middleware wiring
         │  ├─ slices/{project,compile,simulation,playback,viewport,ui}.ts  ← V.2
         │  ├─ compileThunk.ts     ← V.4
         │  ├─ selectors.ts        ← V.5
         │  ├─ artifactCache.ts    tier 2                                   ← V.1
         │  └─ middleware/{autoCompile,persist,artifactGc}.ts               ← V.6
         ├─ script-host/
         │  ├─ host.ts             main-thread side, watchdog
         │  ├─ worker.ts           sandbox                                  ← VII.2
         │  └─ api/                job, tools, geometry, strategy, entry    ← VII.3
         ├─ compute/
         │  ├─ pool.ts             ← VI.2
         │  └─ worker.ts           dispatch table for plan/simulate/parse
         └─ ui/
            ├─ App.tsx
            ├─ Editor.tsx          CodeMirror 6 host                        ← VII.4
            ├─ Viewport.tsx        imperative shell                         ← VIII.1
            ├─ panels/{GCode,Ir,Diagnostics,Stats,Certificate}.tsx
            ├─ Inspector.tsx       setup, tools, machine selection
            └─ Transport.tsx       play/scrub/speed
```

★ marks the one file where micro-optimisation is justified.

## XII.3 The old→new map, complete

| Prototype function | Lines | Destination |
| --- | --- | --- |
| `PRESETS`, `heightfieldTris` | cam 22–90 | `geometry/heightfield.ts` |
| `parseSTL`, `buildModel` | cam 94–142 | `geometry/mesh.ts` |
| `buildGrid` | cam 146–173 | `geometry/spatial-index.ts` |
| `pointInTri`, `edgeBall`, `makeEvaluator` | cam 175–309 | `geometry/drop-cutter.ts` |
| `buildCLField`, `bilin` | cam 313–352 | `geometry/cl-field.ts` |
| `marchSquares`, `splitByMask` | cam 356–450 | `geometry/contours.ts` |
| `solveEikonal` | cam 454–476 | `geometry/eikonal.ts` |
| `emitEntry` | cam 489–544 | `planner/entry.ts` |
| `generateJob` roughing | cam 564–698 | `strategies/zlevel-rough.ts` |
| `generateJob` raster | cam 762–806 | `strategies/raster-finish.ts` |
| `generateJob` hybrid | cam 814–902 | `strategies/hybrid-waterline.ts` |
| `generateJob` scallop | cam 904–946 | `strategies/constant-scallop.ts` |
| `finLink`, stay-down logic | cam 664–686, 733–757 | `planner/linker.ts` |
| `refineLine`, `refineA/B` | cam 722–786 | `planner/refine.ts` |
| flattening loop | cam 970–996 | `compiler/flatten.ts` |
| `compressCut`, `fitArcsRun` | cam 1013–1109 | `planner/arc-fit.ts` |
| `toGcode` | cam 1115–1186 | `post-rs274/` + `compiler/gcode-ir.ts` |
| `verifyJob`, `devColor` | cam 1192–1309 | `analysis/dexel.ts`, `analysis/deviation.ts` |
| Three.js scene, orbit, lines | cam 1472–1729 | `viewer-three/` |
| units, `unwrap`, `warnBare` | ide 122–149 | `units/` + `script-host/api/` |
| `tools.*` | ide 152–165 | `machine/tools.ts` |
| `job.*` façade | ide 169–329 | `script-host/api/job.ts` |
| `face`, `rectPocket` | ide 236–328 | `strategies/face.ts`, `strategies/rect-pocket.ts` |
| sandbox invocation | ide 332–343 | `script-host/worker.ts` (hardened) |
| validation pass | ide 357–655 | `compiler/validate.ts` + `analysis/static-checks.ts` |
| `safeTraverse` | ide 439–453 | `planner/clearance.ts` |
| `addLinear`, `axisWords` | ide 402–437 | `compiler/gcode-ir.ts` |
| `highlight`, `Editor` | ide 661–788 | **deleted** — replaced by CodeMirror 6 |
| `Viewer`, `posAt` | ide 794–1282 | `viewer-three/` |
| `parseGcode`, `arcPoints` | z1 97–267 | `gcode-parser/` |
| `toolProfile` | z1 272–283 | `machine/tools.ts` |
| `StockSim` | z1 287–379 | `analysis/dexel.ts` |
| `runGlobalChecks` | z1 383–425 | `analysis/static-checks.ts` |
| `useViewport` | z1 429–748 | `viewer-three/` |
| `positionAt` | z1 752–776 | `viewer-three/playback.ts` |
| all three UIs | — | `apps/studio/src/ui/` |

Roughly 3,400 of the 4,861 prototype lines survive as ported logic; about 1,000
lines of triplicated viewport and UI code collapse into one implementation; about
450 lines (the hand-rolled editor and three sets of inline styles) are deleted
outright.

---

# PART XIII — Implementation plan

Eight milestones. Each ends with something demonstrable and tested. The ordering
is chosen so that the riskiest architectural commitments are validated before
much code depends on them.

## M1 — Core types and a G-code round trip *(no UI)*

**Build:** `@cam/units`, `@cam/math`, `@cam/ir`, `@cam/machine`,
`@cam/gcode-parser`, `@cam/compiler/gcode-ir`, `@cam/post-rs274`.

**Demonstrate:** a Node script that constructs a `CanonicalProgram` by hand,
emits RS-274, parses it back, and asserts the motion sequences match.

**Why first.** This validates the central bet — that a non-modal IR can be
compressed into modal G-code losslessly — before any strategy, worker or
component depends on it. If the round trip is awkward, the IR is wrong, and now
is the cheapest moment to find out.

**Done when:**
- [ ] Branded units compile; mixing `Mm` and `Rpm` is a type error.
- [ ] `compose(ab, bc)` and `invert` satisfy the groupoid laws under fast-check.
- [ ] `concat` rejects paths whose endpoints do not meet.
- [ ] Round-trip property test passes on 1,000 generated programs.
- [ ] `MakeraBadge.nc` parses; the block census matches the numbers in XI.3.

## M2 — Port the geometry kernel

**Build:** `@cam/geometry` in full — mesh, spatial index, drop-cutter, CL field,
contours, Eikonal.

**Demonstrate:** a Node benchmark that loads a preset heightfield, builds the CL
field, and prints timings against the prototype's.

**Done when:**
- [ ] `evalTipZ` matches the prototype's output to 1e-9 on a fixed sample set
      (capture the prototype's values as a golden file first).
- [ ] Analytic check: for a hemisphere of radius `R0` and a ball tool of radius
      `R`, the CL surface is a hemisphere of radius `R0 + R`. Assert within 1e-6.
- [ ] Marching squares on a cone produces concentric circles of the expected radii.
- [ ] Eikonal on a flat plane with `|∇f| = 0` gives `T` = distance/`s0`.
- [ ] Drop-cutter throughput ≥ the prototype's (no regression from restructuring).

## M3 — The viewport package

**Build:** `@cam/viewer-three` — one orbit controller, one playback clock, one
toolpath renderer, one stock mesh, one DRO.

**Demonstrate:** a standalone HTML page (no React) that loads a canned
`RenderBuffers` and plays it back.

**Why before React.** Building it framework-free forces the imperative-shell
boundary to be real rather than aspirational.

**Done when:**
- [ ] `sampleAt` passes the edge-case tests in VIII.5.
- [ ] The trail advances by `drawRange` with no geometry rebuild (assert
      `geometry.attributes.position.version` never increments during playback).
- [ ] 18,000-segment program renders at 60 fps.
- [ ] `dispose()` leaves zero live WebGL contexts (check `renderer.info`).

## M4 — Strategies and the planner

**Build:** `@cam/strategies` (all six), `@cam/planner` (entry, linker, clearance,
refine, arc-fit).

**Demonstrate:** CLI: `dropcut plan part.stl --strategy constant-scallop
--scallop 0.01 -o out.nc`, producing G-code visually indistinguishable from the
prototype's.

**Done when:**
- [ ] Each strategy produces a `ToolpathSet` whose paths are all continuous
      (`concat` would accept every consecutive pair).
- [ ] Arc fitting: refitted arcs deviate from the source polyline by ≤ `arcTol`
      (property test over generated polylines).
- [ ] Arc fitting: consecutive arcs share endpoints exactly — the centre
      projection from IX.8 is verified, not assumed.
- [ ] Golden-file comparison against prototype output for all four
      strategy/preset combinations.

## M5 — Analysis and the certificate

**Build:** `@cam/analysis` — merged dexel simulator, deviation, static checks,
error budget, certificate.

**Demonstrate:** the CLI prints a certificate for a generated job, and flags the
deliberately-broken sample program in `z1-gcode-checker-l2.jsx:39` with exactly
the two planted issues (spindle stopped before an engraving pass; rapid through
uncut stock).

**Done when:**
- [ ] All thirteen static checks in X.4 fire on crafted inputs and stay silent on
      clean ones.
- [ ] Simulating a program that cuts a flat pocket produces a heightmap equal to
      the analytic answer within one cell.
- [ ] The error budget sums correctly and warns when arc tolerance exceeds the
      requested scallop.

## M6 — The application shell

**Build:** `apps/studio` — Vite, Redux store, the six slices, compile thunk,
artifact cache, layout, Viewport component, panels.

**Demonstrate:** the app loads a hard-coded plan (no scripting yet), compiles it,
shows G-code / IR / diagnostics tabs, and plays it back in 3D.

**Done when:**
- [ ] `serializableCheck` and `immutableCheck` are on and silent.
- [ ] No typed array appears anywhere in `store.getState()` (assert in a test).
- [ ] Editing a parameter recompiles and updates the viewport in under 300 ms for
      the sample part.
- [ ] Undo/redo works on the project slice and does not resurrect stale artifacts.

## M7 — The scripting IDE

**Build:** script worker with the hardened sandbox, capability API, watchdog,
CodeMirror 6 host, diagnostics in the gutter, autocomplete from strategy schemas.

**Demonstrate:** type the prototype's default program (`dropcut-ide(1).jsx:39`)
into the editor and get identical G-code to the prototype.

**Done when:**
- [ ] `while(true){}` is terminated by the watchdog and the app stays responsive.
- [ ] `fetch("…")` inside a script throws rather than making a request.
- [ ] A thrown error inside `job.face(...)` produces a diagnostic with the right
      script line number.
- [ ] Autocomplete offers `strategy.constantScallop` and documents its parameters.
- [ ] Bare-number warnings appear in the diagnostics panel, and the program still
      compiles.

## M8 — Dialects, import, persistence

**Build:** `post-makera`, `post-linuxcnc`, G-code import view, IndexedDB
persistence, project save/load.

**Demonstrate:** compile one plan for two machines and diff the outputs; import
`MakeraBadge.nc` and back-plot it with its stock reconstructed from the
`;@MKR|STOCK` header.

**Done when:**
- [ ] Compiling for `makera-z1` emits no `G2`/`G3` (arcs linearized), ends with
      `M02`, and carries a `;@MKR|` header.
- [ ] Compiling the same plan for `xyz-3018` emits arcs.
- [ ] Round-trip property test passes for every dialect.
- [ ] A project survives reload with script, setup, tools and machine intact.

## Suggested ordering for a single intern

M1 → M2 → M4 → M5 as a **headless CAM library with a CLI**, then M3 → M6 → M7 as
the **application**, then M8. Working headless first means every algorithm is
testable in Node from day one, and the UI work later becomes assembly rather
than debugging-through-a-canvas.

---

# PART XIV — Testing strategy

## XIV.1 The test pyramid, and what goes where

```text
        ┌──────────────────────────────┐
        │  E2E (Playwright)            │  ~10 tests: load, edit, compile,
        │                              │  play, export, import
        ├──────────────────────────────┤
        │  Golden files                │  ~30: prototype-parity snapshots
        ├──────────────────────────────┤
        │  Property tests (fast-check) │  ~15: the algebraic laws
        ├──────────────────────────────┤
        │  Unit tests (Vitest)         │  the bulk
        └──────────────────────────────┘
```

## XIV.2 Property tests — the laws worth encoding

These are the highest-value tests in the suite because they check *invariants*
rather than examples, and every one of them corresponds to a claim the
architecture makes.

| Law | Statement |
| --- | --- |
| Frame groupoid | `apply(invert(t), apply(t, p)) ≈ p` |
| Frame composition | `apply(compose(ab, bc), p) ≈ apply(bc, apply(ab, p))` |
| Path associativity | `concat(concat(a,b),c) ≡ concat(a,concat(b,c))` |
| Path identity | `concat(a, empty(a.end)) ≡ a` |
| Modal round trip | `parse(emit(P)).motions ≈ P.motions` |
| Compression soundness | `interpret(compress(B)) ≡ interpret(B)` |
| Arc fit tolerance | every source point within `tol` of the fitted arc |
| Arc fit continuity | consecutive fitted arcs share endpoints exactly |
| Linearization | `linearize(arc, tol)` deviates from the arc by ≤ `tol` |
| Simulation monotonicity | heightmap cells never increase during a program |
| Time monotonicity | `motions[i].t1 ≤ motions[i+1].t0` for all `i` |

## XIV.3 Golden files: parity with the prototypes

Before touching anything, capture the prototypes' outputs as fixtures. Add a
temporary `console.log(JSON.stringify(...))` to each prototype, run it in a
browser for each preset/strategy/tool combination, and save the results.

```text
test/golden/
├─ cl-field/{sprite,star,dome,hills}-{ball3,flat4}.json     evalTipZ samples
├─ toolpath/{preset}-{strategy}.json                        move list + stats
├─ gcode/{preset}-{strategy}.nc                             emitted text
└─ verify/{preset}-{strategy}.json                          deviation statistics
```

These fixtures are the definition of "the port did not change behaviour". When a
port intentionally changes output — for example replacing the string-keyed
contour chaining from IX.3 — the diff must be reviewed and the golden file
updated in the same commit, with the reason in the message.

## XIV.4 Numerical tolerance discipline

Floating-point tests need stated tolerances, not `toBe`. The convention:

| Comparison | Tolerance |
| --- | --- |
| Same algorithm, restructured code | `1e-9` (bit-comparable intent) |
| Geometry against an analytic answer | `1e-6` mm |
| Anything through the CL field (bilinear) | `gs × maxSlope / 2` |
| Anything through G-code text | `5e-4` mm (`toFixed(3)`) |

## XIV.5 Performance budgets

Assert these in CI on a fixed machine; treat a regression as a failure.

| Operation | Input | Budget |
| --- | --- | --- |
| STL parse | 100k triangles | < 400 ms |
| Spatial index build | 100k triangles | < 300 ms |
| `evalTipZ` throughput | ball tool, 100k-tri mesh | > 200k queries/s |
| CL field | 400×400 grid | < 3 s |
| Constant-scallop plan | dome preset, 0.01 mm | < 8 s |
| Dexel verify | 240×240 grid, 200k points | < 4 s |
| G-code parse | `MakeraBadge.nc`, 18.5k lines | < 200 ms |
| Viewport frame | 18k segments + trail | < 16 ms |

---

# PART XV — Decision records

### ADR-001 — Machining semantics, not G-code, is the model

**Status:** accepted.
**Context:** The obvious design is to generate G-code strings directly, as
`toGcode` (`dropcut-cam(1).jsx:1115`) does. It is simple and it works.
**Options:** (a) generate strings directly; (b) generate a G-code AST; (c) model
machining semantically and treat G-code as one backend.
**Decision:** (c), per `original/DESIGN-01-semantic-cam-architecture.md`.
**Rationale:** Simulation, time estimation, verification, visualisation and
optimisation are all interpretations of the same program. With (a) each is
re-derived from text, and the prototypes show the cost: `verifyJob` re-walks a
representation that already lost the arcs `compressCut` found. Multi-dialect
support is impossible under (a) without string rewriting.
**Consequences:** more layers and more types; a real compiler to maintain; but
new backends and new analyses become additive rather than invasive.

### ADR-002 — The canonical IR is non-modal

**Status:** accepted.
**Context:** G-code is modal. Modelling the IR modally would make emission
trivial.
**Decision:** every command carries its complete state — feed on every cut,
speed on every spindle command, geometry on every arc.
**Rationale:** modal state is the primary source of G-code bugs (Part I.7). A
non-modal IR means any command can be inspected, reordered, filtered or
transformed in isolation. Modality re-enters only in `compress()` (XI.2), where
it is one testable function.
**Consequences:** the IR is more verbose in memory; compression must be correct,
which the round-trip property test enforces.

### ADR-003 — Certified stages via type brands

**Status:** accepted.
**Context:** The prototype enforces "no G-code without validation" with
`gcode: hasErrors ? [] : gcode` (`dropcut-ide(1).jsx:649`) — a convention that a
future refactor can silently break.
**Options:** (a) runtime check as today; (b) unique-symbol brand on
`ValidatedProgram`; (c) a full effect system.
**Decision:** (b).
**Rationale:** the brand costs about ten lines and makes the invariant
unforgeable outside `@cam/compiler`. (c) is disproportionate.
**Consequences:** `validate()` is the sole constructor; tests that need a
program must go through it, which is the point.

### ADR-004 — Redux holds documents, not geometry

**Status:** accepted.
**Context:** A finished job can be 24 MB of typed arrays.
**Decision:** three tiers (V.1); Redux stores content-hash ids into a
module-level artifact cache.
**Rationale:** RTK's serialisability and immutability checks are valuable and
must stay on; large buffers would force them off. Time-travel debugging remains
useful because the *document* is small.
**Consequences:** an explicit cache with GC middleware; components resolve ids
to artifacts. Accepted cost: the cache is not part of undo history, so undo
triggers a recompile rather than restoring a cached result.

### ADR-005 — Web Workers with transferables for compute

**Status:** accepted.
**Context:** Generation takes seconds; the prototypes yield with
`setTimeout(0)` (VI.1).
**Options:** (a) keep cooperative yielding; (b) workers with structured clone;
(c) workers with transferables; (d) WASM.
**Decision:** (c) now, (d) considered later for the drop-cutter kernel only.
**Rationale:** (a) still stutters and pollutes the algorithms with yield points;
(b) copies megabytes per result; (c) is zero-copy and needs no special headers.
WASM would help the hot kernel but adds a toolchain — revisit if profiling says
so.
**Consequences:** the planner/renderer boundary must be typed arrays, which is
why `flatten.ts` is an explicit pass.

### ADR-006 — Scripts run in a sandboxed worker

**Status:** accepted.
**Context:** `new Function` on the main thread (`dropcut-ide(1).jsx:333`) gives
scripts the DOM, the network and the ability to hang the tab.
**Options:** (a) status quo; (b) module worker with capability globals and a
watchdog; (c) a JS interpreter in JS (QuickJS-WASM, `ses`); (d) null-origin
iframe.
**Decision:** (b) now, (d) as a hardening follow-up.
**Rationale:** (b) removes the DOM by construction and makes termination
possible, at near-zero cost. (c) is genuinely secure but 1–3 MB of payload and
10–100× slower, which matters because scripts drive planning. (d) is the real
boundary and is deferred rather than dismissed.
**Consequences:** the script API must be fully serialisable across
`postMessage`, which is why `ManufacturingPlan` is plain JSON — a constraint that
turns out to be a benefit, since it is also the save format.

### ADR-007 — CodeMirror 6 over Monaco

**Status:** accepted.
**Rationale:** ~150 KB versus ~2 MB; a composable extension model; no competing
worker architecture. Monaco's advantage is full TypeScript language services,
which we do not need — the DSL surface is small enough that schema-driven
completion covers it.
**Consequences:** no type checking inside the editor. Mitigated by emitting
`.d.ts` for the DSL so users who prefer an external editor get types there.

### ADR-008 — Z-up coordinates in the viewport

**Status:** accepted.
**Context:** Three.js defaults to Y-up; machine coordinates are Z-up. Two
prototypes set `camera.up = (0,0,1)`; the third remaps every point on insertion.
**Decision:** Z-up throughout; no coordinate remapping anywhere.
**Rationale:** a remap that must be remembered at every call site
(`dropcut-ide(1).jsx:1043`) will eventually be forgotten, and the resulting bug
looks plausible rather than obviously wrong.
**Consequences:** a few Three.js helpers (`GridHelper`) need an explicit
rotation. Small, local, and done once.

### ADR-009 — One merged simulator with two modes

**Status:** accepted.
**Context:** `verifyJob` (batch, deviation-vs-target) and `StockSim`
(incremental, playback) are two implementations of one algorithm.
**Decision:** one `DexelSim` class with `simulateAll()` and
`advanceTo(t)`/`reset()`.
**Rationale:** the stamping kernel is identical; only the driver differs.
**Consequences:** must support both "target field loaded" and "no target"
(playback does not need deviation). Backward scrubbing resets and re-runs;
snapshots are the escape hatch if that proves slow (IX.9).

### ADR-010 — Publish honest safety certificates

**Status:** accepted.
**Context:** DESIGN-01 §20. The simulator is sampled, not exact.
**Decision:** every check reports `verified-exact`, `verified-to-resolution`
(with the resolution), `not-checked` (with a reason), or `unverifiable`.
**Rationale:** a boolean `safe` invites misplaced trust in a domain where the
failure mode is a broken machine. Stating resolutions also turns unchecked items
into a visible backlog.
**Consequences:** more UI surface; users must read a checklist rather than a
tick. That is the intended behaviour change.

---

# PART XVI — Risks and open questions

## Risks

| # | Risk | Impact | Mitigation |
| --- | --- | --- | --- |
| R1 | Port changes numerical behaviour subtly; toolpaths look right but are wrong | high | Golden files captured **before** any porting (XIV.3); analytic checks in M2 |
| R2 | Drop-cutter regresses in speed after restructuring | high | Benchmark in CI from M2; keep the kernel monomorphic and allocation-free |
| R3 | The `Path`/`Point3` object model is too heavy for millions of points | med | `poly` segments carry `Float64Array`; `flatten.ts` converts at the boundary |
| R4 | Worker sandbox is not a real security boundary | med | Documented in VII.2; iframe hardening tracked as a follow-up |
| R5 | Contour chaining tolerance (1/256 mm) leaves gaps on fine grids | med | Make the quantum explicit and test on a 0.05 mm grid (IX.3) |
| R6 | Redux gets used as a dumping ground once deadlines bite | med | `serializableCheck` on; a test asserts no typed arrays in state |
| R7 | Scope creep into 4/5-axis before 3-axis is solid | med | `SE(3)` frames keep the door open; the roadmap keeps it shut |
| R8 | The arc-direction sign convention is ported incorrectly | high | Round-trip property test per plane; explicit fixtures for G17/G18/G19 |
| R9 | Backward scrubbing becomes unusably slow on large programs | low | Snapshot strategy specified in IX.9 |
| R10 | Dependency layering erodes | low | `dependency-cruiser` in CI from M1 |

## Open questions

1. **Should the CL field be a first-class cached artifact?** Hybrid and
   constant-scallop both need it and it costs seconds. Memoising it on
   `PlanningContext` (IV.6) handles the within-compile case; caching it across
   compiles keyed by `(mesh hash, tool, bounds, gridSize)` would make parameter
   tweaking near-instant. Recommendation: add the cross-compile cache in M4 —
   it is a small change with a large interactive payoff.

2. **Where should time estimation live?** The prototypes use naive
   `length / feed` with fixed multipliers for plunge and ramp
   (`KIND_SPEED`, `dropcut-cam(1).jsx:483`). Real controllers accelerate and
   decelerate, so short segments take far longer than length/feed suggests, and
   estimates for finishing passes can be off by 2× or more. Options: keep it
   naive and label it, or model trapezoidal acceleration per segment with the
   machine's jerk/accel limits. Recommendation: keep it naive for v1 but put
   `accel` in `MachineProfile` so the better model can be added without a
   schema change.

3. **How should meshes be persisted in a project file?** An STL can be tens of
   megabytes. Embed as base64, store separately in IndexedDB and reference by
   hash, or require the user to re-attach? Recommendation: IndexedDB by content
   hash, with the project file holding only the hash and the original filename.

4. **Should the DSL be TypeScript rather than JavaScript?** Type checking in the
   browser needs the TS compiler (~3 MB). Recommendation: ship `.d.ts` for
   external editors, keep the in-app language JavaScript, and revisit if users
   ask.

5. **Do we need tool-holder collision checking for v1?** It requires stickout
   and holder geometry that users rarely enter accurately. Recommendation: no —
   report it as `not-checked` in the certificate, which is exactly what the
   certificate design is for.

6. **What is the story for tool-change pauses on manual-tool-change machines?**
   Both target machines are `toolChange: "manual"`, meaning the program must
   stop and prompt. `M6` semantics vary by controller. This needs research
   before M8.

---

# PART XVII — Glossary

| Term | Meaning |
| --- | --- |
| **Allowance / stock to leave** | Material deliberately left by roughing for finishing to remove |
| **Arc fitting** | Replacing a polyline with circular arcs within a tolerance |
| **Backplot** | Rendering a G-code program's motion as lines |
| **Ball nose** | End mill with a hemispherical tip |
| **Boustrophedon** | Alternating-direction passes, like ox-plough furrows |
| **CL surface** | Cutter-location surface: tip positions that touch the part without gouging |
| **Chord tolerance** | Max deviation allowed when approximating a curve with line segments |
| **Climb / conventional** | Milling direction relative to spindle rotation (not modelled in v1) |
| **Dexel** | Ray-based volume model; the heightmap here is the 1-ray-per-column case |
| **DRO** | Digital readout — the live X/Y/Z display |
| **Eikonal equation** | `\|∇T\| = f`; its level sets are equally spaced under metric `f` |
| **Feed rate** | Controlled cutting speed, mm/min |
| **Fixture** | Clamping hardware holding the stock |
| **Gouge** | Cutting into material that should have remained |
| **Helix entry** | Descending into material along a helical path |
| **Modal** | State persisting until changed; G-code's defining hazard |
| **Post / postprocessor** | Backend converting neutral output to a controller's dialect |
| **Rapid** | Uncontrolled-feed positioning move (`G0`) |
| **RS-274** | The G-code standard; RS-274/NGC is the LinuxCNC variant |
| **Scallop** | Ridge left between adjacent ball-nose passes |
| **Spoilboard** | Sacrificial surface beneath the stock |
| **Stepdown** | Depth of cut per Z level |
| **Stepover** | Lateral distance between adjacent passes |
| **STEP-NC** | ISO 14649: feature-based manufacturing data model |
| **Stock** | Raw material before machining |
| **Waterline** | Constant-Z contour toolpath |
| **Work offset** | `G54`–`G59`: origin shift from machine to part coordinates |

---

# PART XVIII — References

## Source files analysed

| Path | Lines | Role |
| --- | --- | --- |
| `original/dropcut-cam(1).jsx` | 1,971 | Drop-cutter CAM: strategies, arc fit, dexel verify, post |
| `original/dropcut-ide(1).jsx` | 1,673 | Scripting IDE: DSL, canonical IR, validation, modal post |
| `original/z1-gcode-checker-l2.jsx` | 1,217 | G-code parser, stock simulator, static checks |
| `original/MakeraBadge.nc` | 18,531 | Real Makera Studio export — dialect and parser fixture |
| `original/DESIGN-01-semantic-cam-architecture.md` | — | Normative architecture (five-layer stack, IR, capabilities) |
| `original/DESIGN-02-kleisli-composition-for-machine-commands.md` | — | Sequencing model for stateful, fallible machine commands |

## Key line references

| Subject | Location |
| --- | --- |
| Drop-cutter evaluator | `dropcut-cam(1).jsx:203-309` |
| Sphere-edge contact maximisation | `dropcut-cam(1).jsx:184-201` |
| Spatial index + stamp dedup | `dropcut-cam(1).jsx:146-173, 212-224` |
| CL field + slope | `dropcut-cam(1).jsx:313-352` |
| Marching squares + saddle fix | `dropcut-cam(1).jsx:356-431, 382-391` |
| Eikonal fast sweeping | `dropcut-cam(1).jsx:454-476` |
| Entry: helix → ramp → plunge | `dropcut-cam(1).jsx:489-544` |
| Roughing with union-find | `dropcut-cam(1).jsx:564-698` |
| Scallop→stepover conversion | `dropcut-cam(1).jsx:706-710` |
| Three finishing strategies | `dropcut-cam(1).jsx:762-946` |
| Arc fitting + centre projection | `dropcut-cam(1).jsx:1013-1109, 1058-1065` |
| G-code emission, modal suppression | `dropcut-cam(1).jsx:1115-1186, 1133-1134` |
| Arc plane sign convention | `dropcut-cam(1).jsx:1157-1168` |
| Dexel verification + deviation colour | `dropcut-cam(1).jsx:1192-1309` |
| Branded units, `unwrap` | `dropcut-ide(1).jsx:122-149` |
| `job` façade | `dropcut-ide(1).jsx:169-329` |
| Sandbox invocation | `dropcut-ide(1).jsx:332-343` |
| Validation and lowering | `dropcut-ide(1).jsx:357-655` |
| `safeTraverse` | `dropcut-ide(1).jsx:439-453` |
| "No G-code without validation" | `dropcut-ide(1).jsx:644-654` |
| Debounced recompile (600 ms) | `dropcut-ide(1).jsx:1300-1308` |
| Trail via `drawRange` | `dropcut-ide(1).jsx:1123-1130, 972-980` |
| Modal G-code parser | `z1-gcode-checker-l2.jsx:97-230` |
| Arc reconstruction (I/J and R) | `z1-gcode-checker-l2.jsx:237-267` |
| Tool profile function | `z1-gcode-checker-l2.jsx:272-281` |
| `StockSim` stamp and sweep | `z1-gcode-checker-l2.jsx:287-379` |
| Whole-program checks | `z1-gcode-checker-l2.jsx:383-425` |
| Incremental sim with reset-on-rewind | `z1-gcode-checker-l2.jsx:860-880` |

## External standards

- **NIST RS274NGC Interpreter, Version 3** — the canonical-machining-functions
  model this architecture inverts. <https://www.nist.gov/publications/nist-rs274ngc-interpreter-version-3>
- **ISO 14649-10 (STEP-NC)** — feature-based manufacturing data model; the source
  of "keep manufacturing features, do not collapse to axis motion".
  <https://www.iso.org/standard/40895.html>
- **LinuxCNC G-code overview** — the modal-group reference.
  <https://www.linuxcnc.org/docs/2.9/html/gcode/overview.html>



