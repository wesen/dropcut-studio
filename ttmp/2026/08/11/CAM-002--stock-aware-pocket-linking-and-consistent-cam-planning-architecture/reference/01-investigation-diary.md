---
Title: Investigation diary
Ticket: CAM-002
Status: active
Topics:
    - cam
    - toolpath
    - gcode
    - safety
    - architecture
DocType: reference
Intent: long-term
Owners: []
RelatedFiles:
    - Path: /home/manuel/code/wesen/2026-08-09--cam-software/packages/analysis/src/dexel.ts
      Note: |-
        Existing post-emission evolving stock model
        Existing sampled evolving stock model
    - Path: /home/manuel/code/wesen/2026-08-09--cam-software/packages/planner/src/linker.ts
      Note: |-
        Conservative static-surface link policy
        Conservative generic link decision
    - Path: /home/manuel/code/wesen/2026-08-09--cam-software/packages/planner/src/run.ts
      Note: |-
        Runner responsible for generic path links and repeated entry calls
        Planner orchestration for ordering links entries and emission
    - Path: /home/manuel/code/wesen/2026-08-09--cam-software/packages/planner/src/types.ts
      Note: |-
        Strategy contract whose missing clearance semantics shaped the design
        Strategy and plan contracts
    - Path: /home/manuel/code/wesen/2026-08-09--cam-software/packages/strategies/src/pocket.ts
      Note: |-
        Source of the observed repeated per-depth pocket starts
        Current pocket geometry and per-depth path generation
    - Path: repo://packages/planner/src/entry.ts
      Note: Entry planning semantics
ExternalSources: []
Summary: Chronological evidence and decisions behind the future stock-aware pocket-linking design.
LastUpdated: 2026-08-11T16:38:00-04:00
WhatFor: Resume the CAM-002 investigation without rediscovering the observed behavior, architecture, constraints, and proposed phases.
WhenToUse: Read before implementing or reviewing CAM-002.
---


# Diary

## Goal

Capture the evidence-first investigation and design of safe, efficient pocket-level transitions, then broaden that finding into a consistent CAM planning architecture suitable for implementation by a new intern.

## Step 1: Reproduce and trace the repeated pocket entry

The user supplied a 60-pocket Delrin program and a viewport screenshot showing repeated vertical motion at each pocket. I traced one `rectPocket` call from the JavaScript API through strategy generation and generic planner linking rather than assuming the script loop was responsible.

The evidence showed that each depth is an independent centre-start path. The path ends at an outer corner, the next path starts at the centre, and the generic linker rejects the approximately 6.95 mm gap because it exceeds the 3.81 mm stay-down threshold for this tool and stepover. It therefore retracts to at least stock top and asks the entry planner to descend again.

### Prompt Context

**User prompt (verbatim):**

```text
So when doing the pocketing, it seems that it restarts the dropdown from the top every time, instead of just starting at the current pocket level. Does that make sense?

const tool = tools.flatEndMill({
  name: "6 mm Delrin slot mill",
  diameter: mm(3.175),
  fluteLength: mm(12),
});

job.setup({
  stock: {
    x: mm(103),
    y: mm(153),
    z: mm(10),
    originX: mm(0),
    originY: mm(0),
    topZ: mm(0),
  },
  clearance: mm(5),
  workOffset: "G54",
  floorZ: mm(-10),
});

const columns = 6;
const rows = 10;
const slotSize = 13;
const pitch = 15;
const xMargin = 7.5;
const yMargin = 2.5;

job.withTool(tool, () => {
  job.withSpindle({ speed: rpm(12000) }, () => {
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        job.rectPocket({
          x: mm(xMargin + column * pitch),
          y: mm(yMargin + row * pitch),
          w: mm(slotSize),
          h: mm(slotSize),
          depth: mm(8),
          stepdown: mm(2),
          stepover: 0.4,
          feed: mmPerMin(600),
          plungeFeed: mmPerMin(200),
        });
      }
    }
  });
});


/tmp/pi-clipboard-76b70cfd-3f1e-46d8-943d-e4fe55e7c0ef.png
```

**Assistant interpretation:** Determine whether the viewport reflects repeated retract-and-entry cycles at every pocket depth and identify whether the script or planner causes them.

**Inferred user intent:** Avoid unnecessary tool retractions and repeated plunges while keeping pocket machining safe.

### What I did

- Asked the image-analysis tool to inspect repeated starts, vertical moves, and links.
- Read `packages/strategies/src/pocket.ts`, `packages/planner/src/run.ts`, and `packages/planner/src/linker.ts`.
- Calculated the actual stepover and centre-to-corner distance for the supplied 3.175 mm tool.
- Distinguished the tool's display name (`6 mm`) from its actual diameter (`3.175 mm`).

### Why

- The visible symptom could have come from operation ordering, path generation, postprocessing, or viewport rendering. Tracing the full source path avoids fixing the wrong layer.

### What worked

- The screenshot and source agreed: repeated vertical columns correspond to independent depth paths and repeated entries.
- The generic linker behavior was explainable from its documented conservative threshold and stock-top floor.

### What didn't work

- N/A. No code was modified or executed in this step.

### What I learned

- `planRectPocket` contains the key knowledge that the centre was cleared by the previous level, but `ToolpathSet` cannot carry that fact.
- The linker sees a static surface and endpoints, not evolving stock.
- The current behavior is conservative rather than arbitrary.

### What was tricky to build

- The terminology “starts from the top” can mean restarting the XY contour, retracting in Z, or re-entering from stock top. The screenshot and command-generation code had to be considered together. The source confirmed all three relevant pieces: new centre-start geometry, retract to safe Z, and another entry.

### What warrants a second pair of eyes

- Verify the exact emitted G-code around a depth boundary for each postprocessor; the source-level conclusion is strong, but a future implementation baseline should count actual motions.

### What should be done in the future

- Add a regression fixture that counts internal pocket retracts and entries.

### Code review instructions

- Start at `packages/strategies/src/pocket.ts:111-146`, then follow `packages/planner/src/run.ts:122-175` into `packages/planner/src/linker.ts:72-123`.
- Compile one four-level pocket and inspect its emitted motion sequence.

### Technical details

```text
actual stepover = 0.4 × 3.175 = 1.27 mm
stay-down threshold = max(3 × 1.27, 1.5) = 3.81 mm
outer centre extent = 13/2 − 3.175/2 = 4.9125 mm
corner-to-centre XY gap ≈ 6.95 mm
result: generic linker chooses retract
```

## Step 2: Create the future-work ticket and map architectural boundaries

I created CAM-002 as an explicitly future implementation ticket. The investigation expanded from a local pocket symptom into the strategy/planner contract, entry semantics, path ordering, exact validation, sampled stock simulation, and Studio compilation pipeline.

The architecture has good boundaries worth preserving: declarative plans, strategy dispatch inversion, controller-independent IR, validation before postprocessing, and honest sampled recertification. The main gap is not lack of layering; it is that the strategy-to-planner boundary strips away level dependencies and cleared-region evidence.

### Prompt Context

**User prompt (verbatim):** "Create a docmgr ticket for this (in the future), and write a detailed design document and referencing the current status and code. The code was not written by a CAM expert, so I think there's a lot of possibilities to improve and make this all more consistent. Create  a detailed analysis / design / implementation guide that is for a new intern, explaining all the parts of the system needed to understand what it is, with prose paragraphs and bullet point sand pseudocode and diagrams and api references and file references. It should be very clear and technical. Store in the ticket and the nupload to remarkable."

**Assistant interpretation:** Create a comprehensive, evidence-backed docmgr ticket for future CAM planner improvement, orient a new intern, and deliver it to reMarkable.

**Inferred user intent:** Turn a concrete machining inefficiency into a durable technical roadmap for making the non-expert-authored CAM core safer, more coherent, and easier to extend.

### What I did

- Created ticket `CAM-002` with architecture, CAM, G-code, safety, and toolpath topics.
- Added a design doc, investigation diary, and five tracked tasks.
- Read the operation and strategy contracts, strategy registry, pocket strategy, planner runner, linker, entry planner, path IR, compiler lowering and validation, dexel simulator, Studio compile thunk, and existing pocket tests.
- Captured line-numbered evidence for the critical code paths.

### Why

- A broad refactor without a precise current-state map would risk weakening conservative safety behavior or duplicating concerns across strategies.

### What worked

- Existing comments document prior safety failures, including a rapid through untouched stock caught by the dexel simulator. This directly supports keeping the generic linker conservative.
- Existing exact-vs-sampled certificate semantics provide a strong pattern for future removal-aware planning.

### What didn't work

- N/A. Ticket creation and repository inspection succeeded.

### What I learned

- `orderPaths` uses only XY distance and has no explicit fixed sequence semantics.
- One `CutCmd` has one feed, so a “single continuous path” cannot safely preserve separate cutting and plunge feeds without a richer span representation.
- `DexelSim` already tracks evolving stock after emission, but planning should depend on a small conservative clearance interface rather than importing verifier policy directly.

### What was tricky to build

- The local fix initially appears to be “return to centre, descend, continue.” The hidden complication is feed ownership: an XY return should use cutting feed while the Z transition should use `plungeFeed`. Collapsing both into one path silently loses that distinction. The design therefore introduces typed ordered spans rather than recommending a deceptively simple polyline concatenation.

### What warrants a second pair of eyes

- Whether the first implementation should add explicit pocket transitions or migrate all strategies to ordered spans immediately.
- Whether the proposed analytic pocket proof adequately handles every supported tool geometry.
- Whether sampled removal state belongs in `@cam/planner`, a new stock package, or shared geometry infrastructure.

### What should be done in the future

- Implement CAM-002 in phases, beginning with measurable regression tests and parameter validation.
- Have a CAM practitioner review entry, chip evacuation, contour direction, and grouped-pocket policy before exposing public defaults.

### Code review instructions

- Read the design doc sections 4-6 before evaluating proposed APIs.
- Follow the primary review order in design-doc section 15.
- Validate future work with `pnpm typecheck`, `pnpm test`, Studio build, emitted G-code inspection, and sampled simulation.

### Technical details

```text
ManufacturingPlan
  -> dispatchStrategy
  -> ToolpathSet (currently loses topology/removal facts)
  -> orderPaths
  -> planLink
  -> entryCommands
  -> CanonicalProgram
  -> lower
  -> validate
  -> emit
  -> sampled checks
  -> recertify
```

## Step 3: Write the intern-oriented design and delivery package

The final design document explains the system from vocabulary through end-to-end compilation, identifies the exact information-loss boundary, proposes an immediate analytic pocket solution and a longer-term conservative stock-state interface, and gives phased file-level implementation and validation guidance.

The document intentionally does not call for a generic “never retract” option. It treats linking settings as preferences constrained by clearance proof and keeps final emitted-motion simulation as independent evidence.

### Prompt Context

**User prompt (verbatim):** (same as Step 2)

**Assistant interpretation:** Produce the complete technical deliverable, validate docmgr bookkeeping, and upload it as a readable bundle.

**Inferred user intent:** Give a new intern enough context and concrete direction to implement the feature without compromising machining safety.

### What I did

- Wrote the primary design with prose, tables, ASCII diagrams, pseudocode, API sketches, decision records, tests, risks, implementation phases, and file references.
- Updated the ticket index and related source files.
- Prepared docmgr validation and reMarkable bundle delivery.

### Why

- The change crosses strategy topology, feed semantics, linker authorization, stock knowledge, diagnostics, tests, and public API. A short issue description would omit the constraints that prevent unsafe shortcuts.

### What worked

- The existing architecture supported a clear phased design rather than requiring a rewrite.
- The local analytic proof can deliver value before a general sampled stock model exists.

### What didn't work

- N/A at authoring time. Delivery command results are recorded in the ticket changelog and final handoff.

### What I learned

- The right consistency target is not “one algorithm everywhere.” It is a shared contract: strategies provide topology and proof; the planner authorizes motion; validators and simulators independently establish evidence.

### What was tricky to build

- The guide had to be broad enough to improve the architecture while keeping the reported pocket issue implementable. The phased plan separates the exact 2.5D proof from general removal-aware planning so an intern can deliver a safe first milestone without building an industrial CAM kernel.

### What warrants a second pair of eyes

- CAM-domain review of tool engagement, return-to-centre geometry, entry policy, chip evacuation, and climb/conventional implications.
- Architecture review of `StrategyMotion`, provenance, and removal-state package ownership.

### What should be done in the future

- Implement only after baseline motion-count tests and a review of the Phase 1 span contract.

### Code review instructions

- Start with the design's executive summary and root cause, then inspect decision records and Phase 0-4.
- Compare every safety claim against the cited source and add emitted-motion regression evidence during implementation.

### Technical details

- Primary design: `design-doc/01-stock-aware-pocket-linking-architecture-and-implementation-guide.md`.
- Ticket: `CAM-002`.
