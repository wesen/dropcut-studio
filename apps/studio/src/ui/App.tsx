/**
 * The application shell: header, editor, viewport, transport, panels.
 */

import { useEffect, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import { machineIds, getMachine } from "@cam/machine";
import { formatDuration } from "@cam/analysis";
import type { AppDispatch, RootState } from "../state/store.js";
import { restoreSession } from "../state/projectThunks.js";
import {
  colorModeChanged, layerToggled, machineChanged,
  simulateToggled, speedChanged, viewChanged,
} from "../state/slices.js";
import type { LayerName } from "../state/slices.js";
import { getArtifact } from "../state/artifactCache.js";
import { Editor } from "./Editor.js";
import { Viewport } from "./Viewport.js";
import { Panels } from "./Panels.js";
import { ProjectBar } from "./ProjectBar.js";
import { getViewport, onViewportChange } from "./viewportHandle.js";

export function App() {
  const dispatch = useDispatch<AppDispatch>();

  // Restore the last session (or fall back to an example) and compile it, so
  // the app opens showing whatever the user was last working on.
  useEffect(() => { void dispatch(restoreSession()); }, [dispatch]);

  return (
    <div className="app">
      <Header />
      <ProjectBar />
      <div className="body">
        <div className="left">
          <div className="pane-title">program.cam.js — recompiles as you type</div>
          <Editor />
        </div>
        <div className="right">
          <div className="viewport-wrap">
            <Viewport />
            <Dro />
            <ViewControls />
          </div>
          <Transport />
          <Panels />
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- header -------------------------------- */

function Header() {
  const dispatch = useDispatch<AppDispatch>();
  const machineId = useSelector((s: RootState) => s.project.machineId);
  const simulate = useSelector((s: RootState) => s.project.simulate);
  const status = useSelector((s: RootState) => s.compile.status);
  const stats = useSelector((s: RootState) => s.compile.stats);
  const diagnostics = useSelector((s: RootState) => s.compile.diagnostics);
  const artifactId = useSelector((s: RootState) => s.compile.artifactId);

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length;

  const download = () => {
    const artifact = getArtifact(artifactId);
    if (!artifact) return;
    const blob = new Blob([artifact.document.text + "\n"], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `program-${machineId}.nc`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <header className="header">
      <div className="brand">DROP<b>CUT</b> <span>STUDIO</span></div>

      <select
        value={machineId}
        onChange={(e) => dispatch(machineChanged(e.target.value))}
        title="Target machine — capabilities drive lowering and emission"
      >
        {machineIds().map((id) => (
          <option key={id} value={id}>{getMachine(id).name}</option>
        ))}
      </select>

      <label className="check" title="Material simulation. Off is faster; the certificate says so.">
        <input
          type="checkbox"
          checked={simulate}
          onChange={(e) => dispatch(simulateToggled(e.target.checked))}
        />
        simulate
      </label>

      <div className="spacer" />

      <div className="status">
        {status === "running" && <span className="dim">compiling…</span>}
        {status === "ok" && stats && (
          <>
            <span className="ok">● compiled</span>
            <span className="dim">
              {" "}{stats.lines.toLocaleString()} lines · cut {stats.cutLengthMm.toFixed(0)} mm ·
              est {formatDuration(stats.seconds)}
            </span>
            {warnings > 0 && <span className="warn"> · {warnings} warn</span>}
          </>
        )}
        {status === "failed" && (
          <span className="err">● {errors} error{errors === 1 ? "" : "s"} — emission blocked</span>
        )}
      </div>

      <button className="primary" onClick={download} disabled={status !== "ok"}>
        EXPORT .NC
      </button>
    </header>
  );
}

/* ---------------------------------- DRO --------------------------------- */

/**
 * The digital readout.
 *
 * Written straight into the DOM from the viewport's tick, NOT through React
 * state. It updates many times a second and re-rendering a component tree for
 * three numbers is exactly the thing tier 3 exists to avoid.
 */
function Dro() {
  const x = useRef<HTMLSpanElement>(null);
  const y = useRef<HTMLSpanElement>(null);
  const z = useRef<HTMLSpanElement>(null);
  const t = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let offTick: (() => void) | undefined;
    const offViewport = onViewportChange((api) => {
      offTick?.();
      offTick = undefined;
      if (!api) return;
      offTick = api.onTick((info) => {
        const fmt = (v: number) =>
          (v < 0 ? "-" : "+") + Math.abs(v).toFixed(3).padStart(7, "0");
        if (x.current) x.current.textContent = fmt(info.x);
        if (y.current) y.current.textContent = fmt(info.y);
        if (z.current) z.current.textContent = fmt(info.z);
        if (t.current) {
          t.current.textContent =
            `${formatDuration(info.time)} / ${formatDuration(info.duration)}`;
        }
      });
    });
    return () => { offTick?.(); offViewport(); };
  }, []);

  return (
    <div className="dro">
      <div><span className="l">X</span><span className="v" ref={x}>+000.000</span></div>
      <div><span className="l">Y</span><span className="v" ref={y}>+000.000</span></div>
      <div><span className="l">Z</span><span className="v" ref={z}>+000.000</span></div>
      <div className="t"><span ref={t}>0:00 / 0:00</span></div>
    </div>
  );
}

/* ------------------------------ view controls ---------------------------- */

const LAYERS: LayerName[] = ["part", "stock", "toolpath", "rapids", "trail"];

function ViewControls() {
  const dispatch = useDispatch<AppDispatch>();
  const show = useSelector((s: RootState) => s.viewport.show);
  const colorMode = useSelector((s: RootState) => s.viewport.colorMode);

  return (
    <div className="view-controls">
      {(["iso", "top", "front", "right"] as const).map((v) => (
        <button key={v} onClick={() => dispatch(viewChanged(v))}>{v}</button>
      ))}
      <button onClick={() => getViewport()?.frameAll()}>fit</button>
      <span className="sep" />
      {LAYERS.map((l) => (
        <label key={l} className="check">
          <input type="checkbox" checked={show[l]} onChange={() => dispatch(layerToggled(l))} />
          {l}
        </label>
      ))}
      <span className="sep" />
      <select
        value={colorMode}
        onChange={(e) => dispatch(colorModeChanged(e.target.value as "purpose" | "depth"))}
      >
        <option value="purpose">colour: purpose</option>
        <option value="depth">colour: depth</option>
      </select>
    </div>
  );
}

/* ------------------------------- transport ------------------------------- */

function Transport() {
  const dispatch = useDispatch<AppDispatch>();
  const playing = useSelector((s: RootState) => s.playback.playing);
  const time = useSelector((s: RootState) => s.playback.time);
  const duration = useSelector((s: RootState) => s.playback.duration);
  const speed = useSelector((s: RootState) => s.playback.speed);

  const fraction = duration > 0 ? time / duration : 0;

  return (
    <div className="transport">
      <button className="play" onClick={() => getViewport()?.toggle()}>
        {playing ? "❚❚" : "▶"}
      </button>
      <button onClick={() => getViewport()?.seek(0)}>⟲</button>
      <input
        type="range"
        min={0}
        max={1000}
        value={Math.round(fraction * 1000)}
        onChange={(e) => getViewport()?.seek((Number(e.target.value) / 1000) * duration)}
      />
      <select value={speed} onChange={(e) => dispatch(speedChanged(Number(e.target.value)))}>
        {[1, 4, 8, 32, 128].map((s) => <option key={s} value={s}>{s}×</option>)}
      </select>
      <span className="dim">{formatDuration(time)} / {formatDuration(duration)}</span>
    </div>
  );
}
