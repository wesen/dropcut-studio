/**
 * The imperative shell.
 *
 * React owns the host `<div>`. The renderer owns everything inside it. They
 * communicate through `ViewportApi`, never through props on the hot path — the
 * playback clock changes 60 times a second and must never touch the component
 * tree.
 *
 * Each `useEffect` here is a COARSE, LOW-FREQUENCY sync keyed on an id or a
 * small object. That is the whole pattern.
 *
 * Design doc: Part VIII.1.
 */

import { useEffect, useRef } from "react";
import { shallowEqual, useDispatch, useSelector } from "react-redux";
import type { ViewportApi } from "@cam/viewer-three";
import { createViewport } from "@cam/viewer-three";
import { getArtifact } from "../state/artifactCache.js";
import type { AppDispatch, RootState } from "../state/store.js";
import { tick } from "../state/slices.js";
import { setViewport } from "./viewportHandle.js";

export function Viewport() {
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<ViewportApi | null>(null);
  const dispatch = useDispatch<AppDispatch>();

  const artifactId = useSelector((s: RootState) => s.compile.artifactId);
  const show = useSelector((s: RootState) => s.viewport.show, shallowEqual);
  const colorMode = useSelector((s: RootState) => s.viewport.colorMode);
  const view = useSelector((s: RootState) => s.viewport.view);
  const speed = useSelector((s: RootState) => s.playback.speed);

  // Mount once. Never re-runs, which is the point.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const api = createViewport(host, { throttleHz: 12 });
    apiRef.current = api;
    setViewport(api);

    const off = api.onTick((info) => {
      dispatch(tick({
        time: info.time,
        duration: info.duration,
        playing: info.playing,
        gcodeLine: info.gcodeLine,
      }));
    });

    return () => {
      off();
      setViewport(null);
      api.dispose();
      apiRef.current = null;
    };
  }, [dispatch]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const artifact = getArtifact(artifactId);
    api.setToolpath(artifact?.buffers ?? null);
    api.setPart(artifact?.mesh?.tris ?? null);
    api.setStock(artifact?.stock ?? null);
    if (artifact) api.frameAll();
  }, [artifactId]);

  useEffect(() => { apiRef.current?.setVisibility(show); }, [show]);
  useEffect(() => { apiRef.current?.setColorMode(colorMode); }, [colorMode]);
  useEffect(() => { apiRef.current?.view(view); }, [view]);
  useEffect(() => { apiRef.current?.setSpeed(speed); }, [speed]);

  return <div ref={hostRef} className="viewport" />;
}
