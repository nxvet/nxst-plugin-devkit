// Bounded random result values, for the simulator's random mode (`--random`, `rand on`).
//
// Replaying one capture over and over sends the same results every time; in random mode each send
// carries new values that still look like results. Which fields hold result values is instrument
// semantics: the plugin's profile finds them (`SimulatorProfile.randomize`) and asks a
// `RandomValue` for each new one. This module owns the generic part: when a value counts as a
// number, the range a new value is drawn from and its number of decimals, and a seeded generator so
// that a run can be repeated. It is pure: no I/O, no clock, and no randomness of its own (the
// caller passes the generator).
//
// Values are handled as exact decimals (a BigInt count of units of 10^-n), never in binary
// floating point, so a bound such as 7.31 - 0.2 * 0.11 is exactly 7.288, and a value drawn on the
// decimals grid can never land outside its range through rounding.

/**
 * One result value as the plugin's own (shipped) parser reads it. Every member is the text as the
 * message carries it, or `''` when the message does not carry it.
 */
export interface ResultValue {
  /** The item's name, used in the simulator's log line (for example `GLU`). */
  name: string
  /** The result value. */
  value: string
  /** The low end of the reference range. */
  low: string
  /** The high end of the reference range. */
  high: string
}

/** The range a new value is drawn from (see `randomRange`). */
export interface RandomRange {
  /** The smallest value that may be drawn. */
  min: number
  /** The largest value that may be drawn. */
  max: number
  /** The number of fraction digits of a drawn value. */
  decimals: number
  /**
   * `reference`: the reference range, widened by a fifth of its span on each side. `value`: from 0
   * to twice the value, because there is no usable reference range.
   */
  basis: 'reference' | 'value'
}

/** One value a `RandomValue` made by `createRandomValue` produced, reported through `onPick`. */
export interface RandomPick {
  input: ResultValue
  range: RandomRange
  /** The new value, exactly as it is returned. */
  value: string
}

/**
 * Returns the new value for one result value as text, or `undefined` when `input.value` is not a
 * plain number (the caller then leaves the value as it is).
 */
export type RandomValue = (input: ResultValue) => string | undefined

/** The largest seed `seededRandom` accepts: 2^32 - 1. */
export const MAX_SEED = 4_294_967_295

/** Throws a RangeError unless `seed` is an integer from 0 to `MAX_SEED`. */
export const requireSeed = (name: string, seed: number): void => {
  if (Number.isInteger(seed) === false || seed < 0 || seed > MAX_SEED) {
    throw new RangeError(`${name} must be an integer from 0 to ${MAX_SEED}, got ${seed}`)
  }
}

/** A plain number, once trimmed: an optional minus sign, digits, and optionally a dot and more digits. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/

/** An exact decimal: `units / 10^scale`. */
interface Decimal {
  units: bigint
  scale: number
}

/** The exact value of a plain number, or `undefined` when `text` is not one. */
const parsePlain = (text: string): Decimal | undefined => {
  const trimmed = text.trim()

  if (PLAIN_NUMBER.test(trimmed) === false) return undefined

  const [whole, fraction = ''] = trimmed.split('.')

  return { units: BigInt(whole + fraction), scale: fraction.length }
}

/** `decimal` in units of 10^-scale; `scale` must not be smaller than the decimal's own. */
const unitsAt = (decimal: Decimal, scale: number): bigint => decimal.units * 10n ** BigInt(scale - decimal.scale)

/** `units / 10^scale` written with exactly `scale` fraction digits. A BigInt has no negative zero, so neither does the text. */
const formatUnits = (units: bigint, scale: number): string => {
  const sign = units < 0n ? '-' : ''
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, '0')

  return scale === 0 ? `${sign}${digits}` : `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`
}

/** The double nearest to `units / 10^scale` (parsing decimal text is correctly rounded). */
const toNumber = (units: bigint, scale: number): number => Number(formatUnits(units, scale))

/** `a / b` rounded towards minus infinity, for `b > 0`. */
const floorDiv = (a: bigint, b: bigint): bigint => a / b - (a % b < 0n ? 1n : 0n)

/** `a / b` rounded towards plus infinity, for `b > 0`. */
const ceilDiv = (a: bigint, b: bigint): bigint => a / b + (a % b > 0n ? 1n : 0n)

interface Resolved {
  range: RandomRange
  /** The bounds in units of 10^-(decimals + 1), exact. */
  minUnits: bigint
  maxUnits: bigint
}

/**
 * The range for `input`, with its exact bounds. They are computed in units of 10^-(decimals + 1):
 * every value involved lies on the decimals grid, so a span is a multiple of 10 such units and a
 * fifth of it (span / 5 = 2 * span / 10) is a whole number of them. No rounding happens anywhere;
 * `min` and `max` are the doubles nearest to the exact bounds.
 */
const resolve = (input: ResultValue): Resolved | undefined => {
  const value = parsePlain(input.value)

  if (value === undefined) return undefined

  const low = parsePlain(input.low)
  const high = parsePlain(input.high)
  const decimals = Math.max(value.scale, low?.scale ?? 0, high?.scale ?? 0)
  const scale = decimals + 1
  const lowUnits = low === undefined ? undefined : unitsAt(low, scale)
  const highUnits = high === undefined ? undefined : unitsAt(high, scale)
  let minUnits: bigint
  let maxUnits: bigint
  let basis: RandomRange['basis']

  if (lowUnits !== undefined && highUnits !== undefined && lowUnits <= highUnits) {
    const widen = (highUnits - lowUnits) / 5n

    minUnits = lowUnits - widen
    maxUnits = highUnits + widen
    basis = 'reference'

    // A range that starts at 0 or above describes something that cannot be negative.
    if (lowUnits >= 0n && minUnits < 0n) minUnits = 0n
  } else {
    const twice = 2n * unitsAt(value, scale)

    minUnits = twice < 0n ? twice : 0n
    maxUnits = twice > 0n ? twice : twice === 0n ? 10n ** BigInt(scale) : 0n
    basis = 'value'
  }

  return {
    range: { min: toNumber(minUnits, scale), max: toNumber(maxUnits, scale), decimals, basis },
    minUnits,
    maxUnits,
  }
}

/**
 * The range a new value for `input` is drawn from, or `undefined` when `input.value` is not a plain
 * number. A plain number is, once trimmed, an optional minus sign, digits, and optionally a dot
 * followed by digits (`98`, `7.074`, `-3`, `0.50`); `<50.0`, `>99`, `/`, `-`, `18.4 *` and `''` are not.
 *
 * - When low and high are both plain numbers and low is not above high (`basis: 'reference'`), the
 *   reference range is widened by a fifth of its span on each side, except that a range whose low
 *   is 0 or above never goes below 0: 7.31 to 7.42 gives 7.288 to 7.442, -3 to 3 gives -4.2 to 4.2,
 *   0 to 5 gives 0 to 6, and 4 to 4 gives 4 to 4.
 * - Otherwise (no range, one bound only, a bound that is not a plain number, low above high), the
 *   range runs from 0 to twice the value (`basis: 'value'`): 12 gives 0 to 24, -1.5 gives -3 to 0,
 *   and 0 gives 0 to 1.
 *
 * `decimals` is the largest number of fraction digits among the value, low and high, counting only
 * those that are plain numbers: a value of 7.074 with a range of 7.31 to 7.42 gives 3.
 */
export const randomRange = (input: ResultValue): RandomRange | undefined => resolve(input)?.range

/**
 * Where `value` lies relative to the reference range from `low` to `high`, both ends included:
 * `below`, `within` or `above`. Returns `undefined` unless all three are plain numbers (see
 * `randomRange`) and low is not above high. The comparison is exact, not in floating point. Meant
 * for whatever an analyzer derives from a value (an H or L flag), recomputed against the original
 * reference range once the value has been replaced.
 */
export const rangePosition = (value: string, low: string, high: string): 'below' | 'within' | 'above' | undefined => {
  const v = parsePlain(value)
  const lo = parsePlain(low)
  const hi = parsePlain(high)

  if (v === undefined || lo === undefined || hi === undefined) return undefined

  const scale = Math.max(v.scale, lo.scale, hi.scale)
  const [at, from, to] = [v, lo, hi].map((decimal) => unitsAt(decimal, scale))

  if (from > to) return undefined
  if (at < from) return 'below'
  if (at > to) return 'above'

  return 'within'
}

/**
 * A repeatable source of numbers from 0 up to (not including) 1, for `createRandomValue`: the
 * mulberry32 generator, small and fast, good for test data and nothing secret. The same seed always
 * gives the same sequence. Throws a RangeError unless `seed` is an integer from 0 to 4294967295
 * (2^32 - 1).
 */
export const seededRandom = (seed: number): (() => number) => {
  requireSeed('seededRandom: seed', seed)

  let state = seed | 0

  return () => {
    state = (state + 0x6d2b79f5) | 0

    let t = Math.imul(state ^ (state >>> 15), state | 1)

    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * Builds a `RandomValue` that draws each new value from `randomRange(input)`: every number with
 * `decimals` fraction digits from `min` to `max` is equally likely, both ends included. The value is
 * written with exactly `decimals` fraction digits, and never as `-0`. `random` must return a number
 * from 0 up to (not including) 1, like `Math.random` or `seededRandom(seed)`; anything else throws
 * a RangeError. `onPick`, when given, is called with each value produced. A value that is not a
 * plain number gives `undefined` without calling `random` or `onPick`.
 */
export const createRandomValue = (random: () => number, onPick?: (pick: RandomPick) => void): RandomValue => (input) => {
  const resolved = resolve(input)

  if (resolved === undefined) return undefined

  const { range, minUnits, maxUnits } = resolved
  // The grid of drawable values, in units of 10^-decimals.
  const first = ceilDiv(minUnits, 10n)
  const last = floorDiv(maxUnits, 10n)
  let units: bigint

  if (first <= last) {
    const count = last - first + 1n
    const r = random()

    if ((r >= 0 && r < 1) === false) throw new RangeError(`createRandomValue: random() must return a number from 0 up to (not including) 1, got ${r}`)

    // Number(count) is exact up to 2^53 and floor(r * count) then stays below count; the cap only
    // matters for larger counts, whose conversion may round up.
    const offset = BigInt(Math.floor(r * Number(count)))

    units = first + (offset < count ? offset : count - 1n)
  } else {
    // A range narrower than one step. The rules above never produce one (a range always holds the
    // value or a bound, which lie on the grid), but the function stays total: round the minimum.
    units = floorDiv(minUnits + 5n, 10n)
  }

  const value = formatUnits(units, range.decimals)

  onPick?.({ input, range, value })

  return value
}
