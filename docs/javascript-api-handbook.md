# DROPCUT Studio JavaScript API Handbook

This is the complete reference for the JavaScript capability API available in the Studio editor. The API is a sandboxed DSL: a script builds a manufacturing plan, then the compiler validates, plans, simulates, and emits machine G-code. It is not Node.js and it has no ambient filesystem, network, process, or DOM access.

The API is intentionally explicit about units and machine state. Use the handbook as a contract when writing scripts or asking a coding agent to modify one.

## 1. Quick start

```js
const tool = tools.flatEndMill({ name: "6 mm flat", diameter: mm(6) });

job.setup({
  stock: { x: mm(60), y: mm(40), z: mm(12), originX: mm(5), originY: mm(5) },
  clearance: mm(6),
});

job.withTool(tool, () => {
  job.withSpindle({ speed: rpm(12000) }, () => {
    job.face({
      x: mm(5), y: mm(5), w: mm(60), h: mm(40), z: mm(-0.5),
      stepover: 0.6, feed: mmPerMin(900),
    });
    job.rectPocket({
      x: mm(18), y: mm(14), w: mm(34), h: mm(20),
      depth: mm(5), stepdown: mm(2), feed: mmPerMin(600),
      plungeFeed: mmPerMin(200),
    });
  });
});
```

A normal program follows this order:

1. Create tools.
2. Describe stock and machine coordinates with `job.setup`.
3. Select a tool.
4. Optionally scope a spindle speed.
5. Select a mesh when using 3D operations.
6. Add operations.
7. Read diagnostics and the certificate before exporting G-code.

## 2. Execution model and invariants

The sandbox creates a fresh API object for every run. Variables and state from one compile cannot leak into another compile. The script receives named capabilities such as `job`, `tools`, and `mm`; it does not receive `window`, `document`, `process`, `require`, or network APIs.

The builder accumulates a plan. Calling an operation does not immediately move a machine and does not emit G-code. The compiler consumes the plan after the script returns.

### Required invariants

- `job.setup()` should be called before operations. The builder starts with a 100 × 100 × 20 mm default stock, but explicit setup is strongly recommended.
- Every operation requires an active tool. Use `job.toolChange(tool)` or `job.withTool(tool, body)`.
- `job.withTool` and `job.withSpindle` restore their previous state in a `finally` block, including when `body` throws.
- Work coordinates and mesh coordinates are distinct concepts. Use `stock.originX`, `stock.originY`, `stock.topZ`, and `geometry.mesh`'s `at` offset to place a part.
- `stepover` values are ratios, not lengths. `0.45` means 45% of the tool diameter.
- `depth`, `z`, `stepdown`, `margin`, `scallop`, and `chordTolerance` are lengths.
- A compile certificate describes checks that ran; it is not a substitute for workholding, tool inspection, a dry run, or machine-specific verification.

## 3. Units and numeric arguments

The builder supports branded runtime units. A branded value is an object, so the sandbox can detect a length accidentally passed where an RPM or feed was expected.

| Function | Meaning | Example |
|---|---|---|
| `mm(value)` | Length in millimetres | `mm(2.5)` |
| `inch(value)` | Inches converted to millimetres | `inch(0.25)` |
| `rpm(value)` | Spindle speed | `rpm(12000)` |
| `mmPerMin(value)` | Feed rate | `mmPerMin(900)` |
| `deg(value)` | Angle in degrees | `deg(45)` |
| `percent(value)` | Ratio conversion | `percent(45)` is `0.45` |

Bare finite numbers are accepted for a gradual learning curve. They are interpreted in the parameter's documented unit and add a `units.bareNumber` warning. Prefer branded values in saved programs. `NaN`, `Infinity`, missing values, and wrong brands are errors.

## 4. Tool API

Tools are opaque objects returned by the constructors below. Do not construct or modify a tool object yourself.

### `tools.flatEndMill(options)`

Creates a flat-bottom end mill.

```js
tools.flatEndMill({ name?, diameter, fluteLength? })
```

- `name`: optional display name; defaults to an automatically assigned tool name.
- `diameter`: required length.
- `fluteLength`: optional length recorded in the tool definition.

### `tools.ballEndMill(options)`

Creates a ball end mill.

```js
tools.ballEndMill({ name?, diameter, fluteLength? })
```

Arguments have the same meaning as `flatEndMill`.

### `tools.bullNose(options)`

Creates a bull-nose end mill.

```js
tools.bullNose({ name?, diameter, cornerRadius })
```

`diameter` and `cornerRadius` are required lengths.

### `tools.vBit(options)`

Creates a V-bit.

```js
tools.vBit({ name?, diameter, tipDiameter, includedAngle })
```

`diameter` and `tipDiameter` are lengths. `includedAngle` is an angle and should use `deg()`.

### Tool selection

```js
job.toolChange(tool);                 // remains active
job.withTool(tool, () => { ... });    // restored after body
```

A tool from `tools.*` is required. Passing an arbitrary object is an error. Nested `withTool` scopes are supported; the outer tool resumes after the inner body.

## 5. Setup and machine state

### `job.setup(options)`

```js
job.setup({
  stock: {
    x, y, z,
    originX?, originY?, topZ?,
  },
  clearance?,
  workOffset?,
  floorZ?,
})
```

`stock.x`, `stock.y`, and `stock.z` are required lengths. Defaults are:

| Property | Default | Meaning |
|---|---:|---|
| `originX` | `0 mm` | Stock origin in work X |
| `originY` | `0 mm` | Stock origin in work Y |
| `topZ` | `0 mm` | Top surface in work Z |
| `clearance` | `5 mm` | Safe clearance height |
| `workOffset` | `"G54"` | Work coordinate system label |
| `floorZ` | `topZ - z` | Lowest stock Z |

Calling `setup` replaces the previous setup. It does not select a tool or clear operations.

### `job.toolChange(tool)`

Selects `tool` for subsequent operations. It throws if the value was not returned by a tool constructor.

### `job.withSpindle(options, body)`

```js
job.withSpindle({ speed: rpm(12000) }, () => {
  // operations here carry spindleSpeed = 12000
});
```

`speed` is required and must be an RPM value. The previous spindle state is restored after the callback. Operations created without a spindle scope omit spindle speed and are still subject to machine validation.

## 6. 2.5D operations

All operation methods require an active tool and append one operation to the plan.

### `job.face(options)`

```js
job.face({ x, y, w, h, z, stepover?, feed })
```

Faces a rectangle from `(x, y)` with width `w` and height `h` at depth `z`.

- `x`, `y`, `w`, `h`, and `z` are required lengths.
- `feed` is a required feed rate.
- `stepover` is an optional ratio; default `0.5`.

The facing path deliberately accounts for the tool diameter. Position the rectangle and stock origin with enough room for the intended edge overrun.

### `job.rectPocket(options)`

```js
job.rectPocket({
  x, y, w, h, depth, stepdown,
  stepover?, feed, plungeFeed?,
})
```

Clears a rectangular pocket with concentric rings and repeated Z stepdowns.

- `x`, `y`, `w`, `h`, `depth`, and `stepdown` are required lengths.
- `feed` is required; `plungeFeed` is optional.
- `stepover` is an optional ratio; default `0.4`.

### `job.drill(options)`

```js
job.drill({ points: [{ x, y }, ...], depth, peck?, feed })
```

Drills each point in order.

- `points` is an array of work-coordinate points.
- `depth` and optional `peck` are lengths.
- `feed` is required.

## 7. 3D operations

3D operations use the selected mesh. Call `geometry.mesh` before roughing or finishing.

### `job.roughSurface(options)`

```js
job.roughSurface({
  stepdown, stepover?, stockToLeave,
  entry?, margin?, feed, plungeFeed?,
})
```

Removes bulk material while leaving stock for finishing.

- `stepdown`, `stockToLeave`, and optional `margin` are lengths.
- `feed` is required; `plungeFeed` is optional.
- `stepover` defaults to `0.45`.
- `entry` defaults to `entry.auto({ maxRampAngle: 3 })`.
- `margin` defaults to `1 mm`.

### `job.finishSurface(options)`

```js
job.finishSurface({ strategy, chordTolerance?, margin?, feed })
```

Finishes the selected surface using a strategy.

- `strategy` is required and must be returned by `strategy.*`.
- `feed` is required.
- `chordTolerance` defaults to `0.01 mm`.
- `margin` defaults to `1 mm`.

## 8. Entries

```js
entry.auto({ maxRampAngle? })
entry.ramp({ angle? })
entry.plunge()
```

`auto` and `ramp` angles default to `3°`. An entry is a value passed to `roughSurface`; it does not emit anything by itself.

## 9. Finishing strategies

```js
strategy.raster({ direction?: "X" | "Y", scallop?, stepover? })
strategy.hybridWaterline({ scallop, steepAngle? })
strategy.constantScallop({ scallop })
```

- `raster` defaults to direction `"X"`. Its optional `scallop` is a length and `stepover` is a ratio.
- `hybridWaterline` requires `scallop` and defaults `steepAngle` to `45°`; it combines raster-like shallow-area passes with waterline passes on steep areas.
- `constantScallop` requires `scallop` and spaces passes according to surface cusp height.

## 10. Geometry

### `geometry.mesh(name, options?)`

```js
geometry.mesh("dome", { at: { x?, y?, z? } })
```

Selects a mesh supplied by the host. The built-in preset is currently `"dome"`. Unknown names fail with an error listing available meshes.

The optional `at` values translate the mesh into work coordinates. Each offset defaults to zero. This is independent of the stock's origin.

## 11. Complete 3D program

```js
const rough = tools.flatEndMill({ name: "6 mm rougher", diameter: mm(6) });
const finish = tools.ballEndMill({ name: "3 mm ball", diameter: mm(3) });

job.setup({
  stock: { x: mm(36), y: mm(36), z: mm(16), originX: mm(12), originY: mm(12), topZ: mm(15) },
  clearance: mm(20), floorZ: mm(0),
});
geometry.mesh("dome", { at: { x: mm(30), y: mm(30) } });

job.withTool(rough, () => {
  job.withSpindle({ speed: rpm(10000) }, () => {
    job.roughSurface({
      stepdown: mm(2), stepover: 0.45, stockToLeave: mm(0.3),
      entry: entry.auto({ maxRampAngle: deg(3) }), feed: mmPerMin(1200),
    });
  });
});

job.withTool(finish, () => {
  job.withSpindle({ speed: rpm(12000) }, () => {
    job.finishSurface({
      strategy: strategy.constantScallop({ scallop: mm(0.02) }),
      chordTolerance: mm(0.01), feed: mmPerMin(900),
    });
  });
});
```

## 12. Errors, warnings, and validation

The script stage throws for missing required values, wrong unit brands, non-finite numbers, missing tools, unknown meshes, and missing strategies. The editor reports the failure with the script location when available.

Bare numbers are warnings rather than errors. The warning says how the value was interpreted; replace the number with the corresponding unit constructor when preparing a production program.

After the script stage, validation checks machine travel, feed and spindle constraints, interlocks, path continuity, and unit-derived values. Simulation and the certificate add further evidence when enabled. Fix every error and review every warning before exporting `.NC`.

## 13. Coding-agent handoff checklist

When asking an agent to write or change a program, include:

- this handbook;
- the current script and the target machine;
- the stock dimensions, work origin, material, tools, and workholding assumptions;
- the desired operation sequence and acceptable feeds, spindle speeds, stepdowns, and tolerances;
- the complete diagnostics and certificate after compiling.

Ask the agent to preserve branded units, tool and spindle scopes, explicit setup, and the validation workflow. Do not ask it to treat a passing certificate as permission to run an unreviewed program on a machine.
