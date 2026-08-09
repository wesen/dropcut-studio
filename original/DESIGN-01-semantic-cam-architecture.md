# Semantic CAM architecture — do not make G-code the semantic model

> Source: design note supplied by the user (2026-08-09), stored verbatim in content.
> Only change: the inline/display math delimiters, which were mangled to `[ ... ]` and
> stray `====` / `----` lines by the paste round-trip, have been normalized to `$$ ... $$`
> so the equations render. No wording was altered.

The key design decision is:

> **Do not make G-code the semantic model. Make machining the semantic model, and treat G-code as one serialization/backend.**

That is very close to the architecture behind NIST's RS274/NGC work: its interpreter converts modal G-code into canonical machining functions. We want the reverse direction—construct canonical machining semantics first, then compile them to LinuxCNC, GRBL, Fanuc, Makera, etc. ([NIST][1])

STEP-NC points in the same direction at a higher abstraction level: it separates manufacturing features, working steps, technology parameters, and machine functions rather than reducing the process immediately to axis commands. ([iso.org][2])

Your current Dropcut implementation already has most of the interesting CAM algorithms, but `generateJob()` currently conflates strategy planning, path construction, linking, clearance, feeds, entry methods, and the final move representation. Arc fitting, G-code generation, and verification then operate on that ad-hoc `{kind, phase, pts, ops}` representation.

I would replace that with the following architecture.

---

# 1. The semantic stack

Think of the system as five languages:

| Layer                      | Describes                                             | Example                                            |
| -------------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| **Geometry**               | What physical things exist                            | stock, target part, fixture, cutter                |
| **Manufacturing intent**   | What should be done                                   | rough this region, finish this surface             |
| **Canonical machining IR** | Machine-independent physical actions                  | traverse, cut along curve, change tool, probe      |
| **Machine IR**             | Actions after machine capability/kinematic resolution | coordinated X/Y/Z move, spindle, fixture selection |
| **G-code IR/text**         | Controller encoding                                   | `G1 X10 Y20 F600`                                  |

So:

```text
Geometry
   ↓
Manufacturing Plan
   ↓ planning
Canonical Machining IR
   ↓ machine lowering + validation
Machine Program
   ↓ postprocessor
G-code blocks
   ↓ pretty-print/modal compression
.nc
```

And verification should work primarily on the **canonical machining IR**, not on G-code text.

This gives us a compiler rather than a string generator.

---

# 2. Three mathematical objects sit at the center

There are three particularly useful mathematical models here.

## Geometry is sets and transformations

A solid is conceptually a subset

$$S \subseteq \mathbb{R}^3.$$

A tool is another solid

$$T \subseteq \mathbb{R}^3.$$

A coordinate frame transformation is an element of the rigid-motion group

$$SE(3).$$

For a simple 3-axis mill, much of the time we only need translations plus a fixed orientation, but designing around `SE(3)` means 4/5-axis machining doesn't require replacing the entire abstraction later.

This immediately suggests a typed geometry API:

```ts
const stock = box({
  x: mm(60),
  y: mm(40),
  z: mm(12),
});

const part = mesh(stl);

const fixture = frame("G54", {
  origin: vec3(mm(0), mm(0), mm(0)),
});
```

Crucially, **points should belong to frames**.

```ts
Point3<"part">
Point3<"machine">
Point3<"fixture:G54">
```

Mixing a machine-coordinate point with a work-coordinate point should not silently work.

That eliminates an entire class of CNC failures.

---

# 3. Paths naturally form a category

This is one of the category-theory ideas that is genuinely useful rather than decorative.

A path has a start pose and an end pose:

$$p : A \to B.$$

Another path might be

$$q : B \to C.$$

Then composition is possible:

$$q \circ p : A \to C.$$

But this:

$$A\to B \qquad D\to E$$

cannot be composed unless $B=D$.

That is exactly the invariant we want for toolpaths.

So instead of:

```ts
[
  0, 0, 5,
  10, 0, 5,
  10, 10, -2
]
```

we want:

```ts
const path =
  Path.at(p(0, 0, 5))
    .lineTo(p(10, 0, 5))
    .lineTo(p(10, 10, -2));
```

Internally:

```ts
interface Path<A extends Pose, B extends Pose> {
  readonly start: A;
  readonly end: B;
  readonly segments: readonly Segment[];
}
```

And:

```ts
concat(
  p1: Path<A, B>,
  p2: Path<B, C>
): Path<A, C>
```

Composition is associative:

$$(r\circ q)\circ p = r\circ(q\circ p)$$

and the zero-length stationary path serves as the identity.

That makes toolpath concatenation an actual algebra with laws that can be property-tested.

---

# 4. But a path is not yet a machining action

This distinction is important.

The same geometric curve could mean:

```text
rapid through free space
cut material
probe toward a surface
feed while not cutting
lead-in
retract
```

So separate:

```ts
Curve
```

from:

```ts
Motion
```

For example:

```ts
type Motion =
  | Traverse
  | CuttingMove
  | ProbeMove;
```

A cutting move might be:

```ts
interface CuttingMove {
  kind: "cut";
  path: ToolPath;
  feed: FeedRate;
  tool: ToolRef;
  intent:
    | "rough"
    | "finish"
    | "plunge"
    | "ramp"
    | "lead-in"
    | "lead-out";
}
```

A traverse is semantically different:

```ts
interface Traverse {
  kind: "traverse";
  path: ToolPath;
  clearance: ClearanceRequirement;
}
```

Notice that there is no `G0`.

That's deliberate.

A postprocessor might implement a traverse as:

```text
G0 Z...
G0 X... Y...
G0 Z...
```

instead of:

```text
G0 X... Y... Z...
```

if the controller's rapid motion is not guaranteed to follow a coordinated straight line.

The high-level program asked for **safe traversal**, not for the byte sequence `G0`.

---

# 5. Denotational semantics of cutting

This gives us an exceptionally clean definition of what machining means.

Let the cutter occupy solid $T$.

Let its trajectory be

$$\gamma : [0,1]\rightarrow SE(3).$$

The swept cutter volume is:

$$\operatorname{Sweep}(T,\gamma) = \bigcup_{t\in[0,1]} \gamma(t)\,T.$$

If the current stock is $S$, executing a cutting motion gives:

$$S' = S\setminus\operatorname{Sweep}(T,\gamma).$$

That is the denotational meaning of a cutting operation.

A rapid move has:

$$S'=S.$$

A finish operation doesn't fundamentally mean "lots of G1 instructions."

It means:

$$S \longmapsto S\setminus V$$

for some generated swept volume $V$.

This gives us a much stronger basis for verification.

### Gouging

Let $P$ be material that must remain in the final part.

A no-gouge condition is essentially:

$$\operatorname{Sweep}(T,\gamma) \cap P_{\mathrm{protected}} = \varnothing.$$

With an allowance $a$, the protected region changes accordingly.

Your drop-cutter evaluator can therefore be seen as a specialized solver for finding cutter poses whose swept cutter geometry remains outside the protected part.

Your current `makeEvaluator()` is already computationally approximating exactly this sort of geometric relationship.

---

# 6. Programs need effects, not just path composition

Category theory gives us another useful construction here.

Machine actions affect state:

```ts
interface MachineState {
  pose: Pose;
  tool: ToolId | null;
  spindle: SpindleState;
  coolant: CoolantState;
  fixture: FixtureFrame;
}
```

Executing a command has semantics approximately:

$$\llbracket c\rrbracket : \Sigma \rightarrow \operatorname{Result}(\Sigma\times \mathit{Trace},\ \mathit{Error})$$

where $\Sigma$ is the complete machining state.

So:

```text
command
    MachineState
        ↓
 Result<MachineState + physical trace>
```

Sequential composition is then equivalent to composition in the Kleisli category of something like:

```text
State
+ Error
+ Trace
```

In programming terms, it's approximately the combination of a State, Result, and Writer effect.

This isn't terminology we need to expose in the API. But it gives us precise laws.

For:

```ts
seq(a, b, c)
```

the semantics are:

$$\llbracket c\rrbracket \mathbin{>\!\!=\!\!>} \llbracket b\rrbracket \mathbin{>\!\!=\!\!>} \llbracket a\rrbracket.$$

If `b` fails its precondition, `c` cannot execute.

---

# 7. Canonical IR

I would make the central IR roughly this:

```ts
type CanonicalCommand =
  | ToolChange
  | Spindle
  | Coolant
  | Traverse
  | Cut
  | Probe
  | Dwell
  | Pause;
```

For example:

```ts
interface ToolChange {
  kind: "tool-change";
  tool: ToolRef;
}

interface Spindle {
  kind: "spindle";
  state:
    | { mode: "off" }
    | {
        mode: "cw" | "ccw";
        speed: RPM;
      };
}

interface Traverse {
  kind: "traverse";
  path: Path;
}

interface Cut {
  kind: "cut";
  path: Path;
  feed: FeedRate;
  tolerance: Length;
  purpose: CuttingPurpose;
}

interface Probe {
  kind: "probe";
  path: Path;
  feed: FeedRate;
  failure: "abort" | "continue";
  result: ProbeVariable;
}
```

The IR is deliberately **non-modal**.

Every cutting motion knows its feed.

Every spindle operation knows its speed.

Every path knows its frame.

Every arc knows its plane geometrically, rather than depending on stale `G17/G18/G19`.

G-code's modal groups are a property of the target language; LinuxCNC itself treats motion, plane selection, units, distance mode, feed-rate mode, coordinate systems, etc. as separate modal groups. ([LinuxCNC][3])

We should not infect the source language with those semantics.

---

# 8. G-code modal state becomes a compiler optimization

Suppose our canonical IR contains:

```ts
cut(lineA, feed(600));
cut(lineB, feed(600));
cut(lineC, feed(600));
```

Semantically each operation says `600 mm/min`.

The G-code postprocessor can observe:

```text
previous feed = 600
required feed = 600
```

and omit the redundant `F600`.

Likewise:

```text
currentPlane = XY
requiredPlane = XY
```

means don't emit another `G17`.

So:

```ts
Canonical Program
       ↓
explicit GCodeBlocks
       ↓
modal-state compression
       ↓
text
```

The compiler—not the programmer—owns modal state.

This converts G-code's dangerous hidden state into a mundane backend compression problem.

---

# 9. High-level manufacturing IR

Canonical moves are still too low-level for the API you actually want users to write.

Above them should be a manufacturing-plan layer:

```ts
type MillingOperation =
  | Face
  | Pocket
  | Profile
  | SurfaceRough
  | SurfaceFinish
  | Drill
  | Chamfer
  | ProbeOperation;
```

For example:

```ts
mill.surfaceFinish({
  surface: part.exterior(),
  tool: ballNose({
    diameter: mm(3),
  }),

  strategy: constantScallop({
    scallop: mm(0.01),
  }),

  tolerance: mm(0.01),
});
```

Your current strategies map cleanly to this layer:

```ts
raster(...)
hybridWaterline(...)
constantScallop(...)
```

The Eikonal solver belongs inside `constantScallop`, not inside the program representation.

Likewise:

```ts
rough({
  stepdown: mm(1.5),
  stepover: percent(45),
  stockToLeave: mm(0.2),
  entry: autoEntry({
    maxRampAngle: deg(3)
  })
})
```

could encapsulate much of your present roughing code.

---

# 10. Preserve manufacturing features

The geometry API should not only expose generic meshes.

These:

```ts
Solid
Surface
Curve
Region2
```

are useful.

But so are:

```ts
Pocket
Hole
Boss
PlanarFace
FreeformSurface
Profile
Slot
```

because machining meaning is attached to them.

Compare:

```ts
remove(solid)
```

with:

```ts
mill.pocket(pocket, {...})
```

The second tells the planner a huge amount.

This is one of the useful ideas behind STEP-NC: its process model retains geometric and technological/manufacturing information above the raw axis-motion layer. ([iso.org][2])

You don't need to implement STEP-NC, but you should borrow this idea.

---

# 11. The user-facing API could look like this

For example:

```ts
import {
  cam,
  mm,
  rpm,
  mmPerMin,
  deg,
} from "@mill/core";

const T1 = cam.tools.ballEndMill({
  name: "3mm ball",
  diameter: mm(3),
  fluteLength: mm(12),
});

const stock = cam.geometry.box({
  x: mm(50),
  y: mm(50),
  z: mm(15),
});

const part = cam.geometry.mesh(stl);

const setup = cam.setup({
  stock,
  part,

  fixture: cam.frame.workpiece({
    id: "top",
    origin: [mm(0), mm(0), mm(0)],
  }),
});

const plan = cam.plan(setup)

  .roughSurface({
    target: part,

    tool: T1,

    stepdown: mm(1.5),
    stepover: 0.45,
    stockToLeave: mm(0.2),

    entry: cam.entry.auto({
      maxRampAngle: deg(3),
    }),
  })

  .finishSurface({
    target: part,

    tool: T1,

    strategy: cam.strategy.constantScallop({
      height: mm(0.01),
    }),

    chordTolerance: mm(0.01),
  });
```

Then:

```ts
const canonical =
  await cam.planToolpaths(plan);
```

This returns **no G-code**.

It returns semantic machining operations.

---

# 12. Compilation should be explicit

Then:

```ts
const machine = machineProfile({
  axes: "XYZ",

  travels: {
    x: range(mm(-5), mm(300)),
    y: range(mm(-5), mm(180)),
    z: range(mm(-80), mm(0)),
  },

  spindle: {
    min: rpm(3000),
    max: rpm(24000),
  },

  rapid: {
    semantics: "axis-independent",
  },

  arcs: {
    xy: true,
    xz: true,
    yz: true,
    helical: false,
  },

  probing: "g38",
});
```

Then:

```ts
const result =
  await cam.compile(canonical, machine);
```

Maybe:

```ts
result.program
result.diagnostics
result.analysis
```

and finally:

```ts
const nc =
  linuxCNC.emit(result.program);
```

or:

```ts
const nc =
  makera.emit(result.program);
```

---

# 13. The really useful type trick: certified stages

Don't let these all have the same TypeScript type.

For example:

```ts
type PlannedProgram = ...
type LoweredProgram = ...
type ValidatedProgram = ...
type PostprocessedProgram = ...
```

Then:

```ts
plan(): PlannedProgram

lower(
  PlannedProgram,
  MachineProfile
): LoweredProgram

validate(
  LoweredProgram,
  Scene
): Result<ValidatedProgram, ValidationError[]>

emit(
  ValidatedProgram,
  PostProcessor
): GCode
```

The postprocessor cannot accidentally accept an arbitrary half-generated program.

You can enforce it with an unexported brand:

```ts
declare const validated:
  unique symbol;

export interface ValidatedProgram
  extends LoweredProgram {
  readonly [validated]: true;
}
```

Only the verifier module can create that value.

This isn't a mathematical proof of machine safety—but it is a useful API proof that the requested validation pipeline ran.

---

# 14. Units should not be bare numbers

Currently:

```ts
diameter: 3
feed: 600
rpm: 10000
clearance: 5
```

all have the same JavaScript type.

That's unnecessary risk.

Use branded measures:

```ts
type Mm = number & Brand<"mm">;
type Inch = number & Brand<"inch">;

type RPM = number & Brand<"rpm">;
type MmPerMinute =
  number & Brand<"mm/min">;

type Degree =
  number & Brand<"degree">;
```

Then:

```ts
lineTo({
  x: rpm(10000)
});
```

is a compile error.

At API boundaries, runtime schemas must validate the brands because TypeScript is erased.

---

# 15. Frames deserve the same treatment

This is even more important than units.

Something like:

```ts
type Point3<F> = {
  x: Mm;
  y: Mm;
  z: Mm;

  frame: F;
};
```

Then:

```ts
const machineP:
  Point3<MachineFrame>;

const partP:
  Point3<PartFrame>;
```

cannot be subtracted without:

```ts
transform(partToMachine, partP)
```

Coordinate transformations are morphisms:

$$T_{AB}:A\rightarrow B$$

with composition:

$$T_{BC}\circ T_{AB} : A\rightarrow C.$$

Rigid frame transformations form a groupoid: every coordinate transformation has an inverse.

That is exactly the mathematical structure we need.

---

# 16. Toolpaths should be geometric objects, not arrays

An internal segment type could be:

```ts
type Segment =
  | Line
  | Arc
  | Helix
  | Bezier
  | BSpline;
```

An arc shouldn't contain G-code-ish `I/J/K`.

Use geometric data:

```ts
interface Arc<F> {
  kind: "arc";

  start: Point3<F>;
  end: Point3<F>;

  center: Point3<F>;
  axis: UnitVector3<F>;

  sweep: Radians;
}
```

Then LinuxCNC might lower it into:

```text
G17
G3 X... Y... I... J...
```

while another controller could choose radius notation, linearize it, or use some higher-order interpolation format.

---

# 17. Arc fitting becomes an optimization pass

Your current `compressCut()` / `fitArcsRun()` can survive nearly intact algorithmically.

But its conceptual type should change from:

```text
Float32Array → G-code-ish ops
```

to:

```text
Polyline
    ↓ ArcFit(tolerance)
PiecewiseCurve
```

with a postcondition:

$$d_H(P,C)\leq\epsilon$$

where $d_H$ is some chosen geometric deviation metric and $\epsilon$ is the requested fitting tolerance.

Then:

```ts
arcFit({
  tolerance: mm(0.01)
})
```

is a semantics-preserving compiler optimization.

It knows nothing about `G17`.

Later:

```ts
lowerArcs(machine)
```

decides whether the controller can actually represent them.

---

# 18. Compiler correctness becomes a commuting diagram

The architectural invariant should be:

```text
Canonical program P
        │
        │ postprocessor
        ▼
      G-code
```

with:

$$\operatorname{Semantics}_{\mathit{machine}}(P) \approx_{\epsilon} \operatorname{Semantics}_{\mathit{controller}}(\operatorname{post}(P)).$$

In other words, compiling shouldn't materially change what the tool does.

The $\epsilon$ is important because linearization and arc fitting introduce finite geometric tolerances.

Every lowering pass could therefore carry a **certificate/budget**:

```ts
interface ErrorBudget {
  geometric: Mm;
  timing?: Seconds;
}
```

If:

```text
drop-cutter sampling     0.005 mm
arc fitting              0.010 mm
post linearization       0.002 mm
```

you don't pretend the output has 0.001 mm accuracy.

You propagate a conservative error budget.

This is an excellent place for formal semantics to directly improve practical CAM.

---

# 19. Safety as predicates on programs

We can write many CAM guarantees as predicates.

For a program $P$:

$$\operatorname{WithinTravel}(P)$$

$$\operatorname{NoFixtureCollision}(P)$$

$$\operatorname{NoGouge}(P)$$

$$\operatorname{ToolCompatible}(P)$$

$$\operatorname{FeedWithinLimits}(P)$$

$$\operatorname{SpindleWithinLimits}(P)$$

$$\operatorname{Continuous}(P)$$

and:

$$\operatorname{Safe}(P) = \bigwedge_i P_i.$$

The validator then returns:

```ts
type Validation =
  | {
      ok: true;
      program: ValidatedProgram;
      certificate: SafetyCertificate;
    }
  | {
      ok: false;
      errors: Diagnostic[];
    };
```

A diagnostic should point back to the manufacturing operation that caused it:

```text
finishSurface #2
  → path 41
    → segment 307
      → exceeds machine X travel by 1.42 mm
```

So every lowering pass should retain source provenance.

---

# 20. Not all verification is equally strong

This matters with your current dexel simulator.

Your `verifyJob()` samples the machining result onto a heightfield/dexel representation and computes gouge/excess deviation. That's very useful, but it is a **numerical approximation**, not a mathematical proof that no collision occurs between samples.

Therefore the API should distinguish:

```ts
analysis: "sampled"
```

from something like:

```ts
analysis: "conservative-bound"
```

or:

```ts
analysis: "exact"
```

if you someday have such a verifier.

For example:

```ts
certificate.gouge = {
  status: "verified-to-resolution",
  spatialResolution: mm(0.15),
  numericalTolerance: mm(0.01),
};
```

That's much better than:

```ts
safe: true
```

because it describes what has actually been established.

---

# 21. Operational semantics

For the core IR, I'd actually write down a small-step semantics in the design document.

Suppose:

$$\sigma = (p,t,s,c,w,S)$$

contains pose, tool, spindle, coolant, work coordinate system, and stock.

A spindle transition could be:

$$\frac{r\in \mathit{Machine.spindleRange}}{\langle \mathit{SpindleCW}(r),\sigma\rangle \rightarrow \sigma[s:=\mathit{CW}(r)]}$$

A tool change might require:

$$s=\mathit{OFF}.$$

So:

$$\frac{\sigma.\mathit{spindle}=\mathit{OFF}}{\langle \mathit{ToolChange}(T),\sigma\rangle \rightarrow \sigma[\mathit{tool}:=T]}$$

A cutting operation might require:

$$\mathit{tool}\neq\varnothing$$

and:

$$\mathit{feed}>0.$$

Then:

$$\langle \mathit{Cut}(\gamma),\sigma\rangle \rightarrow \sigma[\mathit{pose}:=\gamma(1),\ \mathit{stock}:=\mathit{stock}\setminus \operatorname{Sweep}(\mathit{tool},\gamma)].$$

This gives the IR an actual specification independent of any implementation.

That specification becomes the reference for tests and eventually formal verification.

---

# 22. Scope combinators can encode lifecycle guarantees

Instead of:

```ts
spindle.on();
...
...
...
spindle.off();
```

offer:

```ts
withSpindle(
  {
    speed: rpm(10_000),
    direction: "cw",
  },

  () => {
    // machining operations
  }
);
```

Its meaning is:

```text
SpindleOn
body
SpindleOff
```

Likewise:

```ts
withCoolant("flood", body)
withTool(T1, body)
```

This is essentially structured resource management.

It eliminates malformed sequences by construction.

A generated program can still flatten to:

```text
T1 M6
S10000 M3
...
M5
```

but the API never asks users to manually balance starts and stops.

---

# 23. Strategies should be plugins

Your Dropcut algorithms make a good test case for this abstraction:

```ts
interface ToolpathStrategy<
  Input,
  Params
> {
  plan(
    ctx: PlanningContext,
    input: Input,
    params: Params
  ): Promise<ToolpathSet>;
}
```

Then:

```ts
RasterFinish
HybridWaterlineFinish
ConstantScallopFinish
ZLevelRough
```

become independent strategy implementations.

For example:

```ts
const constantScallop =
  defineStrategy({
    name: "constant-scallop",

    async plan(ctx, surface, p) {
      const field =
        await ctx.cutterLocationField(...);

      const eikonal =
        solveEikonal(...);

      return contoursToToolpaths(...);
    },
  });
```

This makes experimentation with CAM mathematics substantially easier.

---

# 24. Geometry should also be kernel-independent

Avoid exposing Three.js geometry as the canonical geometry model.

Three.js should be a renderer.

Use interfaces such as:

```ts
interface Surface {
  bounds(): Box3;
  evaluate(u: number, v: number): Point3;
}

interface Mesh extends Solid {
  triangles(): Iterable<Triangle>;
}

interface Solid {
  bounds(): Box3;
}
```

A future implementation could then use:

```text
triangle meshes
OpenCascade
Manifold
CGAL/WASM
signed-distance fields
NURBS
```

without changing the CAM API.

Your current STL triangles become one implementation of `Mesh`.

---

# 25. A nice API for 2.5D milling

You can make simple milling extremely concise.

For example:

```ts
const plate =
  sketch()
    .rect(mm(80), mm(50))
    .extrude(mm(8));

const pocket =
  sketch()
    .roundedRect(
      mm(40),
      mm(20),
      mm(3)
    )
    .pocket({
      depth: mm(4),
    });

const holes =
  pattern.grid({
    rows: 2,
    columns: 4,
    spacingX: mm(15),
  }).holes({
    diameter: mm(4),
    depth: through(),
  });
```

Then:

```ts
job
  .millPocket(pocket, {
    tool: T1,
    strategy: "offset",
  })

  .drill(holes, {
    tool: drill4mm,
  });
```

That is far more useful to a JS programmer than constructing lines of G-code.

---

# 26. And still allow escape to exact machine motions

Some users need complete control.

So the DSL should have an escape layer:

```ts
job.canonical(({ move, spindle }) => {
  spindle.cw(rpm(12_000));

  move.traverseTo(
    p(mm(0), mm(0), mm(5))
  );

  move.feedTo(
    p(mm(0), mm(0), mm(-1)),
    mmPerMin(300)
  );
});
```

But even this is semantic—not raw G-code.

Raw G-code should be an explicitly unsafe backend-specific escape hatch:

```ts
linuxcnc.raw("M64 P0");
```

possibly tagged:

```ts
effects: ["digital-output"]
```

so the rest of the compiler knows that it cannot fully analyze it.

---

# 27. Machine capabilities should be algebraic data

Don't write:

```ts
if (machine === "Makera")
```

throughout the compiler.

Define capabilities.

For example:

```ts
interface MachineCapabilities {
  axes: AxisSet;

  interpolation: {
    linear: true;
    arcXY: boolean;
    arcXZ: boolean;
    arcYZ: boolean;
    helix: boolean;
  };

  spindle: {
    directions: readonly (
      "cw" | "ccw"
    )[];

    range: Range<RPM>;
  };

  probe:
    | { kind: "g38" }
    | { kind: "g31" }
    | null;

  rapid:
    | "coordinated"
    | "axis-independent";

  toolChange:
    | "manual"
    | "automatic";

  coordinateSystems:
    readonly FixtureId[];
}
```

Then lowering is capability-driven.

---

# 28. This handles G-code dialects cleanly

The canonical IR might say:

```ts
probe({
  direction: vec3(0, 0, -1),
  maxTravel: mm(30),
  feed: mmPerMin(100),
  failure: "abort",
});
```

LinuxCNC could emit:

```text
G38.2 Z-30 F100
```

A Fanuc-style backend might emit:

```text
G31 Z-30 F100
```

plus whatever result-validation sequence its dialect requires.

The semantics are identical.

The encoding differs.

---

# 29. The postprocessor itself should have two stages

I would not even have the postprocessor directly produce strings.

First:

```ts
CanonicalIR
    ↓
GCodeIR
```

where:

```ts
interface GCodeBlock {
  motion?: MotionWord;
  axes?: Partial<Axes>;
  feed?: FeedRate;
  spindle?: RPM;
  misc?: MCode[];
  comment?: string;
}
```

Then:

```ts
GCodeIR
   ↓ modal optimizer
OptimizedGCodeIR
   ↓ formatter
string
```

This means you can unit-test:

```text
machine semantics → block semantics
```

separately from formatting.

---

# 30. The compiler pipeline I would implement

A complete version could look like:

```text
ManufacturingPlan
      ↓
feature expansion
      ↓
strategy planning
      ↓
ToolpathProgram
      ↓
linking
      ↓
entry/exit generation
      ↓
clearance planning
      ↓
curve refinement
      ↓
arc/spline fitting
      ↓
CanonicalProgram
      ↓
machine capability lowering
      ↓
kinematic transformation
      ↓
static machine validation
      ↓
material/collision verification
      ↓
ValidatedProgram
      ↓
dialect lowering
      ↓
GCodeIR
      ↓
modal compression
      ↓
G-code
```

Your current `generateJob()` contains approximately the middle six stages simultaneously.

Separating them is probably the single largest architectural improvement available.

---

# 31. This also makes optimization principled

Once toolpaths have semantics, we can define optimization as:

$$\min_P \quad C(P)$$

subject to:

$$\llbracket P\rrbracket \models \mathit{Specification}$$

and:

$$\mathit{Safe}(P).$$

The cost could be:

$$C(P) = \alpha\,\mathit{time}(P) + \beta\,\mathit{toolwear}(P) + \gamma\,\mathit{retracts}(P) + \delta\,\mathit{jerk}(P).$$

Then nearest-neighbor contour ordering, feed optimization, stay-down links, retract minimization, entry selection, etc. become genuine optimization passes under safety constraints.

That is a much more general interpretation of what your roughing code is already doing heuristically.

---

# 32. Where the current Dropcut code maps

I'd refactor it approximately like this:

| Existing code                  | New subsystem                     |
| ------------------------------ | --------------------------------- |
| `parseSTL` / `buildModel`      | `geometry/mesh`                   |
| `buildGrid`                    | `geometry/spatial-index`          |
| `makeEvaluator`                | `cam/drop-cutter/kernel`          |
| `buildCLField`                 | `cam/fields/cutter-location`      |
| `marchSquares`                 | `geometry/contours`               |
| `solveEikonal`                 | `cam/strategies/constant-scallop` |
| `emitEntry`                    | `cam/planning/entry`              |
| roughing part of `generateJob` | `cam/strategies/rough-raster`     |
| raster finish                  | `cam/strategies/raster`           |
| hybrid finish                  | `cam/strategies/hybrid`           |
| scallop finish                 | `cam/strategies/constant-scallop` |
| path linking logic             | `cam/planning/linker`             |
| `compressCut`                  | `compiler/arc-fit`                |
| `verifyJob`                    | `analysis/dexel`                  |
| `toGcode`                      | `posts/rs274`                     |
| Three.js code                  | `viewer/three`                    |

The existing prototype is thus quite reusable; the problem is much more its **semantic boundaries** than the underlying algorithms.

---

# 33. Package structure

I would probably start with:

```text
@cam/units
@cam/math
@cam/geometry
@cam/machine
@cam/ir
@cam/planner
@cam/strategies
@cam/analysis
@cam/compiler
@cam/post-rs274
@cam/post-linuxcnc
@cam/post-makera
@cam/viewer-three
```

The dependency direction matters:

```text
geometry ← planner ← strategies
    ↑         ↓
    └────── ir
             ↓
          analysis
             ↓
          compiler
             ↓
            post
```

The renderer should depend on the IR.

The IR should **never** depend on Three.js or the renderer.

---

# 34. The most important distinction

I would name three types very explicitly:

```ts
ManufacturingPlan
ToolpathProgram
MachineProgram
```

because they answer three different questions:

```text
ManufacturingPlan:
    What machining do I want?

ToolpathProgram:
    How should the tool move relative
    to the workpiece?

MachineProgram:
    How can this particular machine
    realize those motions?
```

And G-code answers a fourth:

```text
How do I encode that MachineProgram
in this controller's language?
```

That separation is the foundation.

---

# 35. Where category theory really pays off

There are four category-theoretic ideas I'd retain in the design:

| Mathematical structure             | CNC meaning                                     |
| ---------------------------------- | ----------------------------------------------- |
| **Category of paths**              | composable trajectories with matching endpoints |
| **Groupoid of frames**             | coordinate transformations and inverses         |
| **Kleisli composition**            | stateful/failing machine operations             |
| **Semantics-preserving morphisms** | compiler transformations/lowerings              |

I would resist making the rest of the API "categorical" merely for elegance.

For instance, there is little benefit in exposing users to:

```ts
Kleisli<MachineState, ...>
```

instead of:

```ts
program.cut(...)
```

Category theory should determine the laws of the implementation, not make the API harder to read.

---

# 36. A very desirable end state

Eventually this:

```ts
const job =
  cam(setup)

    .rough(part, {
      tool: T1,
      stock: mm(0.2),

      strategy:
        rasterRough({
          stepdown: mm(1.5),
          stepover: 0.45,
        }),
    })

    .finish(part, {
      tool: T1,

      strategy:
        constantScallop({
          scallop: mm(0.01),
        }),
    });

const compiled =
  await job.compile(machine);

const checked =
  await compiled.verify({
    fixtures,
    tolerance: mm(0.02),
  });

const nc =
  linuxcnc.emit(
    checked.requireSafe()
  );
```

could simultaneously produce:

```text
job.plan
job.geometry
job.toolpaths
job.materialRemoval
job.timeEstimate
job.machineTrace
job.safetyCertificate
job.gcode
```

because they're all different interpretations of the **same semantic program**.

That is the deeper payoff of the denotational approach.

You stop treating "the program" as G-code text.

The program becomes an abstract machining object, and G-code, simulation, visualization, time estimation, verification, documentation, and optimization are all **interpreters of that object**.

That is the architecture I would build the library around.

[1]: https://www.nist.gov/publications/nist-rs274ngc-interpreter-version-3 "The NIST RS274NGC Interpreter - Version 3 | NIST"
[2]: https://www.iso.org/standard/40895.html "ISO 14649-10:2004 - Industrial automation systems ..."
[3]: https://www.linuxcnc.org/docs/2.9/html/gcode/overview.html "G-code Overview"
