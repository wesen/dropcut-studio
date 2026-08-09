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
