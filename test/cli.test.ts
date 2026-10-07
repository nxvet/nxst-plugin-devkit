// Command-line plumbing: argument parsing that never exits, output directory naming, the logger.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'

import type { CaptureProfile } from '../src/capture.ts'
import { UsageError, allocateOutDir, createLogger, localDate, parseCaptureArgs, parseSimulatorArgs } from '../src/cli.ts'
import type { ConnectionModel, SimulatorProfile } from '../src/simulator.ts'

const ROOT = path.join(os.tmpdir(), 'devkit-cli-root')
const DATE = new Date(2025, 2, 10, 10, 45, 0)

const simulatorProfile = (connection: ConnectionModel): SimulatorProfile => ({
  name: 'Demo analyzer',
  prompt: 'demo> ',
  rootDir: ROOT,
  defaults: { port: 5100, ackTimeoutMs: 8000, chunkBytes: 1448, gapMs: 250 },
  connection,
  menuColumns: ['id'],
  describe: () => ({ controlId: 'CTRL-1', cells: ['CTRL-1'], summary: 'demo', ackExpected: true }),
  resend: (bytes) => ({ bytes: Buffer.from(bytes), applied: [], skipped: [] }),
  fresh: (bytes) => ({ bytes: Buffer.from(bytes), applied: [], skipped: [] }),
  setPatientId: (bytes) => ({ bytes: Buffer.from(bytes), applied: [], skipped: [] }),
  evaluateAck: () => ({ code: 'AA', ok: true, notes: [], warnings: [] }),
})

const PERSISTENT = simulatorProfile({ kind: 'persistent', retryMs: 1500 })
const PER_MESSAGE = simulatorProfile({ kind: 'per-message', probeMs: 10_000, preSendMs: 300, closeAfterAckMs: 3 })

const captureProfile: CaptureProfile = {
  name: 'Demo analyzer',
  rootDir: ROOT,
  defaults: { port: 5100 },
  redaction: [],
  ackCodes: ['AA', 'AE'],
  switches: { '--swap-header': 'swap the sender and receiver fields of the ACK header' },
  onFrame: () => ({ controlId: 'CTRL-1', summary: 'demo', ack: { code: 'AA', text: '' } }),
  buildAck: () => 'MSH|^~\\&|R||D||20250310104500||ACK|1|P|2.4\rMSA|AA|CTRL-1\r',
}

const usageError = (run: () => unknown, pattern: RegExp): void => {
  assert.throws(run, (error: unknown) => error instanceof UsageError && pattern.test(error.message) && error.usage.includes('Usage:'))
}

/** The default output directory the `--out` line of a usage text names, `<date>` included. */
const defaultOutIn = (usage: string): string => {
  const line = usage.split('\n').find((entry) => entry.trimStart().startsWith('--out <dir>')) ?? ''
  const matched = /\(default (\S+<date>)/.exec(line)

  assert.ok(matched !== null, `the --out line names its default: ${JSON.stringify(line)}`)

  return matched[1]
}

/** `outDir` relative to `ROOT`, with forward slashes, as the usage text writes it. */
const underRoot = (outDir: string): string => path.relative(ROOT, outDir).split(path.sep).join('/')

describe('parseSimulatorArgs', () => {
  it('fills the defaults from the profile for a persistent-connection analyzer', () => {
    const parsed = parseSimulatorArgs(PERSISTENT, [], DATE)

    assert.equal(parsed.kind, 'run')

    if (parsed.kind !== 'run') return

    assert.equal(parsed.list, false)
    assert.equal(parsed.options.host, '127.0.0.1')
    assert.equal(parsed.options.port, 5100)
    assert.equal(parsed.options.source, path.join(ROOT, 'fixtures', 'session.jsonl'))
    assert.equal(parsed.options.outDir, path.join(ROOT, 'captures', 'simulate-2025-03-10'))
    assert.equal(parsed.options.gapMs, 250)
    assert.equal(parsed.options.ackTimeoutMs, 8000)
    assert.equal(parsed.options.chunkBytes, 1448)
    assert.equal(parsed.options.chunkGapMs, 10)
    assert.equal(parsed.options.patientId, undefined)
    assert.equal(parsed.options.fresh, false)
    assert.equal(parsed.options.holdSeconds, 0)
    assert.equal(parsed.options.retryMs, 1500)
    assert.equal(parsed.options.probeMs, 0)
    assert.equal(parsed.options.preSendMs, 0)
    assert.equal(parsed.options.closeAfterAckMs, 0)
  })

  it('fills the per-message defaults and rejects the other model\'s flag', () => {
    const parsed = parseSimulatorArgs(PER_MESSAGE, ['--probe', '2000', '--pre-send', '0'], DATE)

    assert.equal(parsed.kind, 'run')

    if (parsed.kind !== 'run') return

    assert.equal(parsed.options.probeMs, 2000)
    assert.equal(parsed.options.preSendMs, 0)
    assert.equal(parsed.options.closeAfterAckMs, 3)
    assert.equal(parsed.options.retryMs, 0)
    usageError(() => parseSimulatorArgs(PER_MESSAGE, ['--retry', '5'], DATE), /unknown argument "--retry"/)
    usageError(() => parseSimulatorArgs(PERSISTENT, ['--probe', '5'], DATE), /unknown argument "--probe"/)
  })

  it('reads every flag', () => {
    const parsed = parseSimulatorArgs(PERSISTENT, [
      '--host', '10.1.2.3', '--port', '6000', '--source', 'captures/x', '--gap', 'real', '--ack-timeout', '500',
      '--chunk', '0', '--chunk-gap', '20', '--patient-id', 'PX-9', '--fresh', '--hold', '2', '--out', 'out/here', '--retry', '0', '--list',
    ], DATE)

    assert.equal(parsed.kind, 'run')

    if (parsed.kind !== 'run') return

    assert.equal(parsed.list, true)
    assert.equal(parsed.options.host, '10.1.2.3')
    assert.equal(parsed.options.port, 6000)
    assert.equal(parsed.options.source, path.join(ROOT, 'captures', 'x'))
    assert.equal(parsed.options.gapMs, undefined)
    assert.equal(parsed.options.ackTimeoutMs, 500)
    assert.equal(parsed.options.chunkBytes, 0)
    assert.equal(parsed.options.chunkGapMs, 20)
    assert.equal(parsed.options.patientId, 'PX-9')
    assert.equal(parsed.options.fresh, true)
    assert.equal(parsed.options.holdSeconds, 2)
    assert.equal(parsed.options.outDir, path.resolve('out/here'))
    assert.equal(parsed.options.retryMs, 0)
  })

  it('returns the usage text for --help', () => {
    const parsed = parseSimulatorArgs(PERSISTENT, ['--help'], DATE)

    assert.equal(parsed.kind, 'help')
    assert.match(parsed.usage, /Usage: simulate/)
    assert.match(parsed.usage, /--retry/)
    assert.match(parseSimulatorArgs(PER_MESSAGE, ['-h'], DATE).usage, /--probe/)
  })

  it('reports usage errors instead of exiting', () => {
    usageError(() => parseSimulatorArgs(PERSISTENT, ['--bogus'], DATE), /unknown argument "--bogus"/)
    usageError(() => parseSimulatorArgs(PERSISTENT, ['--port'], DATE), /--port needs a value/)
    usageError(() => parseSimulatorArgs(PERSISTENT, ['--port', '--list'], DATE), /--port needs a value/)
    usageError(() => parseSimulatorArgs(PERSISTENT, ['--port', '70000'], DATE), /--port must be an integer between 1 and 65535/)
    usageError(() => parseSimulatorArgs(PERSISTENT, ['--gap', 'soon'], DATE), /--gap must be an integer/)
    usageError(() => parseSimulatorArgs(PERSISTENT, ['--ack-timeout', '0'], DATE), /--ack-timeout must be an integer between 1/)
    usageError(() => parseSimulatorArgs(PERSISTENT, ['--patient-id', 'A|B'], DATE), /--patient-id: patient id must not contain HL7 delimiters/)
    usageError(() => parseSimulatorArgs(PERSISTENT, ['--patient-id', ' '], DATE), /--patient-id: patient id must not be empty/)
  })

  it('numbers the default output directory when the day already has results', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'devkit-cli-'))
    const profile = { ...PERSISTENT, rootDir: root }
    const first = path.join(root, 'captures', 'simulate-2025-03-10')

    mkdirSync(first, { recursive: true })
    writeFileSync(path.join(first, 'sent-001.hl7'), 'x')

    const parsed = parseSimulatorArgs(profile, [], DATE)

    assert.equal(parsed.kind === 'run' && parsed.options.outDir, `${first}-2`)
  })
})

describe('parseCaptureArgs', () => {
  it('fills the defaults and reads every flag, including the profile\'s own switches', () => {
    const defaults = parseCaptureArgs(captureProfile, [], DATE)

    assert.equal(defaults.kind, 'run')

    if (defaults.kind !== 'run') return

    assert.deepEqual({ ...defaults.options, switches: [...defaults.options.switches] }, {
      port: 5100,
      outDir: path.join(ROOT, 'captures', 'capture-2025-03-10'),
      sendAck: true,
      ackCode: undefined,
      ackDelayMs: 0,
      closeAfterAck: false,
      redact: true,
      switches: [],
    })

    const parsed = parseCaptureArgs(captureProfile, ['--port', '0', '--out', 'o', '--ack-code', 'AE', '--ack-delay', '30000', '--close-after-ack', '--no-redact', '--swap-header'], DATE)

    assert.equal(parsed.kind, 'run')

    if (parsed.kind !== 'run') return

    assert.equal(parsed.options.port, 0)
    assert.equal(parsed.options.outDir, path.resolve('o'))
    assert.equal(parsed.options.ackCode, 'AE')
    assert.equal(parsed.options.ackDelayMs, 30_000)
    assert.equal(parsed.options.closeAfterAck, true)
    assert.equal(parsed.options.redact, false)
    assert.deepEqual([...parsed.options.switches], ['--swap-header'])
  })

  it('rejects an unknown ACK code, flags that contradict --no-ack, and unknown switches', () => {
    usageError(() => parseCaptureArgs(captureProfile, ['--ack-code', 'ZZ'], DATE), /--ack-code must be one of AA, AE/)
    usageError(() => parseCaptureArgs(captureProfile, ['--no-ack', '--ack-delay', '5'], DATE), /--no-ack cannot be combined with --ack-delay/)
    usageError(() => parseCaptureArgs(captureProfile, ['--no-ack', '--close-after-ack'], DATE), /--no-ack cannot be combined with --close-after-ack/)
    usageError(() => parseCaptureArgs(captureProfile, ['--swap'], DATE), /unknown argument "--swap"/)
    usageError(() => parseCaptureArgs({ ...captureProfile, switches: undefined }, ['--swap-header'], DATE), /unknown argument "--swap-header"/)
  })

  it('returns the usage text for --help, listing the profile\'s switches and ACK codes', () => {
    const parsed = parseCaptureArgs(captureProfile, ['--help'], DATE)

    assert.equal(parsed.kind, 'help')
    assert.match(parsed.usage, /Usage: live-capture/)
    assert.match(parsed.usage, /--swap-header\s+swap the sender/)
    assert.match(parsed.usage, /\(AA, AE\)/)
  })
})

describe('usage text', () => {
  it('names the default output directory of both tools exactly as it is allocated', () => {
    const simulator = parseSimulatorArgs(PERSISTENT, [], DATE)
    const capture = parseCaptureArgs(captureProfile, [], DATE)

    assert.equal(simulator.kind, 'run')
    assert.equal(capture.kind, 'run')

    if (simulator.kind !== 'run' || capture.kind !== 'run') return

    assert.equal(defaultOutIn(simulator.usage).replace('<date>', localDate(DATE)), underRoot(simulator.options.outDir))
    assert.equal(defaultOutIn(capture.usage).replace('<date>', localDate(DATE)), underRoot(capture.options.outDir))
  })
})

describe('allocateOutDir', () => {
  it('uses the base name when the directory does not exist or is empty, and counts up past used ones', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'devkit-out-'))

    assert.equal(allocateOutDir(base, 'simulate', DATE), path.join(base, 'simulate-2025-03-10'))

    mkdirSync(path.join(base, 'simulate-2025-03-10'))
    assert.equal(allocateOutDir(base, 'simulate', DATE), path.join(base, 'simulate-2025-03-10'), 'an empty directory is reused')

    writeFileSync(path.join(base, 'simulate-2025-03-10', 'simulate.log'), '')
    assert.equal(allocateOutDir(base, 'simulate', DATE), path.join(base, 'simulate-2025-03-10-2'))

    mkdirSync(path.join(base, 'simulate-2025-03-10-2'))
    writeFileSync(path.join(base, 'simulate-2025-03-10-2', 'raw-001.hl7'), '')
    assert.equal(allocateOutDir(base, 'simulate', DATE), path.join(base, 'simulate-2025-03-10-3'))
  })
})

describe('createLogger', () => {
  it('writes timestamped lines to stdout and, once a log file is set, to the file as well', () => {
    const stdout = new PassThrough()
    let text = ''

    stdout.on('data', (chunk: Buffer) => { text += chunk.toString('utf-8') })

    const dir = mkdtempSync(path.join(os.tmpdir(), 'devkit-log-'))
    const file = path.join(dir, 'simulate.log')
    const logger = createLogger({ stdout, stderr: stdout, isTTY: false, now: () => DATE })

    logger.say('first')
    logger.setLogFile(file)
    logger.say('second')

    assert.equal(text, '[2025-03-10 10:45:00.000] first\n[2025-03-10 10:45:00.000] second\n')
    assert.equal(readFileSync(file, 'utf-8'), '[2025-03-10 10:45:00.000] second\n')
  })

  it('does not redraw a prompt when the output is not a terminal', () => {
    const stdout = new PassThrough()
    let prompts = 0

    stdout.on('data', () => {})

    const logger = createLogger({ stdout, stderr: stdout, isTTY: false, now: () => DATE })

    logger.attachPrompt({ prompt: () => { prompts += 1 } } as unknown as import('node:readline').Interface)
    logger.say('line')

    assert.equal(prompts, 0)
  })
})
