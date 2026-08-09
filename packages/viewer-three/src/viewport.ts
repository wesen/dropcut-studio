/**
 * @cam/viewer-three/viewport — the imperative 3D shell.
 *
 * DELIBERATELY FRAMEWORK-FREE. React and a 60 Hz WebGL renderer have
 * incompatible update models, and the only way to keep that boundary honest is
 * to build the renderer so it does not know React exists. React later owns the
 * host `<div>`; everything inside it is driven through `ViewportApi`.
 *
 * Z-UP throughout, matching machine coordinates (ADR-008). Three defaults to
 * Y-up, and one of the prototypes handled that by remapping every point on
 * insertion — a transformation that has to be remembered at every call site and
 * produces plausible-looking wrong geometry the moment one is missed.
 *
 * Design doc: Part VIII.
 */

import * as THREE from "three";
import type { RenderBuffers } from "@cam/ir";
import { MoveKind } from "@cam/ir";
import { sampleAt, trailCount } from "./playback.js";

export interface StockBox {
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  readonly topZ: number;
}

export type LayerName = "part" | "stock" | "toolpath" | "rapids" | "trail" | "tool";
export type ColorMode = "purpose" | "depth";
export type NamedView = "iso" | "top" | "front" | "right";

export interface ViewportApi {
  setToolpath(buffers: RenderBuffers | null): void;
  setStock(stock: StockBox | null): void;
  setPart(triangles: Float64Array | null): void;
  setVisibility(v: Partial<Record<LayerName, boolean>>): void;
  setColorMode(mode: ColorMode): void;

  play(): void;
  pause(): void;
  toggle(): void;
  seek(seconds: number): void;
  setSpeed(multiplier: number): void;
  get playing(): boolean;
  get time(): number;
  get duration(): number;

  /** Called at most `throttleHz` times a second with playback position. */
  onTick(cb: (info: TickInfo) => void): () => void;

  view(named: NamedView): void;
  frameAll(): void;
  resize(): void;
  dispose(): void;
}

export interface TickInfo {
  readonly time: number;
  readonly duration: number;
  readonly playing: boolean;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly gcodeLine: number;
}

export interface ViewportOptions {
  readonly background?: number;
  /** Rate limit for `onTick`. The DRO is written directly at 60 Hz regardless. */
  readonly throttleHz?: number;
}

const COLORS = {
  traverse: 0xb4543f,
  rough: 0x5b7089,
  finish: 0x4fc8dd,
  plunge: 0xe8c468,
  ramp: 0xe89a68,
  trail: 0xf2f6fa,
  stock: 0x33404f,
  stockEdge: 0x46566a,
  part: 0x33383f,
  grid: 0x2b323c,
  gridDim: 0x1c2229,
  tool: 0xffb100,
};

export function createViewport(host: HTMLElement, opts: ViewportOptions = {}): ViewportApi {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(opts.background ?? 0x101318);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
  camera.up.set(0, 0, 1); // Z-up: machine coordinates, not Three's default

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio ?? 1));
  renderer.domElement.style.display = "block";
  host.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0x9fb4cc, 0x22262c, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 0.85);
  key.position.set(40, -55, 80);
  scene.add(key);

  /* ----------------------------- scene graph ---------------------------- */

  const grid = new THREE.GridHelper(200, 20, COLORS.grid, COLORS.gridDim);
  grid.rotation.x = Math.PI / 2; // GridHelper is XZ by default; we want XY
  scene.add(grid);

  const axes = makeAxes(14);
  scene.add(axes);

  const layers: Record<LayerName, THREE.Object3D> = {
    part: new THREE.Group(),
    stock: new THREE.Group(),
    toolpath: new THREE.Group(),
    rapids: new THREE.Group(),
    trail: new THREE.Group(),
    tool: makeToolMarker(),
  };
  for (const g of Object.values(layers)) scene.add(g);

  /* ------------------------------- orbit -------------------------------- */

  const orbit = { theta: -Math.PI / 3.2, phi: 1.05, radius: 120,
    target: new THREE.Vector3(0, 0, 0) };

  const applyCamera = () => {
    const s = Math.sin(orbit.phi);
    camera.position.set(
      orbit.target.x + orbit.radius * s * Math.cos(orbit.theta),
      orbit.target.y + orbit.radius * s * Math.sin(orbit.theta),
      orbit.target.z + orbit.radius * Math.cos(orbit.phi),
    );
    camera.lookAt(orbit.target);
  };
  applyCamera();

  let drag: { x: number; y: number; pan: boolean } | null = null;
  const dom = renderer.domElement;

  const onContextMenu = (e: Event) => e.preventDefault();
  const onPointerDown = (e: PointerEvent) => {
    drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
    dom.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.pan) {
      const k = orbit.radius * 0.0016;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      orbit.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    } else {
      orbit.theta -= dx * 0.008;
      orbit.phi = Math.min(Math.PI - 0.05, Math.max(0.05, orbit.phi - dy * 0.008));
    }
    applyCamera();
  };
  const onPointerUp = () => { drag = null; };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    orbit.radius = Math.min(2000, Math.max(2, orbit.radius * Math.exp(e.deltaY * 0.0011)));
    applyCamera();
  };

  dom.addEventListener("contextmenu", onContextMenu);
  dom.addEventListener("pointerdown", onPointerDown);
  dom.addEventListener("pointermove", onPointerMove);
  dom.addEventListener("pointerup", onPointerUp);
  dom.addEventListener("wheel", onWheel, { passive: false });

  /* ------------------------------ playback ------------------------------ */

  // These live in plain closure variables, NOT React state: they change at
  // 60 Hz and rendering them through a component tree would be absurd.
  const clock = { t: 0, playing: false, speed: 8 };
  let buffers: RenderBuffers | null = null;
  let trailLine: THREE.Line | null = null;
  let lastGcodeLine = -1;
  let lastTickAt = 0;
  const listeners = new Set<(info: TickInfo) => void>();
  const throttleMs = 1000 / (opts.throttleHz ?? 12);

  let raf = 0;
  let previous = now();

  function frame(): void {
    raf = requestAnimationFrame(frame);
    const t = now();
    const dt = Math.min(0.1, (t - previous) / 1000);
    previous = t;

    if (clock.playing && buffers && buffers.totalSeconds > 0) {
      clock.t += dt * clock.speed;
      if (clock.t >= buffers.totalSeconds) {
        clock.t = buffers.totalSeconds;
        clock.playing = false;
      }
    }

    updateMarker(t);
    renderer.render(scene, camera);
  }

  function updateMarker(wallClock: number): void {
    if (!buffers || buffers.count === 0) {
      layers.tool.visible = false;
      return;
    }
    layers.tool.visible = true;
    const s = sampleAt(buffers, clock.t);
    layers.tool.position.set(s.x, s.y, s.z);

    if (trailLine) {
      trailLine.geometry.setDrawRange(0, Math.max(2, trailCount(buffers, clock.t) + 1));
    }

    const lineChanged = s.gcodeLine !== lastGcodeLine;
    if (lineChanged) lastGcodeLine = s.gcodeLine;

    // Notify at a human rate, not a frame rate — but always on a line change so
    // editor highlighting stays in step.
    if (lineChanged || wallClock - lastTickAt >= throttleMs) {
      lastTickAt = wallClock;
      const info: TickInfo = {
        time: clock.t,
        duration: buffers.totalSeconds,
        playing: clock.playing,
        x: s.x, y: s.y, z: s.z,
        gcodeLine: s.gcodeLine,
      };
      for (const cb of listeners) cb(info);
    }
  }

  raf = requestAnimationFrame(frame);

  /* ------------------------------ resizing ------------------------------ */

  const resize = () => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();

  const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  observer?.observe(host);

  /* ------------------------------- API ---------------------------------- */

  function clearGroup(group: THREE.Object3D): void {
    while (group.children.length > 0) {
      const child = group.children.pop()!;
      child.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
    }
  }

  const api: ViewportApi = {
    setToolpath(next) {
      clearGroup(layers.toolpath);
      clearGroup(layers.rapids);
      clearGroup(layers.trail);
      trailLine = null;
      buffers = next;
      clock.t = 0;
      clock.playing = false;
      lastGcodeLine = -1;
      if (!next || next.count < 2) return;

      const { cuts, rapids } = splitByKind(next);
      if (cuts.length > 0) {
        const geo = bufferFrom(cuts.positions);
        geo.setAttribute("color", new THREE.BufferAttribute(cuts.colors, 3));
        layers.toolpath.add(new THREE.LineSegments(
          geo, new THREE.LineBasicMaterial({ vertexColors: true }),
        ));
      }
      if (rapids.length > 0) {
        const mat = new THREE.LineDashedMaterial({
          color: COLORS.traverse, dashSize: 1.6, gapSize: 1.6,
          transparent: true, opacity: 0.45,
        });
        const line = new THREE.LineSegments(bufferFrom(rapids.positions), mat);
        line.computeLineDistances();
        layers.rapids.add(line);
      }

      // The trail is ONE line over every point with a draw range that advances
      // during playback. No geometry is rebuilt per frame; a single integer
      // changes. This is the neatest trick the prototypes had.
      const trailGeo = new THREE.BufferGeometry();
      trailGeo.setAttribute("position", new THREE.BufferAttribute(next.positions, 3));
      trailGeo.setDrawRange(0, 0);
      trailLine = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: COLORS.trail }));
      layers.trail.add(trailLine);
    },

    setStock(stock) {
      clearGroup(layers.stock);
      if (!stock) return;
      const geo = new THREE.BoxGeometry(stock.width, stock.depth, stock.height);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: COLORS.stock, transparent: true, opacity: 0.18,
        metalness: 0.2, roughness: 0.8,
      }));
      mesh.position.set(
        stock.originX + stock.width / 2,
        stock.originY + stock.depth / 2,
        stock.topZ - stock.height / 2,
      );
      layers.stock.add(mesh);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: COLORS.stockEdge }),
      );
      edges.position.copy(mesh.position);
      layers.stock.add(edges);
    },

    setPart(triangles) {
      clearGroup(layers.part);
      if (!triangles || triangles.length === 0) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(triangles), 3));
      geo.computeVertexNormals();
      layers.part.add(new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
        color: COLORS.part, shininess: 42, specular: 0x556070, side: THREE.DoubleSide,
      })));
    },

    setVisibility(v) {
      for (const [name, visible] of Object.entries(v)) {
        const layer = layers[name as LayerName];
        if (layer) layer.visible = visible !== false;
      }
    },

    setColorMode(mode) {
      colorMode = mode;
      if (buffers) api.setToolpath(buffers);
    },

    play() { if (buffers && clock.t >= buffers.totalSeconds) clock.t = 0; clock.playing = true; },
    pause() { clock.playing = false; },
    toggle() { clock.playing ? api.pause() : api.play(); },
    seek(seconds) {
      clock.t = Math.max(0, Math.min(seconds, buffers?.totalSeconds ?? 0));
      updateMarker(now());
    },
    setSpeed(multiplier) { clock.speed = Math.max(0.1, multiplier); },
    get playing() { return clock.playing; },
    get time() { return clock.t; },
    get duration() { return buffers?.totalSeconds ?? 0; },

    onTick(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    view(named) {
      switch (named) {
        case "top": orbit.theta = -Math.PI / 2; orbit.phi = 0.06; break;
        case "front": orbit.theta = -Math.PI / 2; orbit.phi = Math.PI / 2 - 0.001; break;
        case "right": orbit.theta = 0; orbit.phi = Math.PI / 2 - 0.001; break;
        default: orbit.theta = -Math.PI / 3.2; orbit.phi = 1.05; break;
      }
      applyCamera();
    },

    frameAll() {
      const box = new THREE.Box3();
      for (const name of ["part", "stock", "toolpath"] as const) {
        const g = layers[name];
        if (g.children.length > 0) box.expandByObject(g);
      }
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3());
      box.getCenter(orbit.target);
      orbit.radius = Math.max(20, Math.max(size.x, size.y, size.z) * 1.9);
      applyCamera();
    },

    resize,

    dispose() {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      dom.removeEventListener("contextmenu", onContextMenu);
      dom.removeEventListener("pointerdown", onPointerDown);
      dom.removeEventListener("pointermove", onPointerMove);
      dom.removeEventListener("pointerup", onPointerUp);
      dom.removeEventListener("wheel", onWheel);
      for (const g of Object.values(layers)) clearGroup(g);
      listeners.clear();
      renderer.dispose();
      if (dom.parentNode === host) host.removeChild(dom);
    },
  };

  let colorMode: ColorMode = "purpose";

  /** Split the buffer into cut segments (vertex-coloured) and rapid segments. */
  function splitByKind(b: RenderBuffers) {
    const cutPos: number[] = [];
    const cutCol: number[] = [];
    const rapidPos: number[] = [];
    const span = Math.max(1e-6, b.maxZ - b.minZ);

    for (let i = 1; i < b.count; i++) {
      const a = (i - 1) * 3;
      const c = i * 3;
      const kind = b.kinds[i];
      if (kind === MoveKind.Traverse) {
        rapidPos.push(b.positions[a], b.positions[a + 1], b.positions[a + 2],
          b.positions[c], b.positions[c + 1], b.positions[c + 2]);
        continue;
      }
      cutPos.push(b.positions[a], b.positions[a + 1], b.positions[a + 2],
        b.positions[c], b.positions[c + 1], b.positions[c + 2]);
      const col = colorMode === "depth"
        ? depthColour((b.positions[c + 2] - b.minZ) / span)
        : purposeColour(kind);
      cutCol.push(...col, ...col);
    }

    return {
      cuts: { positions: Float32Array.from(cutPos), colors: Float32Array.from(cutCol),
        length: cutPos.length },
      rapids: { positions: Float32Array.from(rapidPos), length: rapidPos.length },
    };
  }

  return api;
}

/* ------------------------------ helpers -------------------------------- */

function bufferFrom(positions: Float32Array): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return g;
}

function purposeColour(kind: number): [number, number, number] {
  const hex = kind === MoveKind.Rough ? COLORS.rough
    : kind === MoveKind.Plunge ? COLORS.plunge
    : kind === MoveKind.Ramp ? COLORS.ramp
    : COLORS.finish;
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

function depthColour(t: number): [number, number, number] {
  const c = Math.min(1, Math.max(0, t));
  return [0.31 + c * 0.69, 0.78 - c * 0.09, 0.87 - c * 0.87];
}

function makeAxes(length: number): THREE.Object3D {
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0.02), new THREE.Vector3(length, 0, 0.02),
    new THREE.Vector3(0, 0, 0.02), new THREE.Vector3(0, length, 0.02),
    new THREE.Vector3(0, 0, 0.02), new THREE.Vector3(0, 0, length),
  ]);
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array([
    1, 0.45, 0.35, 1, 0.45, 0.35,
    0.45, 0.85, 0.5, 0.45, 0.85, 0.5,
    0.4, 0.7, 1, 0.4, 0.7, 1,
  ]), 3));
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
}

function makeToolMarker(): THREE.Object3D {
  const group = new THREE.Group();
  const mat = new THREE.MeshPhongMaterial({ color: COLORS.tool, shininess: 90 });
  const tip = new THREE.Mesh(new THREE.ConeGeometry(1.4, 4, 16), mat);
  tip.rotation.x = -Math.PI / 2;
  tip.position.z = 2;
  const shank = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 20, 12), mat);
  shank.rotation.x = Math.PI / 2;
  shank.position.z = 14;
  group.add(tip, shank);
  return group;
}

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();
