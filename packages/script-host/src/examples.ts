/**
 * Example programs shipped with the app.
 *
 * These double as documentation and as integration-test fixtures: if the DSL
 * surface changes in a way that breaks them, the tests fail.
 */

export interface Example {
  readonly name: string;
  readonly description: string;
  readonly source: string;
}

export const EXAMPLES: readonly Example[] = [
  {
    name: "pocket-and-face",
    description: "2.5D: face the top, then clear a rectangular pocket",
    source: `// DROPCUT Studio — 2.5D example.
// Units are branded: mm(), rpm(), mmPerMin(). Bare numbers work but warn.

const T1 = tools.flatEndMill({ name: "4mm flat", diameter: mm(4) });

// The stock sits 5 mm inside the origin. Facing runs one tool radius past the
// stock edge for a clean cut, so parking at exactly X0 Y0 would put those
// overshoot moves outside the envelope of a machine whose travel starts at zero.
job.setup({
  stock: { x: mm(60), y: mm(40), z: mm(12),
           originX: mm(5), originY: mm(5), topZ: mm(0) },
  clearance: mm(6),
});

job.withTool(T1, () => {
  job.withSpindle({ speed: rpm(12000) }, () => {

    // Face the top. Stepover is a fraction of the ACTUAL tool diameter.
    job.face({
      x: mm(5), y: mm(5), w: mm(60), h: mm(40), z: mm(-0.5),
      stepover: 0.6,
      feed: mmPerMin(900),
    });

    // Pocket, three stepdowns, concentric rings from the middle out.
    job.rectPocket({
      x: mm(19), y: mm(15), w: mm(32), h: mm(20),
      depth: mm(6),
      stepdown: mm(2),
      stepover: 0.45,
      feed: mmPerMin(600),
      plungeFeed: mmPerMin(200),
    });
  });
});
`,
  },
  {
    name: "surface-finish",
    description: "3D: rough a dome, then finish it with constant scallop",
    source: `// DROPCUT Studio — 3D surfacing example.
// Rough with a flat mill leaving stock, then finish with a ball nose.

const ROUGH  = tools.flatEndMill({ name: "6mm flat", diameter: mm(6) });
const FINISH = tools.ballEndMill({ name: "3mm ball", diameter: mm(3) });

// Place the part 30 mm into the work envelope. The dome preset is modelled
// centred on its own origin; "at" moves it to where the stock is clamped, which
// also keeps every coordinate positive for machines whose travel starts at zero.
job.setup({
  stock: { x: mm(36), y: mm(36), z: mm(16),
           originX: mm(12), originY: mm(12), topZ: mm(15) },
  clearance: mm(20),
  floorZ: mm(0),
});

geometry.mesh("dome", { at: { x: mm(30), y: mm(30) } });

job.withTool(ROUGH, () => {
  job.withSpindle({ speed: rpm(10000) }, () => {
    job.roughSurface({
      stepdown: mm(2),
      stepover: 0.45,
      stockToLeave: mm(0.3),
      entry: entry.auto({ maxRampAngle: deg(3) }),
      feed: mmPerMin(1200),
    });
  });
});

job.withTool(FINISH, () => {
  job.withSpindle({ speed: rpm(12000) }, () => {
    // Constant scallop spaces passes evenly ALONG THE SURFACE, so the cusp
    // height is uniform on the flat top and the steep flank alike.
    job.finishSurface({
      strategy: strategy.constantScallop({ scallop: mm(0.02) }),
      chordTolerance: mm(0.01),
      feed: mmPerMin(900),
    });
  });
});
`,
  },
  {
    name: "hybrid-finish",
    description: "3D: raster the shallow top, waterline the steep flank",
    source: `const T = tools.ballEndMill({ name: "3mm ball", diameter: mm(3) });

job.setup({
  stock: { x: mm(36), y: mm(36), z: mm(16),
           originX: mm(12), originY: mm(12), topZ: mm(15) },
  clearance: mm(20),
  floorZ: mm(0),
});

geometry.mesh("dome", { at: { x: mm(30), y: mm(30) } });

job.withTool(T, () => {
  job.withSpindle({ speed: rpm(12000) }, () => {
    job.finishSurface({
      strategy: strategy.hybridWaterline({
        scallop: mm(0.03),
        steepAngle: deg(45),
      }),
      chordTolerance: mm(0.01),
      feed: mmPerMin(800),
    });
  });
});
`,
  },
];

export const exampleByName = (name: string): Example | undefined =>
  EXAMPLES.find((e) => e.name === name);
