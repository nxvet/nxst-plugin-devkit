// Replay fixtures: reading the JSONL that `nxst-plugin dev --fixture` replays, reading raw
// capture files, and writing a fixture from the events a live capture recorded.
//
// The fixture format belongs to @nxvet/nxst-plugin. That package only exports types, so the line
// rules are re-implemented here, one for one, and pinned by tests: blank lines and `//` comments
// are ignored; a line with `hex` or `text` is data (and takes precedence over `event`); `event`
// is `connection`, `close` or `error`; a line with only `delayMs` is a pause; anything else is an
// error that names the line. `delayMs` is always the gap since the previous line.
import { extractMllpFrameBytes, mllpFrameRanges } from '@nxvet/nxst-hl7-parser'

import type { Redactor } from './redact.ts'
import { redactChunks, residualCheck } from './redact.ts'

/** One message a simulator can send. */
export interface Message {
  /** 1-based position in the list. */
  index: number
  /** The frame content between `<SB>` and `<EB>`, byte for byte, without the MLLP framing. */
  bytes: Buffer
  /** The connection the message arrived on (1-based; raw files are all connection 1). */
  connection: number
  /**
   * Milliseconds since the previous message: the sum of every `delayMs` after the line that
   * completed the previous message up to and including the line that completed this one, so
   * pauses, closes and empty connections in between all count. The first message carries the
   * delay since the start of the fixture; a second frame in the same chunk carries 0. Raw files
   * have no timing, so their messages carry 0.
   */
  delayMs: number
}

/** The messages read from a source, plus whatever the reader had to drop (never silently). */
export interface MessageSet {
  messages: Message[]
  /** Connections seen (fixtures: `connection` lines; data before any such line counts as one). */
  connections: number
  /** Bytes outside any MLLP frame, per connection (counts only, never content). */
  discarded: Array<{ connection: number, bytes: number }>
  /** Frames still open when a connection ended (counts only). */
  incomplete: Array<{ connection: number, bytes: number }>
}

/** One line of a fixture, decoded. */
export type FixtureStep =
  | { kind: 'data', delayMs: number, bytes: Buffer, line: number }
  | { kind: 'wait', delayMs: number, line: number }
  | { kind: 'connection' | 'close' | 'error', delayMs: number, line: number }

export const parseFixtureSteps = (text: string): FixtureStep[] => {
  const steps: FixtureStep[] = []

  for (const [index, raw] of text.split('\n').entries()) {
    const line = index + 1
    const trimmed = raw.trim()

    if (trimmed === '' || trimmed.startsWith('//')) continue

    let parsed: Record<string, unknown>

    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>
    } catch (error) {
      throw new Error(`fixture line ${line} is not valid JSON: ${(error as Error).message}`)
    }

    const delayMs = Number(parsed.delayMs ?? 0)

    if (Number.isFinite(delayMs) === false || delayMs < 0) {
      throw new Error(`fixture line ${line} has an invalid delayMs: ${String(parsed.delayMs)}`)
    }

    if (typeof parsed.hex === 'string' || typeof parsed.text === 'string') {
      const bytes = typeof parsed.hex === 'string'
        ? Buffer.from(parsed.hex.replace(/\s+/g, ''), 'hex')
        : Buffer.from(parsed.text as string, 'utf-8')

      steps.push(bytes.length === 0 ? { kind: 'wait', delayMs, line } : { kind: 'data', delayMs, bytes, line })
      continue
    }

    if (parsed.event === 'close' || parsed.event === 'error' || parsed.event === 'connection') {
      steps.push({ kind: parsed.event, delayMs, line })
      continue
    }

    if (Object.keys(parsed).length === 1 && parsed.delayMs !== undefined) {
      steps.push({ kind: 'wait', delayMs, line })
      continue
    }

    throw new Error(`fixture line ${line} needs hex, text, event (close / error / connection), or only delayMs`)
  }

  return steps
}

/**
 * Reads the messages of a fixture.
 *
 * Bytes are joined only within one connection (the first chunk of the next connection can never
 * be the second half of a frame cut by a close); a frame still open at a close or at the end of
 * the file is reported in `incomplete`. Data before the first `connection` line (a client-mode
 * plugin's fixture has no such line) is treated as connection 1.
 */
export const messagesFromFixture = (text: string): MessageSet => {
  const steps = parseFixtureSteps(text)
  const messages: Message[] = []
  const discarded: MessageSet['discarded'] = []
  const incomplete: MessageSet['incomplete'] = []
  let connections = 0
  let buffer: Buffer = Buffer.alloc(0)
  let open = false
  let pendingDelay = 0

  const finishConnection = (): void => {
    if (buffer.length > 0) incomplete.push({ connection: connections, bytes: buffer.length })

    buffer = Buffer.alloc(0)
    open = false
  }

  for (const step of steps) {
    pendingDelay += step.delayMs

    if (step.kind === 'connection') {
      if (open) finishConnection()

      connections += 1
      open = true
      continue
    }

    if (step.kind === 'close' || step.kind === 'error') {
      if (open) finishConnection()

      continue
    }

    if (step.kind !== 'data') continue

    if (open === false) {
      connections += 1
      open = true
    }

    const extracted = extractMllpFrameBytes(Buffer.concat([buffer, step.bytes]))

    buffer = extracted.rest

    if (extracted.discarded > 0) discarded.push({ connection: connections, bytes: extracted.discarded })

    for (const frame of extracted.frames) {
      messages.push({ index: messages.length + 1, bytes: frame, connection: connections, delayMs: pendingDelay })
      pendingDelay = 0
    }
  }

  if (open) finishConnection()

  return { messages, connections, discarded, incomplete }
}

/** A raw capture file (`raw-NNN.hl7`) or any single `.hl7` file. */
export interface RawFile {
  name: string
  bytes: Uint8Array
}

/** The number at the end of the file name before its extension (`raw-007.hl7` is 7), or `undefined`. */
const trailingNumber = (name: string): number | undefined => {
  const matched = /(\d+)$/.exec(name.replace(/\.[^.]*$/, ''))

  return matched === null ? undefined : Number(matched[1])
}

/**
 * Reads messages from raw capture files, sorted by their trailing number (`raw-2` before
 * `raw-10`) with the name as a tie-breaker.
 *
 * A capture file normally holds the content of one frame without framing. A file that still has
 * the MLLP framing is accepted too: every frame in it is read (an unterminated one as well, since a
 * file cannot be waiting for more bytes). A file without `<SB>` is taken whole, bytes untouched.
 * Raw files carry no timing, so `delayMs` is 0.
 */
export const messagesFromRawFiles = (files: readonly RawFile[]): MessageSet => {
  const sorted = [...files].sort((a, b) => {
    const left = trailingNumber(a.name)
    const right = trailingNumber(b.name)

    if (left !== undefined && right !== undefined && left !== right) return left - right

    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })

  const messages: Message[] = []
  const incomplete: MessageSet['incomplete'] = []

  for (const file of sorted) {
    const bytes = Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength)
    const frames = mllpFrameRanges(bytes)

    if (frames.length === 0) {
      messages.push({ index: messages.length + 1, bytes: Buffer.from(bytes), connection: 1, delayMs: 0 })
      continue
    }

    for (const frame of frames) {
      if (frame.complete === false) incomplete.push({ connection: 1, bytes: frame.end - frame.start })

      messages.push({ index: messages.length + 1, bytes: Buffer.from(bytes.subarray(frame.start, frame.end)), connection: 1, delayMs: 0 })
    }
  }

  return { messages, connections: 1, discarded: [], incomplete }
}

/**
 * One event a live capture recorded. `atMs` is the time since the capture started; `connection`
 * numbers connections from 1. `close.by` says who closed: `peer` (FIN or RST from the analyzer) or
 * `local` (the capture tool closed it).
 */
export type CaptureEvent =
  | { kind: 'connection', connection: number, atMs: number }
  | { kind: 'data', connection: number, atMs: number, bytes: Uint8Array }
  | { kind: 'error', connection: number, atMs: number, message: string }
  | { kind: 'close', connection: number, atMs: number, by: 'peer' | 'local' }

export interface FixtureOptions {
  /** What was captured, for the header comment (for example the analyzer's display name). */
  instrument: string
  /** What produced the file, for the header comment (for example `tools/live-capture.ts`). */
  tool: string
  /** When the capture started; written into the header. */
  capturedAt: Date
  /** Redacts personal data before the bytes are written. Omit only for local debugging. */
  redactor?: Redactor
  /** The pause after the last step, so the receiver can finish its last upload. Defaults to 500. */
  trailingWaitMs?: number
}

export interface FixtureResult {
  /** The complete `session.jsonl`, header included. */
  text: string
  connections: number
  /** Data steps written (a chunk emptied by redaction becomes a pause and is not counted). */
  chunks: number
  /** True when connections overlapped and had to be replayed one after another. */
  serialized: boolean
  /** Close steps added so that each serialized connection's bytes land on its own handle. */
  syntheticCloses: number
  /** Distinct originals redacted per kind (empty when no redactor was given). */
  replaced: Record<string, number>
  /** Warnings for a human reviewer. Never contain an original value. */
  warnings: string[]
}

interface ConnectionLog {
  id: number
  openAt: number
  closeAt: number | undefined
  closedBy: 'peer' | 'local' | undefined
  events: CaptureEvent[]
}

const asBuffer = (bytes: Uint8Array): Buffer => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/**
 * Turns the events of a capture into a fixture.
 *
 * Each connection is written as `connection` -> its chunks (boundaries preserved, as `hex`) ->
 * `error` / `close`, then a trailing pause. The replay harness delivers bytes to the first
 * connection still open, so:
 *   - when connections never overlap, the real timeline is written as is;
 *   - when they do overlap, the replay cannot reproduce it; the connections are written one after
 *     another (closed ones first, those still open at the end last), a `close` is added to every
 *     connection that stayed open while another follows, and the header says so.
 */
export const buildFixture = (events: readonly CaptureEvent[], options: FixtureOptions): FixtureResult => {
  const logs = new Map<number, ConnectionLog>()

  for (const event of events) {
    let log = logs.get(event.connection)

    if (log === undefined) {
      log = { id: event.connection, openAt: event.atMs, closeAt: undefined, closedBy: undefined, events: [] }
      logs.set(event.connection, log)
    }

    log.events.push(event)

    if (event.kind === 'connection') log.openAt = event.atMs

    if (event.kind === 'close') {
      log.closeAt = event.atMs
      log.closedBy = event.by
    }
  }

  const byOpen = [...logs.values()].sort((a, b) => a.openAt - b.openAt || a.id - b.id)
  let openUntil = Number.NEGATIVE_INFINITY
  let serialized = false

  for (const log of byOpen) {
    if (log.openAt < openUntil) serialized = true

    openUntil = Math.max(openUntil, log.closeAt ?? Number.POSITIVE_INFINITY)
  }

  const order = serialized
    ? [...byOpen.filter((log) => log.closeAt !== undefined), ...byOpen.filter((log) => log.closeAt === undefined)]
    : byOpen

  const { redactor } = options
  const body: string[] = []
  const writtenStreams: Buffer[] = []
  let chunks = 0
  let syntheticCloses = 0
  let previousAt = order.length === 0 ? 0 : order[0].openAt

  const step = (atMs: number, rest: Record<string, unknown>): void => {
    const delayMs = Math.max(0, Math.round(atMs - previousAt))

    previousAt = atMs
    body.push(JSON.stringify({ delayMs, ...rest }))
  }

  for (const [index, log] of order.entries()) {
    const dataEvents = log.events.filter((event): event is Extract<CaptureEvent, { kind: 'data' }> => event.kind === 'data')
    const originals = dataEvents.map((event) => event.bytes)
    const payloads = redactor === undefined ? originals.map(asBuffer) : redactChunks(originals, redactor)
    const written = Buffer.concat(payloads)
    const ending = log.closedBy === 'local' ? 'closed locally' : log.closedBy === 'peer' ? 'closed by the peer' : 'still open when the capture ended'

    writtenStreams.push(written)
    body.push('')
    body.push(`// Connection #${log.id}: ${dataEvents.length} chunk(s), ${written.length} bytes${redactor === undefined ? '' : ' (redacted)'}, ${ending}.`)

    let dataIndex = 0

    for (const event of log.events) {
      if (event.kind === 'connection') {
        step(event.atMs, { event: 'connection' })
      } else if (event.kind === 'data') {
        const bytes = payloads[dataIndex]

        dataIndex += 1

        if (bytes.length === 0) {
          // The whole chunk was inside a redacted value and was absorbed into the previous chunk: keep only the gap.
          step(event.atMs, {})
        } else {
          step(event.atMs, { hex: bytes.toString('hex') })
          chunks += 1
        }
      } else if (event.kind === 'error') {
        step(event.atMs, { event: 'error', message: event.message })
      } else {
        step(event.atMs, { event: 'close' })
      }
    }

    if (log.closeAt === undefined && index < order.length - 1) {
      body.push('// This connection was still open during the capture; a close is added so the next connection gets its own handle.')
      step(previousAt, { event: 'close' })
      syntheticCloses += 1
    }
  }

  body.push('')
  body.push('// Trailing pause so the last upload can finish.')
  body.push(JSON.stringify({ delayMs: options.trailingWaitMs ?? 500 }))

  const replaced = redactor === undefined ? {} : redactor.counts()
  const warnings = redactor === undefined ? [] : residualCheck(writtenStreams, redactor)

  const header = [
    `// Generated by ${options.tool} from a capture of ${options.instrument}.`,
    `// Capture started ${options.capturedAt.toISOString()}; ${order.length} connection(s), ${chunks} data step(s) (chunk boundaries preserved, as hex).`,
    '// delayMs is the gap since the previous line, in milliseconds, taken from the actual receive times. A server-mode plugin needs a connection step first.',
    ...(redactor === undefined
      ? ['// WARNING: not redacted. This file may contain personal data and must not be committed.']
      : [
          `// Personal data redacted (the same original always gets the same placeholder): ${redactor.kinds.map((kind) => `${kind} ${replaced[kind] ?? 0}`).join(', ')} distinct value(s). Every other byte is unchanged.`,
        ]),
    ...(serialized
      ? [
          '// WARNING: connections overlapped in the capture. The replay harness delivers bytes to the first open connection only,',
          `//   so the connections are replayed one after another (${syntheticCloses} close step(s) added); the gaps between connections are indicative only.`,
        ]
      : ['// Connections did not overlap; the capture is replayed on its real timeline.']),
    ...warnings.map((warning) => `// WARNING: ${warning}`),
    '// Review before committing: only the configured fields are redacted; personal data in other fields or outside any frame is not detected.',
  ]

  return {
    text: `${[...header, ...body].join('\n')}\n`,
    connections: order.length,
    chunks,
    serialized,
    syntheticCloses,
    replaced,
    warnings,
  }
}
