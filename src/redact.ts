// Redaction of personal data in captured HL7 streams, before a capture becomes a replay fixture.
//
// Which fields carry personal data is instrument semantics and is supplied by the caller as a
// `RedactionSpec`. This module only knows how to find those fields in a byte stream (through the
// byte-range helpers of @nxvet/nxst-hl7-parser), how to keep placeholders consistent across a whole
// capture, and how to re-cut a redacted stream at the chunk boundaries the capture was received
// in. Nothing is decoded and re-encoded: every byte outside a redacted value is kept exactly as it
// was received, including bytes that are not valid UTF-8.
import type { ByteRange, Hl7Segment, RangeReplacement, SegmentRange } from '@nxvet/nxst-hl7-parser'
import {
  field,
  fieldRange,
  mllpFrameRanges,
  parseMessage,
  replaceRanges,
  segmentRanges,
  splitRange,
  trimRange,
} from '@nxvet/nxst-hl7-parser'

/** A read-only view of one segment occurrence, handed to `RedactionRule.when`. */
export interface SegmentView {
  /** The segment name (`PID`, `OBX`, ...). */
  name: string
  /** Field `n` of the segment, numbered as in the HL7 specification (MSH offset applied). */
  field(n: number): string
}

/** One field (or component) that holds personal data. */
export interface RedactionRule {
  /**
   * The category of the value (`patientId`, `petName`, ...). Rules that share a kind share one
   * original-to-placeholder map, so the same original value gets the same placeholder wherever it
   * appears, and the placeholder sequence is numbered per kind.
   */
  kind: string
  /** Segment name the rule applies to. Every occurrence of the segment is considered. */
  segment: string
  /** Field number, as in the HL7 specification. */
  field: number
  /** Component number (1-based) within the field; omit to redact the field (or repetition) as a whole. */
  component?: number
  /**
   * When true, every `~`-separated repetition of the field is redacted (the given component of
   * each repetition, or each repetition as a whole). When absent, only the first repetition is
   * considered: the given component of it, or the whole field when no component is given.
   */
  everyRepetition?: boolean
  /**
   * Optional predicate evaluated per segment occurrence; the rule applies only when it returns
   * true. Use it when personal data sits in a generic segment (an OBX whose OBX-3 names the
   * value, an NTE whose NTE-2 marks the author).
   */
  when?: (segment: SegmentView) => boolean
  /** The placeholder for the n-th distinct original of this kind (n starts at 1). */
  label: (n: number) => string
}

export type RedactionSpec = readonly RedactionRule[]

/**
 * One replacement found by a redactor: the bytes in `[start, end)` are replaced with `value`. It
 * has the shape of the parser's `RangeReplacement`, so it can be passed to `replaceRanges` directly.
 */
export interface Replacement extends RangeReplacement {
  kind: string
  value: string
}

/** A redactor keeps the original-to-placeholder maps for one capture. */
export interface Redactor {
  /** The kinds declared by the spec, in declaration order. */
  readonly kinds: readonly string[]
  /**
   * Every replacement in a byte stream that may hold several MLLP frames and bytes outside any
   * frame, sorted by position. Frames are found with `mllpFrameRanges`, so an unfinished frame
   * (one still being received) is redacted as well.
   */
  findInStream(stream: Uint8Array): Replacement[]
  /** Every replacement in the content of one message (no MLLP framing), sorted by position. */
  findInMessage(message: Uint8Array): Replacement[]
  /** Redacts the text of one message (no MLLP framing). */
  redactText(text: string): string
  /** How many distinct originals each kind has seen. */
  counts(): Record<string, number>
  /**
   * Every original value seen, per kind. Meant only for the residual check: the values must
   * never be printed or written to a file.
   */
  originals(): Array<{ kind: string, value: string }>
}

/** Characters a placeholder must not contain: HL7 delimiters and line breaks would corrupt the message. */
const FORBIDDEN_IN_LABEL = /[|^~\\&\r\n]/

const asBuffer = (bytes: Uint8Array): Buffer => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/**
 * Checks the placeholders a spec produces, so that a bad `label` is caught when the redactor is
 * created rather than when a capture is written: no delimiters or line breaks, never empty, and
 * two kinds never produce the same placeholder (the fixture could not be read back unambiguously).
 */
const validateSpec = (spec: RedactionSpec): void => {
  const seen = new Map<string, string>()

  for (const rule of spec) {
    if (rule.kind === '') throw new Error('redaction rule has an empty kind')
    if (!Number.isInteger(rule.field) || rule.field < 1) throw new Error(`redaction rule "${rule.kind}": field must be a positive integer`)
    if (rule.component !== undefined && (!Number.isInteger(rule.component) || rule.component < 1)) {
      throw new Error(`redaction rule "${rule.kind}": component must be a positive integer`)
    }

    for (const n of [1, 2, 3]) {
      const label = rule.label(n)

      if (typeof label !== 'string' || label === '') throw new Error(`redaction rule "${rule.kind}": label(${n}) is empty`)
      if (FORBIDDEN_IN_LABEL.test(label)) throw new Error(`redaction rule "${rule.kind}": label(${n}) contains an HL7 delimiter or a line break`)

      const owner = seen.get(label)

      if (owner !== undefined && owner !== rule.kind) {
        throw new Error(`redaction rules "${owner}" and "${rule.kind}" produce the same placeholder "${label}"`)
      }

      seen.set(label, rule.kind)
    }
  }
}

export const createRedactor = (spec: RedactionSpec): Redactor => {
  validateSpec(spec)

  const kinds = [...new Set(spec.map((rule) => rule.kind))]
  const maps = new Map<string, Map<string, string>>(kinds.map((kind) => [kind, new Map()]))
  const labelFor = new Map<string, (n: number) => string>()

  // The first rule of a kind decides the placeholder format for that kind.
  for (const rule of spec) {
    if (labelFor.has(rule.kind) === false) labelFor.set(rule.kind, rule.label)
  }

  const placeholder = (kind: string, original: string): string => {
    const map = maps.get(kind) as Map<string, string>
    let label = map.get(original)

    if (label === undefined) {
      label = (labelFor.get(kind) as (n: number) => string)(map.size + 1)
      map.set(original, label)
    }

    return label
  }

  /**
   * Records a replacement for `range` unless it is empty after trimming. Whitespace is not
   * personal data and stays where it is; the trimming is the parser's `trimRange`, which is the
   * same set of characters `String.prototype.trim` removes, so values match what a plugin reads.
   */
  const collect = (out: Replacement[], buffer: Buffer, kind: string, range: ByteRange | undefined): void => {
    if (range === undefined) return

    const { start, end } = trimRange(buffer, range)

    if (start === end) return

    const original = buffer.toString('utf-8', start, end)

    out.push({ kind, start, end, value: placeholder(kind, original) })
  }

  const viewOf = (buffer: Buffer, segment: SegmentRange): SegmentView => {
    const parsed: Hl7Segment | undefined = parseMessage(buffer.toString('utf-8', segment.start, segment.end))[0]

    return { name: segment.name, field: (n) => field(parsed, n) }
  }

  const findInRange = (buffer: Buffer, within?: ByteRange): Replacement[] => {
    const out: Replacement[] = []

    for (const segment of segmentRanges(buffer, within)) {
      let view: SegmentView | undefined

      for (const rule of spec) {
        if (rule.segment !== segment.name) continue

        if (rule.when !== undefined) {
          view ??= viewOf(buffer, segment)

          if (rule.when(view) === false) continue
        }

        const whole = fieldRange(buffer, segment, rule.field)

        if (whole === undefined) continue

        const repetitions = rule.everyRepetition ? splitRange(buffer, whole, '~') : [splitRange(buffer, whole, '~')[0]]

        for (const repetition of repetitions) {
          if (rule.component === undefined) {
            collect(out, buffer, rule.kind, rule.everyRepetition ? repetition : whole)
          } else {
            collect(out, buffer, rule.kind, splitRange(buffer, repetition, '^')[rule.component - 1])
          }
        }
      }
    }

    return out.sort((a, b) => a.start - b.start)
  }

  const findInStream = (stream: Uint8Array): Replacement[] => {
    const buffer = asBuffer(stream)

    return mllpFrameRanges(buffer).flatMap((frame) => findInRange(buffer, frame)).sort((a, b) => a.start - b.start)
  }

  const findInMessage = (message: Uint8Array): Replacement[] => findInRange(asBuffer(message))

  const redactText = (text: string): string => {
    const bytes = Buffer.from(text, 'utf-8')

    return replaceRanges(bytes, findInMessage(bytes)).bytes.toString('utf-8')
  }

  return {
    kinds,
    findInStream,
    findInMessage,
    redactText,
    counts: () => Object.fromEntries(kinds.map((kind) => [kind, (maps.get(kind) as Map<string, string>).size])),
    originals: () => kinds.flatMap((kind) => [...(maps.get(kind) as Map<string, string>).keys()].map((value) => ({ kind, value }))),
  }
}

/**
 * Redacts the chunks one connection received, preserving the chunk boundaries.
 *
 * The chunks are concatenated first, because a value may straddle two chunks, and the result is
 * re-cut with `mapOffset` from `replaceRanges`. A boundary that falls inside (or at the end of) a
 * replaced value is moved to the end of the placeholder: a chunk must never keep the first half of
 * an original. The number of chunks is preserved; a chunk may come back empty when its boundary
 * was absorbed that way (callers typically write it as a plain wait step).
 */
export const redactChunks = (chunks: readonly Uint8Array[], redactor: Redactor): Buffer[] => {
  const stream = Buffer.concat(chunks.map(asBuffer))
  const { bytes: redacted, mapOffset } = replaceRanges(stream, redactor.findInStream(stream))
  const out: Buffer[] = []
  let original = 0
  let previous = 0

  for (const chunk of chunks) {
    original += chunk.byteLength

    const next = mapOffset(original)

    out.push(redacted.subarray(previous, next))
    previous = next
  }

  return out
}

/**
 * Looks for originals that survived redaction, for example in a field the spec does not cover or
 * in bytes outside any frame. Originals shorter than `minBytes` are skipped (a short numeric id is
 * too likely to appear in a result value by coincidence). The returned warnings never contain an
 * original value.
 */
export const residualCheck = (streams: readonly Uint8Array[], redactor: Redactor, minBytes = 4): string[] => {
  const everything = Buffer.concat(streams.map(asBuffer))
  const warnings: string[] = []

  for (const { kind, value } of redactor.originals()) {
    const needle = Buffer.from(value, 'utf-8')

    if (needle.length < minBytes) continue

    let hits = 0
    let at = everything.indexOf(needle)

    while (at !== -1) {
      hits += 1
      at = everything.indexOf(needle, at + 1)
    }

    if (hits > 0) {
      warnings.push(`a "${kind}" original (${needle.length} bytes) still appears ${hits} time(s) after redaction; `
        + 'it may sit in a field the spec does not cover, in bytes outside any frame, or be a coincidence - review by hand')
    }
  }

  return warnings
}
