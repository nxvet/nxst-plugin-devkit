// The instrument simulator: plays an analyzer towards a real receiver (the SyncTool plugin
// listening on its port), sending messages captured from the real device and checking every ACK.
//
// What the analyzer means by its bytes (which message is QC, how an ACK is judged, which fields a
// resend renews, which fields hold personal data) is instrument semantics and comes from the
// `SimulatorProfile` the plugin supplies. This module owns the mechanics: loading messages,
// the interactive mode, the two connection models analyzers use, the send pipeline, ACK matching,
// timeouts, the per-message state, the summary and the exit code.
//
// `createSimulator` never touches `process`, never exits, never installs signal handlers and
// never creates a readline interface: it works through the `Io` object it is given, so a test can
// drive it in-process. `runSimulator` is the thin command-line wrapper that does all of that.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'
import type { Interface } from 'node:readline'

import { extractMllpFrames, field, findSegment, parseMessage } from '@nxvet/nxst-hl7-parser'

import type { Io, ParsedSimulatorArgs, SourceKind } from './cli.ts'
import { MAX_TIMER_MS, UsageError, createLogger, displayPath, isInside, parseSimulatorArgs } from './cli.ts'
import type { RewriteResult } from './edit.ts'
import { splitChunks, wrapFrame } from './edit.ts'
import type { Message, MessageSet } from './fixture.ts'
import { messagesFromFixture, messagesFromRawFiles } from './fixture.ts'
import type { MessageState } from './repl.ts'
import { describePatientIdOverride, describeState, formatTable, parseCommand, validatePatientId } from './repl.ts'

// ---------------------------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------------------------

/**
 * How the analyzer uses TCP.
 *
 * - `persistent`: it connects once (at power-on) and keeps the connection open, sending several
 *   messages on it; when the receiver closes it, it reconnects after `retryMs` (0 = never). The
 *   `n` / `c` / `k` commands open another connection, close or destroy the current one.
 * - `per-message`: it opens a connection for every result, sends after `preSendMs`, waits for the
 *   ACK and closes `closeAfterAckMs` later; while idle it probes the receiver every `probeMs`
 *   (connect, send nothing, close). A refused connection is a failed send, not retried.
 */
export type ConnectionModel =
  | { kind: 'persistent', retryMs: number }
  | { kind: 'per-message', probeMs: number, preSendMs: number, closeAfterAckMs: number }

/** What the simulator shows and expects for one message, as the plugin's own parser sees it. */
export interface Description {
  /** The message control id (MSH-10), used to match the ACK. Empty when the message has none. */
  controlId: string
  /** The instrument-specific columns of the message list (never personal data). */
  cells: string[]
  /** One line printed when the message is sent (never personal data). */
  summary: string
  /** False when the plugin would not acknowledge this message, so a timeout is not a failure. */
  ackExpected: boolean
  /** Optional key/value facts to count across the run and print in the summary. */
  tally?: Record<string, string>
}

/** The plugin's judgement of an ACK that was matched to a message it sent. */
export interface AckVerdict {
  /** MSA-1. */
  code: string
  /** Whether this ACK counts as the message being accepted (decides the exit code). */
  ok: boolean
  /** Lines to print under the ACK. */
  notes: string[]
  /** Lines to print as warnings under the ACK. */
  warnings: string[]
  /** Optional key/value facts to count across the run and print in the summary. */
  tally?: Record<string, string>
}

export interface SimulatorProfile {
  /** Display name of the analyzer. */
  name: string
  /** The prompt of the interactive mode, for example `egi> `. */
  prompt: string
  /** The plugin directory: the default source is `fixtures/session.jsonl` and the default output goes under `captures/`. */
  rootDir: string
  defaults: {
    port: number
    ackTimeoutMs: number
    /** 0 = write each frame in one piece. */
    chunkBytes: number
    gapMs: number
    chunkGapMs?: number
  }
  connection: ConnectionModel
  /** Headers of the instrument-specific columns returned in `Description.cells`. */
  menuColumns: string[]
  describe(bytes: Uint8Array, now: Date): Description
  /** The bytes to send for `r`: whatever the real analyzer changes when it resends a result. */
  resend(bytes: Uint8Array, now: Date): RewriteResult
  /** The bytes to send under `--fresh`: a new control id (not in `seen`) and timestamp. */
  fresh(bytes: Uint8Array, now: Date, seen: ReadonlySet<string>): RewriteResult
  /** The bytes with the patient id replaced (a message without a patient segment may be returned unchanged, with `skipped` saying why). */
  setPatientId(bytes: Uint8Array, id: string): RewriteResult
  /** Judges an ACK whose MSA-2 matched the control id of `sentBytes`. */
  evaluateAck(ackText: string, sentBytes: Uint8Array): AckVerdict
}

/** The options `createSimulator` runs with (see `parseSimulatorArgs` for the command-line form). */
export interface SimulatorOptions {
  host: string
  port: number
  /** A fixture (`.jsonl`), a directory of `raw-NNN.hl7` files, or one message file. */
  source: string
  /** Where `sent-NNN.hl7` and `simulate.log` are written. Created on `start()`. */
  outDir: string
  /** Pause between messages sent by one command; `undefined` replays the captured gaps. */
  gapMs: number | undefined
  ackTimeoutMs: number
  chunkBytes: number
  chunkGapMs: number
  /** Initial patient id override; the `id` command changes it. */
  patientId: string | undefined
  fresh: boolean
  holdSeconds: number
  /** Persistent model only. */
  retryMs: number
  /** Per-message model only. */
  probeMs: number
  preSendMs: number
  closeAfterAckMs: number
}

export interface SimulatorStats {
  /** Send attempts (including resends and attempts that could not connect). */
  sent: number
  /** Matched ACKs the profile accepted. */
  matchedOk: number
  /** Matched ACKs the profile did not accept. */
  matchedNotOk: number
  unmatched: number
  duplicate: number
  timedOut: number
  /** Timeouts of messages the plugin was not expected to acknowledge. */
  timedOutExpected: number
  lostOnClose: number
  connectFailed: number
  writeFailed: number
  nonAck: number
  /** Bytes received outside any MLLP frame. */
  discarded: number
  opened: number
  closedByPeer: number
  closedByUs: number
  closedWithError: number
  probes: number
  probeFailed: number
  probeBytesIn: number
  /** ACK codes seen, with counts. */
  codes: Record<string, number>
  /** Facts reported through `tally`, counted per key and value. */
  tally: Record<string, Record<string, number>>
}

export interface Summary {
  /** True when every message sent was acknowledged and accepted. */
  ok: boolean
  /** 0 when `ok`, 1 otherwise. */
  exitCode: number
  stats: SimulatorStats
}

export interface Simulator {
  /** Creates the output directory, prints the settings (and, on a terminal, the list), connects or starts probing. */
  start(): Promise<void>
  /** Prints the message list with the current state of each message. */
  list(): void
  /** Runs one command line. Returns `quit` when the operator asked to stop; call `finish()` then. */
  run(line: string): Promise<'continue' | 'quit'>
  /** Waits for in-flight ACKs, prints the summary, closes everything, stops every timer. Idempotent. */
  finish(): Promise<Summary>
  /** The readline interface whose prompt is redrawn after each output line (terminal mode). */
  attachPrompt(rl: Interface | undefined): void
  readonly stats: SimulatorStats
  readonly messages: readonly Message[]
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

interface Pending {
  seq: number
  index: number
  controlId: string
  bytes: Buffer
  info: Description
  sentAt: number
  timer: NodeJS.Timeout
}

interface Connection {
  id: number
  socket: net.Socket
  openedAt: number
  /** Bytes not yet forming a complete MLLP frame. */
  buffer: Buffer
  /** Messages sent on this connection and still waiting for an ACK, oldest first. */
  pending: Pending[]
  sent: number
  bytesIn: number
  localCloseAt: number | undefined
  localCloseReason: string | undefined
  peerEndAt: number | undefined
  /** Resolves when this connection is done with its message (per-message model). */
  done: Promise<void>
  settle: () => void
  settled: boolean
}

/** A receive buffer that still holds no complete frame beyond this size is dropped. */
const MAX_BUFFER_BYTES = 1024 * 1024

const pad3 = (n: number): string => String(n).padStart(3, '0')

const loadSource = (source: string): { set: MessageSet, kind: SourceKind } => {
  if (fs.existsSync(source) === false) throw new Error(`source not found: ${source}`)

  if (fs.statSync(source).isDirectory()) {
    const files = fs.readdirSync(source)
      .filter((name) => /^raw-\d+\.hl7$/.test(name))
      .map((name) => ({ name, bytes: fs.readFileSync(path.join(source, name)) }))

    if (files.length === 0) throw new Error(`no raw-NNN.hl7 files in ${source}`)

    return { set: messagesFromRawFiles(files), kind: 'directory' }
  }

  if (source.endsWith('.jsonl')) return { set: messagesFromFixture(fs.readFileSync(source, 'utf-8')), kind: 'fixture' }

  return { set: messagesFromRawFiles([{ name: path.basename(source), bytes: fs.readFileSync(source) }]), kind: 'file' }
}

const emptyStats = (): SimulatorStats => ({
  sent: 0,
  matchedOk: 0,
  matchedNotOk: 0,
  unmatched: 0,
  duplicate: 0,
  timedOut: 0,
  timedOutExpected: 0,
  lostOnClose: 0,
  connectFailed: 0,
  writeFailed: 0,
  nonAck: 0,
  discarded: 0,
  opened: 0,
  closedByPeer: 0,
  closedByUs: 0,
  closedWithError: 0,
  probes: 0,
  probeFailed: 0,
  probeBytesIn: 0,
  codes: {},
  tally: {},
})

const count = (record: Record<string, number>, key: string): void => {
  record[key] = (record[key] ?? 0) + 1
}

/** `AA×5, AE×1` for a count record. */
const counted = (record: Record<string, number>): string => {
  const entries = Object.entries(record)

  return entries.length === 0 ? 'none' : entries.map(([key, value]) => `${key || '(empty)'}×${value}`).join(', ')
}

export const createSimulator = (profile: SimulatorProfile, options: SimulatorOptions, io: Io): Simulator => {
  const clock = (): Date => io.now?.() ?? new Date()
  const nowMs = (): number => clock().getTime()
  const logger = createLogger(io)
  const { say } = logger
  const model = profile.connection
  const { set: source, kind: sourceKind } = loadSource(options.source)
  const messages = source.messages

  if (messages.length === 0) throw new Error(`no complete MLLP frame in ${options.source}`)

  const startedAt = clock()
  const descriptions = messages.map((message) => profile.describe(message.bytes, startedAt))
  const states: MessageState[] = messages.map(() => ({ sent: 0, pending: 0, timedOut: 0, connectFailed: 0 }))
  const seenControlIds = new Set<string>(descriptions.map((description) => description.controlId).filter((id) => id !== ''))
  const ackedControlIds = new Set<string>()
  const stats = emptyStats()
  const connections = new Map<number, Connection>()
  const probeSockets = new Set<net.Socket>()
  const timers = new Set<NodeJS.Timeout>()
  const sleepers = new Set<() => void>()

  let patientIdOverride = options.patientId
  let connectionCount = 0
  let probeCount = 0
  let current: Connection | undefined
  let connecting: Promise<Connection | undefined> | undefined
  let reconnectTimer: NodeJS.Timeout | undefined
  let probeTimer: NodeJS.Timeout | undefined
  let stopping = false
  let sentCount = 0
  let cursor = 0
  let lastSent: { bytes: Buffer, index: number } | undefined
  let finishing: Promise<Summary> | undefined

  const describeTarget = `${options.host}:${options.port}`

  /** A pause that `finish()` can cut short, so nothing waits on a cleared timer. */
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      sleepers.delete(wake)
      resolve()
    }, Math.min(ms, MAX_TIMER_MS))
    const wake = (): void => {
      clearTimeout(timer)
      timers.delete(timer)
      resolve()
    }

    timers.add(timer)
    sleepers.add(wake)
  })

  const track = (timer: NodeJS.Timeout): NodeJS.Timeout => {
    timers.add(timer)

    return timer
  }

  const untrack = (timer: NodeJS.Timeout): void => {
    clearTimeout(timer)
    timers.delete(timer)
  }

  const tally = (facts: Record<string, string> | undefined): void => {
    for (const [key, value] of Object.entries(facts ?? {})) {
      stats.tally[key] ??= {}
      count(stats.tally[key], value)
    }
  }

  const pendingTotal = (): number => [...connections.values()].reduce((sum, conn) => sum + conn.pending.length, 0)

  // ----------------------------------------------------------------------------------------
  // List
  // ----------------------------------------------------------------------------------------

  const list = (): void => {
    const at = nowMs()
    const rows = messages.map((message, i) => [
      String(message.index),
      ...descriptions[i].cells,
      `${message.bytes.length} B`,
      describeState(states[i], at),
    ])

    say(`Source ${displayPath(profile.rootDir, options.source)} (${sourceKind}): ${messages.length} message(s), ${source.connections} connection(s)`)

    for (const line of formatTable(['#', ...profile.menuColumns, 'size', 'status'], rows)) say(`  ${line}`)

    say(`  ${describePatientIdOverride(patientIdOverride)}`)

    if (options.gapMs === undefined) {
      say(`  (--gap real: gaps from the capture: ${messages.map((message) => `#${message.index} +${message.delayMs} ms`).join(', ')})`)
    }

    for (const entry of source.discarded) say(`  ! connection #${entry.connection} had ${entry.bytes} byte(s) outside any frame (dropped; content not shown)`)
    for (const entry of source.incomplete) say(`  ! connection #${entry.connection} ended with an incomplete frame of ${entry.bytes} byte(s) (not sent)`)

    if (options.gapMs === undefined && messages.every((message) => message.delayMs === 0)) {
      say('  ! --gap real, but the source carries no timing (raw files): messages will be sent back to back')
    }
  }

  // ----------------------------------------------------------------------------------------
  // Connections
  // ----------------------------------------------------------------------------------------

  const pickCurrent = (): void => {
    const candidates = [...connections.values()].filter((conn) => conn.localCloseAt === undefined)

    current = candidates.length === 0 ? undefined : candidates[candidates.length - 1]
  }

  const settle = (conn: Connection): void => {
    if (conn.settled) return

    conn.settled = true
    conn.settle()
  }

  const dropPending = (conn: Connection): void => {
    for (const entry of conn.pending) {
      untrack(entry.timer)
      states[entry.index - 1].pending -= 1
      stats.lostOnClose += 1
      say(`  ! sent-${pad3(entry.seq)} (control id ${JSON.stringify(entry.controlId)}) was still waiting for an ACK when connection #${conn.id} closed`)
    }

    conn.pending = []
  }

  const scheduleReconnect = (): void => {
    if (stopping || model.kind !== 'persistent' || options.retryMs === 0 || reconnectTimer !== undefined) return

    // Only when nothing else is open: a connection opened with `n` and closed by the receiver
    // must not spawn a replacement, or the number of connections would only ever grow.
    if ([...connections.values()].some((conn) => conn.localCloseAt === undefined)) return

    say(`  reconnecting in ${options.retryMs} ms (the analyzer opens a new connection after the receiver closed one)`)
    reconnectTimer = track(setTimeout(() => {
      timers.delete(reconnectTimer as NodeJS.Timeout)
      reconnectTimer = undefined
      void connect().catch((error: unknown) => { say(`  ! reconnect failed: ${(error as Error).message}`) })
    }, options.retryMs))
  }

  const closeAfterAck = (conn: Connection): void => {
    const timer = track(setTimeout(() => {
      timers.delete(timer)

      if (conn.socket.destroyed || conn.socket.writableEnded) return

      conn.localCloseAt = nowMs()
      conn.localCloseReason = `${options.closeAfterAckMs} ms after the ACK`
      conn.socket.end()

      // Do not let the connection linger if the receiver never answers the FIN.
      const guard = track(setTimeout(() => {
        timers.delete(guard)

        if (conn.socket.destroyed === false) conn.socket.destroy()
      }, 2000))

      guard.unref()
    }, options.closeAfterAckMs))
  }

  const onFrame = (conn: Connection, text: string): void => {
    const at = nowMs()
    const segments = parseMessage(text)
    const msh = findSegment(segments, 'MSH')
    const msa = findSegment(segments, 'MSA')
    const type = field(msh, 9).trim()
    const msa2 = field(msa, 2).trim()

    if (type.startsWith('ACK') === false || msa === undefined) {
      stats.nonAck += 1
      say(`  ! connection #${conn.id} received a frame that is not an ACK (type ${JSON.stringify(type)}, control id ${JSON.stringify(field(msh, 10).trim())}, ${Buffer.byteLength(text, 'utf-8')} bytes); the analyzer would not answer it, nor does the simulator`)
      return
    }

    // Matched by MSA-2, oldest first: a resend in flight shares its control id with the original.
    const index = conn.pending.findIndex((entry) => entry.controlId === msa2)

    if (index === -1) {
      if (ackedControlIds.has(msa2)) {
        stats.duplicate += 1
        say(`  ! connection #${conn.id} received a duplicate ACK (MSA-2 ${JSON.stringify(msa2)} was already matched)`)
      } else {
        stats.unmatched += 1
        say(`  ! connection #${conn.id} received an ACK that matches nothing in flight (MSA-2 ${JSON.stringify(msa2)})`)
      }

      return
    }

    const [entry] = conn.pending.splice(index, 1)

    untrack(entry.timer)
    ackedControlIds.add(msa2)

    const verdict = profile.evaluateAck(text, entry.bytes)
    const state = states[entry.index - 1]

    state.pending -= 1
    state.lastAck = { code: verdict.code, atMs: at }
    count(stats.codes, verdict.code)

    if (verdict.ok) stats.matchedOk += 1
    else stats.matchedNotOk += 1

    tally(verdict.tally)

    say(`  ← connection #${conn.id}: ACK ${verdict.code || '(no code)'} for sent-${pad3(entry.seq)} (MSA-2 matched, ${at - entry.sentAt} ms${verdict.ok ? '' : ', not accepted'})`)

    for (const note of verdict.notes) say(`    ${note}`)
    for (const warning of verdict.warnings) say(`    ! ${warning}`)

    if (model.kind === 'per-message') {
      closeAfterAck(conn)
      settle(conn)
    }
  }

  const onChunk = (conn: Connection, chunk: Buffer): void => {
    conn.bytesIn += chunk.length

    const { frames, rest, discarded } = extractMllpFrames(Buffer.concat([conn.buffer, chunk]))

    conn.buffer = rest

    if (discarded > 0) {
      stats.discarded += discarded
      say(`  ! connection #${conn.id} received ${discarded} byte(s) outside any MLLP frame (content not shown; not answered)`)
    }

    if (conn.buffer.length > MAX_BUFFER_BYTES) {
      say(`  ! connection #${conn.id} buffered ${conn.buffer.length} bytes without a complete frame; dropping them`)
      conn.buffer = Buffer.alloc(0)
    }

    for (const frame of frames) onFrame(conn, frame)
  }

  /** One connection attempt; resolves `undefined` when the receiver could not be reached. */
  const openConnection = (): Promise<Connection | undefined> => new Promise((resolve) => {
    const socket = net.createConnection({ host: options.host, port: options.port })
    let connected = false

    socket.once('connect', () => {
      connected = true
      connectionCount += 1
      stats.opened += 1

      let settleDone: () => void = () => {}
      const done = new Promise<void>((resolveDone) => { settleDone = resolveDone })
      const conn: Connection = {
        id: connectionCount,
        socket,
        openedAt: nowMs(),
        buffer: Buffer.alloc(0),
        pending: [],
        sent: 0,
        bytesIn: 0,
        localCloseAt: undefined,
        localCloseReason: undefined,
        peerEndAt: undefined,
        done,
        settle: settleDone,
        settled: false,
      }

      // Pieces written close together would otherwise be coalesced into one segment.
      if (options.chunkBytes > 0) socket.setNoDelay(true)

      connections.set(conn.id, conn)
      current = conn
      say(`▶ connection #${conn.id} open to ${describeTarget} (local ${socket.localAddress}:${socket.localPort}; ${connections.size} open)`
        + (model.kind === 'persistent' && connections.size === 1 ? '; idle until a command sends something, as the analyzer is after power-on' : ''))

      socket.on('data', (chunk: Buffer) => { onChunk(conn, chunk) })

      socket.on('end', () => {
        conn.peerEndAt = nowMs()
        say(conn.localCloseAt === undefined
          ? `◀ connection #${conn.id}: the receiver sent FIN first`
          : `◀ connection #${conn.id}: the receiver answered our FIN`)
      })

      socket.on('error', (error: NodeJS.ErrnoException) => {
        say(`✗ connection #${conn.id} error: ${error.code ?? ''} ${error.message}`)
      })

      socket.on('close', (hadError: boolean) => {
        const at = nowMs()
        const byUs = conn.localCloseAt !== undefined && (conn.peerEndAt === undefined || conn.localCloseAt <= conn.peerEndAt)

        connections.delete(conn.id)

        if (byUs) stats.closedByUs += 1
        else if (hadError) stats.closedWithError += 1
        else stats.closedByPeer += 1

        say(`◀ connection #${conn.id} closed (${byUs ? `by us, ${conn.localCloseReason ?? ''}` : hadError ? 'with an error' : 'by the receiver'}; `
          + `open for ${((at - conn.openedAt) / 1000).toFixed(1)} s, ${conn.sent} message(s) sent, ${conn.bytesIn} bytes received; ${connections.size} still open)`)

        dropPending(conn)
        settle(conn)

        if (current === conn) pickCurrent()
        if (byUs === false) scheduleReconnect()
      })

      resolve(conn)
    })

    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (connected) return

      socket.destroy()
      say(`✗ could not connect to ${describeTarget}: ${error.code ?? ''} ${error.message} (is the receiver listening on that port?)`)
      resolve(undefined)
    })
  })

  /** Persistent model: keeps trying every `retryMs` until connected or stopped. */
  const connect = async (): Promise<Connection | undefined> => {
    if (connecting !== undefined) return connecting

    connecting = (async () => {
      try {
        for (;;) {
          if (stopping) return undefined

          const conn = await openConnection()

          if (conn !== undefined || options.retryMs === 0) return conn

          say(`  retrying in ${options.retryMs} ms`)
          await sleep(options.retryMs)
        }
      } finally {
        connecting = undefined
      }
    })()

    return connecting
  }

  const ensureConnection = async (): Promise<Connection | undefined> => {
    if (model.kind === 'per-message') return openConnection()

    if (current !== undefined && current.socket.destroyed === false && current.socket.writableEnded === false) return current

    return connect()
  }

  // ----------------------------------------------------------------------------------------
  // Probes (per-message model)
  // ----------------------------------------------------------------------------------------

  const probe = (): void => {
    if (stopping || options.probeMs === 0) return

    probeCount += 1

    const n = probeCount
    const socket = net.createConnection({ host: options.host, port: options.port })
    let connected = false

    probeSockets.add(socket)

    socket.once('connect', () => {
      connected = true
      stats.probes += 1
      socket.end()
      say(`· probe #${n}: connected to ${describeTarget} and closed (0 bytes)`)
    })

    socket.on('data', (chunk: Buffer) => {
      stats.probeBytesIn += chunk.length
      say(`  ! probe #${n} received ${chunk.length} byte(s); the receiver should send nothing on a probe`)
    })

    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (connected) {
        say(`  ! probe #${n}: error while closing: ${error.code ?? ''} ${error.message}`)
        return
      }

      stats.probeFailed += 1
      socket.destroy()
      say(`· probe #${n}: could not connect to ${describeTarget} (${error.code ?? error.message}); the analyzer keeps probing`)
    })

    socket.on('close', () => { probeSockets.delete(socket) })

    const guard = track(setTimeout(() => {
      timers.delete(guard)

      if (socket.destroyed === false) socket.destroy()
    }, 2000))

    guard.unref()
  }

  const startProbing = (): void => {
    if (options.probeMs === 0) return

    probe()
    probeTimer = setInterval(probe, options.probeMs)
  }

  // ----------------------------------------------------------------------------------------
  // Sending
  // ----------------------------------------------------------------------------------------

  const writeAll = (socket: net.Socket, chunk: Buffer): Promise<void> => new Promise((resolve, reject) => {
    socket.write(chunk, (error) => { if (error === undefined || error === null) resolve(); else reject(error) })
  })

  const noteConnectFailure = (index: number, reason: string): void => {
    const state = states[index - 1]

    state.sent += 1
    state.connectFailed += 1
    stats.sent += 1
    stats.connectFailed += 1
    say(`  ✗ message #${index} not sent: ${reason}`)
  }

  const send = async (bytes: Buffer, index: number, mode: 'normal' | 'resend', patientId?: string): Promise<void> => {
    const state = states[index - 1]
    const conn = await ensureConnection()

    if (conn === undefined) {
      noteConnectFailure(index, `could not connect to ${describeTarget}${model.kind === 'per-message' ? ' (the analyzer does not retry a result)' : ''}`)
      return
    }

    if (model.kind === 'per-message' && options.preSendMs > 0) await sleep(options.preSendMs)

    if (conn.socket.destroyed || conn.socket.writableEnded) {
      noteConnectFailure(index, `connection #${conn.id} closed before anything was sent`)
      return
    }

    const now = clock()
    const applied: string[] = []
    const skipped: string[] = []
    let working: Buffer = Buffer.from(bytes)

    const take = (result: RewriteResult): void => {
      working = result.bytes
      applied.push(...result.applied)
      skipped.push(...result.skipped.map((entry) => `${entry.name} (${entry.reason})`))
    }

    if (mode === 'resend') {
      take(profile.resend(working, now))
    } else {
      const id = patientId ?? patientIdOverride

      if (id !== undefined) take(profile.setPatientId(working, id))
      if (options.fresh) take(profile.fresh(working, now, seenControlIds))
    }

    const info = profile.describe(working, now)
    const ackExpected = info.ackExpected && info.controlId !== ''

    if (info.controlId !== '') seenControlIds.add(info.controlId)

    sentCount += 1
    stats.sent += 1
    state.sent += 1
    state.pending += 1
    conn.sent += 1

    const seq = sentCount
    const file = path.join(options.outDir, `sent-${pad3(seq)}.hl7`)

    fs.writeFileSync(file, working)

    say(`→ connection #${conn.id}: sending #${index}${mode === 'resend' ? ' again (resend)' : ''} as ${displayPath(profile.rootDir, file)} (${working.length} bytes): ${info.summary}`)

    if (applied.length > 0 || skipped.length > 0) {
      say(`    rewrote ${applied.length > 0 ? applied.join(', ') : 'nothing'}${skipped.length > 0 ? `; skipped ${skipped.join(', ')}` : ''}`)
    }

    if (ackExpected === false) say('    no ACK is expected for this message; a timeout will not count as a failure')

    const frame = wrapFrame(working)
    const chunks = splitChunks(frame, options.chunkBytes)
    const sentAt = nowMs()
    const entry: Pending = {
      seq,
      index,
      controlId: info.controlId,
      bytes: working,
      info,
      sentAt,
      timer: track(setTimeout(() => {
        timers.delete(entry.timer)

        const at = conn.pending.indexOf(entry)

        if (at === -1) return

        conn.pending.splice(at, 1)
        state.pending -= 1
        state.timedOut += 1

        if (ackExpected) {
          stats.timedOut += 1
          say(`  ⏱ sent-${pad3(seq)} (control id ${JSON.stringify(info.controlId)}): no ACK within ${options.ackTimeoutMs} ms; not resent`)
        } else {
          stats.timedOutExpected += 1
          say(`  ⏱ sent-${pad3(seq)} (control id ${JSON.stringify(info.controlId)}): no ACK within ${options.ackTimeoutMs} ms, as expected for this message; not resent`)
        }

        if (model.kind === 'per-message') {
          conn.localCloseAt = nowMs()
          conn.localCloseReason = 'ACK timeout'
          conn.socket.destroy()
          settle(conn)
        }
      }, options.ackTimeoutMs)),
    }

    conn.pending.push(entry)
    lastSent = { bytes: working, index }

    try {
      for (const [i, chunk] of chunks.entries()) {
        if (i > 0 && options.chunkGapMs > 0) await sleep(options.chunkGapMs)

        await writeAll(conn.socket, chunk)
      }

      if (chunks.length > 1) say(`    written in ${chunks.length} pieces (${chunks.map((chunk) => chunk.length).join(' + ')} bytes, ${options.chunkGapMs} ms apart); whether they arrive separately depends on the network`)
    } catch (error) {
      stats.writeFailed += 1
      say(`  ✗ sent-${pad3(seq)}: write failed: ${(error as Error).message}`)
    }

    // One result per connection: the next message waits until this one is acknowledged, timed out or closed.
    if (model.kind === 'per-message') await conn.done
  }

  const sendIndex = async (index: number, patientId?: string): Promise<void> => {
    const message = messages[index - 1]

    if (message === undefined) {
      say(`  ✗ there is no message #${index} (the list has ${messages.length})`)
      return
    }

    await send(message.bytes, index, 'normal', patientId)
    cursor = index
  }

  const sendSequence = async (indexes: readonly number[], patientId?: string): Promise<void> => {
    for (const [i, index] of indexes.entries()) {
      if (stopping) break

      if (i > 0) {
        const gap = options.gapMs ?? (messages[index - 1]?.delayMs ?? 0)

        if (gap > 0) await sleep(gap)
      }

      await sendIndex(index, patientId)
    }
  }

  const sendRemaining = async (patientId?: string): Promise<void> => {
    if (cursor >= messages.length) {
      say(`  (all ${messages.length} messages have been sent; type a number to send one again, or r to resend the last one)`)
      return
    }

    const remaining = messages.slice(cursor)

    say(`  sending the remaining ${remaining.length} message(s), #${remaining[0].index} to #${remaining[remaining.length - 1].index}, ${options.gapMs === undefined ? 'with the captured gaps' : `${options.gapMs} ms apart`}`)
    await sendSequence(remaining.map((message) => message.index), patientId)
  }

  /** Rejects an invalid `id=` / `id` value with a message; `undefined` means no override was asked for. */
  const acceptPatientId = (value: string | undefined, consequence: string): boolean => {
    if (value === undefined) return true

    const problem = validatePatientId(value)

    if (problem === undefined) return true

    say(`  ✗ ${problem}: ${JSON.stringify(value)} (${consequence})`)

    return false
  }

  // ----------------------------------------------------------------------------------------
  // Commands
  // ----------------------------------------------------------------------------------------

  const notAvailable = (): void => {
    say('  (not available for the per-message connection model: the analyzer opens one connection per result and closes it itself)')
  }

  const help = (): string => [
    '  <n> [<n> ...]  send those messages (for example 3, or 3 5 8); each waits for its ACK in the per-message model',
    '  s [n]          send the next message, or message n',
    '  a              send every message not yet sent',
    '  r              resend the last message the way the analyzer would',
    '  ... id=<value> apply a patient id to that command only (for example 3 id=A123)',
    '  id <value>     set the patient id for every later send; id shows it; id - clears it',
    '  l              print the message list again',
    ...(model.kind === 'persistent'
      ? ['  n              open another connection (the old one stays open)', '  c              close the current connection (FIN)', '  k              destroy the current connection']
      : ['  n / c / k      not available: one connection per result']),
    '  w <ms>         wait (useful when commands are piped)',
    '  q              finish: wait for ACKs in flight, print the summary, close everything',
  ].join('\n')

  const run = async (line: string): Promise<'continue' | 'quit'> => {
    const command = parseCommand(line)

    switch (command.kind) {
      case 'noop':
        return 'continue'
      case 'help':
        io.stdout.write(`${help()}\n`)
        return 'continue'
      case 'list':
        list()
        return 'continue'
      case 'send': {
        const missing = command.indexes.filter((index) => index > messages.length)

        if (missing.length > 0) {
          say(`  ✗ there is no message #${missing.join(', #')} (the list has 1 to ${messages.length})`)
          return 'continue'
        }

        if (acceptPatientId(command.patientId, 'nothing sent') === false) return 'continue'

        await sendSequence(command.indexes, command.patientId)
        return 'continue'
      }
      case 'send-next':
        if (cursor >= messages.length) {
          say(`  (all ${messages.length} messages have been sent; type a number to send one again, or r to resend the last one)`)
          return 'continue'
        }

        if (acceptPatientId(command.patientId, 'nothing sent') === false) return 'continue'

        await sendIndex(cursor + 1, command.patientId)
        return 'continue'
      case 'all':
        if (acceptPatientId(command.patientId, 'nothing sent') === false) return 'continue'

        await sendRemaining(command.patientId)
        return 'continue'
      case 'resend':
        if (lastSent === undefined) {
          say('  ✗ nothing has been sent yet, so there is nothing to resend')
          return 'continue'
        }

        await send(lastSent.bytes, lastSent.index, 'resend')
        return 'continue'
      case 'set-id':
        if (acceptPatientId(command.patientId, 'override unchanged') === false) return 'continue'

        patientIdOverride = command.patientId
        say(command.patientId === undefined
          ? '  patient id override cleared: later sends use the ids from the source'
          : `  later sends will carry patient id ${JSON.stringify(command.patientId)} (messages without a patient segment are left as they are; "id -" clears it)`)
        return 'continue'
      case 'show-id':
        say(`  ${describePatientIdOverride(patientIdOverride)}`)
        return 'continue'
      case 'connect':
        if (model.kind !== 'persistent') {
          notAvailable()
          return 'continue'
        }

        await connect()
        return 'continue'
      case 'close':
      case 'destroy': {
        if (model.kind !== 'persistent') {
          notAvailable()
          return 'continue'
        }

        if (current === undefined) {
          say('  (no connection is open)')
          return 'continue'
        }

        const conn = current

        conn.localCloseAt = nowMs()
        conn.localCloseReason = command.kind === 'close' ? 'closed by the operator (FIN)' : 'destroyed by the operator'
        say(`  ✂ connection #${conn.id} ${command.kind === 'close' ? 'closing (FIN)' : 'destroyed'}${conn.pending.length > 0 ? `; ${conn.pending.length} message(s) still waiting for an ACK` : ''}`)

        if (command.kind === 'close') conn.socket.end()
        else conn.socket.destroy()

        pickCurrent()
        return 'continue'
      }
      case 'wait':
        await sleep(command.ms)
        return 'continue'
      case 'quit':
        return 'quit'
      default:
        say(`  ✗ unknown command ${JSON.stringify(command.input)} (type a message number to send it; h for help)`)
        return 'continue'
    }
  }

  // ----------------------------------------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------------------------------------

  const start = async (): Promise<void> => {
    fs.mkdirSync(options.outDir, { recursive: true })
    logger.setLogFile(path.join(options.outDir, 'simulate.log'))

    say(`${profile.name} simulator: ${messages.length} message(s) from ${displayPath(profile.rootDir, options.source)} (${sourceKind}); output in ${displayPath(profile.rootDir, options.outDir)}`)

    if (isInside(path.join(profile.rootDir, 'captures'), options.outDir) === false) {
      say('! the output directory is not under captures/ of the plugin: sent-NNN.hl7 holds the bytes actually sent (personal data when the source is a real capture); make sure it is not committed')
    }

    say(`Settings: receiver ${describeTarget}; ${model.kind === 'persistent'
      ? `persistent connection, ${options.retryMs === 0 ? 'no reconnect' : `reconnect after ${options.retryMs} ms`}`
      : `one connection per result, ${options.probeMs === 0 ? 'no probes' : `probe every ${options.probeMs} ms`}, send ${options.preSendMs} ms after connecting, close ${options.closeAfterAckMs} ms after the ACK`}; `
      + `ACK timeout ${options.ackTimeoutMs} ms (no resend); gap ${options.gapMs === undefined ? 'as captured' : `${options.gapMs} ms`}; `
      + `${options.chunkBytes > 0 ? `frames written in ${options.chunkBytes}-byte pieces ${options.chunkGapMs} ms apart` : 'frames written whole'}; `
      + `${options.fresh ? 'fresh control id and timestamp on every send' : 'control ids and timestamps as in the source'}; `
      + `${patientIdOverride === undefined ? 'patient ids as in the source' : `patient id ${JSON.stringify(patientIdOverride)}`}`)

    if (io.isTTY) {
      say('')
      list()
      say('')
      say('Type a message number to send it (3, or 3 5 8 in turn); id <value> sets the patient id (3 id=A123 for one send); a sends the rest, r resends the last, l lists, h helps, q quits.')
    }

    if (model.kind === 'persistent') await connect()
    else startProbing()
  }

  const waitForPending = async (): Promise<void> => {
    const deadline = nowMs() + options.ackTimeoutMs

    while (pendingTotal() > 0 && nowMs() < deadline) await sleep(50)
  }

  const finish = (): Promise<Summary> => {
    finishing ??= (async () => {
      stopping = true

      if (reconnectTimer !== undefined) {
        untrack(reconnectTimer)
        reconnectTimer = undefined
      }

      if (probeTimer !== undefined) {
        clearInterval(probeTimer)
        probeTimer = undefined
      }

      for (const socket of probeSockets) socket.destroy()

      const inFlight = pendingTotal()

      if (inFlight > 0) {
        say(`  waiting for ${inFlight} ACK(s) in flight (up to ${options.ackTimeoutMs} ms)`)
        await waitForPending()
      }

      if (options.holdSeconds > 0) {
        say(`  --hold: keeping ${connections.size} connection(s) open for ${options.holdSeconds} s`)
        await sleep(options.holdSeconds * 1000)
      }

      const at = nowMs()
      const ok = stats.sent === stats.matchedOk + stats.timedOutExpected && stats.connectFailed === 0 && stats.writeFailed === 0

      say('')
      say('== Summary ==')
      say(`connections: ${stats.opened} opened; closed by us ${stats.closedByUs}, by the receiver ${stats.closedByPeer}, with an error ${stats.closedWithError}; ${connections.size} still open`)

      if (model.kind === 'per-message') {
        say(`probes: ${options.probeMs === 0 ? 'off' : `every ${options.probeMs} ms`}; connected ${stats.probes}, refused ${stats.probeFailed}${stats.probeBytesIn > 0 ? `, ! ${stats.probeBytesIn} byte(s) received on probes` : ''}`)
      }

      say(`sent ${stats.sent}: accepted ${stats.matchedOk}, not accepted ${stats.matchedNotOk}, timed out ${stats.timedOut}${stats.timedOutExpected > 0 ? ` (plus ${stats.timedOutExpected} expected)` : ''}, `
        + `could not connect ${stats.connectFailed}, lost on close ${stats.lostOnClose}, write failed ${stats.writeFailed}`)
      say(`received: unmatched ACKs ${stats.unmatched}, duplicate ACKs ${stats.duplicate}, frames that were not ACKs ${stats.nonAck}, bytes outside frames ${stats.discarded}`)
      say(`ACK codes: ${counted(stats.codes)}`)

      for (const [key, values] of Object.entries(stats.tally)) say(`${key}: ${counted(values)}`)

      for (const conn of connections.values()) {
        say(`  connection #${conn.id} still open: ${((at - conn.openedAt) / 1000).toFixed(1)} s, ${conn.sent} message(s) sent, ${conn.bytesIn} bytes received${conn.pending.length > 0 ? ', still waiting for an ACK' : ''}`)
      }

      say(`result: ${ok ? 'OK, every message was acknowledged and accepted' : 'FAILED, at least one message was not acknowledged and accepted'} (exit ${ok ? 0 : 1})`)

      for (const conn of connections.values()) {
        conn.localCloseAt ??= at
        conn.localCloseReason ??= 'finished'
        dropPending(conn)
        conn.socket.destroy()
        settle(conn)
      }

      for (const timer of timers) clearTimeout(timer)

      timers.clear()

      for (const wake of sleepers) wake()

      sleepers.clear()

      return { ok, exitCode: ok ? 0 : 1, stats }
    })()

    return finishing
  }

  return {
    start,
    list,
    run,
    finish,
    attachPrompt: (rl) => { logger.attachPrompt(rl) },
    stats,
    messages,
  }
}

// ---------------------------------------------------------------------------------------------
// Command-line wrapper
// ---------------------------------------------------------------------------------------------

/**
 * Runs the simulator as a command-line tool: parses `argv`, reads commands from stdin (a prompt on
 * a terminal, one command per line when piped), and exits with the summary's exit code. Exit
 * codes: 0 every message accepted; 1 otherwise; 2 usage error; 130 interrupted twice.
 */
export const runSimulator = async (profile: SimulatorProfile, argv: readonly string[] = process.argv.slice(2)): Promise<never> => {
  const io: Io = {
    stdout: process.stdout,
    stderr: process.stderr,
    input: process.stdin,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
  }

  let parsed: ParsedSimulatorArgs

  try {
    parsed = parseSimulatorArgs(profile, argv)
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${error.usage}\n`)
      process.exit(2)
    }

    throw error
  }

  if (parsed.kind === 'help') {
    process.stdout.write(`${parsed.usage}\n`)
    process.exit(0)
  }

  let simulator: Simulator

  try {
    simulator = createSimulator(profile, parsed.options, io)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exit(1)
  }

  if (parsed.list) {
    simulator.list()
    process.exit(0)
  }

  const rl = readline.createInterface({ input: process.stdin, output: io.isTTY ? process.stdout : undefined, terminal: io.isTTY, prompt: profile.prompt })

  simulator.attachPrompt(io.isTTY ? rl : undefined)

  let queue: Promise<void> = Promise.resolve()
  let quitting = false

  const exit = async (): Promise<void> => {
    quitting = true

    const summary = await simulator.finish()

    rl.close()
    process.exit(summary.exitCode)
  }

  const enqueue = (line: string): void => {
    queue = queue
      .then(async () => {
        if (quitting) return

        const outcome = await simulator.run(line)

        if (outcome === 'quit') await exit()
        else if (io.isTTY) rl.prompt()
      })
      .catch((error: unknown) => { process.stderr.write(`command failed: ${(error as Error).message}\n`) })
  }

  rl.on('line', enqueue)
  // End of input (pipe exhausted, or Ctrl-D) is an implicit quit.
  rl.on('close', () => { if (quitting === false) enqueue('q') })
  // On a terminal readline swallows Ctrl-C and emits this instead.
  rl.on('SIGINT', () => { enqueue('q') })

  let interrupts = 0

  process.on('SIGINT', () => {
    interrupts += 1

    if (interrupts >= 2) process.exit(130)

    enqueue('q')
  })
  process.on('SIGTERM', () => { enqueue('q') })

  await simulator.start()

  if (io.isTTY) rl.prompt()

  return new Promise<never>(() => {})
}
