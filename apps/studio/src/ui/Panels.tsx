/**
 * The bottom panels: G-code, diagnostics, certificate, operations.
 *
 * Four renderings of the SAME compile. That is the payoff of the layered
 * architecture — none of these panels re-derives anything, they each display a
 * different interpretation of one semantic program.
 *
 * The G-code list is VIRTUALISED. The checker prototype capped its view at 6,000
 * lines, which silently truncates a real program (MakeraBadge.nc is 18,531).
 * Rendering only the visible window costs about thirty lines and removes the cap
 * entirely.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import type { Diagnostic } from "@cam/ir";
import { describeProvenance } from "@cam/ir";
import { formatDuration } from "@cam/analysis";
import { getArtifact } from "../state/artifactCache.js";
import type { AppDispatch, RootState } from "../state/store.js";
import { bottomTabChanged, gcodeLineSelected } from "../state/slices.js";
import type { BottomTab } from "../state/slices.js";
import { getViewport } from "./viewportHandle.js";

const TABS: { id: BottomTab; label: string }[] = [
  { id: "gcode", label: "G-CODE" },
  { id: "operations", label: "OPERATIONS" },
  { id: "diagnostics", label: "DIAGNOSTICS" },
  { id: "certificate", label: "CERTIFICATE" },
];

export function Panels() {
  const dispatch = useDispatch<AppDispatch>();
  const tab = useSelector((s: RootState) => s.ui.bottomTab);
  const diagnostics = useSelector((s: RootState) => s.compile.diagnostics);

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length;

  return (
    <div className="panels">
      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={t.id === tab ? "tab active" : "tab"}
            onClick={() => dispatch(bottomTabChanged(t.id))}
          >
            {t.label}
            {t.id === "diagnostics" && errors > 0 && <span className="badge error">{errors}</span>}
            {t.id === "diagnostics" && errors === 0 && warnings > 0 &&
              <span className="badge warn">{warnings}</span>}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {tab === "gcode" && <GcodePanel />}
        {tab === "operations" && <OperationsPanel />}
        {tab === "diagnostics" && <DiagnosticsPanel />}
        {tab === "certificate" && <CertificatePanel />}
      </div>
    </div>
  );
}

/* ------------------------------- G-code -------------------------------- */

const ROW_HEIGHT = 19;
const OVERSCAN = 20;

function GcodePanel() {
  const dispatch = useDispatch<AppDispatch>();
  const artifactId = useSelector((s: RootState) => s.compile.artifactId);
  const status = useSelector((s: RootState) => s.compile.status);
  const activeLine = useSelector((s: RootState) => s.playback.activeGcodeLine);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(300);

  const artifact = getArtifact(artifactId);
  const lines = artifact?.document.lines ?? [];

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Follow the playing line, but only when it moves outside the visible window,
  // so manual scrolling is not fought over.
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || activeLine === null) return;
    const y = activeLine * ROW_HEIGHT;
    if (y < el.scrollTop || y > el.scrollTop + el.clientHeight - ROW_HEIGHT * 2) {
      el.scrollTop = Math.max(0, y - el.clientHeight / 2);
    }
  }, [activeLine]);

  if (status === "failed") {
    return (
      <Empty
        title="No G-code emitted"
        body="The postprocessor only accepts a validated program. Fix the diagnostics and it will emit again."
      />
    );
  }
  if (lines.length === 0) return <Empty title="Nothing compiled yet" body="Edit the script to compile." />;

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visible = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2;
  const slice = lines.slice(first, first + visible);

  return (
    <div
      className="gcode"
      ref={scrollRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: lines.length * ROW_HEIGHT, position: "relative" }}>
        {slice.map((line, i) => {
          const index = first + i;
          const active = index === activeLine;
          return (
            <div
              key={index}
              className={active ? "gline active" : "gline"}
              style={{ position: "absolute", top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
              onClick={() => {
                dispatch(gcodeLineSelected(index));
                seekToGcodeLine(artifactId, index);
              }}
            >
              <span className="n">{line.n}</span>
              <span className={classify(line.text)}>{line.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const classify = (text: string): string => {
  if (text.startsWith("(") || text.startsWith(";")) return "t comment";
  if (/^G0\b/.test(text)) return "t rapid";
  if (/^G[123]\b/.test(text)) return "t cut";
  return "t";
};

/**
 * Click a G-code line, seek playback there.
 *
 * The line/motion link comes from emission, so this is a lookup rather than a
 * search. It is the interaction that makes the tool feel finished.
 */
function seekToGcodeLine(artifactId: string | null, line: number): void {
  const artifact = getArtifact(artifactId);
  const api = getViewport();
  if (!artifact || !api) return;
  const buffers = artifact.buffers;
  for (let i = 0; i < buffers.count; i++) {
    if (buffers.gcodeLines[i] >= line) {
      api.pause();
      api.seek(buffers.times[i]);
      return;
    }
  }
}

/* ----------------------------- operations ------------------------------ */

function OperationsPanel() {
  const summaries = useSelector((s: RootState) => s.compile.summaries);
  const stats = useSelector((s: RootState) => s.compile.stats);
  const elapsed = useSelector((s: RootState) => s.compile.elapsedMs);

  if (summaries.length === 0) return <Empty title="No operations" body="The plan produced nothing." />;

  return (
    <div className="rows">
      {summaries.map((s) => (
        <div className="row" key={s.operationId}>
          <span className="key">{s.operationId}</span>
          <span className="val">{s.description}</span>
          <span className="dim">{s.paths} paths</span>
        </div>
      ))}
      {stats && (
        <div className="row summary">
          <span className="key">total</span>
          <span className="val">
            {stats.lines.toLocaleString()} lines · cut {stats.cutLengthMm.toFixed(0)} mm ·
            rapid {stats.rapidLengthMm.toFixed(0)} mm · est {formatDuration(stats.seconds)}
          </span>
          <span className="dim">compiled in {elapsed} ms</span>
        </div>
      )}
      {stats && (
        <div className="note">
          Time estimate uses the <code>{stats.timeModel}</code> model: it ignores
          acceleration, so passes made of many short segments will take longer in reality.
        </div>
      )}
    </div>
  );
}

/* ---------------------------- diagnostics ------------------------------ */

function DiagnosticsPanel() {
  const diagnostics = useSelector((s: RootState) => s.compile.diagnostics);
  const stage = useSelector((s: RootState) => s.compile.failedStage);

  if (diagnostics.length === 0) {
    return (
      <Empty
        title="Clean pass"
        body="Travel limits, spindle range, interlocks, feed presence, path continuity and unit brands all checked. Nothing to report."
      />
    );
  }

  return (
    <div className="rows">
      {stage && <div className="note error">Compile stopped at the <b>{stage}</b> stage.</div>}
      {diagnostics.map((d, i) => <DiagnosticRow key={i} d={d} />)}
    </div>
  );
}

function DiagnosticRow({ d }: { d: Diagnostic }) {
  const where = d.provenance?.script
    ? `line ${d.provenance.script.line}`
    : d.gcodeLine !== undefined
      ? `gcode ${d.gcodeLine + 1}`
      : describeProvenance(d.provenance);
  return (
    <div className="row">
      <span className={`sev ${d.severity}`}>{d.severity}</span>
      <span className="code">{d.code}</span>
      <span className="val">{d.message}</span>
      {where && <span className="dim">{where}</span>}
    </div>
  );
}

/* ---------------------------- certificate ------------------------------ */

function CertificatePanel() {
  const rows = useSelector((s: RootState) => s.compile.certificate);
  const budget = useSelector((s: RootState) => s.compile.errorBudgetMm);

  if (rows.length === 0) return <Empty title="No certificate" body="Compile to produce one." />;

  return (
    <div className="rows">
      {rows.map((r) => (
        <div className="row" key={r.label}>
          <span className={`sev ${r.status}`}>
            {r.status === "exact" || r.status === "resolution" ? "pass"
              : r.status === "skipped" ? "skip" : "unkn"}
          </span>
          <span className="key wide">{r.label}</span>
          <span className="val">{r.detail}</span>
        </div>
      ))}
      <div className="row summary">
        <span className="key">error budget</span>
        <span className="val">{budget.toFixed(4)} mm total geometric</span>
      </div>
      <div className="note">
        Checks report what was actually established. &quot;Verified to resolution&quot; means the
        material simulation sampled at that grid size — it is not a proof about the space
        between samples. Items marked <b>skip</b> were not modelled at all.
      </div>
    </div>
  );
}

/* ------------------------------- shared -------------------------------- */

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      <div className="empty-body">{body}</div>
    </div>
  );
}
