// The live-capture server: listens like the receiver, records every byte a real analyzer sends,
// answers with the plugin's own ACK, and turns the session into a replay fixture when stopped.
//
// It exists because the SDK's replay harness never really listens: to learn what an analyzer
// actually does (how it frames, when it closes, what it does without an ACK), something must open
// a real port and keep the raw bytes. The parsing and the ACK come from the plugin through the
// `CaptureProfile`, so what is verified is the code that ships. This module owns the mechanics:
// the server, per-connection buffers, byte-exact raw files, the capture log, the ACK schedule and
// its deliberate deviations (`--no-ack`, `--ack-code`, `--ack-delay`, `--close-after-ack`),
// resend detection, the summary, and the fixture with redaction.
//
// `createCapture` never touches `process`, never exits and never installs signal handlers.
// `runCapture` is the thin command-line wrapper.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { extractMllpFrameBytes, parseMessage, wrapMllp } from '@nxvet/nxst-hl7-parser'

import type { Io, ParsedCaptureArgs } from './cli.ts'
import { MAX_TIMER_MS, UsageError, createLogger, displayPath, isInside, parseCaptureArgs } from './cli.ts'
import type { CaptureEvent, FixtureResult } from './fixture.ts'
import { buildFixture } from './fixture.ts'
import type { RedactionSpec } from './redact.ts'
import { createRedactor } from './redact.ts'

// ---------------------------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------------------------

/** What the plugin made of one captured frame. */
export interface FrameVerdict {
  /** The message control id (MSH-10), used for resend detection and in the log. Empty when absent. */
  controlId: string
  /** One line describing the outcome (would upload N items, skipped and why); never personal data. */
  summary: string
  /** A hash of the payload the plugin would upload, so a resend can be compared; omit when nothing would be uploaded. */
  payloadHash?: string
  /** The ACK the plugin would send, or `null` when it would not answer this message at all. */
  ack: { code: string, text: string } | null
  /** Optional key/value facts to count across the capture and print in the summary. */
  tally?: Record<string, string>
}

export interface AckContext {
  /** Sequence number of this ACK within the capture (1-based), for ACKs that carry their own id. */
  sequence: number
  /** The MSA-1 code to send: the plugin's own, or the one forced by `--ack-code`. */
  code: string
  /** The profile's own switches that were given on the command line. */
  switches: ReadonlySet<string>
}

export interface CaptureProfile {
  /** Display name of the analyzer; also written into the fixture header. */
  name: string
  /** The plugin directory: default output goes under `captures/`. */
  rootDir: string
  defaults: { port: number }
  /** Which fields of the captured messages hold personal data, for the fixture. */
  redaction: RedactionSpec
  /** The MSA-1 codes `--ack-code` may force. */
  ackCodes: readonly string[]
  /** Extra command-line switches the profile understands (flag to help text), passed to `buildAck`. */
  switches?: Record<string, string>
  /**
   * Parses one frame with the plugin's own code and prints whatever the operator needs to see
   * about it (the real values of fields the documentation leaves open, for example). Must not
   * print personal data.
   */
  onFrame(frame: Uint8Array, receivedAt: Date, say: (line: string) => void): FrameVerdict
  /** Builds the ACK text (without MLLP framing) for a frame whose verdict asked for one. */
  buildAck(frame: Uint8Array, verdict: FrameVerdict, context: AckContext): string
}

/** The options `createCapture` runs with (see `parseCaptureArgs` for the command-line form). */
export interface CaptureOptions {
  /** 0 lets the system pick a free port (reported by `listen()`). */
  port: number
  /** Where `raw-NNN.hl7`, `capture.log` and `session.jsonl` are written. Created on `listen()`. */
  outDir: string
  /** False = never answer. */
  sendAck: boolean
  /** Forces this MSA-1 code on every ACK the plugin would send. */
  ackCode: string | undefined
  /** Delay between receiving a message and answering it. */
  ackDelayMs: number
  /** Close the connection right after each ACK. */
  closeAfterAck: boolean
  /** False = write the fixture without redaction (local debugging only). */
  redact: boolean
  /** The profile's own switches that were given. */
  switches: ReadonlySet<string>
}

export interface CaptureStats {
  connections: number
  closedByPeer: number
  closedByUs: number
  closedWithError: number
  frames: number
  /** ACKs sent, by MSA-1 code. */
  acks: Record<string, number>
  /** Frames the plugin would not answer. */
  noAckByProfile: number
  /** Frames deliberately not answered (`--no-ack`). */
  noAckByFlag: number
  /** ACKs that could not be written (the analyzer had already closed). */
  ackFailed: number
  /** Frames whose control id had been seen before. */
  resends: number
  /** Resends whose payload hash differed from the earlier one. */
  resendsWithNewHash: number
  /** Frames that were not valid UTF-8. */
  nonUtf8: number
  /** Bytes received outside any MLLP frame. */
  discarded: number
  /** Connections that closed with an incomplete frame in their buffer. */
  incompleteAtClose: number
  /** Facts reported through `tally`, counted per key and value. */
  tally: Record<string, Record<string, number>>
}

export interface CaptureSummary {
  /** Always 0: a capture has no pass or fail; the summary is what the operator reads. */
  exitCode: number
  stats: CaptureStats
  /** The fixture written on stop, when any bytes were received. */
  fixture: FixtureResult | undefined
  fixturePath: string | undefined
}

export interface Capture {
  /** Creates the output directory and starts listening; resolves with the port actually bound. */
  listen(): Promise<{ port: number }>
  /** Prints the summary, writes the fixture, closes everything, stops every timer. Idempotent. */
  stop(): Promise<CaptureSummary>
  readonly stats: CaptureStats
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

interface Connection {
  id: number
  peer: string
  socket: net.Socket
  openedAt: number
  bytes: number
  chunks: number
  frames: number
  noise: number
  buffer: Buffer
  lastFrameAt: number | undefined
  lastAckAt: number | undefined
  pendingAcks: number
  localEndAt: number | undefined
  peerEndAt: number | undefined
  ackQueue: Promise<void>
}

interface Seen {
  count: number
  frame: number
  at: number
  rawHash: string
  payloadHash: string | undefined
}

const pad3 = (n: number): string => String(n).padStart(3, '0')

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

const count = (record: Record<string, number>, key: string): void => {
  record[key] = (record[key] ?? 0) + 1
}

const counted = (record: Record<string, number>): string => {
  const entries = Object.entries(record)

  return entries.length === 0 ? 'none' : entries.map(([key, value]) => `${key || '(empty)'}×${value}`).join(', ')
}

const emptyStats = (): CaptureStats => ({
  connections: 0,
  closedByPeer: 0,
  closedByUs: 0,
  closedWithError: 0,
  frames: 0,
  acks: {},
  noAckByProfile: 0,
  noAckByFlag: 0,
  ackFailed: 0,
  resends: 0,
  resendsWithNewHash: 0,
  nonUtf8: 0,
  discarded: 0,
  incompleteAtClose: 0,
  tally: {},
})

/** The machine's IPv4 addresses, so the operator knows what to type into the analyzer. */
const lanAddresses = (): string[] => Object.entries(os.networkInterfaces())
  .flatMap(([name, list]) => (list ?? [])
    .filter((entry) => entry.family === 'IPv4' && entry.internal === false)
    .map((entry) => `${entry.address} (${name})`))

export const createCapture = (profile: CaptureProfile, options: CaptureOptions, io: Io): Capture => {
  const clock = (): Date => io.now?.() ?? new Date()
  const nowMs = (): number => clock().getTime()
  const logger = createLogger(io)
  const { say } = logger
  const stats = emptyStats()
  const open = new Map<net.Socket, Connection>()
  const events: CaptureEvent[] = []
  const seen = new Map<string, Seen>()
  const timers = new Set<NodeJS.Timeout>()
  const sleepers = new Set<() => void>()
  const startedAt = clock()
  const started = startedAt.getTime()

  let server: net.Server | undefined
  let connectionCount = 0
  let frameCount = 0
  let ackSequence = 0
  let stopped: Promise<CaptureSummary> | undefined

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

  const tally = (facts: Record<string, string> | undefined): void => {
    for (const [key, value] of Object.entries(facts ?? {})) {
      stats.tally[key] ??= {}
      count(stats.tally[key], value)
    }
  }

  /** Timing of a connection at the moment it closes: how long ago the last frame and the last ACK were. */
  const timing = (conn: Connection, at: number): string => [
    conn.lastFrameAt === undefined ? 'no frame received' : `${at - conn.lastFrameAt} ms after the last frame`,
    conn.lastAckAt === undefined ? 'no ACK sent' : `${at - conn.lastAckAt} ms after our last ACK`,
    ...(conn.pendingAcks === 0 ? [] : [`! ${conn.pendingAcks} ACK(s) not yet sent`]),
  ].join(', ')

  const scheduleAck = (conn: Connection, frame: number, raw: Buffer, verdict: FrameVerdict, receivedAt: number): void => {
    if (verdict.ack === null) {
      stats.noAckByProfile += 1
      say('  no ACK: the plugin would not answer this message')
      return
    }

    const own = verdict.ack

    if (options.sendAck === false) {
      stats.noAckByFlag += 1
      say(`  ⏸ --no-ack: deliberately not answering (the plugin would answer ${own.code}); watch what the analyzer does`)
      return
    }

    const code = options.ackCode ?? own.code

    conn.pendingAcks += 1
    conn.ackQueue = conn.ackQueue.then(async () => {
      const wait = receivedAt + options.ackDelayMs - nowMs()

      if (wait > 0) await sleep(wait)

      if (conn.socket.destroyed || conn.socket.writableEnded) {
        stats.ackFailed += 1
        say(`  ✗ ACK for frame #${frame} not sent: connection #${conn.id} was already closed ${conn.localEndAt === undefined ? 'by the analyzer' : 'by us'} (${nowMs() - receivedAt} ms after the frame)`)
        return
      }

      ackSequence += 1

      const ack = profile.buildAck(raw, verdict, { sequence: ackSequence, code, switches: options.switches })
      const bytes = wrapMllp(ack)

      await new Promise<void>((resolve) => {
        conn.socket.write(bytes, (error) => {
          const at = nowMs()

          if (error !== undefined && error !== null) {
            stats.ackFailed += 1
            say(`  ✗ ACK for frame #${frame} could not be written: ${error.message}`)
          } else {
            conn.lastAckAt = at
            count(stats.acks, code)
            say(`  → connection #${conn.id}: ACK ${code} for frame #${frame} (${at - receivedAt} ms after the frame, ${bytes.length} bytes)`)

            if (code !== own.code) say(`    --ack-code: MSA-1 forced to ${code}; the plugin would answer ${own.code}`)
          }

          resolve()
        })
      })

      if (options.closeAfterAck && conn.localEndAt === undefined) {
        conn.localEndAt = nowMs()
        conn.socket.end()
        say(`  ✂ --close-after-ack: closing connection #${conn.id} after the ACK (FIN)`)
      }
    }).catch((error: unknown) => {
      say(`  ✗ ACK for frame #${frame} failed: ${(error as Error).message}`)
    }).finally(() => {
      conn.pendingAcks -= 1
    })
  }

  const onFrame = (conn: Connection, raw: Buffer, receivedAtMs: number): void => {
    frameCount += 1
    stats.frames += 1
    conn.frames += 1
    conn.lastFrameAt = receivedAtMs

    const frame = frameCount
    const receivedAt = new Date(receivedAtMs)
    const file = path.join(options.outDir, `raw-${pad3(frame)}.hl7`)

    fs.writeFileSync(file, raw)

    const text = raw.toString('utf-8')
    const names = parseMessage(text).map((segment) => segment.name)

    say(`  ■ frame #${frame} (connection #${conn.id}, its ${conn.frames}${conn.frames === 1 ? 'st' : conn.frames === 2 ? 'nd' : conn.frames === 3 ? 'rd' : 'th'}, ${raw.length} bytes) → ${displayPath(profile.rootDir, file)}`)
    say(`    segments: ${names.join(' ') || '(none)'}`)

    if (Buffer.from(text, 'utf-8').equals(raw) === false) {
      stats.nonUtf8 += 1
      say('  ! this frame is not valid UTF-8 (decoding and re-encoding changes it); the raw file keeps the original bytes')
    }

    const verdict = profile.onFrame(raw, receivedAt, say)

    say(`  ${verdict.summary}`)
    tally(verdict.tally)

    const rawHash = sha256(raw)

    if (verdict.controlId !== '') {
      const previous = seen.get(verdict.controlId)

      if (previous !== undefined) {
        stats.resends += 1

        let note: string

        if (verdict.payloadHash === undefined) note = 'nothing would be uploaded for this one'
        else if (previous.payloadHash === undefined) note = 'nothing was uploaded last time, this one would be'
        else if (verdict.payloadHash === previous.payloadHash) note = 'same payload hash (a receiver that de-duplicates by payload would drop it)'
        else {
          stats.resendsWithNewHash += 1
          note = '! different payload hash (a receiver that de-duplicates by payload would keep both)'
        }

        say(`  ↻ resend #${previous.count}: same control id as frame #${previous.frame}, ${receivedAtMs - previous.at} ms later; raw bytes ${rawHash === previous.rawHash ? 'identical' : 'differ'}; ${note}`)
      }

      seen.set(verdict.controlId, { count: (previous?.count ?? 0) + 1, frame, at: receivedAtMs, rawHash, payloadHash: verdict.payloadHash })
    }

    scheduleAck(conn, frame, raw, verdict, receivedAtMs)
  }

  const onChunk = (conn: Connection, chunk: Buffer): void => {
    const at = nowMs()

    conn.bytes += chunk.length
    conn.chunks += 1
    events.push({ kind: 'data', connection: conn.id, atMs: at - started, bytes: Buffer.from(chunk) })

    const { frames, rest, discarded } = extractMllpFrameBytes(Buffer.concat([conn.buffer, chunk]))

    conn.buffer = rest
    conn.noise += discarded
    stats.discarded += discarded

    say(`  ← connection #${conn.id} chunk #${conn.chunks}: ${chunk.length} bytes`
      + `${frames.length === 0 ? '' : `, ${frames.length} frame(s) complete`}`
      + `${rest.length === 0 ? '' : `, ${rest.length} bytes buffered for the next chunk`}`)

    if (discarded > 0) say(`  ! ${discarded} byte(s) outside any frame dropped (content not shown; kept in the fixture)`)

    for (const raw of frames) onFrame(conn, raw, at)
  }

  const onConnection = (socket: net.Socket): void => {
    connectionCount += 1
    stats.connections += 1

    const at = nowMs()
    const conn: Connection = {
      id: connectionCount,
      peer: `${socket.remoteAddress}:${socket.remotePort}`,
      socket,
      openedAt: at,
      bytes: 0,
      chunks: 0,
      frames: 0,
      noise: 0,
      buffer: Buffer.alloc(0),
      lastFrameAt: undefined,
      lastAckAt: undefined,
      pendingAcks: 0,
      localEndAt: undefined,
      peerEndAt: undefined,
      ackQueue: Promise.resolve(),
    }

    open.set(socket, conn)
    events.push({ kind: 'connection', connection: conn.id, atMs: at - started })
    say(`▶ connection #${conn.id} from ${conn.peer} (${open.size} open)`)

    socket.on('data', (chunk: Buffer) => { onChunk(conn, chunk) })

    socket.on('end', () => {
      const now = nowMs()

      conn.peerEndAt = now
      say(conn.localEndAt === undefined
        ? `◀ connection #${conn.id}: the analyzer sent FIN first (${timing(conn, now)})`
        : `◀ connection #${conn.id}: the analyzer answered our FIN (${now - conn.localEndAt} ms later)`)
    })

    socket.on('error', (error: NodeJS.ErrnoException) => {
      events.push({ kind: 'error', connection: conn.id, atMs: nowMs() - started, message: error.message })
      say(`✗ connection #${conn.id} error: ${error.code ?? ''} ${error.message} (ECONNRESET means the analyzer sent RST instead of FIN)`)
    })

    socket.on('close', (hadError: boolean) => {
      const now = nowMs()
      const byUs = conn.localEndAt !== undefined && (conn.peerEndAt === undefined || conn.localEndAt <= conn.peerEndAt)

      open.delete(socket)
      events.push({ kind: 'close', connection: conn.id, atMs: now - started, by: byUs ? 'local' : 'peer' })

      if (byUs) stats.closedByUs += 1
      else if (hadError) stats.closedWithError += 1
      else stats.closedByPeer += 1

      say(`◀ connection #${conn.id} closed (${byUs ? 'by us' : hadError ? 'with an error' : 'by the analyzer'}; open for ${((now - conn.openedAt) / 1000).toFixed(1)} s, `
        + `${conn.bytes} bytes in ${conn.chunks} chunk(s), ${conn.frames} frame(s), ${conn.noise} bytes of noise; ${timing(conn, now)}; ${open.size} still open)`)

      if (conn.buffer.length > 0) {
        stats.incompleteAtClose += 1
        say(`  ! ${conn.buffer.length} bytes were still buffered without a complete frame (did the analyzer disconnect mid-message?)`)
      }
    })
  }

  const listen = (): Promise<{ port: number }> => new Promise((resolve, reject) => {
    fs.mkdirSync(options.outDir, { recursive: true })

    const occupied = fs.readdirSync(options.outDir).some((name) => /^(raw-\d+\.hl7|capture\.log|session\.jsonl)$/.test(name))

    if (occupied) {
      reject(new Error(`output directory ${options.outDir} already holds a capture; choose another --out so the raw bytes are not overwritten`))
      return
    }

    logger.setLogFile(path.join(options.outDir, 'capture.log'))

    server = net.createServer(onConnection)

    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'EADDRINUSE'
        ? new Error(`port ${options.port} is already in use (is the receiver running?); stop it or choose another --port`)
        : error)
    })

    server.listen(options.port, '0.0.0.0', () => {
      const address = (server as net.Server).address()
      const port = typeof address === 'object' && address !== null ? address.port : options.port

      say(`${profile.name} capture listening on 0.0.0.0:${port}; this machine's addresses: ${lanAddresses().join(', ') || '(none found)'}`)
      say(`ACK: ${options.sendAck
        ? `${options.ackCode === undefined ? "the plugin's own" : `MSA-1 forced to ${options.ackCode}`}${options.ackDelayMs > 0 ? `, ${options.ackDelayMs} ms after each frame` : ''}${options.closeAfterAck ? ', then close' : ''}`
        : 'never (--no-ack)'}; fixture: ${options.redact ? 'redacted' : '! NOT redacted (--no-redact): do not commit it'}; output in ${displayPath(profile.rootDir, options.outDir)}`)

      if (isInside(path.join(profile.rootDir, 'captures'), options.outDir) === false) {
        say('! the output directory is not under captures/ of the plugin: raw-NNN.hl7 holds personal data; make sure it is not committed')
      }

      say('Point the analyzer at this address and port, run a sample, then stop the capture to write the fixture.')
      resolve({ port })
    })
  })

  const stop = (): Promise<CaptureSummary> => {
    stopped ??= (async () => {
      const at = nowMs()

      say('')
      say('== Capture summary ==')
      say(`connections ${stats.connections}: closed by the analyzer ${stats.closedByPeer}, by us ${stats.closedByUs}, with an error ${stats.closedWithError}, still open ${open.size}`)
      say(`frames ${stats.frames}${stats.nonUtf8 > 0 ? ` (! ${stats.nonUtf8} not valid UTF-8)` : ''}; bytes outside frames ${stats.discarded}; connections closed mid-frame ${stats.incompleteAtClose}`)
      say(`ACKs sent: ${counted(stats.acks)}; not answered by the plugin ${stats.noAckByProfile}; withheld by --no-ack ${stats.noAckByFlag}; failed ${stats.ackFailed}`)
      say(`resends: ${stats.resends}${stats.resendsWithNewHash > 0 ? ` (! ${stats.resendsWithNewHash} with a different payload hash)` : ''}`)

      for (const [key, values] of Object.entries(stats.tally)) say(`${key}: ${counted(values)}`)

      let fixture: FixtureResult | undefined
      let fixturePath: string | undefined

      if (events.some((event) => event.kind === 'data')) {
        const redactor = options.redact ? createRedactor(profile.redaction) : undefined

        fixture = buildFixture(events, { instrument: profile.name, tool: 'live-capture', capturedAt: startedAt, redactor })
        fixturePath = path.join(options.outDir, 'session.jsonl')
        fs.writeFileSync(fixturePath, fixture.text, 'utf-8')
        say(`fixture → ${displayPath(profile.rootDir, fixturePath)} (${fixture.connections} connection(s), ${fixture.chunks} data step(s)${fixture.serialized ? `; ! connections overlapped, replayed one after another with ${fixture.syntheticCloses} close step(s) added` : ''})`)
        say(options.redact
          ? `  redacted: ${Object.entries(fixture.replaced).map(([kind, n]) => `${kind} ${n}`).join(', ') || 'nothing to redact'} distinct value(s)`
          : '  ! not redacted (--no-redact): this fixture holds personal data and must not be committed')

        for (const warning of fixture.warnings) say(`  ! ${warning}`)

        say('  review the fixture by hand before copying it into fixtures/, and record the capture date in the plugin README')
      } else {
        say('no bytes received; no fixture written')
      }

      if (open.size > 0) {
        say(`! ${open.size} connection(s) still open at stop (the analyzer did not close them):`)

        for (const conn of open.values()) {
          say(`   connection #${conn.id} ${conn.peer}: open for ${((at - conn.openedAt) / 1000).toFixed(1)} s, ${conn.bytes} bytes, ${conn.frames} frame(s)${conn.bytes === 0 ? ' (never sent anything)' : ''}; ${timing(conn, at)}`)
        }
      }

      for (const socket of open.keys()) socket.destroy()

      await new Promise<void>((resolve) => {
        if (server === undefined) resolve()
        else server.close(() => resolve())
      })

      for (const timer of timers) clearTimeout(timer)

      timers.clear()

      for (const wake of sleepers) wake()

      sleepers.clear()

      return { exitCode: 0, stats, fixture, fixturePath }
    })()

    return stopped
  }

  return { listen, stop, stats }
}

// ---------------------------------------------------------------------------------------------
// Command-line wrapper
// ---------------------------------------------------------------------------------------------

/**
 * Runs the capture tool as a command-line tool: parses `argv`, listens until interrupted, then
 * writes the fixture and exits. Exit codes: 0 on a normal stop; 1 when the port could not be
 * bound or when interrupted twice; 2 usage error.
 */
export const runCapture = async (profile: CaptureProfile, argv: readonly string[] = process.argv.slice(2)): Promise<never> => {
  const io: Io = { stdout: process.stdout, stderr: process.stderr, isTTY: process.stdout.isTTY === true }

  let parsed: ParsedCaptureArgs

  try {
    parsed = parseCaptureArgs(profile, argv)
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

  const capture = createCapture(profile, parsed.options, io)

  try {
    await capture.listen()
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exit(1)
  }

  let stopping = false

  const stop = (): void => {
    if (stopping) process.exit(1)

    stopping = true
    void capture.stop().then((summary) => { process.exit(summary.exitCode) })
  }

  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  return new Promise<never>(() => {})
}
