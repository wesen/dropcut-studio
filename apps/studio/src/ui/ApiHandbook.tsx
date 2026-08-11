import { useState } from "react";
import handbookMarkdown from "../../../../docs/javascript-api-handbook.md?raw";

/** The markdown file is the canonical handbook; Vite bundles it for the copy action. */
export const JS_API_HANDBOOK = handbookMarkdown;

/* Kept temporarily as the rendered reference source while the markdown view is migrated. */
const LEGACY_HANDBOOK_TEXT = `# DROPCUT Studio JavaScript API

DROPCUT Studio runs a small, sandboxed JavaScript DSL. A script builds a manufacturing plan; the compiler validates it, plans toolpaths, simulates when enabled, and emits machine G-code.

## First program

const tool = tools.flatEndMill({ name: "6 mm flat", diameter: mm(6) });
job.setup({
  stock: { x: mm(60), y: mm(40), z: mm(12), originX: mm(5), originY: mm(5) },
  clearance: mm(6),
});
job.withTool(tool, () => {
  job.withSpindle({ speed: rpm(12000) }, () => {
    job.face({ x: mm(5), y: mm(5), w: mm(60), h: mm(40), z: mm(-0.5), feed: mmPerMin(900) });
    job.rectPocket({ x: mm(18), y: mm(14), w: mm(34), h: mm(20), depth: mm(5), stepdown: mm(2), feed: mmPerMin(600) });
  });
});

## Rules that prevent common mistakes

- Prefer branded units: mm(), inch(), rpm(), mmPerMin(), and deg(). Bare numbers are accepted for convenience but produce a warning.
- Call job.setup() before operations. Select a tool with job.toolChange(tool) or use job.withTool(tool, body).
- Operations require an active tool. A spindle is optional; when present, withSpindle() automatically restores the previous speed.
- withTool() and withSpindle() restore their previous state even when the body throws.
- Coordinates are work coordinates. setup.stock.originX/originY and geometry.mesh(..., { at }) place the part in the machine envelope.
- A successful compile is not permission to skip normal machine setup, workholding, tool inspection, and a dry run.

## Units

mm(value)       length in millimetres
inch(value)     imperial length, converted to millimetres
rpm(value)      spindle speed
mmPerMin(value) feed rate
 deg(value)     angle in degrees
percent(value)  ratio helper: percent(45) === 0.45

## Tools

tools.flatEndMill({ name?, diameter, fluteLength? })
tools.ballEndMill({ name?, diameter, fluteLength? })
tools.bullNose({ name?, diameter, cornerRadius })
tools.vBit({ name?, diameter, tipDiameter, includedAngle })

All dimensions use mm() (or inch()); vBit includedAngle uses deg(). The returned tool object is opaque: pass it to job.toolChange() or job.withTool().

## Job setup and state

job.setup({
  stock: { x, y, z, originX?, originY?, topZ? },
  clearance?, workOffset?, floorZ?
})

Defaults: originX=0, originY=0, topZ=0, clearance=5, workOffset="G54", and floorZ=topZ-z. Stock dimensions and all optional coordinates are lengths.

job.toolChange(tool)                 select a tool until the next change
job.withTool(tool, () => { ... })    select temporarily, then restore
job.withSpindle({ speed: rpm(12000) }, () => { ... })

## 2.5D operations

job.face({ x, y, w, h, z, stepover?, feed })
  Faces a rectangular area at z. stepover is a fraction of tool diameter; default 0.5.

job.rectPocket({ x, y, w, h, depth, stepdown, stepover?, feed, plungeFeed? })
  Clears a rectangular pocket in concentric passes. stepover defaults to 0.4.

job.drill({ points: [{ x, y }, ...], depth, peck?, feed })
  Drills every point. peck is optional and controls peck drilling.

## 3D operations

job.roughSurface({ stepdown, stepover?, stockToLeave, entry?, margin?, feed, plungeFeed? })
  Removes bulk material from the selected mesh. Defaults: stepover=0.45, entry=entry.auto(), margin=1 mm.

job.finishSurface({ strategy, chordTolerance?, margin?, feed })
  Finishes the selected mesh. Defaults: chordTolerance=0.01 mm and margin=1 mm.

## Entries and finishing strategies

entry.auto({ maxRampAngle? })     adaptive entry; default maxRampAngle=3 degrees
entry.ramp({ angle? })            ramp entry; default angle=3 degrees
entry.plunge()                    direct plunge

strategy.raster({ direction?: "X"|"Y", scallop?, stepover? })
strategy.hybridWaterline({ scallop, steepAngle? })
strategy.constantScallop({ scallop })

Raster defaults to direction X. hybridWaterline defaults steepAngle to 45 degrees. A strategy's stepover is a ratio; scallop and chord tolerance are lengths.

## Geometry

geometry.mesh(name, { at: { x?, y?, z? } })

Selects a mesh supplied by the application. The current built-in preset is "dome". The optional at offset translates it into work coordinates; omitted offsets are zero.

## Complete 3D example

const rough = tools.flatEndMill({ diameter: mm(6) });
const finish = tools.ballEndMill({ diameter: mm(3) });
job.setup({ stock: { x: mm(36), y: mm(36), z: mm(16), topZ: mm(15) }, floorZ: mm(0), clearance: mm(20) });
geometry.mesh("dome", { at: { x: mm(30), y: mm(30) } });
job.withTool(rough, () => {
  job.withSpindle({ speed: rpm(10000) }, () => {
    job.roughSurface({ stepdown: mm(2), stockToLeave: mm(0.3), feed: mmPerMin(1200), entry: entry.auto() });
  });
});
job.withTool(finish, () => {
  job.withSpindle({ speed: rpm(12000) }, () => {
    job.finishSurface({ strategy: strategy.constantScallop({ scallop: mm(0.02) }), feed: mmPerMin(900) });
  });
});

## Diagnostics and safety

Wrong unit brands (for example rpm(4) as a diameter) throw immediately. Missing values, non-finite numbers, unknown meshes, missing tools, and missing strategies also fail compilation. Bare numbers do not fail: they are interpreted in the parameter's documented unit and reported as units.bareNumber warnings.

The compiler then checks machine limits, feeds, spindle ranges, path continuity, interlocks, and (when enabled) material simulation. Fix every error and review warnings before exporting .NC. The certificate describes what was checked; it is not a substitute for machine-specific verification.

## Agent handoff

Copy this entire handbook into a coding-agent prompt. Include the current script, target machine, the compile diagnostics, and the desired change. Ask the agent to preserve branded units, tool/spindle scopes, and the validation workflow.
`;

export function ApiHandbook({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JS_API_HANDBOOK);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard permission can be denied in an embedded or insecure context.
      setCopied(false);
    }
  };

  return (
    <div className="handbook-backdrop" role="presentation" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <article className="handbook" role="dialog" aria-modal="true" aria-labelledby="handbook-title">
        <div className="handbook-head">
          <div>
            <div className="eyebrow">REFERENCE / SCRIPTING</div>
            <h1 id="handbook-title">JavaScript API handbook</h1>
            <p className="dim">A copy/paste-ready guide for DROPCUT Studio and coding agents.</p>
          </div>
          <div className="handbook-actions">
            <button className="primary" onClick={() => void copy()}>{copied ? "COPIED ✓" : "COPY FOR AGENT"}</button>
            <button onClick={onClose} aria-label="Close handbook">✕</button>
          </div>
        </div>
        <div className="handbook-body">
          <section className="handbook-full-reference"><h2>Full API reference</h2><p className="dim">This handbook is built from <code>docs/javascript-api-handbook.md</code>. The exact text below is also what <b>Copy for agent</b> places on the clipboard.</p><pre className="handbook-markdown">{JS_API_HANDBOOK}</pre></section>
          <section><h2>What the API does</h2><p>A script describes a manufacturing plan. The sandbox exposes only the capability API below; the compiler validates the plan, generates toolpaths, and emits G-code. The API is deliberately small: units make intent explicit, scopes restore state, and operations require a selected tool.</p></section>
          <section><h2>First program</h2><Code>{`const tool = tools.flatEndMill({ name: "6 mm flat", diameter: mm(6) });
job.setup({ stock: { x: mm(60), y: mm(40), z: mm(12) }, clearance: mm(6) });
job.withTool(tool, () => {
  job.withSpindle({ speed: rpm(12000) }, () => {
    job.face({ x: mm(0), y: mm(0), w: mm(60), h: mm(40), z: mm(-0.5), feed: mmPerMin(900) });
  });
});`}</Code></section>
          <section><h2>Core rules</h2><ul><li>Use <code>mm()</code>, <code>inch()</code>, <code>rpm()</code>, <code>mmPerMin()</code>, and <code>deg()</code>. Bare numbers work but create warnings.</li><li>Call <code>job.setup()</code> and select a tool before adding operations.</li><li><code>withTool</code> and <code>withSpindle</code> restore previous state, including after an exception.</li><li>Coordinates are work coordinates; use stock origins and mesh offsets to place work safely.</li></ul></section>
          <section><h2>Units</h2><Reference rows={["mm(value) — length in millimetres", "inch(value) — imperial length converted to millimetres", "rpm(value) — spindle speed", "mmPerMin(value) — feed rate", "deg(value) — angle in degrees", "percent(value) — ratio helper; percent(45) is 0.45"]} /></section>
          <section><h2>Tools</h2><Reference rows={["tools.flatEndMill({ name?, diameter, fluteLength? })", "tools.ballEndMill({ name?, diameter, fluteLength? })", "tools.bullNose({ name?, diameter, cornerRadius })", "tools.vBit({ name?, diameter, tipDiameter, includedAngle })"]} /><p>Dimensions use <code>mm()</code> or <code>inch()</code>; V-bit angle uses <code>deg()</code>. Pass the returned opaque tool to <code>job.toolChange</code> or <code>job.withTool</code>.</p></section>
          <section><h2>Setup and state</h2><Code>{`job.setup({
  stock: { x, y, z, originX?, originY?, topZ? },
  clearance?, workOffset?, floorZ?
})
job.toolChange(tool)
job.withTool(tool, () => { ... })
job.withSpindle({ speed: rpm(12000) }, () => { ... })`}</Code><p>Defaults are <code>originX=0</code>, <code>originY=0</code>, <code>topZ=0</code>, <code>clearance=5</code>, <code>workOffset="G54"</code>, and <code>floorZ=topZ-z</code>.</p></section>
          <section><h2>Operations reference</h2><Reference rows={["job.face({ x, y, w, h, z, stepover?, feed }) — rectangular facing; stepover defaults to 0.5 tool diameter", "job.rectPocket({ x, y, w, h, depth, stepdown, stepover?, feed, plungeFeed? }) — concentric pocketing; stepover defaults to 0.4", "job.drill({ points: [{ x, y }, ...], depth, peck?, feed }) — drill each point", "job.roughSurface({ stepdown, stepover?, stockToLeave, entry?, margin?, feed, plungeFeed? }) — bulk 3D removal", "job.finishSurface({ strategy, chordTolerance?, margin?, feed }) — 3D finishing"]} /></section>
          <section><h2>Entries, strategies, and geometry</h2><Reference rows={["entry.auto({ maxRampAngle? }) — default 3°", "entry.ramp({ angle? }) — default 3°", "entry.plunge()", "strategy.raster({ direction?: \"X\"|\"Y\", scallop?, stepover? }) — direction defaults to X", "strategy.hybridWaterline({ scallop, steepAngle? }) — steepAngle defaults to 45°", "strategy.constantScallop({ scallop })", "geometry.mesh(name, { at: { x?, y?, z? } }) — select and translate a supplied mesh"]} /><p>The built-in mesh preset is <code>"dome"</code>. Scallop and chord tolerance are lengths; stepover is a ratio.</p></section>
          <section><h2>Complete 3D example</h2><Code>{`const rough = tools.flatEndMill({ diameter: mm(6) });
const finish = tools.ballEndMill({ diameter: mm(3) });
job.setup({ stock: { x: mm(36), y: mm(36), z: mm(16), topZ: mm(15) }, floorZ: mm(0) });
geometry.mesh("dome", { at: { x: mm(30), y: mm(30) } });
job.withTool(rough, () => {
  job.withSpindle({ speed: rpm(10000) }, () => {
    job.roughSurface({ stepdown: mm(2), stockToLeave: mm(0.3), feed: mmPerMin(1200) });
  });
});
job.withTool(finish, () => {
  job.withSpindle({ speed: rpm(12000) }, () => {
    job.finishSurface({ strategy: strategy.constantScallop({ scallop: mm(0.02) }), feed: mmPerMin(900) });
  });
});`}</Code></section>
          <section><h2>Diagnostics and agent handoff</h2><p>Wrong unit brands, missing values, non-finite numbers, unknown meshes, missing tools, and missing strategies fail compilation. Bare numbers produce <code>units.bareNumber</code> warnings. Review all errors and warnings, machine limits, feeds, spindle ranges, interlocks, path continuity, and the certificate before export.</p><p>Use <b>Copy for agent</b> to copy the full handbook. Include the current script, target machine, diagnostics, and desired change in the same prompt.</p></section>
        </div>
      </article>
    </div>
  );
}

function Code({ children }: { children: string }) { return <pre className="handbook-code"><code>{children}</code></pre>; }
function Reference({ rows }: { rows: readonly string[] }) { return <div className="api-reference">{rows.map((row) => <div key={row}><code>{row}</code></div>)}</div>; }
