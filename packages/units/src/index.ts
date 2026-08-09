/**
 * @cam/units — branded scalar types.
 *
 * TypeScript brands make `Mm` and `Rpm` distinct types even though both erase to
 * `number`. This catches the entire class of "passed the feed rate where the
 * diameter was expected" bug at compile time, at zero runtime cost.
 *
 * There is exactly ONE internal length unit: millimetres. `inch()` converts on
 * construction rather than carrying an inch-typed value through the system, so
 * no code downstream of the boundary ever asks "which unit is this in?".
 *
 * Design doc: Part IV.1.
 */

declare const brandKey: unique symbol;

/** Phantom marker. Never present at runtime. */
export type Brand<K extends string> = { readonly [brandKey]: K };

export type Mm = number & Brand<"mm">;
export type Rpm = number & Brand<"rpm">;
export type MmPerMin = number & Brand<"mm/min">;
export type Degrees = number & Brand<"deg">;
export type Radians = number & Brand<"rad">;
export type Seconds = number & Brand<"s">;
/** Dimensionless fraction, typically 0..1 (e.g. stepover as a fraction of tool diameter). */
export type Ratio = number & Brand<"ratio">;

export const mm = (v: number): Mm => v as Mm;
/** Converts to millimetres immediately — inches never enter the core. */
export const inch = (v: number): Mm => (v * 25.4) as Mm;
export const rpm = (v: number): Rpm => v as Rpm;
export const mmPerMin = (v: number): MmPerMin => v as MmPerMin;
export const deg = (v: number): Degrees => v as Degrees;
export const rad = (v: number): Radians => v as Radians;
export const seconds = (v: number): Seconds => v as Seconds;
export const ratio = (v: number): Ratio => v as Ratio;

/** Strip the brand. Use only at boundaries (formatting, arithmetic helpers). */
export const raw = (v: number): number => v;

export const degToRad = (d: Degrees): Radians => ((d * Math.PI) / 180) as Radians;
export const radToDeg = (r: Radians): Degrees => ((r * 180) / Math.PI) as Degrees;

/** mm/min → mm/s. Feed rates are quoted per minute; time maths wants seconds. */
export const perSecond = (f: MmPerMin): number => f / 60;

export interface Range<T extends number> {
  readonly min: T;
  readonly max: T;
}

export const range = <T extends number>(min: T, max: T): Range<T> => ({ min, max });

export const inRange = <T extends number>(r: Range<T>, v: T): boolean =>
  v >= r.min && v <= r.max;

export const clampToRange = <T extends number>(r: Range<T>, v: T): T =>
  (v < r.min ? r.min : v > r.max ? r.max : v) as T;

/**
 * Format a length for G-code output.
 *
 * Fixed 3 decimals is the RS-274 convention and is itself an error contribution
 * of +/- 0.0005 mm — see the error budget in design doc Part X.2. Negative zero
 * is normalised away because "-0.000" confuses some controllers.
 */
export function formatMm(v: number, decimals = 3): string {
  const s = v.toFixed(decimals);
  return s === "-" + (0).toFixed(decimals) ? (0).toFixed(decimals) : s;
}

/** Quantisation error introduced by `formatMm` at a given precision. */
export function roundingError(decimals = 3): Mm {
  return mm(0.5 * Math.pow(10, -decimals));
}
