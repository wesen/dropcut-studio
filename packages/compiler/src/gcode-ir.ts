/**
 * @cam/compiler/gcode-ir — structured G-code blocks and modal compression.
 *
 * Emission is two-stage (DESIGN-01 §29). Never generate strings directly:
 *
 *     ValidatedProgram -> GCodeBlock[] -> compress() -> format() -> text
 *
 * This module owns the ONLY place in the entire codebase that reasons about
 * modality. Everything upstream is non-modal by construction; the compressor
 * drops words that the controller would infer anyway. Because modality is
 * confined here, it is one pure function with one property test rather than an
 * invariant smeared across the emitter.
 *
 * Design doc: Part XI.1, XI.2.
 */

import { formatMm } from "@cam/units";
import type { Provenance } from "@cam/ir";

export type MotionWord = "G0" | "G1" | "G2" | "G3";
export type PlaneWord = "G17" | "G18" | "G19";
export type AxisWord = "X" | "Y" | "Z" | "I" | "J" | "K" | "R";

export interface GCodeBlock {
  /**
   * Emitted exactly as given, bypassing word assembly and comment formatting.
   *
   * Needed for structured metadata such as Makera's `;@MKR|...` header, which
   * is syntactically a comment but semantically a record: reformatting it as a
   * comment (`; @MKR|...`) would break the consumer's parser.
   */
  readonly verbatim?: string;
  readonly motion?: MotionWord;
  readonly plane?: PlaneWord;
  readonly axes?: Partial<Record<AxisWord, number>>;
  readonly feed?: number;
  readonly spindleSpeed?: number;
  readonly spindleCode?: "M3" | "M4" | "M5";
  readonly tool?: number;
  /** Raw M-words and other codes, emitted verbatim in order. */
  readonly misc?: readonly string[];
  readonly comment?: string;
  readonly provenance?: Provenance;
  /** Index into the motion timeline, for click-to-seek in the UI. */
  readonly motionIndex?: number;
}

/** Axis words that carry a position (as opposed to arc parameters). */
const POSITION_AXES: readonly AxisWord[] = ["X", "Y", "Z"];
/** Arc parameters are always re-emitted; they are relative to the current point. */
const ARC_AXES: readonly AxisWord[] = ["I", "J", "K", "R"];

export interface CompressOptions {
  /** Axis values closer than this are treated as unchanged. */
  readonly epsilon?: number;
  /** Suppress repeated axis words. Disable for maximum-explicitness output. */
  readonly dropRedundantAxes?: boolean;
}

/**
 * Drop words the controller would infer from modal state.
 *
 * Rules, in order of how much they matter:
 *  - motion word: drop if unchanged (G1 stays active)
 *  - plane word: drop if unchanged
 *  - feed: drop if unchanged
 *  - position axes: drop if unchanged (a block that moves only in X need not
 *    restate Y and Z)
 *  - arc axes: NEVER dropped — I/J/K are offsets from the current point and are
 *    meaningless to carry over
 *  - spindle speed: drop if unchanged AND no spindle code is being issued
 *
 * A block that ends up with no words at all is removed entirely, unless it
 * carries a comment.
 */
export function compress(
  blocks: readonly GCodeBlock[],
  opts: CompressOptions = {},
): GCodeBlock[] {
  const eps = opts.epsilon ?? 1e-9;
  const dropAxes = opts.dropRedundantAxes ?? true;

  let motion: MotionWord | undefined;
  let plane: PlaneWord | undefined;
  let feed: number | undefined;
  let speed: number | undefined;
  const lastAxis: Partial<Record<AxisWord, number>> = {};

  const out: GCodeBlock[] = [];

  for (const b of blocks) {
    const next: {
      -readonly [K in keyof GCodeBlock]: GCodeBlock[K];
    } = { ...b };

    if (b.motion !== undefined) {
      if (b.motion === motion) delete next.motion;
      else motion = b.motion;
    }

    if (b.plane !== undefined) {
      if (b.plane === plane) delete next.plane;
      else plane = b.plane;
    }

    if (b.feed !== undefined) {
      if (feed !== undefined && Math.abs(b.feed - feed) <= eps) delete next.feed;
      else feed = b.feed;
    }

    if (b.spindleSpeed !== undefined) {
      // An M3/M4 always restates S, because some controllers latch it there.
      const restating = b.spindleCode === "M3" || b.spindleCode === "M4";
      if (!restating && speed !== undefined && Math.abs(b.spindleSpeed - speed) <= eps) {
        delete next.spindleSpeed;
      } else {
        speed = b.spindleSpeed;
      }
    }

    if (b.axes) {
      const axes: Partial<Record<AxisWord, number>> = {};
      for (const ax of POSITION_AXES) {
        const v = b.axes[ax];
        if (v === undefined) continue;
        const prev = lastAxis[ax];
        if (dropAxes && prev !== undefined && Math.abs(v - prev) <= eps) continue;
        axes[ax] = v;
        lastAxis[ax] = v;
      }
      for (const ax of ARC_AXES) {
        const v = b.axes[ax];
        if (v !== undefined) axes[ax] = v;
      }
      if (Object.keys(axes).length > 0) next.axes = axes;
      else delete next.axes;
    }

    if (b.verbatim !== undefined || !isEmptyBlock(next)) out.push(next as GCodeBlock);
  }

  return out;
}

function isEmptyBlock(b: Partial<GCodeBlock>): boolean {
  return (
    b.verbatim === undefined &&
    b.motion === undefined &&
    b.plane === undefined &&
    b.feed === undefined &&
    b.spindleSpeed === undefined &&
    b.spindleCode === undefined &&
    b.tool === undefined &&
    (b.misc === undefined || b.misc.length === 0) &&
    (b.axes === undefined || Object.keys(b.axes).length === 0) &&
    b.comment === undefined
  );
}

export interface FormatOptions {
  readonly decimals?: number;
  /** ";" line comments (Marlin/GRBL style) or "()" inline (Fanuc style). */
  readonly commentStyle?: "semicolon" | "parens";
  readonly separator?: string;
}

/** Render one block to text. Word order follows conventional RS-274 practice. */
export function formatBlock(b: GCodeBlock, opts: FormatOptions = {}): string {
  if (b.verbatim !== undefined) return b.verbatim;

  const dec = opts.decimals ?? 3;
  const sep = opts.separator ?? " ";
  const style = opts.commentStyle ?? "parens";
  const w: string[] = [];

  if (b.plane) w.push(b.plane);
  if (b.tool !== undefined) w.push(`T${b.tool}`);
  if (b.motion) w.push(b.motion);

  if (b.axes) {
    for (const ax of [...POSITION_AXES, ...ARC_AXES] as AxisWord[]) {
      const v = b.axes[ax];
      if (v !== undefined) w.push(`${ax}${formatMm(v, dec)}`);
    }
  }

  if (b.feed !== undefined) w.push(`F${formatMm(b.feed, dec === 3 ? 1 : dec)}`);
  if (b.spindleSpeed !== undefined) w.push(`S${Math.round(b.spindleSpeed)}`);
  if (b.spindleCode) w.push(b.spindleCode);
  if (b.misc) w.push(...b.misc);

  const code = w.join(sep);
  if (!b.comment) return code;

  const c = style === "semicolon"
    ? `; ${b.comment}`
    : `(${b.comment.replace(/[()]/g, "")})`;
  return code ? `${code} ${c}` : c;
}

export function formatProgram(
  blocks: readonly GCodeBlock[],
  opts: FormatOptions = {},
): string {
  return blocks.map((b) => formatBlock(b, opts)).join("\n");
}

/**
 * A G-code document: text plus the index that maps lines back to motions.
 * The line/motion link is what powers click-to-seek and play-time highlighting.
 */
export interface GCodeDocument {
  readonly lines: readonly GCodeLine[];
  readonly text: string;
  readonly dialect: string;
}

export interface GCodeLine {
  readonly n: number;
  readonly text: string;
  readonly motionIndex: number | null;
  readonly provenance?: Provenance;
}

export function toDocument(
  blocks: readonly GCodeBlock[],
  dialect: string,
  opts: FormatOptions = {},
): GCodeDocument {
  const lines: GCodeLine[] = blocks.map((b, i) => ({
    n: i + 1,
    text: formatBlock(b, opts),
    motionIndex: b.motionIndex ?? null,
    provenance: b.provenance,
  }));
  return { lines, text: lines.map((l) => l.text).join("\n"), dialect };
}
