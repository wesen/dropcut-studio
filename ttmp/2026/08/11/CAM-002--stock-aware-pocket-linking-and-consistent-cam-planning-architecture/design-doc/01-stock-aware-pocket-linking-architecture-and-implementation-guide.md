---
Title: Stock-aware pocket linking architecture and implementation guide
Ticket: CAM-002
Status: active
Topics:
    - cam
    - toolpath
    - gcode
    - safety
    - architecture
DocType: design-doc
Intent: long-term
Owners: []
RelatedFiles:
    - Path: /home/manuel/code/wesen/2026-08-09--cam-software/apps/studio/src/state/compileThunk.ts
      Note: End-to-end Studio pipeline from script through recertification
    - Path: /home/manuel/code/wesen/2026-08-09--cam-software/packages/analysis/src/dexel.ts
      Note: |-
        Existing sampled stock-removal model that can validate but does not guide planning
        Existing sampled evolving stock model
    - Path: /home/manuel/code/wesen/2026-08-09--cam-software/packages/planner/src/entry.ts
      Note: |-
        Helix-ramp-plunge entry planner and its clearance callback
        Entry planning semantics
    - Path: /home/manuel/code/wesen/2026-08-09--cam-software/packages/planner/src/linker.ts
      Note: |-
        Current generic distance and part-surface based stay-down decision
        Conservative generic link decision
    - Path: /home/manuel/code/wesen/2026-08-09--cam-software/packages/planner/src/run.ts
      Note: |-
        Operation runner that orders paths and turns links and entries into canonical commands
        Planner orchestration for ordering links entries and emission
    - Path: /home/manuel/code/wesen/2026-08-09--cam-software/packages/planner/src/types.ts
      Note: |-
        ManufacturingPlan and ToolpathSet contracts that currently omit cleared-stock facts
        Strategy and plan contracts
    - Path: /home/manuel/code/wesen/2026-08-09--cam-software/packages/strategies/src/pocket.ts
      Note: |-
        Current rectangular pocket geometry and repeated per-level center starts
        Current pocket geometry and per-depth path generation
ExternalSources: []
Summary: Evidence-backed design for fixing repeated pocket retracts and evolving DROPCUT toward explicit linking policies, removal-aware planning, and consistently testable CAM contracts.
LastUpdated: 2026-08-11T16:35:00-04:00
WhatFor: Guide an intern through the current CAM pipeline and a safe phased implementation of efficient pocket level transitions and stock-aware linking.
WhenToUse: Read before changing pocket toolpaths, entry moves, linking, path ordering, stock simulation, or the public JavaScript pocket API.
---


# Stock-aware pocket linking architecture and implementation guide

## 1. Executive summary

DROPCUT currently machines a rectangular pocket as one independent concentric path for every depth level. Each path starts at the pocket centre and ends at the outer corner. The generic planner sees the outer-corner-to-centre gap, cannot prove that the material between those points has already been removed, retracts to at least the stock top, moves to the centre, and enters again. The result is safe but visibly inefficient: an 8 mm pocket with 2 mm stepdowns repeats four retract-and-entry cycles inside one pocket.

This is not a JavaScript-program error. It follows directly from the current contracts. `planRectPocket` knows that the interior has been cleared, but returns only independent `Path` values. `runPlan` owns linking, but receives no description of the cleared region. `planLink` sees the static part surface rather than evolving stock. Each layer behaves consistently with the information it has; the information needed for an efficient decision is lost at the strategy boundary.

The recommended work is deliberately phased:

1. **Correct the rectangular-pocket behavior locally.** Emit one continuous pocket path that returns to the already-cleared centre at each level, descends under cutting feed, and continues outward. Retract only once when the operation is complete. This is small, reviewable, and does not weaken the generic linker.
2. **Make transition intent explicit.** Replace the assumption that every `ToolpathSet.paths` member is an unrelated contour with typed machining spans and links. Preserve operation sequence and Z-level semantics rather than greedily reordering paths using XY distance alone.
3. **Introduce a conservative removal-state interface.** Let link planning ask whether a swept tool volume is known clear. Start with exact analytic regions produced by 2.5D operations; later add a coarse evolving stock model for general 3D links.
4. **Expose policy without exposing unsafe primitives.** Add high-level `entry`, `linking`, and `order` options to the pocket API only after the behavior and diagnostics exist internally. `keepToolDown` must be a preference constrained by clearance proof, never a command to bypass safety.

The immediate fix is feasible without a full stock model. The broader architecture is worthwhile because the same missing knowledge affects z-level roughing, contour ordering, rest machining, minimum retracts, and future fixture or holder checks.

## 2. Problem statement and scope

### 2.1 Observed behavior

For this operation:

```js
job.rectPocket({
  x: mm(7.5), y: mm(2.5), w: mm(13), h: mm(13),
  depth: mm(8), stepdown: mm(2), stepover: 0.4,
  feed: mmPerMin(600), plungeFeed: mmPerMin(200),
});
```

with a 3.175 mm flat end mill, the strategy computes four levels: −2, −4, −6, and −8 mm. The viewport shows repeated vertical move columns at the same centre position. Every level starts its ring set from the centre rather than continuing from the previous level.

The operation should instead have one initial entry, continuous within-pocket transitions, and one final retract, provided every transition remains inside material already removed by the earlier level.

### 2.2 Scope

This ticket designs:

- a safe immediate fix for rectangular pockets;
- consistent internal representations for geometry, cutting spans, links, and entries;
- a removal-aware query contract for later planner improvements;
- public API evolution for pocket entry, linking, and ordering;
- diagnostics, provenance, tests, simulation, and rollout criteria;
- an intern-oriented map of every relevant layer.

This ticket does **not** implement the changes. It also does not claim full industrial stock-model equivalence, fixture collision checking, holder simulation, trochoidal/adaptive clearing, or automatic feeds-and-speeds selection. Those are future capabilities that can use the proposed foundation.

## 3. Vocabulary and mental model

Before reading the code, distinguish these terms:

- **Manufacturing plan:** Declarative operations, tools, stock, feeds, and parameters. It contains no controller motion.
- **Strategy:** Geometry algorithm that turns one operation into one or more paths.
- **Path:** Continuous geometric motion from one work-coordinate point to another.
- **Entry:** Controlled descent from a known height to the start of a cutting span; currently helix, ramp, or plunge.
- **Link:** Motion between cutting spans. A link may stay down, lift locally, or retract.
- **Traverse:** Non-cutting positioning motion with clearance semantics.
- **Canonical program:** Controller-independent commands such as tool change, spindle, traverse, and cut.
- **Lowering:** Capability-driven conversion of canonical motion for one machine, such as arc linearisation and feed clamping.
- **Validation:** Exact checks over machine limits and command state.
- **Sampled checks:** Discrete simulation over emitted motion and a finite stock grid.
- **Removal state:** Planner knowledge of which swept tool volumes are already clear.
- **Certificate:** An honest record of what was established exactly, to a stated resolution, skipped, or unverifiable.

The central design rule is:

> Geometry generation may assert where cutting should occur, but only a clearance proof may authorize a non-retract link through the workpiece.

## 4. Current architecture: script to machine motion

### 4.1 End-to-end flow

The Studio uses the same pipeline as the CLI. `apps/studio/src/state/compileThunk.ts:54-151` is the clearest executable map.

```text
JavaScript source
      │
      ▼
@cam/script-host
  runScript() ───────────────► ManufacturingPlan
      │
      ▼
@cam/planner + @cam/strategies
  runPlan(dispatchStrategy) ─► CanonicalProgram<"work">
      │
      ▼
@cam/compiler
  lower(machine) ────────────► MachineProgram
  validate(machine) ─────────► ValidatedProgram
      │
      ▼
@cam/post-*
  emit ──────────────────────► G-code + emitted motion
      │
      ▼
@cam/analysis
  sampled checks ────────────► diagnostics + finite-resolution evidence
  recertify ─────────────────► updated safety certificate
      │
      ├────────► viewport buffers
      ├────────► diagnostics and operation summaries
      └────────► downloadable .NC
```

This separation is valuable. It prevents a strategy from emitting controller-specific strings, requires validation before postprocessing, and keeps sampled evidence distinct from exact checks. The design should preserve those boundaries.

### 4.2 Declarative operation contract

`packages/planner/src/types.ts:40-105` defines operation records. `PocketOp` currently contains:

```ts
interface PocketOp extends OperationBase {
  kind: "pocket";
  area: Box2;
  depth: Mm;
  stepdown: Mm;
  stepover: Ratio;
}
```

The operation has dimensions and cutting parameters, but no entry policy, linking preference, pocket ordering, corner radius, finish allowance, or stock-to-leave field. The JavaScript API in `packages/script-host/src/api.ts` mirrors that shape.

This is an acceptable minimal API, but it means the implementation silently chooses important machining behavior. Hidden defaults are especially risky when the fallback can be a vertical plunge.

### 4.3 Strategy dispatch

`packages/strategies/src/registry.ts` switches on `Operation.kind`. Pocket operations call `planRectPocket` with the area, depth, stepdown, and stepover. This registry gives one dependency direction: strategies know planner types, while the planner receives a dispatch function and does not import concrete strategies.

Preserve this inversion. New strategy capabilities should enter through richer return contracts or planning context services, not by making the planner import pocket-specific code.

### 4.4 Rectangular-pocket geometry

`packages/strategies/src/pocket.ts:92-152` performs these steps:

1. Compute tool radius and actual stepover from the loaded tool diameter.
2. Compute the centre and tool-centre-reachable half extents.
3. Reject a pocket too small for the tool.
4. Build Z levels from stock top to requested depth.
5. For every level, start a new path at the centre.
6. Grow rectangular rings outward by one stepover.
7. Return all level paths as one `ToolpathSet`.

The current ring geometry is:

```text
centre C
  │
  └──► upper-right of ring 1
       ◄────────────┐
       │            │
       └────────────┘
       diagonal/outward connector
       ◄─────────────────┐
       │                 │
       └─────────────────┘  end E at outer upper-right
```

For each deeper level, the same structure starts again at `C`. The comment at lines 88-90 says the centre is open air cleared by the previous level. That statement is the key safety fact, but it is not represented in `ToolpathSet`.

### 4.5 ToolpathSet loses machining semantics

`packages/planner/src/types.ts:109-123` describes a toolpath set as independent paths whose linking belongs to the planner:

```ts
interface ToolpathSet {
  paths: readonly Path<"work">[];
  purpose: CuttingPurpose;
  description: string;
  stepover: Mm;
  diagnostics?: readonly Diagnostic[];
}
```

This contract carries geometry but not topology or clearance evidence. It cannot express:

- path 2 must follow path 1 because it is a deeper level;
- the centre corridor was cleared at level 1;
- the link may descend only after returning to the centre;
- a path may be reversed but not reordered across levels;
- a local lift is allowed inside this pocket;
- the outer corner-to-centre link is safe at one Z but not another.

The contract therefore forces the planner to infer semantics from endpoints and static surfaces.

### 4.6 Generic ordering and linking

`packages/planner/src/run.ts:122-175` does three things for each toolpath set:

1. `orderPaths` greedily chooses the nearest path in XY.
2. `planLink` chooses stay-down or retract between paths.
3. `entryCommands` creates an entry after the first traverse or any retract.

The current path ordering in `packages/planner/src/linker.ts:165-225` uses XY distance only. It does not include Z in its nearest-neighbour cost and does not know that pocket levels have a required order. The current pocket happens to use identical centre starts and array order, but the contract does not guarantee semantic level ordering under future geometry changes.

The linker allows a stay-down move only if:

```text
XY gap <= max(3 × stepover, 1.5 mm)
AND
static surface samples do not rise above interpolated tool Z
```

For a 13 mm pocket with a 3.175 mm tool at 40% stepover:

```text
stepover = 1.27 mm
stay-down limit = 3.81 mm
outer reachable half-width = 13/2 − 3.175/2 = 4.9125 mm
outer-corner-to-centre gap ≈ sqrt(4.9125² + 4.9125²) = 6.95 mm
```

The distance test alone rejects the link. The planner retracts to a `safeZ` floored by `stockTopZ` (`linker.ts:102-122`), moves to the next centre, then calls entry planning. That explains the repeated vertical columns.

### 4.7 Entry planning

`packages/planner/src/entry.ts:1-84` correctly states the mechanical concern: an end mill has zero surface speed at its centre, so straight plunging is hard on the tool. The preference order is helix, ramp, then plunge. A clearance callback decides whether the geometry fits.

The runner currently supplies entry mode `auto` only for rough-surface operations; pockets are passed as plunge mode by `entryCommands` in `run.ts` (see the operation-specific mode branch below the main loop). Therefore repeated pocket restarts can become repeated vertical plunges. A pocket API has no `entry` option today, even though `EntrySpec` already exists for roughing.

### 4.8 Validation and simulation

`packages/compiler/src/validate.ts:49-200` checks machine travel, spindle range and direction, tool/spindle/feed interlocks, positive feed, path continuity, and suspicious individual move length. These checks are important but cannot establish that a cutting link stays inside previously removed material.

The sampled stock model in `packages/analysis/src/dexel.ts` does track evolving column heights. It is used after emission by `runSampledChecks`, and `compileThunk.ts:105-134` folds that evidence into the certificate. It is a verifier, not a planning oracle.

This distinction matters:

```text
planner asks: "May I generate this link?"
validator asks: "Does command structure satisfy exact invariants?"
simulator asks: "At sampled points, did emitted motion collide or gouge?"
```

A post-emission simulator can reject a bad plan, but it cannot choose a better link unless its removal-state interface is moved or shared with planning.

## 5. Root cause analysis

The repeated retract is the visible symptom. The architectural root cause is an information mismatch.

| Layer | Knowledge available | Knowledge missing |
|---|---|---|
| Pocket strategy | Ring geometry, level order, cleared centre | Global machine state, fixture/holder state |
| ToolpathSet | Independent paths and stepover | Dependencies, cleared regions, link permissions |
| Generic linker | Endpoints, static part surface, stock top | Evolving removal state and operation topology |
| Validator | Full command stream and machine limits | Continuous solid stock state |
| Dexel simulation | Approximate evolving stock after emission | Ability to revise planner choices |

The current code is conservative where information is absent. That is preferable to an unsafe shortcut, but it produces inconsistent behavior and makes future optimization difficult.

### 5.1 Why increasing `stayDownDistance` is not a fix

Changing the threshold from three stepovers to a large value would make the pocket appear better, but would authorize links based on proximity rather than proof. A short link can cross an uncut island; a long link can be safe through a cleared cavity. Distance is a cost heuristic, not a collision predicate.

### 5.2 Why disabling retracts is not a fix

A global “keep tool down” switch cannot mean “emit direct motion regardless of stock.” Industrial-style settings are preferences subject to safety constraints. If the planner cannot prove a link, it must retract or emit a diagnostic.

### 5.3 Why one continuous path is safe only with an invariant

The local pocket strategy can create a continuous path because it generated the cleared area itself. The required invariant is:

> At transition from level `z_i` to `z_(i+1)`, every XY point swept while returning to the entry point lies inside the cutter-centre region cleared at `z_i`; descent occurs at an entry location known clear down to `z_i`, and the incremental descent to `z_(i+1)` is emitted as cutting motion at plunge/ramp feed.

This does not authorize arbitrary links between operations or pockets.

## 6. Proposed architecture

## 6.1 Phase 1 design: continuous rectangular pocket

The smallest safe change belongs in `planRectPocket`. Build one `PathBuilder` for the whole pocket rather than one path per level.

At each level:

1. Descend at the centre from the previous level to the new level using a controlled segment.
2. Cut rings from the centre outward.
3. Return from the outer ring to the centre at the current level along a route wholly inside the cleared area, unless this is the final level.
4. Repeat.

```text
clearance
    │ initial entry (planner-owned)
    ▼
C at Z−2 ── rings outward ── E at Z−2
  ▲                              │
  └──── cleared return path ◄────┘
    │ controlled stepdown
    ▼
C at Z−4 ── rings outward ── E at Z−4
  ▲                              │
  └──── cleared return path ◄────┘
    │
   ...
    │
E at final depth
    │ one operation-end retract
    ▼
clearance
```

A simple first implementation can reverse the same radial/ring connector route used while growing outward. A better implementation records a centre-to-outer “spine” through already-cut ring corners and traverses that spine in reverse. Do not use a direct diagonal unless a swept-tool containment test proves it remains inside the cleared centre region.

### Phase 1 pseudocode

```ts
function planRectPocket(ctx, params): ToolpathSet {
  validatePocketAndParameters();
  const levels = computeLevels(topZ, depth, stepdown);
  const rings = computeRectangleRings(area, toolRadius, stepover);

  const builder = pathFrom(point(center.x, center.y, levels[0]));

  for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
    const z = levels[levelIndex];

    if (levelIndex > 0) {
      // Current point must be the centre at the previous level.
      builder.lineTo(point(center.x, center.y, z));
    }

    const outboundSpine = [];
    for (const ring of rings) {
      builder.lineTo(ring.startAt(z));
      outboundSpine.push(ring.startAt(z));
      appendClosedRectangle(builder, ring, z);
    }

    if (levelIndex < levels.length - 1) {
      for (const p of reverse(outboundSpineWithoutCurrent())) {
        builder.lineTo(p);
      }
      builder.lineTo(point(center.x, center.y, z));
    }
  }

  return {
    paths: [builder.build()],
    purpose: "rough",
    description: ...,
    stepover: mm(actualStep),
  };
}
```

The exact return route should be generated by a named helper such as `appendClearedReturnToCenter`. The helper name makes the safety claim reviewable and testable.

### Feed limitation in the current IR

One `CutCmd` carries one feed for its entire path. A continuous path containing both XY cutting and Z descent cannot assign `plungeFeed` only to vertical segments. Encoding it as one path would run descent at the general cutting feed, which is not acceptable.

Therefore Phase 1 should not blindly collapse everything into one `Path`. Choose one of these representations:

- return a sequence of typed spans with per-span feed intent; or
- keep one operation-local ordered sequence of paths, but mark required safe links and stepdowns explicitly so `runPlan` emits descent at `plungeFeed` without retracting.

The second option is the smallest safe patch and leads naturally into Phase 2.

## 6.2 Phase 2 design: typed machining spans

Replace `ToolpathSet.paths` as the sole strategy output with an ordered program fragment. Geometry stays separate from link policy, but the strategy can preserve dependencies and attach proof obligations.

```ts
type StrategySpan =
  | {
      kind: "cut";
      id: string;
      path: Path<"work">;
      purpose: CuttingPurpose;
      feedRole: "cut" | "plunge" | "finish";
      reorder: "fixed" | "within-group";
      groupId?: string;
    }
  | {
      kind: "link-request";
      fromSpanId: string;
      toSpanId: string;
      preference: "stay-down" | "minimum-lift" | "retract";
      proof: ClearanceProof;
    };

interface ToolpathPlan {
  spans: readonly StrategySpan[];
  description: string;
  diagnostics?: readonly Diagnostic[];
}
```

For a pocket, the spans would be:

```text
entry-to-Z1
cut-level-Z1
cleared-return-Z1
stepdown-Z1-to-Z2
cut-level-Z2
...
```

The generic planner still emits commands and enforces machine-independent policy. The strategy supplies operation-specific topology and a clearance proof that the planner can verify.

### Clearance proof types

Begin with narrow proof types rather than arbitrary callbacks hidden in strategy code:

```ts
type ClearanceProof =
  | { kind: "none" }
  | {
      kind: "inside-analytic-pocket";
      pocket: Box2;
      toolRadius: Mm;
      clearedToZ: Mm;
    }
  | {
      kind: "removal-state";
      stateRevision: number;
    };
```

An analytic rectangular-pocket proof is deterministic and cheap. It can test the swept cutter centreline against the inset rectangle. The later removal-state proof asks a shared stock model.

### Span compiler pseudocode

```ts
for (const span of strategyPlan.spans) {
  switch (span.kind) {
    case "cut":
      emitCut(span.path, feedFor(span.feedRole));
      removalState.applyCut(span.path, tool);
      cursor = span.path.end;
      break;

    case "link-request":
      const decision = linkPlanner.decide({
        cursor,
        destination: startOf(span.toSpanId),
        preference: span.preference,
        proof: span.proof,
        removalState,
        toolAssembly,
      });
      emit(decision.commands);
      cursor = decision.end;
      break;
  }
}
```

## 6.3 Phase 3 design: conservative evolving removal state

The repository already contains `DexelSim`, a sampled heightmap that mutates as tools sweep through stock. Reusing its concepts is sensible, but the planner contract should not directly depend on the verifier class. Planning and verification have different failure semantics and resolution requirements.

Define a small interface in `@cam/planner` or a lower-level stock package:

```ts
interface RemovalState {
  readonly revision: number;

  /** Record material removed by an accepted cut. */
  applyCut(path: Path<"work">, tool: ToolGeometry, tolerance: Mm): void;

  /** Conservative answer: true only when the entire swept volume is known clear. */
  isSweepClear(request: SweepClearanceRequest): ClearanceResult;

  snapshot(): RemovalSnapshot;
}

type ClearanceResult =
  | { kind: "clear"; method: "analytic" | "sampled"; resolution?: Mm }
  | { kind: "blocked"; maximumEngagement: Mm }
  | { kind: "unknown"; reason: string };
```

A planner must treat `unknown` as “retract or diagnose,” never as clear.

### Conservative sampled query

```text
candidate link path
      │
      ▼
sample centreline no coarser than min(cell size, tool radius / 2)
      │
      ▼
for each sample:
  evaluate full cutter footprint against current stock heights
      │
      ├── any possible intersection ──► blocked/unknown
      └── no intersection + error margin ─► clear-to-resolution
```

To avoid optimistic aliasing, inflate the cutter footprint and stock heights by a numerical margin related to cell size and chord tolerance. Record the resolution used in provenance and diagnostics.

### Analytic first, sampled second

For 2.5D rectangular pockets, analytic containment is stronger and cheaper than a grid. Use it first. Use sampled removal state for general links only when its resolution is adequate for the tool and feature size.

```text
link candidate
   │
   ├── analytic proof available? ─ yes ─► exact clear/blocked
   │
   └── no
       ├── stock model resolution adequate? ─ yes ─► sampled clear/blocked
       └── no ─► unknown ─► retract
```

## 6.4 Link-policy model

The API should separate preference from authorization.

```ts
type LinkPreference =
  | { mode: "retract" }
  | { mode: "minimum-lift"; lift: Mm; maxDistance?: Mm }
  | { mode: "stay-down"; maxDistance?: Mm }
  | { mode: "auto"; lift: Mm; maxDistance?: Mm };
```

Semantics:

- `retract`: always use the configured clearance plane.
- `minimum-lift`: attempt a local lift through known-clear space; retract if proof fails.
- `stay-down`: prefer feed links in known-clear space; retract if proof fails.
- `auto`: choose the lowest-cost authorized option.

No mode bypasses clearance checks.

The decision cost can evolve independently:

```ts
cost(decision) =
    rapidSeconds
  + cuttingLinkSeconds
  + entrySeconds
  + retractPenalty
  + directionChangePenalty
  + riskPenalty;
```

Start with deterministic priority rather than overfitting an elaborate cost function.

## 6.5 Pocket ordering model

A grid of pockets introduces operation-level ordering distinct from links inside one pocket.

```ts
type RegionOrder =
  | "complete-region"   // finish all depths of pocket 1, then pocket 2
  | "by-level"          // machine every pocket at Z1, then every pocket at Z2
  | "auto";
```

`complete-region` minimizes inter-pocket retracts and is the natural interpretation of repeated `job.rectPocket` calls. `by-level` can improve chip evacuation or load consistency but requires a grouped/multi-region operation API; the current script creates 60 independent operations, so the planner retracts after every operation (`run.ts:178-185`).

A future grid helper should create one grouped operation rather than requiring users to loop over 60 independent operations:

```js
job.rectPocketPattern({
  slot: { w: mm(13), h: mm(13), depth: mm(8) },
  pattern: {
    columns: 6,
    rows: 10,
    pitchX: mm(15),
    pitchY: mm(15),
    origin: { x: mm(7.5), y: mm(2.5) },
  },
  stepdown: mm(2),
  stepover: 0.4,
  order: "complete-region",
  entry: entry.auto({ maxRampAngle: deg(3) }),
  linking: linking.auto({ lift: mm(0.5) }),
  feed: mmPerMin(600),
  plungeFeed: mmPerMin(200),
});
```

This API sketch is future scope. It should be introduced only after the internal contracts support grouped regions and after layout validation checks margins, overlap, stock bounds, and tool accessibility.

## 7. Proposed immediate internal API

To keep Phase 1 small while preserving plunge feed, extend the strategy result with fixed link hints:

```ts
interface ToolpathSet {
  paths: readonly Path<"work">[];
  transitions?: readonly PathTransition[]; // length paths.length - 1
  purpose: CuttingPurpose;
  description: string;
  stepover: Mm;
  diagnostics?: readonly Diagnostic[];
}

type PathTransition =
  | { kind: "generic" }
  | {
      kind: "cut-link";
      path: Path<"work">;
      feedRole: "cut" | "plunge";
      proof: AnalyticClearanceProof;
    };
```

For each pocket level boundary, emit two explicit transitions:

1. outer corner back to centre at the old Z using cut feed;
2. centre from old Z to new Z using plunge feed.

If two transitions per boundary do not fit a one-transition-per-gap shape, represent each as a strategy span immediately rather than forcing an awkward temporary type.

A robust implementation should favor the span model if it adds no more than a modest amount of code. Do not preserve a simplistic interface at the cost of losing feed semantics.

## 8. Decision records

### Decision: Keep the generic linker conservative

- **Context:** The current linker lacks evolving stock knowledge.
- **Options considered:** Increase stay-down distance; disable retracts; special-case pockets in the linker; add explicit clearance evidence.
- **Decision:** Do not weaken generic link checks. Add operation-specific evidence or explicit spans.
- **Rationale:** Distance does not prove clearance. A generic shortcut could cross uncut islands or stock.
- **Consequences:** The immediate change needs a richer strategy-to-planner contract or a continuous operation fragment.
- **Status:** proposed

### Decision: Preserve per-segment feed intent

- **Context:** Pocket transitions need cutting feed for XY return and plunge feed for Z descent.
- **Options considered:** One continuous `Path` at cutting feed; one path at plunge feed; separate commands/spans with feed roles.
- **Decision:** Represent feed roles explicitly and emit separate `CutCmd` spans where feeds differ.
- **Rationale:** A visually continuous path is not sufficient if its descent runs at an unsafe feed.
- **Consequences:** `ToolpathSet` must evolve beyond a plain array of homogeneous paths.
- **Status:** proposed

### Decision: Use analytic pocket clearance before a sampled stock model

- **Context:** Rectangular pocket geometry gives exact known-clear regions, while a grid introduces approximation.
- **Options considered:** Build full stock tracking first; reuse `DexelSim` immediately; analytic local proof first.
- **Decision:** Implement analytic pocket containment for Phase 1/2 and add sampled removal state later.
- **Rationale:** It solves the reported behavior with a smaller, stronger proof.
- **Consequences:** General roughing links remain conservative until Phase 3.
- **Status:** proposed

### Decision: Treat user linking settings as preferences

- **Context:** Professional CAM exposes keep-down/minimum-retract controls, but users should not be able to authorize collisions.
- **Options considered:** Boolean `keepToolDown`; raw link mode; constrained high-level policy.
- **Decision:** Expose a preference that falls back to retract when clearance is blocked or unknown.
- **Rationale:** Safety authorization remains planner-owned.
- **Consequences:** Diagnostics should explain when and why a preference degraded.
- **Status:** proposed

### Decision: Keep planning and certification epistemically separate

- **Context:** The post-emission simulator already tracks sampled stock, but certification must state the strength of evidence honestly.
- **Options considered:** Let successful planning imply certificate pass; share a stock kernel while preserving separate results; use simulator output directly as exact proof.
- **Decision:** Share geometry/removal primitives if useful, but keep planner authorization and certificate status separate.
- **Rationale:** A sampled model is not exact, and a planner decision does not prove emitted controller motion.
- **Consequences:** The final emitted motion must still be simulated and recertified.
- **Status:** proposed

## 9. Diagnostics and provenance

Every optimized transition should remain explainable in the UI and emitted artifact.

Suggested diagnostic codes:

- `link.optimizedStayDown`: informational; a link stayed down using a named proof.
- `link.minimumLift`: informational; a local lift was selected.
- `link.degradedToRetract`: informational or warning; preference could not be proven safe.
- `link.stockResolutionInsufficient`: warning; sampled stock grid was too coarse for tool/feature size.
- `entry.degraded`: already exists; continue using it when helix/ramp does not fit.
- `pocket.invalidStepdown`: error for non-positive or non-finite values.
- `pocket.invalidDepth`: error when depth is non-positive or exceeds permitted floor.
- `pocket.invalidStepover`: error when ratio is outside the accepted machining range.

Provenance should identify:

```ts
interface ProvenanceExtension {
  operationId: string;
  strategyName: string;
  spanId: string;
  levelIndex?: number;
  regionIndex?: number;
  transitionKind?: "entry" | "cut" | "return" | "stepdown" | "link";
  clearanceMethod?: "analytic-pocket" | "sampled-stock" | "global-retract";
  stockRevision?: number;
}
```

The current `pathIndex` alone is not enough to explain a multi-level pocket.

## 10. Parameter validation gaps

While implementing this ticket, add explicit validation close to strategy entry. The current loops rely on arithmetic and a 100,000-iteration guard. Validate before geometry generation:

- `depth > 0` and finite;
- `stepdown > 0` and finite;
- `0 < stepover <= 1` unless a documented strategy allows otherwise;
- area width and height are positive;
- tool diameter and required flute length are compatible with depth where data exists;
- target floor does not go below `setup.floorZ`;
- pocket inset by tool radius is non-empty;
- entry geometry fits the inset region;
- grouped pockets do not overlap and stay within intended stock bounds.

Tool flute length exists on `Tool`, but holder and stickout are explicitly not checked in the current certificate. If flute length is known and depth exceeds it, issue an error or strong warning; do not imply holder safety.

## 11. Detailed implementation plan for an intern

### Phase 0: Establish a measurable baseline

Start by adding a focused fixture for a 13 × 13 × 8 mm pocket with a 3.175 mm tool and 2 mm stepdown.

Record:

- number of level paths;
- number of traverse commands inside the operation;
- number and length of vertical entries;
- cut length, rapid length, and estimated duration;
- minimum and maximum Z;
- sampled rapid-crash diagnostics;
- emitted G-code motion sequence.

Commands:

```bash
pnpm test -- packages/strategies/src/pipeline.test.ts
pnpm typecheck
```

Add assertions before changing behavior. A test that only checks “compile succeeds” will not detect the regression.

### Phase 1: Add strict pocket parameter checks

Files:

- `packages/strategies/src/pocket.ts`
- `packages/strategies/src/pipeline.test.ts`

Create helpers:

```ts
validatePocketParams(ctx, params): Diagnostic[] | throws
computeDepthLevels(topZ, depth, stepdown): number[]
computeRectRings(area, toolRadius, step): RectRing[]
```

Tests must cover exact division and a final partial stepdown. For depth 7 and stepdown 2, levels must be `[-2, -4, -6, -7]`, not `[-2, -4, -6]` or `[-2, -4, -6, -8]`.

### Phase 2: Introduce ordered spans or explicit transitions

Files:

- `packages/planner/src/types.ts`
- `packages/planner/src/run.ts`
- `packages/strategies/src/pocket.ts`
- planner and strategy tests

Do not immediately migrate every strategy. Support both legacy path sets and ordered spans during development only if the migration is completed in the same ticket branch; avoid a permanent compatibility layer unless required.

Recommended shape:

```ts
interface ToolpathSet {
  readonly sequence: readonly StrategyMotion[];
  readonly description: string;
  readonly stepover: Mm;
  readonly diagnostics?: readonly Diagnostic[];
}
```

Write a small adapter for existing strategies in the registry, then migrate each deliberately.

### Phase 3: Emit pocket return and stepdown spans

Files:

- `packages/strategies/src/pocket.ts`
- `packages/planner/src/run.ts`

For each non-final level:

1. generate an XY return path at the completed level;
2. attach an analytic pocket-clearance proof;
3. generate a vertical or ramped stepdown span with `feedRole: "plunge"`;
4. preserve fixed ordering.

The initial entry remains planner-owned. Add `entry` to `PocketOp` and the script API so it can use the existing helix/ramp/plunge machinery.

### Phase 4: Add analytic swept-centre containment

Files:

- new `packages/planner/src/clearance.ts`
- `packages/planner/src/linker.ts`
- tests under `packages/planner/src`

For a flat end mill in an axis-aligned rectangular pocket, the cutter centre must remain inside the pocket inset by the tool radius. Sample or analytically bound every line segment of the proposed return path. Because the inset is convex, both endpoints inside the inset imply the complete straight segment is inside. For arcs or polylines, validate each segment or sampled arc conservatively.

```ts
function provePathInsideInsetBox(path, box, radius): boolean {
  const inset = insetBox(box, radius);
  for (const segment of path.segments) {
    if (!segmentEntirelyInsideConvexBox(segment, inset)) return false;
  }
  return true;
}
```

This proves lateral containment, not that deeper material is cleared. Associate the proof with `clearedToZ` and reject any link below that level.

### Phase 5: Migrate generic ordering semantics

Files:

- `packages/planner/src/linker.ts`
- `packages/planner/src/types.ts`
- all strategy implementations and tests

Make reorderability explicit. Do not let `orderPaths` reorder fixed depth sequences. For reorderable contour groups, include Z and estimated transition mode in cost.

```ts
if (group.order === "fixed") preserveInputOrder();
else nearestNeighborWithinGroup({ includeZ: true, allowReverse: group.allowReverse });
```

Closed contour rotation is a separate optimization. Do not reverse or rotate contours unless direction and climb/conventional semantics are modeled.

### Phase 6: Add removal-state service

Files:

- likely new `packages/stock` or `packages/planner/src/removal-state.ts`;
- `packages/analysis/src/dexel.ts` refactored to share kernels rather than planner importing verifier policy;
- `packages/planner/src/run.ts` and `linker.ts`;
- certificate and integration tests.

Start with a heightmap because this is a three-axis system and `DexelSim` already demonstrates the representation. Define conservative margins and unknown behavior. Benchmark memory and planning time on the 200k-motion fixture.

### Phase 7: Public API and handbook

Files:

- `packages/script-host/src/api.ts`
- `packages/script-host/src/examples.ts`
- `packages/script-host/src/sandbox.test.ts`
- `docs/javascript-api-handbook.md`
- `apps/studio/src/ui/ApiHandbook.tsx`

Proposed pocket API:

```js
job.rectPocket({
  x, y, w, h,
  depth,
  stepdown,
  stepover,
  entry: entry.auto({ maxRampAngle: deg(3) }),
  linking: linking.auto({ lift: mm(0.5), maxDistance: mm(30) }),
  feed,
  plungeFeed,
});
```

Defaults should preserve safety and document behavior changes. Update examples and integration tests rather than adding silent backwards-compatibility shims.

### Phase 8: UI observability

Add an operation-detail view or diagnostics summary showing:

- depth levels;
- entry type selected;
- number of stay-down, minimum-lift, and retract links;
- degraded links and reasons;
- rapid and cut distance attributable to links;
- stock-model resolution used for sampled authorization.

The viewport should color entry, cutting, return, and retract motions distinctly when debugging.

## 12. Test and validation strategy

### 12.1 Unit tests

Pocket geometry:

- exact requested depth with partial final stepdown;
- actual tool diameter controls stepover;
- too-small pockets fail;
- invalid depth, stepdown, and stepover fail quickly;
- return paths remain inside the inset pocket;
- level sequence remains fixed;
- final level does not add an unnecessary return-to-centre unless required by exit policy.

Link planning:

- analytic proof accepts a contained return path;
- proof rejects a path touching/crossing the wall after tool-radius inset;
- unknown proof degrades to retract;
- minimum-lift never goes below known stock;
- feed roles map to `feed` and `plungeFeed` correctly.

### 12.2 Property tests

Use `fast-check`, already present in the repository, to generate valid rectangles, tool diameters, depths, stepdowns, and stepovers.

Properties:

```text
all cut points lie within tool-centre reachable pocket bounds
all Z values are between stock top and requested bottom
maximum adjacent depth drop <= requested stepdown
final cutting level == topZ - depth
sequence is continuous within each emitted span
no fixed sequence is reordered
all optimized links have a successful clearance proof
```

### 12.3 Golden motion tests

Assert semantic motion rather than brittle G-code formatting:

```text
old baseline: 4 internal retracts + 4 entries for one four-level pocket
new target:   0 internal global retracts + 1 initial entry + 3 controlled stepdowns
```

Keep one emitted G-code golden per postprocessor only where controller behavior matters.

### 12.4 Sampled simulation

Run the final emitted motion through `runSampledChecks` at multiple resolutions. The optimized path must not produce rapid-through-stock or floor gouge diagnostics. Use coarse and fine grids to detect resolution-sensitive behavior.

Simulation passing is necessary but not sufficient. The analytic pocket-link tests are the primary proof for the local optimization.

### 12.5 End-to-end grid fixture

Add the 6 × 10 Delrin pocket grid as a slow integration fixture or generated test:

- stock: 103 × 153 × 10 mm;
- tool: 3.175 mm flat end mill;
- slot: 13 × 13 mm;
- pitch: 15 mm;
- margins: 7.5 mm X and 2.5 mm Y;
- depth: 8 mm;
- stepdown: 2 mm.

Compare compile time, motion count, rapid distance, estimated time, and diagnostics before and after. Do not encode the proposed 600 mm/min and 12,000 rpm as universally safe Delrin values; they are fixture inputs, not recommendations.

### 12.6 Required validation commands

```bash
pnpm typecheck
pnpm test
pnpm --filter @studio/app build
pnpm dropcut -- compile <fixture.js> -m <target-machine> -o /tmp/pocket.nc
```

Manually inspect:

- viewport with entry/link coloring;
- operation summary counts;
- first pocket and transition between pockets;
- generated G-code around each depth transition;
- certificate entries and all diagnostics.

## 13. Risks and mitigations

| Risk | Failure mode | Mitigation |
|---|---|---|
| Continuous path hides feed changes | Vertical descent runs at XY cutting feed | Typed spans with `feedRole` |
| Optimistic clearance proof | Cutter crosses remaining material | Analytic inset proof; unknown means retract |
| Sampled stock aliasing | Thin wall falls between cells | Inflate conservatively; require adequate resolution |
| Path ordering crosses levels | Deeper level runs before shallower clearing | Fixed sequence metadata |
| Tool geometry assumptions | V-bit/ball/bull behaves unlike flat cutter | Limit analytic proof by supported geometry; diagnose fallback |
| Chip evacuation worsens | Staying down recuts chips in deep Delrin pockets | User policy, periodic retract option, grouped ordering |
| Entry overload | Small tool plunges repeatedly or cannot helix | Pocket `entry` option and degradation diagnostics |
| Performance regression | Stock updates dominate planning | Analytic fast paths, incremental updates, benchmarks |
| False safety impression | Passing certificate treated as machine authorization | Preserve explicit fixture/holder not-checked states |

## 14. Alternatives considered

### Keep current behavior

This is safe and simple, but wastes time, repeats tool-hostile entries, and fails user expectations for ordinary pocket clearing. It remains the fallback whenever optimized clearance is unknown.

### Build full volumetric CSG stock first

A volumetric model could represent more geometry than a heightmap, but it adds substantial complexity and is unnecessary for current three-axis, top-down operations. The repository already uses a heightmap successfully for simulation.

### Put all linking inside each strategy

Strategies know the geometry, so this is tempting. It would duplicate feed, clearance, provenance, and machine-independent motion policy across strategies—the same entanglement the current architecture was designed to remove. Strategies should supply topology and proof; the planner should authorize and emit links.

### Use emitted-motion simulation in a retry loop

The planner could generate a candidate, simulate it, and retry with retractions after failure. This is useful as a defense, but expensive and hard to reason about. It also makes behavior resolution-dependent. Prefer proof before emission, then simulate as independent verification.

## 15. Review guide

A reviewer should begin in this order:

1. `packages/strategies/src/pocket.ts:84-152` — understand level and ring generation.
2. `packages/planner/src/types.ts:107-123` — see what the strategy cannot express.
3. `packages/planner/src/run.ts:122-185` — follow ordering, linking, entry, and operation-end retract.
4. `packages/planner/src/linker.ts:21-163` — inspect the conservative clearance decision.
5. `packages/planner/src/entry.ts:24-177` — understand feed-controlled descent geometry.
6. `packages/compiler/src/validate.ts:49-200` — distinguish exact command checks.
7. `packages/analysis/src/dexel.ts:1-149` and `apps/studio/src/state/compileThunk.ts:105-134` — understand sampled post-emission stock checks.
8. `packages/strategies/src/pipeline.test.ts:253-303` — see current pocket coverage and missing assertions.

Questions for the second pair of eyes:

- Does the proposed return path have a rigorous swept-tool containment argument?
- Are feed changes represented without splitting away required sequence semantics?
- Can any generic reordering move a deeper span before its clearing prerequisite?
- Does `unknown` consistently cause a retract?
- Are sampled and exact claims labeled honestly?
- Do diagnostics make degraded entries and links visible?

## 16. Open questions

1. Should the first internal migration use `StrategyMotion[]` immediately, or add a short-lived transition field?
2. Should a pocket finish with the tool at its centre or outer boundary? The best exit depends on the next region and chip evacuation policy.
3. Which tool geometries are eligible for exact rectangular-pocket containment in the first release?
4. Should periodic chip-clear retracts be expressed by count, depth interval, elapsed cut time, or strategy policy?
5. Should grouped pocket patterns be a new operation or syntactic sugar that expands into a grouped plan record?
6. What minimum stock-grid resolution relative to tool diameter is acceptable for sampled link authorization?
7. Should flute-length violations be errors when flute length is known, given that stickout and holder geometry remain unknown?
8. How should climb/conventional direction constrain contour reversal and start-point rotation?

## 17. References

### Primary code

- `packages/script-host/src/api.ts` — JavaScript DSL construction of `PocketOp`.
- `packages/planner/src/types.ts:40-139` — operations, plan, strategy contract, planning context.
- `packages/strategies/src/registry.ts` — operation-to-strategy dispatch.
- `packages/strategies/src/pocket.ts:77-152` — current rectangular pocket implementation.
- `packages/planner/src/run.ts:105-193` — strategy execution, ordering, linking, entry, and retract.
- `packages/planner/src/linker.ts:21-225` — link policy and XY nearest-neighbour ordering.
- `packages/planner/src/entry.ts:22-182` — helix/ramp/plunge entry planning.
- `packages/ir/src/path.ts` — continuous path representation and composition.
- `packages/compiler/src/lower.ts` — machine-capability lowering.
- `packages/compiler/src/validate.ts` — exact validation and certificate construction.
- `packages/analysis/src/dexel.ts` — evolving sampled stock heightmap.
- `packages/analysis/src/checks.ts` — sampled rapid/gouge checks.
- `apps/studio/src/state/compileThunk.ts` — complete application pipeline.
- `packages/strategies/src/pipeline.test.ts:253-303` — existing pocket regression tests.

### Related ticket documentation

- `CAM-001/design-doc/01-dropcut-studio-architecture-analysis-and-implementation-guide.md` — original system-wide architecture.
- `CAM-001/reference/02-prototype-api-reference-and-code-map.md` — prior prototype code map and identified defects.
