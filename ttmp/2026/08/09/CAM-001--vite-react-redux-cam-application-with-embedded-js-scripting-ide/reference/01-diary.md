---
Title: Diary
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
      Note: Normative architecture supplied by the user
    - Path: repo://original/DESIGN-02-kleisli-composition-for-machine-commands.md
      Note: Sequencing model behind the DSL chaining API
    - Path: repo://original/MakeraBadge.nc
      Note: Real Makera Studio export; dialect and parser conformance fixture
    - Path: repo://original/dropcut-cam(1).jsx
      Note: Drop-cutter CAM prototype; generateJob:546 fuses six pipeline stages
    - Path: repo://original/dropcut-ide(1).jsx
      Note: Scripting IDE prototype; compileProgram:116 is the DSL host and canonical-IR lowerer
    - Path: repo://original/z1-gcode-checker-l2.jsx
      Note: G-code parser and StockSim:287 heightmap verifier
ExternalSources: []
Summary: 'Chronological investigation diary for CAM-001: reading the three JSX prototypes, storing the DSL design notes, and writing the intern architecture guide.'
LastUpdated: 2026-08-09T00:00:00Z
WhatFor: Recording what was investigated, in what order, with what evidence, so the next person can continue or audit the analysis.
WhenToUse: Read before continuing CAM-001 work, or when auditing how a claim in the design doc was reached.
---


# Diary

## Goal

Capture the investigation behind CAM-001: reverse-engineering three standalone
React/Three.js CAM prototypes into a single coherent architecture for a Vite +
React + Redux CAM application with an embedded JavaScript scripting IDE, and
producing an intern-readable analysis/design/implementation guide.

---

## Step 1: Locate the prototypes and open the ticket

The user asked me to analyze "the prototypes in `sources/`". That directory does
not exist — the prototypes live in `original/`. I confirmed this before doing
anything else rather than guessing, because a wrong directory would have meant
analyzing nothing. The repository at this point was two commits deep and
contained only `original/`, a docmgr scaffold under `ttmp/`, and `.ttmp.yaml`.

With the source located I created the ticket workspace and the three documents
the deliverable needs: the main design doc, this diary, and a companion API/code
map that the design doc can reference instead of inlining every signature.

### Prompt Context

**User prompt (verbatim):** "Create a new docmgr ticket to create a vite react redux CAM software with inbuilt IDE for JS scripting. Analyze the prototypes in sources/ and assemble it from there, as a starting point, as a study.

Create  a detailed analysis / design / implementation guide that is for a new intern, explaining all the parts of the system needed to understand what it is, with prose paragraphs and bullet point sand pseudocode and diagrams and api references and file references. It should be very clear and technical. Store in the ticket and the nupload to remarkable.

Keep a detailed diary as you work, frequent, and use the diary format form the skill. Commit at appropriate intervals."

**Assistant interpretation:** Open a docmgr ticket; read the three prototype JSX
files as primary evidence; design a single Vite + React + Redux application that
absorbs all three; write a long-form, intern-oriented guide (prose, bullets,
pseudocode, diagrams, API reference, file:line references) into the ticket; keep
a diary in the `diary` skill's format; commit as work lands; upload the bundle
to reMarkable.

**Inferred user intent:** The three prototypes are separate one-file studies that
duplicate each other's viewport, playback and simulation code. The user wants
them consolidated into one real application skeleton, and wants the reasoning
written down well enough that a new intern could pick the project up and build
it without prior CAM knowledge.

### What I did

- Ran `ls` on the repo root and discovered `original/`, not `sources/`.
- `docmgr status --summary-only` → `tickets=0 docs=0`, confirming a clean slate.
- Created the ticket:
  `docmgr ticket create-ticket --ticket CAM-001 --title "Vite + React + Redux CAM application with embedded JS scripting IDE" --topics cam,gcode,react,redux,vite,ide,toolpath`
  → `created CAM-001 at ttmp/2026/08/09/CAM-001--vite-react-redux-cam-application-with-embedded-js-scripting-ide (9 dirs, 4 files)`
- Added the seven new topic slugs to `ttmp/vocabulary.yaml` via `docmgr vocab add`,
  since the stock vocabulary only knew `chat`, `backend`, `websocket`.
- Created three documents: the design doc, this diary, and the API/code map.

### Why

`docmgr doctor` validates frontmatter topics against the vocabulary. Adding the
slugs up front avoids a doctor failure at the end of the run, when it is more
annoying to fix.

### What worked

The ticket scaffold came up cleanly and the vocabulary additions were accepted
without complaint.

### What didn't work

`docmgr ticket create-ticket --help` prints its help through a pager-formatted
renderer that truncates the flag list mid-table, so I could not read the full
flag set from `--help | head -40`. The command's examples were enough to
construct the invocation, so I did not chase it further.

### What I learned

The prototypes are larger than "sketches": 1,971 + 1,673 + 1,217 = 4,861 lines of
dense numerical and rendering code. This is not a greenfield design exercise; it
is a consolidation of working algorithms whose problem is module boundaries, not
correctness.

### What warrants a second pair of eyes

Nothing yet — no code changed.

### What should be done in the future

N/A for this step.

### Code review instructions

- Start at `/home/manuel/code/wesen/2026-08-09--cam-software/ttmp/vocabulary.yaml`
  and confirm the seven added topic slugs read sensibly.
- Validate with `docmgr doctor --ticket CAM-001 --stale-after 30`.

---

## Step 2: Read all three prototypes end to end

I read the three files in full rather than grepping for landmarks, because the
deliverable is a claim about how they fit together and that claim needs to be
grounded in the actual control flow, not in the section-header comments. The
files turned out to partition cleanly by concern: one is a toolpath *generator*,
one is a *compiler and scripting host*, one is a G-code *parser and verifier*.
Between them they already contain every stage of the pipeline described in the
user's design notes — just fused into three monoliths that each re-implement the
viewport.

The single most useful finding is that all three files independently reimplement
the same four things: a Three.js orbit-camera viewport, a time-indexed playback
scrubber with binary search over cumulative time, a heightmap material-removal
simulator, and a DRO readout. That duplication is the strongest argument for the
package split the design doc proposes.

### Prompt Context

**User prompt (verbatim):** (see Step 1)

**Assistant interpretation:** Build an evidence base before writing any
architecture claims.

**Inferred user intent:** The guide should describe what the code *actually*
does, with line references an intern can open, not a plausible-sounding
generic CAM architecture.

### What I did

Read, in full:

- `original/dropcut-cam(1).jsx` (1,971 lines) — drop-cutter CAM. Presets and STL
  loading (`PRESETS`, `parseSTL:94`, `buildModel:119`), a uniform-grid spatial
  index (`buildGrid:146`), the exact drop-cutter evaluator for ball and flat
  cutters (`makeEvaluator:203`, with `edgeBall:184` and `pointInTri:175`), a
  sampled cutter-location field (`buildCLField:313`), marching squares plus
  segment chaining (`marchSquares:356`), an Eikonal fast-sweeping solver
  (`solveEikonal:454`), the monolithic `generateJob:546`, least-squares arc
  fitting (`compressCut:1013`, `fitArcsRun:1036`), the G-code writer
  (`toGcode:1115`), and the dexel verifier (`verifyJob:1192`).
- `original/dropcut-ide(1).jsx` (1,673 lines) — the scripting IDE. A DSL executed
  through `new Function` (`compileProgram:116`, sandbox construction at 332–343),
  branded units (`mm`/`rpm`/`mmPerMin`/`deg` at 141–144), the `job` façade with
  strategies `face:236` and `rectPocket:275`, canonical-IR lowering with
  validation and modal G-code emission (357–655), a textarea+overlay editor with
  regex highlighting (`highlight:665`, `Editor:688`), and the viewer with
  `posAt:920` time lookup.
- `original/z1-gcode-checker-l2.jsx` (1,217 lines) — the G-code verifier. A modal
  RS-274 parser (`parseGcode:97`), arc reconstruction from I/J or R
  (`arcPoints:237`), tool profile geometry (`toolProfile:272`), the heightmap
  stock simulator (`class StockSim:287` with `stamp:306` and `sweep:344`),
  whole-program checks (`runGlobalChecks:383`), and incremental
  simulate-forward/reset-on-rewind playback (`setSimTo:860`).

### Why

Each file is the reference implementation for one pipeline stage. The guide has
to state which existing function becomes which future module, and that mapping
is only defensible if I have read the functions.

### What worked

The three files are unexpectedly complementary. Laid against the user's five-layer
semantic stack they cover: geometry (`parseSTL`/`buildModel`), strategy planning
(`generateJob`), canonical IR (the IDE's `cmds` array), machine lowering (the
IDE's validation pass), post (`toGcode`), and verification (`verifyJob` /
`StockSim`). Nothing in the stack is missing an implementation — the pieces are
just in the wrong files.

### What didn't work

Reading `dropcut-cam(1).jsx` in one call hit the tool's page cap:

```
[Truncated: PARTIAL view — showing lines 1-1055 of 1972 total (39704 tokens, cap 25000)]
```

I paged the remainder with explicit `offset`/`limit` reads rather than falling
back to grep, since the arc-fitting and verification code is exactly the part
where skimming would produce wrong claims.

### What I learned

Three findings that materially shape the design:

1. **`generateJob` fuses six pipeline stages.** Within a single ~460-line
   function it does Z-level region decomposition (union-find over scanline
   intervals, 593–635), entry-move synthesis, stay-down link decisions with
   collision sampling (664–686), three finishing strategies, arc fitting and
   flattening into parallel typed arrays. The user's design note calls this out
   and reading the code confirms it precisely.

2. **The IDE already implements the "errors block emission" invariant** the
   architecture wants: `compileProgram` returns `gcode: hasErrors ? [] : gcode`
   (line 649). The postprocessor genuinely cannot see an unvalidated program.
   That is the certified-stage idea from DESIGN-01 §13, implemented with a
   runtime check instead of a type brand.

3. **The two simulators disagree on representation.** `verifyJob` builds a target
   heightfield and diffs machined-vs-target into a deviation map with a
   tolerance band; `StockSim` mutates a heightmap incrementally and can only
   rewind by full reset (`setSimTo:864`). They should be one component with two
   query modes, not two components.

### What was tricky to build

Nothing was built yet, but two things were tricky to *read*:

- **The `W()` axis-swap trick** in `generateJob` (line 556):
  `const W = alongX ? (a,bb)=>[a,bb] : (a,bb)=>[bb,a]`. The whole roughing and
  raster code is written in an abstract `(a, b)` frame and mapped to world
  `(x, y)` through `W`, with a parallel `evalABr` wrapper that swaps arguments
  the other way. It is compact and it works, but the reader must hold two
  coordinate conventions simultaneously. Any port must keep the swap in exactly
  one place or it will silently transpose toolpaths.
- **Arc direction sign conventions** in `toGcode` (1157–1168). The same
  `op.pos` boolean maps to `G2` in the G18 branch and `G3` in the G17 and G19
  branches, because a positive sweep in the local `(u, v)` frame corresponds to
  opposite handedness depending on which axis was eliminated. This is correct
  but entirely comment-dependent; it is a prime candidate for the property test
  proposed in the guide.

### What warrants a second pair of eyes

The claim that `StockSim.stamp` has a dead early-out is worth checking
independently. Lines 311–313 compute `this._maxIn(lx, ly, R)` inside an `if`
whose body is an empty comment, and `_maxIn()` at line 341 is a stub returning
`-Infinity`. The condition can never be usefully true and the branch does
nothing. I read this as vestigial optimization scaffolding rather than a bug
with runtime effect, but a second reader should confirm it before the port
copies it forward.

### What should be done in the future

- Port `generateJob`'s roughing region decomposition with tests before splitting
  it; it is the densest logic in the three files.
- Decide whether the CL-field sampling resolution (`gs` at line 809, clamped to
  0.25–0.6 mm) should stay heuristic or become part of the declared error budget.

### Code review instructions

- Start with `original/dropcut-cam(1).jsx:546` (`generateJob`) — this is the
  function the whole refactor is organized around.
- Then `original/dropcut-ide(1).jsx:357-655`, the validate-and-lower pass, which
  is the model for the new compiler's middle end.
- Then `original/z1-gcode-checker-l2.jsx:287-379` (`StockSim`), the simulator
  that should survive as the shared verification kernel.

### Technical details

Line counts and role split:

| File | Lines | Role in the future architecture |
| --- | --- | --- |
| `dropcut-cam(1).jsx` | 1,971 | strategies, geometry kernel, arc fit, dexel verify, post |
| `dropcut-ide(1).jsx` | 1,673 | scripting host, canonical IR, validation, modal post, editor |
| `z1-gcode-checker-l2.jsx` | 1,217 | G-code parser, stock simulator, static checks |

---

## Step 3: Store the two DSL design notes supplied mid-session

Partway through the investigation the user pasted two long design notes — one
arguing that machining, not G-code, should be the semantic model (a 36-section
architecture covering the five-layer stack, canonical IR, certified compilation
stages, branded units and frames, capability-driven lowering, and a mapping of
every existing Dropcut function to a future module), and one explaining Kleisli
composition as the formal model for sequencing stateful, fallible machine
commands. They asked for both to be stored in `original/`.

These notes are now the normative design input for the ticket. They arrived
after I had read the prototypes, which was fortunate: the notes make specific
claims about the existing code (that `generateJob` conflates stages, that
`makeEvaluator` approximates a swept-volume condition, that `verifyJob` is a
sampled rather than exact verifier) and I could confirm each against what I had
just read rather than taking them on faith. All three check out.

### Prompt Context

**User prompt (verbatim):** "Store this in original too, this is info about the design of the DSL"

**Assistant interpretation:** Persist both pasted design documents as files under
`original/`, alongside the prototypes, as reference input rather than ticket
output.

**Inferred user intent:** These notes are the intended architecture. They should
live with the source material so the guide can cite them, and so they survive
the conversation.

**Commit (docs):** `214a44a` — ":memo: Store DSL semantic-architecture design notes in original/"

### What I did

- Wrote `original/DESIGN-01-semantic-cam-architecture.md` (32 KB) and
  `original/DESIGN-02-kleisli-composition-for-machine-commands.md` (13 KB).
- Completed the user's interrupted `cp ~/Downloads/MakeraBadge.nc original/`
  (328 KB, 18,531 lines).
- Committed all of it together with the ticket scaffold as `214a44a`.

### Why

The notes define the target architecture; without them the guide would be my
architecture rather than the project's. Storing them as files (not just
conversation) means the design doc can reference them by path and an intern can
read the primary source.

### What worked

Both documents stored cleanly and the commit went through.

### What didn't work

The paste arrived through a shell-input path and the shell tried to evaluate it:

```
(eval):180: parse error near `\circ'
```

The text still reached me intact, but its LaTeX had been mangled in transit:
display math had lost its delimiters and become bare `[ ... ]` blocks, and
several equations containing `=` had been reinterpreted as Markdown setext
headings, leaving stray `====` and `----` rules mid-equation. For example
`\operatorname{Sweep}(T,\gamma) = \bigcup...` had been split across a `====`
line.

I normalized the delimiters to `$$ ... $$` and rejoined the split equations,
changing no wording, and recorded that edit in a note at the top of each file so
the next reader knows the files are not byte-identical to the paste.

### What I learned

`MakeraBadge.nc` is a much better postprocessor test fixture than I expected. It
is a real Makera Studio export and it demonstrates concretely what "dialect"
means beyond word choice:

- A structured metadata header carried in comments with a `;@MKR|KEY|k=v` grammar
  — `SCHEMA`, `MACHINE`, `MATERIAL`, `STOCK`, `ORIGIN`, `CAM`, `UNIT`, a `TOOL`
  table with full cutter geometry (tip diameter, corner radius, half angle), a
  `TIME` estimate, and a `TOOLPATH` manifest naming each operation.
- Per-operation markers in the body: `;@MKR|TOOLPATH_START|toolpath_number=1`.
- A base64 PNG thumbnail appended as comment lines, ending `;(thumbnail_image_end)`.
- Word-count evidence of full linearization: 17,439 `G1` and 792 `G0` blocks and
  **zero** `G2`/`G3`. Makera Studio does not emit arcs here at all.
- Both `M5` and `M05` appear, plus `M02` rather than `M30`.

That last pair of facts is a direct argument for DESIGN-01 §27's capability
model: "does this controller accept arcs" and "which flavour of the stop code"
are per-machine data, not per-machine `if` branches. It also means the arc
fitting in `compressCut` must be defeatable by machine profile — for a Makera
target the fitted arcs would have to be linearized straight back out.

### What was tricky to build

Reconstructing the mangled equations required judgement rather than mechanical
substitution. The corruption was ambiguous in places: a line reading `====`
between two expression fragments could have been either a heading rule the
author wrote or an `=` that the Markdown pass promoted. I resolved each by
checking whether the surrounding fragments formed a well-typed equation — e.g.
`\operatorname{Safe}(P)` / `======` / `\bigwedge_i P_i.` only makes sense as
`Safe(P) = \bigwedge_i P_i`. Every such site had exactly one sensible reading,
so I am reasonably confident in the reconstruction, but it is a judgement call
and the header note flags it.

### What warrants a second pair of eyes

The equation reconstruction in DESIGN-01 §§5, 17, 18, 19, 31 and DESIGN-02 §§4,
5, 16 — the sections where `=` signs were swallowed. A reader who has the
original paste should diff the math against it.

### What should be done in the future

- Use `MakeraBadge.nc` as the parser conformance fixture: the `;@MKR|` header
  grammar is a good test of comment-preserving parsing, and 18k lines is a
  reasonable performance floor for the viewport.
- Add a `makera` machine profile with `arcs: none` and `programEnd: "M02"` once
  the capability model exists, and verify the post linearizes fitted arcs.

### Code review instructions

- Read `original/DESIGN-01-semantic-cam-architecture.md` first — it is the
  normative architecture; §§30 and 32 (pipeline stages and the old→new module
  map) are what the implementation plan is built from.
- `original/DESIGN-02-kleisli-composition-for-machine-commands.md` explains the
  sequencing model behind the DSL's chaining API; §§6, 13, 15 are the ones that
  touch CAM directly.
- Verify the commit contains what it claims: `git show --stat 214a44a`.

### Technical details

Makera header grammar as observed:

```text
;@MKR|BEGIN
;@MKR|SCHEMA|v=1.0.0
;@MKR|MACHINE|id=Z1|name=Makera Z1
;@MKR|STOCK|id=cuboid|length=100|width=100|height=1.3|diameter=1
;@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-50|y=-50|z=0.65
;@MKR|UNIT|value=mm
;@MKR|TOOL|number=1|id=...|name=3.175*12mm Flat End(Metal)|type=Flat End|
      diameter=3.175|tipdiameter=3.175|cornerradius=0|halfAngle=0
;@MKR|TIME|seconds=1800
;@MKR|TOOLPATH|number=1|tool_number=2|name=[T2]2D Pocket
;@MKR|END
```

Block census for the 18,531-line file:

```text
17439  G1        792  G0        1  G90      1  G28
    1  M5          1  M05       1  M02
    0  G2/G3   ← fully linearized
```

---

## Step 4: Write the guide, the code map, and publish

With the evidence base in place I wrote the two deliverables. The design doc is
organised so an intern can read it linearly: a domain primer that assumes no CAM
knowledge, then a dissection of what exists, then the design, then the build
order. The companion code map exists so the design doc could reference prototype
symbols without inlining every signature — and it turned into the more useful
document for anyone actually porting code, because it is where the gotchas live.

The single most valuable output of the close reading was not the architecture; it
was the defect list. Eight issues surfaced, one of which (D1) is a live bug in the
IDE prototype rather than a porting note.

### Prompt Context

**User prompt (verbatim):** (see Step 1)

**Assistant interpretation:** Produce the long-form intern guide and supporting
reference, wire up ticket bookkeeping, validate, and upload to reMarkable.

**Inferred user intent:** A document good enough to hand to a new hire as their
sole onboarding material, plus a paper copy to read away from a screen.

**Commit (docs):** `e3b2563` — ":memo: CAM-001: intern architecture guide, code map, task plan"

### What I did

- Wrote `design-doc/01` (3,364 lines, 18 parts): domain primer; prototype
  dissection with file:line evidence; the five-layer semantic stack and package
  dependency graph; the data model (branded units, frame groupoid, path category,
  non-modal canonical IR, provenance, certified stages, machine profiles, tools);
  three-tier Redux design; worker compute layer; sandboxed scripting host and DSL
  surface; imperative-shell viewport; algorithm derivations; verification with
  error budgets and safety certificates; dialect postprocessors; file-by-file
  repository layout with a complete old→new map; an eight-milestone build plan;
  testing strategy; ten ADRs; risks and open questions; glossary; references.
- Wrote `reference/02`, the function-by-function code map, ending with the defect
  table.
- Rewrote `tasks.md` as 84 items — twelve done, the rest organised by milestone.
- Related the six source files to all three docs; added five changelog entries;
  rewrote `index.md` with an overview, a document table and the ADR summary.
- `docmgr doctor --ticket CAM-001 --stale-after 30` → **all checks passed**.
- Uploaded a three-document bundle to `/ai/2026/08/09/CAM-001`.

### Why

The user asked for a guide "for a new intern … very clear and technical", so the
document leads with the domain rather than the architecture. Someone who does not
know what a scallop is cannot evaluate a claim about constant-scallop strategy
design, and the prototypes assume that knowledge throughout.

### What worked

The old→new module map (design doc XII.3) fell out almost mechanically once the
five-layer stack was fixed, because the prototypes' functions are already
single-purpose — it is only `generateJob` that fuses stages. That is a good sign
for the port: roughly 3,400 of 4,861 lines survive as ported logic, ~1,000 lines
of triplicated viewport code collapse into one implementation, and ~450 lines
(the hand-rolled editor, inline styles) are deleted.

### What didn't work

The first reMarkable upload failed in the PDF stage:

```
Error: pandoc failed: Error producing PDF.
! Missing { inserted.
<to be read again>
                   \discretionary
l.2742 \[s^\*
: exit status 43
```

I had written `$$s^\* = \frac{m\,r_p}{\sqrt{1+m^2}},$$` — escaping the asterisk
out of Markdown habit. In LaTeX `\*` is not a valid control sequence, and the
error surfaces as a confusing "Missing { inserted" pointing at the line. Changing
it to `s^{*}` fixed it and the re-upload succeeded first try:

```
OK: uploaded CAM-001 DROPCUT Studio Architecture Guide.pdf -> /ai/2026/08/09/CAM-001
```

Also worth recording: `remarquee upload bundle` prints its full help text after
the error, so the actual message scrolls off if you pipe to `tail`. Use `head`
when diagnosing an upload failure.

### What I learned

Writing the error-budget section (design doc X.2) forced a realisation that is
not in the source notes: **`toFixed(3)` in `toGcode`
(`dropcut-cam(1).jsx:1116`) is itself an error contribution.** Three decimal
places is ±0.0005 mm of quantisation on every coordinate. It is invisible next to
a 0.01 mm arc tolerance, but it belongs in the budget, and it is exactly the kind
of term that gets forgotten when someone later asks why a "0.001 mm" finish is
not achievable. The related insight — that requesting a 0.005 mm scallop while
arc fitting runs at 0.010 mm tolerance is self-defeating and the compiler should
say so — only becomes expressible once the budget is written down.

### What was tricky to build

**Deciding how much of the user's design notes to restate versus reference.** The
notes are normative and stored in `original/`, so quoting them wholesale would
have doubled the guide's length for no gain. But an intern reading only the guide
needs the concepts. I settled on: restate the *conclusions* with a section
reference (e.g. "DESIGN-01 §22"), and spend the guide's own words on the thing
the notes cannot provide — the mapping onto the actual prototype code with line
numbers. Where the notes make a claim about the existing code, I verified it
against what I had read rather than repeating it; all three such claims held.

**Keeping the Redux section honest.** The temptation with a "React + Redux" brief
is to put everything in the store because that is what the brief seems to ask
for. The three-tier rule (V.1) is the resolution, but it needed justifying rather
than asserting, so I anchored it in a measurement — a finished job is up to 24 MB
of typed arrays — and in an existing prototype behaviour: the DRO is already
written via `ref.textContent` inside the rAF loop
(`dropcut-cam(1).jsx:1570-1574`) precisely because 60 Hz React renders of a
number are absurd. The rule formalises something the prototypes discovered
empirically.

### What warrants a second pair of eyes

- **D1** (`dropcut-ide(1).jsx:244, 288`): `face` and `rectPocket` hard-code
  `const dia = 4` with a comment claiming it is "resolved at lowering against
  active tool" — but no such resolution exists anywhere in the file. If that
  reading is right, the stepover is wrong for every tool that is not 4 mm, and
  this is a live bug in the demo, not just a porting note. Worth confirming with
  whoever wrote it.
- **The performance budgets in XIV.5** are estimates extrapolated from the
  prototypes' structure, not measurements. They should be replaced with measured
  baselines during M2 rather than treated as targets handed down.
- **The claim that ~3,400 lines survive the port** is an estimate from the module
  map, not a line-by-line count.

### What should be done in the future

- Capture the golden files (task 24) *before* any porting starts. If M2 begins
  without them there is no way to prove the port preserved behaviour, and that is
  irreversible once the prototypes are edited.
- Feed the defect table back to whoever owns the prototypes, especially D1.
- Revisit the time-estimation question (open question 2) before anyone relies on
  the estimates for shop scheduling; naive length/feed can be off by 2× on
  finishing passes with many short segments.

### Code review instructions

- Read `design-doc/01` Parts I–III first for the shape, then Part IV for the data
  model — everything else depends on it.
- Check Part XII.3 (the old→new map) against the prototype line numbers; it is
  the most mechanically verifiable part of the document, and an error there
  propagates into the build plan.
- Check `reference/02` §5 (the defect table) by opening each cited line.
- Validate bookkeeping with `docmgr doctor --ticket CAM-001 --stale-after 30`.

### Technical details

Deliverable inventory:

```text
design-doc/01-…-implementation-guide.md   3,364 lines, 18 parts, 10 ADRs
reference/01-diary.md                     this file, 4 steps
reference/02-…-code-map.md                ~50 symbols, 8 defects
tasks.md                                  84 items (12 done, 72 planned)
changelog.md                              5 entries with file notes
index.md                                  overview, document table, ADR summary
```

reMarkable: `/ai/2026/08/09/CAM-001/CAM-001 DROPCUT Studio Architecture Guide.pdf`

---

## Step 5: Implement the headless core — M1, M2, M4, M5, M7

The user said "implement it", and separately that the prototypes are reference
sketches rather than code to port. That second remark changed the shape of the
work considerably: instead of golden-file parity against the prototypes, every
algorithm could be written cleanly and tested against **closed-form ground
truth**. That turned out to be worth far more than parity would have been,
because it catches errors the prototypes might also have had — and because a
test that says "a hemisphere of radius R0 machined with a ball of radius R has a
cutter-location surface that is a hemisphere of radius R0+R" is a statement about
machining, not about a previous implementation.

The build order followed the design doc's milestones but skipped the two UI ones
(M3 viewport, M6 React shell) in favour of finishing the headless pipeline first.
That ordering was deliberate and is the one the design doc recommends for a
single developer: with a CLI, every algorithm is testable in Node from day one,
and the UI later becomes assembly rather than debugging through a canvas.

### Prompt Context

**User prompt (verbatim):** "Implement it. Keep a detailed diary as you go, print work slips after significant tasks, commit at appropriate intervals."

Followed mid-turn by: "you don't need to port the exact code, it's prototype reference sketches"

**Assistant interpretation:** Build the system the design doc specifies, writing
fresh implementations guided by the prototypes' algorithms rather than
transliterating them. Keep the diary current, print a thermal work slip after
each milestone, and commit per milestone.

**Inferred user intent:** A working codebase, not a port. The prototypes are
there to explain what the algorithms are; the quality bar is the design doc.

**Commits:** `c3af382` (M1) · `239c28b` (M2) · `af1caea` (M4) · `4c780ec` (M5) ·
`97d7c64` (M7)

### What I did

Fourteen packages, 64 TypeScript files, ~11,100 lines, 191 tests.

- **M1 — core and the round trip.** `@cam/units` (branded scalars, inch
  normalised to mm at construction), `@cam/math` (Vec3/Box, frame-tagged
  `Point3`, SE(3) `Transform`), `@cam/ir` (Path as a category, non-modal
  `CanonicalCommand`, `Provenance`/`Diagnostic`, the `ValidatedProgram` brand),
  `@cam/machine` (capabilities as data, three profiles), `@cam/compiler`
  (`GCodeBlock`, the single modal `compress()`, capability-driven `lower()`,
  `validate()` as sole gate), `@cam/gcode-parser`, `@cam/post-rs274`,
  `@cam/post-makera`.
- **M2 — geometry.** Mesh/STL, spatial index, drop-cutter evaluator, CL field,
  marching squares, Eikonal fast sweeping.
- **M4 — strategies and planner.** Raster, constant-scallop, hybrid-waterline,
  z-level rough, face, rect pocket, drill; entry planning, link decisions, path
  ordering, adaptive refinement, and the runner that composes them.
- **M5 — analysis.** One dexel simulator with batch and incremental modes,
  deviation analysis, sampled safety checks, error budgets, safety certificates,
  time estimation, and `recertify()`.
- **M7 — scripting.** The capability API, the sandbox, three worked examples,
  and a CLI (`compile`, `check`, `example`, `examples`, `machines`).

### Why

The design doc's central bet is that machining, not G-code, should be the
semantic model. The only way to know whether that bet pays is to build enough of
the stack that a real program flows through every layer. It does: a JavaScript
script now produces validated, simulated, machine-specific G-code with a printed
safety certificate, and the same canonical program compiled for two machines
differs exactly where their capabilities differ.

### What worked

**The round-trip property test justified the whole architecture on day one.**
`parse(emit(P))` recovering the same motion as the uncompressed blocks, over 400
generated programs on three machine profiles, is the evidence that a non-modal IR
can be compressed to modal G-code losslessly. Without a parser we would have had
to take that on faith.

**Analytic ground truth found real bugs that parity would have hidden.** The
hemisphere identity, the 45-degree ramp offset `R(sqrt(2)-1)`, the vee-groove
depth, cone contours as circles of radius `R0(1-L/H)` — each is a statement about
geometry that a wrong implementation cannot accidentally satisfy.

**Capability-driven lowering worked exactly as advertised.** Compiling one
program for LinuxCNC and for the Makera produces arcs in one and linearized
polylines in the other, `M30` versus `M02`, with a structured `;@MKR|` header on
one side only — and there is not a single `if (machine === ...)` in the compiler.

**The simulator earned its place immediately.** See below.

### What didn't work

**The drop-cutter was 60x slower than the design doc's estimate.** First
measurement: 3,197 queries/s against a claimed budget of 200,000. The estimate
was mine, written in the design doc and flagged there as unmeasured (risk R2),
and it was simply wrong: a 6 mm tool over a 50 tri/mm² mesh has ~1,400 triangles
under it on *every* query, so that throughput is not reachable at that density.

Two fixes took it to ~78,000 q/s at typical density:

- **Distance-aware pruning.** The obvious bound is "geometry topping out at
  `maxZ` can lift the sphere centre to at most `maxZ + R`". That is far too
  loose. Using the horizontal distance `d` to the candidate's bounding box gives
  `maxZ + sqrt(R² − d²)`, which rejects rim geometry almost immediately once the
  centre of the disc has set a good running best. This alone was most of the win.
- **Nearest-first cell traversal.** Walking cells in Chebyshev rings outward from
  the query point means the contact is usually found in the very first cell, so
  the running best is tight before the outer rings are considered. Row-major
  order examined hundreds of irrelevant triangles first.

Plain `maxZ + R` pruning on its own bought only 1.35x, which is the sort of
result that would have been easy to accept as "well, that's the cost" without
measuring what the bound was actually rejecting.

**A LaTeX escape broke the earlier reMarkable upload** (recorded in Step 4) and,
in this step, **a backtick inside a template literal** broke the build: I wrote
`` `at` `` in a comment inside an example's backtick-quoted source string, which
terminated the string. esbuild's message (`Expected "}" but found "at"`) points
at the consequence rather than the cause.

**Two bugs in my own new code**, both caught by tests rather than review:

```
expected null to be 'dome'
```

`runScript` destructured the API host with `const { api, harvest, ...rest }`,
which evaluated the `meshName` **getter at spread time** — before the script had
run. Always null. Fixed by keeping the host object and reading the property after
execution.

```
expected 4 to be 3
```

The script-line offset probe measured *body* lines rather than *user* lines, so
every reported error location was off by one. Now measured at load time by
throwing from a known user line, because a hard-coded constant silently
misreports every error and an engine change would go unnoticed.

### What I learned

**The simulator is not a nicety; it is the only thing that finds link bugs.**
Running it over a real finishing compile reported a rapid ploughing through
12.9 mm of stock. Two genuine planner defects, neither visible by reading:

1. **Retract heights were computed from the part surface.** On a finishing-only
   job the material above the part has never been removed, so a locally-optimal
   retract at 2.6 mm rapids straight through 12.4 mm of untouched block. The
   "local safe height" optimisation is only valid *after roughing has cleared the
   region*, and the planner had no way to know that. Retracts are now floored at
   the stock top; doing better needs in-planner stock tracking.
2. **A retract traverse ended at cutting depth**, so its final descent was a
   rapid going down into material. Traverses now end at the safe height and the
   entry planner owns the descent under feed control. This also removed a double
   descent — traverse down, then entry descending again from clearance.

Residual after both fixes: zero.

**A missing capability surfaced only under the "every example on every machine"
test.** The dome preset is modelled centred on its own origin, and nothing in the
pipeline mapped a part into the work envelope, so it could not be machined on any
profile whose travel starts at zero. `geometry.mesh(name, { at })` now exists,
which is exactly what a machinist does when deciding where on the bed to clamp.
That requirement had not appeared in the design doc at all.

**Validation being strict is a feature that keeps embarrassing the fixtures.**
Three separate test failures in this step were the validator being *right*:
facing overshoots one tool radius past the stock edge (so a stock clamped at
exactly X0 fails on a machine whose travel starts at 0); 14,000 rpm exceeds the
Makera's 13,000 limit; a part centred on the origin needs negative travel. Each
time the correct fix was to the fixture, not the check.

### What was tricky to build

**Making frame tagging actually error.** The whole point of `Point3<"work">` vs
`Point3<"machine">` is that mixing them fails to compile. My first version did
not: TypeScript inferred the frame parameter from *both* arguments and happily
widened to a union, so passing a part-frame point to a work-frame transform
type-checked. The `@ts-expect-error` in the test flagged this by reporting
"unused directive" — the test caught the *type system* being wrong, which is a
pleasing thing for a test to do. `NoInfer<A>` on the point parameter fixes it.

**Marching squares emitting degenerate segments.** Contour extraction on a cone
returned three polylines where one was expected. The main loop was perfect (835
points, length 65.973 against the analytic 2π·10.5 = 65.973); the extras were
two-point "loops" of coincident points. Cause: when a grid node's value lands
*exactly* on the contour level — which happens at r = 10.5 precisely, on a cone
sampled at 0.1 mm — the edge interpolation puts the crossing exactly on that
corner, and two of the cell's edges then produce the same point. Zero-length
segments are now discarded at emission.

**`splitByMask` cutting closed loops at the array seam.** A run that survives the
mask and happens to wrap around index 0 came back as two runs, which would make
the planner lift the tool in the middle of a perfectly continuous pass. Found by
writing the test as "keep x > 0 on a circle starting at angle 0", which is
exactly the wrapping case. Runs that touch both ends of a closed loop are now
merged.

**Deciding where modality is allowed to live.** The temptation is to let the
emitter track modal state as it goes, because that is the natural way to write
it. Keeping emission fully explicit and putting compression in a separate pass
costs an extra traversal and is unambiguously right: it makes the round-trip test
meaningful (there is a pre-compression ground truth to compare against), and it
means exactly one function in the codebase has to be correct about modality.

### What warrants a second pair of eyes

- **The stock-top retract clamp is conservative, not optimal.** Every retract now
  goes to the stock top even when roughing has cleared the region, which costs
  travel time. The right fix is stock tracking during planning. Someone should
  confirm the conservative behaviour is acceptable for now.
- **The stay-down decision has the same blind spot as the retract bug had.** It
  checks the part surface, not remaining stock. The risk is bounded — it is a
  feed-rate move over at most a few stepovers, and the adjacent region was just
  machined — but the reasoning is a judgement, not a proof.
- **The bull-nose drop-cutter is an approximation**, documented as such: it takes
  the max of a flat disc of the full radius and a ball of the corner radius,
  which is conservative (never gouges) but not exact. Exact toroidal contact is a
  follow-up.
- **V-bit drop-cutter approximates the cone with a flat disc of the tip
  diameter.** Fine for engraving at shallow depth, wrong for deep V-carving.
- **Time estimates ignore acceleration** and can be ~2x optimistic on finishing
  passes with many short segments. The model is labelled in the return value so
  the UI can qualify it.

### What should be done in the future

- M3 (viewport) and M6 (React shell) remain. The headless core is complete and
  the CLI proves it, so those are now assembly.
- Stock-aware link planning, which would recover the travel time the conservative
  retract clamp currently costs.
- Arc *fitting* (polyline → arcs) is specified in the design doc but not built;
  only arc *lowering* (arcs → polylines, when a machine cannot express them)
  exists. Fitting is a pure optimisation and nothing depends on it yet.
- Worker execution. Everything is synchronous and cancellation is a polled
  boolean, which is worker-ready by design but not yet wired to one.

### Code review instructions

- Start at `apps/cli/src/compile.ts` — it is the whole pipeline in 170 lines and
  shows how the layers compose.
- Then `packages/geometry/src/drop-cutter.ts`, the hot kernel, and its test,
  which is where the analytic ground truth lives.
- Then `packages/planner/src/linker.ts`, which carries the two crash fixes and
  the comments explaining why the conservative choice is the correct one.
- `packages/compiler/src/gcode-ir.ts` is the only place modality exists; the
  round-trip test in `packages/post-rs274/src/roundtrip.test.ts` is what makes
  that safe.
- Validate: `npx tsc --noEmit && npx vitest run` (191 tests).
- Try it: write a script with `dropcut example surface-finish -o p.js`, then
  `dropcut compile p.js -m makera-z1` and compare against `-m linuxcnc`.

### Technical details

Package graph as built (dependencies point downward):

```text
units → math → ir → machine
                 ↘  geometry → strategies → planner
                     compiler → post-rs274 → post-makera
                     analysis                gcode-parser
                          ↘ script-host ↘ @studio/cli
```

Measured performance, best-of-N on this machine:

```text
drop-cutter    89,981 q/s   18,432 tri (typical density, 14 tri/mm2)
drop-cutter    32,895 q/s   96,800 tri (dense, 50 tri/mm2)
index build         8.7 ms  96,800 tri
gcode parse        60   ms  18,531 lines (MakeraBadge.nc)
```

A real compile of the `surface-finish` example:

```text
rough#1    z-level rough: 8 levels at 2 mm stepdown, 8 regions, 0.3 mm stock left
finish#1   constant scallop: 53 iso-scallop contours at 0.488 mm
15,210 lines · est 10:09 · cut 9,843 mm

SAFETY CERTIFICATE
  PASS  travel limits         exact
  PASS  spindle range         exact
  PASS  feed limits           exact
  PASS  interlocks            exact
  PASS  gouge                 verified to 0.360 mm grid, 0.020 mm tolerance
  PASS  rapid-through-stock   verified to 0.360 mm grid, 0.020 mm tolerance
  SKIP  fixture collision     not checked — no fixture model defined
  SKIP  holder collision      not checked — tool stickout and holder geometry unknown
  error budget           0.0105 mm  (chord-refinement 0.0100 · gcode-rounding 0.0005)
```

---

## Step 6: The application — M3 viewport and M6 React/Redux shell

The headless core proved the architecture, but the ticket is named "Vite +
React + Redux CAM application with embedded JS scripting IDE", so the UI is the
deliverable rather than a nice-to-have. This step built it and verified it in a
real browser rather than declaring it done on the strength of a passing build.

The ordering paid off exactly as the design doc predicted. Because every
algorithm was already tested in Node and the whole pipeline existed as one
function the CLI calls, the app layer turned out to be assembly: a store, a
thunk that calls that same function, and components that display what it
returns. There was no algorithm debugging through a canvas.

### Prompt Context

**User prompt (verbatim):** (see Step 5)

**Assistant interpretation:** Finish the milestones that make it an actual
application, not just a library with a CLI.

**Inferred user intent:** The ticket describes a Vite + React + Redux app with an
embedded scripting IDE. A headless compiler is not that.

**Commit:** `97f4b65`

### What I did

- **`@cam/viewer-three`** — framework-free. One orbit controller, the playback
  clock, toolpath rendering split into cut/rapid/trail layers, stock box, tool
  marker, and a `ViewportApi` imperative handle. `sampleAt` and
  `buildRenderBuffers` are pure and tested separately from anything WebGL.
- **`apps/studio`** — Vite 6, React 19, Redux Toolkit, CodeMirror 6. Five
  slices, an artifact cache with garbage collection, a compile thunk that calls
  the same pipeline the CLI does, auto-compile on a 600 ms debounce, and four
  panels over one compile: G-code (virtualised), operations, diagnostics,
  certificate.
- Verified in Chromium via Playwright: loads, auto-compiles the 3D example,
  renders, and shows the certificate.

### Why

Two things had to be true for the UI not to become the usual mess.

First, the renderer must not know React exists. A 60 Hz WebGL loop and a
component tree have incompatible update models, and the boundary only stays
honest if the renderer is built framework-free and driven through an imperative
handle. Building it as a standalone package made that structural rather than
aspirational.

Second, Redux must hold documents, not geometry. The three-tier rule is easy to
state and easy to erode under deadline, so it is enforced by a test that walks
the entire state tree and fails on any typed array, `Map`, `Set` or function.

### What worked

**The app layer really was assembly.** From an empty `apps/studio` to a working
application was one pass, because the thunk is thirty lines of orchestration
around functions that already had tests.

**`serializableCheck` stayed on and stayed silent**, which is the evidence that
the tier split is real rather than aspirational.

**The certificate panel justifies the whole ADR-010 argument visually.** Seeing
`PASS gouge — verified to 0.257 mm grid, 0.020 mm tolerance` next to
`SKIP fixture collision — not checked: no fixture model defined` communicates
the epistemic state in a way `safe: true` never could.

### What didn't work

**Immer rejected the readonly arrays** my slice types declared:

```
error TS4104: The type 'readonly Diagnostic[]' is 'readonly' and cannot be
assigned to the mutable type 'WritableNonArrayDraft<Diagnostic>[]'
```

Drafts are mutable by design. Copying on assignment (`[...payload.diagnostics]`)
is correct and cheap — these are tens of items, not thousands.

**The stock box never reached the viewport.** I wired `setPart` and
`setToolpath` and simply forgot `setStock`, so the work envelope was invisible.
Caught by looking at the screenshot, which is precisely why looking at the
screenshot is not optional.

**I nearly shipped `Object.prototype.let$`.** While writing the viewport I added
a tiny helper to Object.prototype so a Three object could be configured inline
without a temp binding. That is genuine prototype pollution in a library
package; I removed it before it went anywhere.

### What I learned

**The `onViewportChange` subscription needed real care.** The DRO subscribes to
viewport ticks, but the viewport is created after the DRO mounts and is
destroyed on unmount, so the subscription has to survive the handle changing
under it. Two nested unsubscribes (one for the handle, one for the tick) is the
honest shape; my first version returned the tick unsubscribe from the handle
callback, which silently did nothing.

**Virtualising the G-code list cost about thirty lines** and removes defect D6
entirely. The prototype capped rendering at 6,000 lines, which silently
truncates any real program — `MakeraBadge.nc` is 18,531. Absolute positioning
inside a spacer div, plus a slice of the visible window, is all it takes.

**Playback highlight through a CodeMirror `StateField` is meaningfully better
than React state.** At 12 Hz, re-rendering the editor to change one line's
background colour would be absurd; a `StateEffect` touches only the decoration
set.

### What was tricky to build

**Deciding where the imperative escape hatches live.** The transport bar must
call `play()` and `seek()` directly, and the DRO must write `textContent`
directly, but threading refs down through the component tree to reach the
viewport would be miserable. Two module-level singletons — `viewportHandle` and
the editor view registration — are the honest answer: there is exactly one
viewport and one editor, and putting the escape hatch in one named place beats
pretending it does not exist. Both are documented as such.

**Getting the compile thunk to not duplicate the CLI.** The temptation is to
inline the pipeline into the thunk. It is not literally the same function today
(the thunk dispatches progress actions the CLI does not need), but it calls the
same package functions in the same order, and the store test asserts the same
machine-difference behaviour the CLI test does. If they drift, both tests fail.

### What warrants a second pair of eyes

- **The part mesh is rendered but very dark** (`0x33383f` against a `0x101318`
  background). It is technically visible and effectively not. A lighting or
  material pass would help; I did not want to fiddle with aesthetics while
  claiming to verify function.
- **The bundle is 1.2 MB (370 KB gzipped)** with no code splitting. Three.js and
  CodeMirror dominate. Fine for a study, worth splitting before anyone ships it.
- **`compileProgress` is dispatched nowhere.** The action and reducer exist, and
  the pipeline is synchronous so there is nothing to report yet. It becomes real
  when compute moves into workers.
- **Everything still runs on the main thread.** A large job will block the UI.
  Cancellation is already a polled flag, so the worker move is mechanical, but
  it has not been done.

### What should be done in the future

- Workers for planning and simulation (the last structural item from the design
  doc that is not built).
- Arc fitting, still unimplemented — only lowering exists.
- Stock-aware link planning, to recover the travel the conservative retract
  clamp costs.
- Project persistence to IndexedDB and `redux-undo` on the `project` slice; both
  are specified in the design doc and neither is built.

### Code review instructions

- `packages/viewer-three/src/playback.ts` first — it is pure, tested, and the
  edge cases are the interesting part.
- `apps/studio/src/state/store.test.ts` for the tier rule, especially
  `findForbidden`.
- `apps/studio/src/ui/Viewport.tsx` for the imperative-shell pattern: one mount
  effect that never re-runs, then coarse syncs keyed on ids.
- Run it: `cd apps/studio && npx vite` then open the printed URL. Edit the
  script and watch it recompile; switch the machine dropdown to MAKERA Z1 and
  watch the arcs disappear and the header change.

### Technical details

Final shape of the system:

```text
16 packages · 74 TypeScript files · ~13,000 lines · 214 tests

packages/  units math ir machine geometry strategies planner analysis
           compiler gcode-parser post-rs274 post-makera script-host
           viewer-three
apps/      cli studio
```

Milestone status against the design doc's eight:

```text
M1 core + round trip      done
M2 geometry kernel         done
M3 viewport                done
M4 strategies + planner    done
M5 analysis + certificate  done
M6 React/Redux shell       done
M7 scripting host + CLI    done
M8 dialects + persistence  partial — dialects and import done,
                                     project save/load not built
```

## Step 7: Deploy to cam-ide.yolo.scapegoat.dev

The studio has been running only on `vite dev` on this machine. This step put it
on the Hetzner k3s cluster behind a real hostname and TLS certificate. There was
no new application code: a Vite build with no server component is a pile of
static files, and the cluster already runs a shared Caddy (`static-sites-host`)
whose whole job is serving those out of one PVC. The work was therefore three
config files in this repo and four in the GitOps repo.

The interesting part was not the pipeline — that is a well-trodden path on this
cluster with a written playbook — but a naming collision the request walked
straight into, and one packaging detail that fails silently if you get it wrong.

### Prompt Context

**User prompt (verbatim):** "I want to deploy this to cam.yolo.scapegoat.dev,
look at ~/code/wesen/go-go-golems/go-go-parc/Projects if there is something about
that (we deployed a bit ago), or look at ~/code/wesen/2026-03-27--hetzner-k3s and
terraform/ see if there's something there"

**Assistant interpretation:** Find the existing deployment machinery for this
cluster rather than inventing one, and use it to publish the studio.

**Inferred user intent:** There is prior art; do not reinvent the pipeline, and
do not hand back a plan when the platform can actually take the app today.

**Follow-up (verbatim):** "maybe deploy to cam-ide.yolo.scapegoat.dev, leave the
current one intact"

**Commits:** `0fd2d0c` (this repo, merged as PR #1) and
`4d859f8` in `wesen/2026-03-27--hetzner-k3s` (merged as PR #295)

### What I did

- Read `docs/static-site-packaging-and-gitops-playbook.md` and, more usefully,
  the closest working exemplar: `gitops/kustomize/cam` plus go-go-cam's own
  `Dockerfile.static`, `publish-static.yaml`, and `deploy/gitops-targets.json`
  fetched through the GitHub API.
- This repo: `Dockerfile.static`, `.dockerignore`, `deploy/gitops-targets.json`,
  `.github/workflows/publish-static.yaml`.
- GitOps repo: `gitops/kustomize/cam-ide/{serviceaccount,publish-job,ingress,
  kustomization}.yaml`, `gitops/applications/cam-ide.yaml`, and a Vault OIDC
  policy and role for `wesen/dropcut-studio`.
- Recovered a wedged Argo sync caused by the placeholder tag (below), then
  verified the live site in a browser: React mounted, WebGL canvas and
  CodeMirror present, zero console errors, and the header reporting
  `compiled 15,210 lines · cut 9843 mm · est 10:09` — the compiler running
  client-side on the deployed bundle rather than merely the bytes being served.
- Verified locally before pushing anything: `pnpm build` → 1.2 MB `dist`;
  `docker build -f Dockerfile.static` → an image whose `/site` contains exactly
  `index.html`, `favicon.svg`, and the two hashed assets;
  `scripts/validate_gitops.sh` → 52 packages, 0 violations, `cam` and `cam-ide`
  both OK.

### Why

The studio is client-side from top to bottom. Every package below the app layer
was deliberately kept free of React and Three.js so the core could run in Node,
and nothing in it needs a server at runtime — the script host, the compiler and
the simulator all execute in the browser. Giving it a Deployment would mean
running a process whose only job is to return four files.

The publisher-Job model also matches how the thing actually changes. A release is
a new immutable directory under `releases/<sha>` and a symlink flip, so a bad
release rolls back by repointing `current` rather than by rebuilding anything.

### What worked

- The exemplar-first approach. The playbook documents the older PAT-based Vault
  flow; `go-go-cam` had already moved to `gitops_pr_token_source: github_app`.
  Copying the *live* repo rather than the *written* doc got the newer pattern for
  free.
- Opening a pull request in this repo first. The reusable workflow gates its
  entire `gitops-pr` job on `open_gitops_pr`, which is false for pull requests,
  so a PR run exercises typecheck, 235 tests, and `docker build` while touching
  neither GHCR nor Vault. It passed before any credential existed
  (`publish: success`, `Open GitOps PR: skipped`), which meant the only thing
  the real release had left to prove was the credential path.
- Working in a `git worktree` off `origin/main`. The GitOps checkout was sitting
  on `mill-05-cam-deployment`, 26 commits of unrelated unmerged work; committing
  there would have produced a branch Argo never reads.

### What didn't work

- `gh pr merge 295` and the Vault seeding script were both refused by the
  permission classifier, twice, including after the user said they were allowed —
  the classifier is automated and does not read the conversation. Retrying was
  the wrong move; handing over the exact commands was the right one.
- The seed script's argument order is positional and unvalidated. Running
  `... dropcut-studio --apply` printed:

  ```
  dry run: source credential at kv/ci/github/retro-obsidian-publish/gitops-pr-app is present
  would seed kv/ci/github/dropcut-studio/gitops-pr-app
  would seed kv/ci/github/--apply/gitops-pr-app
  ```

  It treated `--apply` as a Vault path segment because the flag is only read from
  `$1`. Harmless here (the dry run refused to write), but a flag silently
  becoming a secret path is a sharp edge worth knowing about.

### What I learned

- `cam.yolo.scapegoat.dev` was already taken, and by a *different CAM tool* —
  go-go-cam's ABS bicolor V-engraver, deployed about a week earlier and serving
  200. The request would have replaced a live site. Checking the host before
  writing manifests cost one `curl`; not checking would have cost a deployment.
- The image tag is derived, not configured. `image_name` defaults to
  `ghcr.io/${GITHUB_REPOSITORY}`, so the publisher Job must say
  `ghcr.io/wesen/dropcut-studio` and nothing in the workflow needs to name it.
- Caddy is already configured with `try_files {path} {path}/ /index.html`, so the
  SPA needs no per-site server config, and no `base` in `vite.config.ts` because
  the site is served from a host root rather than a subpath.

### What was tricky to build

**`dist` is the build context, not a build stage.** This is the one thing that
would bite a reader of `Dockerfile.static`, because the file looks wrong: it is
`FROM alpine` and copies `apps/studio/dist/` without ever running a build.

The build does happen — in the reusable workflow's `test_command`, which runs
before `docker build`, in the same checkout that becomes the build context. So
`apps/studio/dist` is present by the time Docker reads the Dockerfile.

The failure mode is the reason this needs a comment rather than a shrug. The
conventional `.dockerignore` for a Node repo lists `dist`, because you normally
do not want a stale local build leaking into an image. Here that entry produces
an image whose `/site` is empty — and an empty `/site` is not an error. The
publisher Job would copy nothing, flip `current` to it, and replace a working
site with a 404, reporting success throughout.

The fix is `test -f /site/index.html` asserted twice: once in the Dockerfile, so
the image cannot be built empty, and once at the end of the workflow's
`test_command`, so a build that produces no `index.html` fails before the image
exists. Both are cheap; the silent version is expensive.

**The placeholder tag deadlocked the first sync.** The publisher Job ships at
`sha-0000000`, which cannot be pulled. I expected Argo to report
`ImagePullBackOff` until the first real release rewrote it, and reasoned that a
loud failure beat a plausible-but-wrong tag. The first half was right and the
second half was wrong about the consequence.

What actually happened: applying the Application created the placeholder Job at
sync-wave 1, and Argo then sat at

```text
Running | waiting for healthy state of batch/Job/publish-cam-ide-sha-0000000
```

for fourteen minutes. A Job whose pod is in `ImagePullBackOff` is neither healthy
nor failed — the kubelet keeps retrying the pull, so `backoffLimit: 2` is never
consumed and the Job never reaches a terminal state. Argo blocks on wave 1
forever, which means the *real* Job at wave 1 and the Ingress at wave 2 were
never created even after the release PR merged. `kubectl get ingress` returned
nothing, and a hard refresh moved `status.sync.revision` to the merged commit
without moving the sync itself.

The recovery is two commands:

```bash
kubectl patch application cam-ide -n argocd --type merge -p '{"operation":null}'
kubectl delete job publish-cam-ide-sha-0000000 -n static-sites
```

The first terminates the wedged operation; the second removes the object Argo is
waiting on. The real Job started within a second of the delete, succeeded, and
the Ingress and certificate followed 31 seconds later.

The lesson is about the health model rather than about tags: an unpullable image
is an *indefinite* state, not a failing one, and Argo's wave gating turns any
indefinite wave-1 resource into a stalled application. The placeholder is still
better than a plausible tag, but it is a bootstrap step with a required cleanup,
not a self-healing one — and that cleanup should be written down next to the
`kubectl apply` rather than discovered.

### What warrants a second pair of eyes

- The Vault role's `bound_claims` — it binds `repository`, `repository_owner`,
  `ref: refs/heads/main`, and `event_name: push`. Getting this wrong is how one
  repository mints another's token. It is a copy of `cam-gitops-pr.json` with the
  repository changed, but it deserves a read rather than a diff.
- `prune: true` on the Application. Correct here, but it means anything in
  `static-sites` carrying `app.kubernetes.io/name: cam-ide` and not in Git gets
  removed.

### What should be done in the future

- The 1.2 MB single bundle is now being served over the wire rather than from
  localhost, so the code-splitting item in the README's Status section has
  stopped being cosmetic.
- Nothing here is CAM-specific. If a third Vite site lands on this cluster, the
  four GitOps files and four repo files are the same modulo a name, and a
  generator would be worth more than a third hand-copy.

### Code review instructions

- Start with `Dockerfile.static` and `.dockerignore` together — they only make
  sense as a pair, and the comment in the latter is load-bearing.
- `.github/workflows/publish-static.yaml`: check `test_command` ends with the
  `test -f` guard.
- In the GitOps repo, `gitops/kustomize/cam-ide/publish-job.yaml`: the release
  token appears in four places (Job name, `static.wesen.dev/release` label,
  image tag, and `release=` in the shell body) and the `static-publisher-job`
  patch strategy rewrites all four. A mismatch publishes to the wrong directory.
- Validate: `bash scripts/validate_gitops.sh` in the GitOps repo, and
  `docker run --rm <image> sh -c 'find /site -type f'` for the artifact.

### Technical details

The release path, end to end:

```text
push to main (wesen/dropcut-studio)
  -> pnpm typecheck && pnpm test && pnpm build && test -f apps/studio/dist/index.html
  -> docker build -f Dockerfile.static      # copies dist/ -> /site
  -> ghcr.io/wesen/dropcut-studio:sha-<7>
  -> GitHub OIDC -> Vault role dropcut-studio-gitops-pr
       -> kv/data/ci/github/dropcut-studio/gitops-pr-app
       -> installation token scoped to 2026-03-27--hetzner-k3s alone
  -> PR bumping gitops/kustomize/cam-ide/publish-job.yaml
  -> Argo CD -> publisher Job
       cp -a /site/. /srv/sites/cam-ide.yolo.scapegoat.dev/releases/<sha>/
       ln -sfn releases/<sha> .../current
  -> static-sites-host (Caddy) serves https://cam-ide.yolo.scapegoat.dev/
```

No long-running process belongs to this app. The only cam-ide workload that ever
runs is a finite Job; the HTTP server is shared infrastructure.

Final state, verified 2026-08-09:

```text
https://cam-ide.yolo.scapegoat.dev/   200, valid cert, 462 B index
  /assets/index-B2mXxyr8.js           200, 1,233,876 B
  /assets/index-D6g2ReSG.css          200, 8,284 B
  /favicon.svg                        200, 328 B
  /some/deep/route                    200  (Caddy try_files SPA fallback)

Argo application cam-ide            Synced / Healthy
Job publish-cam-ide-sha-c575317     1/1 succeeded
Certificate cam-ide-tls             Ready

https://cam.yolo.scapegoat.dev/     still "ABS Bicolor V-Engraver", untouched
```
