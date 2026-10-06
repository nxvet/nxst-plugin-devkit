// Byte-exact edits of HL7 messages and MLLP framing helpers.
//
// A simulator sometimes has to change a few fields of a captured message before sending it (a
// fresh control id, the current timestamp, a chosen patient id) while every other byte stays
// exactly as captured, so that what the receiver gets is still the real analyzer's bytes. The
// positions come from the byte-range helpers of @nxvet/nxst-hl7-parser; nothing is decoded and
// re-serialised.
import type { ByteRange, RangeReplacement } from '@nxvet/nxst-hl7-parser'
import { MLLP_CR, MLLP_END, MLLP_START, fieldRange, replaceRanges, segmentRanges, splitRange } from '@nxvet/nxst-hl7-parser'

/** One field, repetition or component to overwrite. */
export interface FieldEdit {
  /** A name for the edit, reported back in `applied` / `skipped` (for example `MSH-10`). */
  name: string
  /** Segment name; the first segment with that name is edited. */
  segment: string
  /** Field number, as in the HL7 specification (MSH offset applied). */
  field: number
  /** Repetition (1-based, split on `~`); defaults to the first. */
  repetition?: number
  /** Component (1-based, split on `^`); omit to overwrite the whole field or repetition. */
  component?: number
  /** The new content. */
  value: string
}

export interface RewriteResult {
  /** A new buffer with the edits applied; the input is never modified. */
  bytes: Buffer
  /** Names of the edits that were applied, in the order given. */
  applied: string[]
  /** Edits that could not be applied, with the reason. Nothing is synthesised for them. */
  skipped: Array<{ name: string, reason: string }>
}

const asBuffer = (bytes: Uint8Array): Buffer => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/**
 * Overwrites the given fields and keeps every other byte as it was.
 *
 * An existing but empty field (or component) is a zero-length range, so the value is inserted in
 * place. A segment, field, repetition or component that does not exist is reported in `skipped`
 * rather than created: a simulator must not send shapes the analyzer never sends. Two edits that
 * touch the same bytes throw (`replaceRanges` rejects overlapping ranges).
 */
export const rewriteFields = (bytes: Uint8Array, edits: readonly FieldEdit[]): RewriteResult => {
  const buffer = asBuffer(bytes)
  const segments = segmentRanges(buffer)
  const replacements: Array<RangeReplacement & { name: string }> = []
  const skipped: RewriteResult['skipped'] = []

  for (const edit of edits) {
    const segment = segments.find((candidate) => candidate.name === edit.segment)

    if (segment === undefined) {
      skipped.push({ name: edit.name, reason: `no ${edit.segment} segment` })
      continue
    }

    const whole = fieldRange(buffer, segment, edit.field)

    if (whole === undefined) {
      skipped.push({ name: edit.name, reason: `${edit.segment} has fewer than ${edit.field} fields` })
      continue
    }

    let target: ByteRange | undefined = whole

    if (edit.repetition !== undefined || edit.component !== undefined) {
      const repetitions = splitRange(buffer, whole, '~')
      const repetition = repetitions[(edit.repetition ?? 1) - 1]

      if (repetition === undefined) {
        skipped.push({ name: edit.name, reason: `${edit.segment}-${edit.field} has no repetition ${edit.repetition}` })
        continue
      }

      target = repetition

      if (edit.component !== undefined) {
        target = splitRange(buffer, repetition, '^')[edit.component - 1]

        if (target === undefined) {
          skipped.push({ name: edit.name, reason: `${edit.segment}-${edit.field} has no component ${edit.component}` })
          continue
        }
      }
    }

    replacements.push({ name: edit.name, start: target.start, end: target.end, value: edit.value })
  }

  return {
    bytes: replaceRanges(buffer, replacements).bytes,
    applied: replacements.map((replacement) => replacement.name),
    skipped,
  }
}

/** Wraps message bytes in an MLLP frame (`<SB>` + bytes + `<EB><CR>`) without decoding them. */
export const wrapFrame = (bytes: Uint8Array): Buffer => Buffer.concat([
  Buffer.from([MLLP_START]),
  bytes,
  Buffer.from([MLLP_END, MLLP_CR]),
])

/**
 * Splits bytes into chunks of `size`, the way TCP may split a frame larger than the segment size.
 * A `size` of 0, a non-integer, or a size not smaller than the input yields a single chunk. Each
 * chunk is an independent copy; concatenating them gives back the input.
 */
export const splitChunks = (bytes: Uint8Array, size: number): Buffer[] => {
  const buffer = asBuffer(bytes)

  if (!Number.isInteger(size) || size <= 0 || size >= buffer.length) return [Buffer.from(buffer)]

  const chunks: Buffer[] = []

  for (let at = 0; at < buffer.length; at += size) chunks.push(Buffer.from(buffer.subarray(at, at + size)))

  return chunks
}
