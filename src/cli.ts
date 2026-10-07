// Command-line plumbing shared by the simulator and the capture tool: argument parsing that
// reports problems instead of exiting, a timestamped logger that cooperates with a readline
// prompt, and the naming of output directories.
//
// The core modules (`simulator.ts`, `capture.ts`) only reach the outside world through an `Io`
// object and never call `process.exit`, so a test can run them in-process with in-memory streams.
// Only the thin `runSimulator` / `runCapture` wrappers touch `process`.
import fs from 'node:fs'
import path from 'node:path'
import { clearLine, cursorTo } from 'node:readline'
import type { Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

import type { CaptureOptions, CaptureProfile } from './capture.ts'
import { validatePatientId } from './repl.ts'
import type { SimulatorOptions, SimulatorProfile } from './simulator.ts'

/** The streams and clock a core module is allowed to use. */
export interface Io {
  stdout: Writable
  stderr: Writable
  /** Where interactive commands come from (only the CLI wrappers read it). */
  input?: Readable
  /** True when the output is a terminal: the message list is printed on start and a prompt is drawn. */
  isTTY: boolean
  /** The clock; defaults to `new Date()`. Tests inject a fixed one. */
  now?: () => Date
}

/** A command-line problem. Carries the usage text so the caller can print both and exit with 2. */
export class UsageError extends Error {
  usage: string

  constructor(message: string, usage: string) {
    super(message)
    this.name = 'UsageError'
    this.usage = usage
  }
}

/** The largest delay `setTimeout` accepts (about 24.8 days). */
export const MAX_TIMER_MS = 2_147_483_647

interface RawArgs {
  values: Map<string, string>
  switches: Set<string>
  help: boolean
}

/** Splits `argv` into valued flags and switches. Unknown flags and missing values are usage errors. */
const splitArgs = (argv: readonly string[], valued: ReadonlySet<string>, switches: ReadonlySet<string>, usage: string): RawArgs => {
  const out: RawArgs = { values: new Map(), switches: new Set(), help: false }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--help' || arg === '-h') {
      out.help = true
      continue
    }

    if (switches.has(arg)) {
      out.switches.add(arg)
      continue
    }

    if (valued.has(arg)) {
      const value = argv[i + 1]

      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`, usage)

      out.values.set(arg, value)
      i += 1
      continue
    }

    throw new UsageError(`unknown argument ${JSON.stringify(arg)}`, usage)
  }

  return out
}

const integer = (flag: string, raw: string, min: number, max: number, usage: string): number => {
  const value = Number(raw)

  if (/^\d+$/.test(raw) === false || value < min || value > max) {
    throw new UsageError(`${flag} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw)}`, usage)
  }

  return value
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** `yyyy-mm-dd` in local time. */
export const localDate = (at: Date): string => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`

/**
 * The output directory for one run: `<baseDir>/<prefix>-<yyyy-mm-dd>`, or `-2`, `-3`, ... when an
 * earlier run of the same day already left results there (output files must never be overwritten:
 * they are the evidence of a run). The directory is not created.
 */
export const allocateOutDir = (baseDir: string, prefix: string, date: Date): string => {
  const base = path.join(baseDir, `${prefix}-${localDate(date)}`)

  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`

    if (fs.existsSync(candidate) === false) return candidate

    const occupied = fs.readdirSync(candidate).some((name) => /^(sent-\d+\.hl7|raw-\d+\.hl7|.*\.log|session\.jsonl)$/.test(name))

    if (occupied === false) return candidate
  }
}

/** True when `target` is inside `root` (used to warn when output leaves the plugin's captures/ directory). */
export const isInside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target)

  return relative !== '' && relative.startsWith('..') === false && path.isAbsolute(relative) === false
}

/** A path for display: relative to `root` when inside it, absolute otherwise. */
export const displayPath = (root: string, target: string): string => (isInside(root, target) ? path.relative(root, target) : target)

/** Writes timestamped lines to the output stream and, once set, to a log file. */
export interface Logger {
  say(line: string): void
  /** Starts mirroring every line to this file (appending). */
  setLogFile(file: string | undefined): void
  /** The prompt to redraw after each line on a terminal; `undefined` detaches it. */
  attachPrompt(rl: Interface | undefined): void
}

export interface LoggerOptions {
  logFile?: string
}

/** Local time to the millisecond, so lines can be lined up with the receiver's own log. */
export const stamp = (at: Date): string => `${localDate(at)} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`

export const createLogger = (io: Io, options: LoggerOptions = {}): Logger => {
  let logFile = options.logFile
  let rl: Interface | undefined

  const say = (line: string): void => {
    const stamped = `[${stamp(io.now?.() ?? new Date())}] ${line}`

    if (io.isTTY && rl !== undefined) {
      // Output arrives asynchronously (an ACK, a probe) while the operator may be typing: clear
      // the prompt line, print, then redraw the prompt with whatever was typed so far.
      clearLine(io.stdout, 0)
      cursorTo(io.stdout, 0)
      io.stdout.write(`${stamped}\n`)
      rl.prompt(true)
    } else {
      io.stdout.write(`${stamped}\n`)
    }

    if (logFile !== undefined) fs.appendFileSync(logFile, `${stamped}\n`)
  }

  return {
    say,
    setLogFile: (file) => { logFile = file },
    attachPrompt: (next) => { rl = next },
  }
}

/** Reads a message source: a fixture (`.jsonl`), a directory of `raw-NNN.hl7` files, or one file. */
export type SourceKind = 'fixture' | 'directory' | 'file'

// ---------------------------------------------------------------------------------------------
// Simulator arguments
// ---------------------------------------------------------------------------------------------

export type ParsedSimulatorArgs =
  | { kind: 'help', usage: string }
  | { kind: 'run', options: SimulatorOptions, list: boolean, usage: string }

const simulatorUsage = (profile: SimulatorProfile): string => {
  const model = profile.connection
  const modelFlags = model.kind === 'persistent'
    ? `  --retry <ms>         reconnect delay after a refused connection or a close by the receiver (default ${model.retryMs}; 0 = never)`
    : [
        `  --probe <ms>         idle probe interval: connect, send nothing, close (default ${model.probeMs}; 0 = no probes)`,
        `  --pre-send <ms>      delay between connecting and sending (default ${model.preSendMs})`,
      ].join('\n')

  return [
    `Usage: simulate [--host <ip>] [--port <n>] [--source <session.jsonl | captures/<dir> | file.hl7>]`,
    '                [--gap <ms>|real] [--ack-timeout <ms>] [--chunk <bytes>] [--chunk-gap <ms>]',
    `                [--patient-id <id>] [--fresh] [--hold <s>] [--out <dir>] [${model.kind === 'persistent' ? '--retry <ms>' : '--probe <ms>] [--pre-send <ms>'}] [--list]`,
    '',
    `${profile.name} simulator: plays the analyzer and sends captured messages to a real receiver.`,
    '',
    '  --host <ip>          the receiver (default 127.0.0.1)',
    `  --port <n>           the receiver's port (default ${profile.defaults.port})`,
    '  --source <path>      messages to send (default fixtures/session.jsonl under the plugin directory;',
    '                       a relative path is taken from the current directory)',
    `  --gap <ms>|real      pause between messages sent in one command (default ${profile.defaults.gapMs}; real = the captured gaps)`,
    `  --ack-timeout <ms>   how long to wait for an ACK; a timeout is logged, never resent (default ${profile.defaults.ackTimeoutMs})`,
    `  --chunk <bytes>      write each frame in pieces of this size (default ${profile.defaults.chunkBytes}; 0 = one write)`,
    `  --chunk-gap <ms>     pause between pieces (default ${profile.defaults.chunkGapMs ?? 10})`,
    '  --patient-id <id>    initial patient id override (the "id" command changes it later)',
    '  --fresh              renew the control id and timestamp of every message before sending',
    '  --hold <s>           keep connections open this long after "q" before exiting (default 0)',
    '  --out <dir>          output directory (default captures/simulate-<date> under the plugin directory;',
    '                       a relative path is taken from the current directory)',
    modelFlags,
    '  --list               print the message list and exit',
    '  --help               this text',
  ].join('\n')
}

/**
 * Parses the simulator's command line. Throws `UsageError` on a problem; never exits. The clock
 * is only used to name the default output directory. A relative `--source` or `--out` is taken from
 * the current directory; the defaults are under `profile.rootDir`.
 */
export const parseSimulatorArgs = (profile: SimulatorProfile, argv: readonly string[], now: Date = new Date()): ParsedSimulatorArgs => {
  const usage = simulatorUsage(profile)
  const model = profile.connection
  const valued = new Set(['--host', '--port', '--source', '--gap', '--ack-timeout', '--chunk', '--chunk-gap', '--patient-id', '--hold', '--out'])

  if (model.kind === 'persistent') valued.add('--retry')
  else valued.add('--probe').add('--pre-send')

  const raw = splitArgs(argv, valued, new Set(['--fresh', '--list']), usage)

  if (raw.help) return { kind: 'help', usage }

  const get = (flag: string): string | undefined => raw.values.get(flag)
  const patientId = get('--patient-id')

  if (patientId !== undefined) {
    const problem = validatePatientId(patientId)

    if (problem !== undefined) throw new UsageError(`--patient-id: ${problem}`, usage)
  }

  const gap = get('--gap') ?? String(profile.defaults.gapMs)
  const sourceArg = get('--source')
  const outArg = get('--out')

  const options: SimulatorOptions = {
    host: get('--host') ?? '127.0.0.1',
    port: integer('--port', get('--port') ?? String(profile.defaults.port), 1, 65535, usage),
    source: sourceArg === undefined ? path.resolve(profile.rootDir, 'fixtures', 'session.jsonl') : path.resolve(sourceArg),
    outDir: outArg === undefined ? allocateOutDir(path.join(profile.rootDir, 'captures'), 'simulate', now) : path.resolve(outArg),
    gapMs: gap === 'real' ? undefined : integer('--gap', gap, 0, MAX_TIMER_MS, usage),
    ackTimeoutMs: integer('--ack-timeout', get('--ack-timeout') ?? String(profile.defaults.ackTimeoutMs), 1, MAX_TIMER_MS, usage),
    chunkBytes: integer('--chunk', get('--chunk') ?? String(profile.defaults.chunkBytes), 0, 1_048_576, usage),
    chunkGapMs: integer('--chunk-gap', get('--chunk-gap') ?? String(profile.defaults.chunkGapMs ?? 10), 0, MAX_TIMER_MS, usage),
    patientId,
    fresh: raw.switches.has('--fresh'),
    holdSeconds: integer('--hold', get('--hold') ?? '0', 0, 86_400, usage),
    retryMs: model.kind === 'persistent' ? integer('--retry', get('--retry') ?? String(model.retryMs), 0, MAX_TIMER_MS, usage) : 0,
    probeMs: model.kind === 'per-message' ? integer('--probe', get('--probe') ?? String(model.probeMs), 0, MAX_TIMER_MS, usage) : 0,
    preSendMs: model.kind === 'per-message' ? integer('--pre-send', get('--pre-send') ?? String(model.preSendMs), 0, MAX_TIMER_MS, usage) : 0,
    closeAfterAckMs: model.kind === 'per-message' ? model.closeAfterAckMs : 0,
  }

  return { kind: 'run', options, list: raw.switches.has('--list'), usage }
}

// ---------------------------------------------------------------------------------------------
// Capture arguments
// ---------------------------------------------------------------------------------------------

export type ParsedCaptureArgs =
  | { kind: 'help', usage: string }
  | { kind: 'run', options: CaptureOptions, usage: string }

const captureUsage = (profile: CaptureProfile<string>): string => {
  const extra = Object.entries(profile.switches ?? {}).map(([flag, help]) => `  ${flag.padEnd(20)} ${help}`)

  return [
    'Usage: live-capture [--port <n>] [--out <dir>] [--no-ack | --ack-code <code>] [--ack-delay <ms>]',
    `                    [--close-after-ack] [--no-redact]${extra.length > 0 ? ` [${Object.keys(profile.switches ?? {}).join('] [')}]` : ''}`,
    '',
    `${profile.name} capture: listens like the receiver, records every byte the analyzer sends, answers with the plugin's ACK.`,
    '',
    `  --port <n>           port to listen on (default ${profile.defaults.port})`,
    '  --out <dir>          output directory (default captures/capture-<date> under the plugin directory;',
    '                       a relative path is taken from the current directory)',
    '  --no-ack             never answer (what does the analyzer do without an ACK?)',
    `  --ack-code <code>    answer with this MSA-1 code instead of the plugin\'s (${profile.ackCodes.join(', ')}; case-insensitive)`,
    '  --ack-delay <ms>     answer this long after the message arrived (probe the analyzer\'s ACK timeout)',
    '  --close-after-ack    close the connection right after the ACK',
    '  --no-redact          write the fixture without redaction (local debugging only; never commit it)',
    ...extra,
    '  --help               this text',
  ].join('\n')
}

/**
 * Parses the capture tool's command line. Throws `UsageError` on a problem; never exits. A relative
 * `--out` is taken from the current directory; the default is under `profile.rootDir`.
 */
export const parseCaptureArgs = <Code extends string>(profile: CaptureProfile<Code>, argv: readonly string[], now: Date = new Date()): ParsedCaptureArgs => {
  const usage = captureUsage(profile)
  const switches = new Set(['--no-ack', '--close-after-ack', '--no-redact', ...Object.keys(profile.switches ?? {})])
  const raw = splitArgs(argv, new Set(['--port', '--out', '--ack-code', '--ack-delay']), switches, usage)

  if (raw.help) return { kind: 'help', usage }

  const sendAck = raw.switches.has('--no-ack') === false
  const ackArg = raw.values.get('--ack-code')
  // The command-line value is checked against the profile's codes here, ignoring case, and passed on
  // in the profile's own spelling; `createCapture` relies on that.
  const allowedCodes: readonly string[] = profile.ackCodes
  const ackCode = ackArg === undefined ? undefined : allowedCodes.find((code) => code.toUpperCase() === ackArg.toUpperCase())

  if (ackArg !== undefined && ackCode === undefined) {
    throw new UsageError(`--ack-code must be one of ${profile.ackCodes.join(', ')}, got ${JSON.stringify(ackArg)}`, usage)
  }

  if (sendAck === false) {
    const conflicts = ['--ack-code', '--ack-delay'].filter((flag) => raw.values.has(flag))

    if (raw.switches.has('--close-after-ack')) conflicts.push('--close-after-ack')
    if (conflicts.length > 0) throw new UsageError(`--no-ack cannot be combined with ${conflicts.join(', ')}: there is no ACK to change`, usage)
  }

  const outArg = raw.values.get('--out')
  const profileSwitches = new Set(Object.keys(profile.switches ?? {}).filter((flag) => raw.switches.has(flag)))

  const options: CaptureOptions = {
    port: integer('--port', raw.values.get('--port') ?? String(profile.defaults.port), 0, 65535, usage),
    outDir: outArg === undefined ? allocateOutDir(path.join(profile.rootDir, 'captures'), 'capture', now) : path.resolve(outArg),
    sendAck,
    ackCode,
    ackDelayMs: integer('--ack-delay', raw.values.get('--ack-delay') ?? '0', 0, MAX_TIMER_MS, usage),
    closeAfterAck: raw.switches.has('--close-after-ack'),
    redact: raw.switches.has('--no-redact') === false,
    switches: profileSwitches,
  }

  return { kind: 'run', options, usage }
}
