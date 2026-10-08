// In-process loopback: a capture (playing the receiver) and a simulator (playing the analyzer)
// talk over a real TCP port, with synthetic profiles. This pins the mechanics the plugins rely
// on: the bytes that arrive are the bytes that were sent, ACKs are matched, timeouts never
// resend, both connection models behave, the exit code reflects the run, an earlier run's output
// is never overwritten, and no personal data from the messages reaches the output.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'

import { component, field, findSegment, findSegments, hl7Timestamp, parseMessage } from '@nxvet/nxst-hl7-parser'

import type { CaptureOptions, CaptureProfile } from '../src/capture.ts'
import { createCapture } from '../src/capture.ts'
import type { FieldEdit, RewriteResult } from '../src/edit.ts'
import { rewriteFields } from '../src/edit.ts'
import type { RandomValue } from '../src/random.ts'
import { randomRange, rangePosition } from '../src/random.ts'
import type { ConnectionModel, SimulatorOptions, SimulatorProfile } from '../src/simulator.ts'
import { createSimulator } from '../src/simulator.ts'
import { CONNECTION, fixture, message, textLine } from './support.ts'

const decode = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf-8')

const PII = ['Zorblax', 'Blorptooth', 'Quillfeather', 'Marrowind']

const simulatorProfile = (rootDir: string, connection: ConnectionModel): SimulatorProfile => ({
  name: 'Demo analyzer',
  prompt: 'demo> ',
  rootDir,
  defaults: { port: 0, ackTimeoutMs: 2000, chunkBytes: 0, gapMs: 0 },
  connection,
  menuColumns: ['control id', 'patient'],
  describe: (bytes) => {
    const segments = parseMessage(decode(bytes))
    const msh = findSegment(segments, 'MSH')
    const pid = findSegment(segments, 'PID')
    const controlId = field(msh, 10).trim()
    const patient = component(field(pid, 3), 1).trim()

    return {
      controlId,
      cells: [controlId || '(none)', patient || '(none)'],
      summary: `message ${controlId || '(no control id)'} for patient ${patient || '(none)'}`,
      ackExpected: controlId !== '',
      tally: { kind: pid === undefined ? 'control' : 'patient' },
    }
  },
  resend: (bytes, now) => rewriteFields(bytes, [{ name: 'MSH-7', segment: 'MSH', field: 7, value: hl7Timestamp(now) }]),
  fresh: (bytes, now, seen) => {
    let n = 1

    while (seen.has(`CTRL-F${n}`)) n += 1

    return rewriteFields(bytes, [
      { name: 'MSH-10', segment: 'MSH', field: 10, value: `CTRL-F${n}` },
      { name: 'MSH-7', segment: 'MSH', field: 7, value: hl7Timestamp(now) },
    ])
  },
  setPatientId: (bytes, id) => rewriteFields(bytes, [{ name: 'PID-3.1', segment: 'PID', field: 3, component: 1, value: id }]),
  evaluateAck: (ackText) => {
    const msa = findSegment(parseMessage(ackText), 'MSA')
    const code = field(msa, 1).trim()

    return { code, ok: code === 'AA', notes: [`MSA-2 ${field(msa, 2)}`], warnings: code === 'AA' ? [] : ['the receiver did not accept the message'], tally: { code } }
  },
})

const captureProfile = (rootDir: string): CaptureProfile => ({
  name: 'Demo analyzer',
  rootDir,
  defaults: { port: 0 },
  redaction: [
    { kind: 'petName', segment: 'PID', field: 5, label: (n) => `Pet${n}` },
    { kind: 'owner', segment: 'PID', field: 21, label: (n) => `Owner${n}` },
    { kind: 'vet', segment: 'PV1', field: 7, label: () => 'Vet' },
  ],
  ackCodes: ['AA', 'AE'],
  onFrame: (frame, _receivedAt, say) => {
    const controlId = field(findSegment(parseMessage(decode(frame)), 'MSH'), 10).trim()

    say(`    control id ${controlId || '(none)'}`)

    return {
      controlId,
      summary: controlId === '' ? 'would not be acknowledged' : `would upload message ${controlId}`,
      payloadHash: createHash('sha256').update(frame).digest('hex'),
      ack: controlId === '' ? null : { code: 'AA', text: 'accepted' },
      tally: { kind: 'result' },
    }
  },
  buildAck: (_frame, verdict, context) => `MSH|^~\\&|RECEIVER||DEMO||20250310104500||ACK^R01|ACK-${context.sequence}|P|2.4\rMSA|${context.code}|${verdict.controlId}|${verdict.ack?.text ?? ''}\r`,
})

/** OBX-7 of the synthetic analyzer: `low-high`, where either end may be negative (`-3-3`). */
const REFERENCE_RANGE = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/

const FLAGS = { below: 'L', within: 'N', above: 'H' } as const

interface Item {
  name: string
  value: string
  low: string
  high: string
  flag: string
}

/** The result items of a synthetic message: OBX-5, with the reference range in OBX-7 and the flag in OBX-8. */
const itemsOf = (bytes: Uint8Array): Item[] => findSegments(parseMessage(decode(bytes)), 'OBX').map((obx) => {
  const [, low = '', high = ''] = REFERENCE_RANGE.exec(field(obx, 7).trim()) ?? []

  return { name: component(field(obx, 3), 2), value: field(obx, 5), low, high, flag: field(obx, 8) }
})

/**
 * The synthetic analyzer's `randomize`: OBX-5 of every OBX gets a new value, and its OBX-8 flag is
 * recomputed against the original reference range in OBX-7.
 */
const randomizeResults = (bytes: Uint8Array, randomValue: RandomValue): RewriteResult => {
  const edits: FieldEdit[] = []
  const left: RewriteResult['skipped'] = []

  for (const [i, { name, value: original, low, high }] of itemsOf(bytes).entries()) {
    const value = randomValue({ name, value: original, low, high })

    if (value === undefined) {
      left.push({ name, reason: 'not a plain number' })
      continue
    }

    const position = rangePosition(value, low, high)

    edits.push({ name, segment: 'OBX', occurrence: i + 1, field: 5, value })

    if (position !== undefined) edits.push({ name: `${name} flag`, segment: 'OBX', occurrence: i + 1, field: 8, value: FLAGS[position] })
  }

  const result = rewriteFields(bytes, edits)

  return { ...result, skipped: [...result.skipped, ...left] }
}

const RESULT_MESSAGE = message({
  controlId: 'CTRL-R1',
  obx: [
    'OBX|1|NM|X001^GLU^DEMO||98|mg/dL|74-146|N|||F',
    'OBX|2|NM|X002^PH^DEMO||7.074||7.31-7.42|L|||F',
    'OBX|3|NM|X003^CRP^DEMO||<5.0|mg/L|0-10|N|||F',
    'OBX|4|NM|X004^BE^DEMO||0.4|mmol/L|-3-3|N|||F',
    'OBX|5|NM|X005^DELTA^DEMO||-1.5|||||F',
  ],
})

interface Harness {
  root: string
  port: number
  capture: ReturnType<typeof createCapture>
  simulator: ReturnType<typeof createSimulator>
  /** The simulator's output directory (not created until `start()`). */
  simulatorDir: string
  simulatorOutput: () => string
  captureOutput: () => string
  rawFiles: () => Buffer[]
  sentFiles: () => Buffer[]
}

const collect = (): { stream: PassThrough, text: () => string } => {
  const stream = new PassThrough()
  let text = ''

  stream.on('data', (chunk: Buffer) => { text += chunk.toString('utf-8') })

  return { stream, text: () => text }
}

const files = (dir: string, prefix: string): Buffer[] => readdirSync(dir)
  .filter((name) => name.startsWith(prefix) && name.endsWith('.hl7'))
  .sort()
  .map((name) => readFileSync(path.join(dir, name)))

/** A port nobody listens on. */
const freePort = (): Promise<number> => new Promise((resolve) => {
  const server = net.createServer()

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as net.AddressInfo

    server.close(() => resolve(port))
  })
})

const setup = async (
  connection: ConnectionModel,
  options: {
    listen?: boolean
    fixtureLines?: string[]
    capture?: Partial<CaptureOptions>
    simulator?: Partial<SimulatorOptions>
    /** Members added to (or replacing those of) the synthetic simulator profile. */
    profile?: Partial<SimulatorProfile>
  } = {},
): Promise<Harness> => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devkit-loop-'))
  const source = path.join(root, 'fixtures', 'session.jsonl')

  mkdirSync(path.dirname(source), { recursive: true })
  writeFileSync(source, fixture(
    CONNECTION,
    ...(options.fixtureLines ?? [
      textLine(message({ controlId: 'CTRL-1' }), 0),
      textLine(message({ controlId: 'CTRL-2', patientId: 'PX-2', petName: 'Blorptooth' }), 10),
      textLine(message({ controlId: 'CTRL-3', pid: null }), 10),
    ]),
  ))

  const captureOut = collect()
  const captureDir = path.join(root, 'captures', 'capture')
  const capture = createCapture(captureProfile(root), {
    port: 0,
    outDir: captureDir,
    sendAck: true,
    ackCode: undefined,
    ackDelayMs: 0,
    closeAfterAck: false,
    redact: true,
    switches: new Set(),
    ...options.capture,
  }, { stdout: captureOut.stream, stderr: captureOut.stream, isTTY: false })

  const port = options.listen === false ? await freePort() : (await capture.listen()).port
  const simulatorOut = collect()
  const simulatorDir = path.join(root, 'captures', 'simulate')
  const simulator = createSimulator({ ...simulatorProfile(root, connection), ...options.profile }, {
    host: '127.0.0.1',
    port,
    source,
    outDir: simulatorDir,
    gapMs: 0,
    ackTimeoutMs: 2000,
    chunkBytes: 0,
    chunkGapMs: 0,
    patientId: undefined,
    fresh: false,
    holdSeconds: 0,
    retryMs: connection.kind === 'persistent' ? connection.retryMs : 0,
    probeMs: connection.kind === 'per-message' ? connection.probeMs : 0,
    preSendMs: connection.kind === 'per-message' ? connection.preSendMs : 0,
    closeAfterAckMs: connection.kind === 'per-message' ? connection.closeAfterAckMs : 0,
    ...options.simulator,
  }, { stdout: simulatorOut.stream, stderr: simulatorOut.stream, isTTY: false })

  return {
    root,
    port,
    capture,
    simulator,
    simulatorDir,
    simulatorOutput: simulatorOut.text,
    captureOutput: captureOut.text,
    rawFiles: () => files(captureDir, 'raw-'),
    sentFiles: () => files(simulatorDir, 'sent-'),
  }
}

const until = async (condition: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs

  while (condition() === false) {
    if (Date.now() > deadline) throw new Error('condition not met in time')

    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
}

const mshField = (bytes: Uint8Array, n: number): string => field(findSegment(parseMessage(decode(bytes)), 'MSH'), n)

describe('loopback, persistent connection', () => {
  it('sends captured bytes unchanged, matches every ACK, resends and overrides the patient id, and keeps personal data out of the output', async () => {
    const h = await setup({ kind: 'persistent', retryMs: 0 })

    await h.simulator.start()
    assert.equal(await h.simulator.run('1 2'), 'continue')
    await until(() => h.simulator.stats.matchedOk === 2)
    assert.equal(h.simulator.stats.opened, 1, 'one connection carries every message')

    await h.simulator.run('r')
    await until(() => h.simulator.stats.matchedOk === 3)

    await h.simulator.run('2 id=PX-9')
    await until(() => h.simulator.stats.matchedOk === 4)
    await h.simulator.run('3 id=PX-9')
    await until(() => h.simulator.stats.matchedOk === 5)

    h.simulator.list()
    assert.equal(await h.simulator.run('q'), 'quit')

    const summary = await h.simulator.finish()

    assert.equal(summary.ok, true)
    assert.equal(summary.exitCode, 0)
    assert.equal(summary.stats.sent, 5)
    assert.deepEqual(summary.stats.codes, { AA: 5 })
    assert.deepEqual(summary.stats.tally.code, { AA: 5 })

    const captureSummary = await h.capture.stop()
    const raw = h.rawFiles()
    const sent = h.sentFiles()

    assert.equal(raw.length, 5)
    assert.deepEqual(raw, sent, 'the receiver got exactly the bytes the simulator wrote')
    assert.equal(mshField(raw[2], 10), 'CTRL-2', 'a resend keeps the control id')
    assert.notEqual(mshField(raw[2], 7), mshField(raw[1], 7), 'a resend carries a new timestamp')
    assert.equal(component(field(findSegment(parseMessage(decode(raw[3])), 'PID'), 3), 1), 'PX-9', 'the one-off patient id reached the receiver')
    assert.equal(findSegment(parseMessage(decode(raw[4])), 'PID'), undefined, 'a message without a patient segment is sent as it is')
    assert.match(h.simulatorOutput(), /skipped PID-3.1 \(no PID segment\)/)
    assert.equal(h.capture.stats.frames, 5)
    assert.deepEqual(h.capture.stats.acks, { AA: 5 })
    assert.equal(h.capture.stats.resends, 2, 'the resend and the second send of message 2 share its control id')
    assert.equal(h.capture.stats.resendsWithNewHash, 2)
    assert.ok(captureSummary.fixture !== undefined)
    assert.equal(captureSummary.fixture.connections, 1)
    assert.equal(captureSummary.fixture.replaced.petName, 2)

    const output = h.simulatorOutput()

    assert.match(output, /ACK AA for sent-001/)
    assert.match(output, /sending #2 again \(resend\)/)
    assert.match(output, /rewrote PID-3.1/)
    assert.match(output, /control id {2}patient/)
    assert.match(output, /OK, every message was acknowledged/)

    for (const value of PII) {
      assert.equal(output.includes(value), false, `${value} must not appear in the simulator output`)
      assert.equal(h.captureOutput().includes(value), false, `${value} must not appear in the capture output`)
      assert.equal(captureSummary.fixture.text.includes(value), false, `${value} must not appear in the fixture`)
    }
  })

  it('reports a timeout without resending when the receiver never answers, and fails the run', async () => {
    const h = await setup({ kind: 'persistent', retryMs: 0 }, { capture: { sendAck: false }, simulator: { ackTimeoutMs: 300 } })

    await h.simulator.start()
    await h.simulator.run('1')
    await until(() => h.simulator.stats.timedOut === 1)

    const summary = await h.simulator.finish()

    assert.equal(summary.ok, false)
    assert.equal(summary.exitCode, 1)
    assert.equal(summary.stats.matchedOk, 0)
    await h.capture.stop()
    assert.equal(h.capture.stats.frames, 1, 'nothing was resent')
    assert.equal(h.capture.stats.noAckByFlag, 1)
    assert.match(h.simulatorOutput(), /no ACK within 300 ms; not resent/)
  })

  it('does not count the timeout of a message the receiver is not expected to acknowledge', async () => {
    const h = await setup(
      { kind: 'persistent', retryMs: 0 },
      { fixtureLines: [textLine(message({ controlId: '' }), 0)], simulator: { ackTimeoutMs: 200 } },
    )

    await h.simulator.start()
    await h.simulator.run('1')
    await until(() => h.simulator.stats.timedOutExpected === 1)

    const summary = await h.simulator.finish()

    assert.equal(summary.ok, true)
    assert.equal(summary.exitCode, 0)
    assert.equal(summary.stats.timedOut, 0)
    await h.capture.stop()
    assert.equal(h.capture.stats.noAckByProfile, 1)
    assert.match(h.simulatorOutput(), /as expected for this message/)
  })

  it('rejects a bad command, a missing message and an invalid patient id without sending anything', async () => {
    const h = await setup({ kind: 'persistent', retryMs: 0 })

    await h.simulator.start()
    await h.simulator.run('zzz')
    await h.simulator.run('9')
    await h.simulator.run('1 id=A|B')
    await h.simulator.run('id A^B')

    const summary = await h.simulator.finish()

    assert.equal(summary.stats.sent, 0)
    await h.capture.stop()
    assert.match(h.simulatorOutput(), /unknown command "zzz"/)
    assert.match(h.simulatorOutput(), /there is no message #9/)
    assert.match(h.simulatorOutput(), /must not contain HL7 delimiters.*nothing sent/)
    assert.match(h.simulatorOutput(), /must not contain HL7 delimiters.*override unchanged/)
  })
})

describe('loopback, one connection per message', () => {
  it('probes while idle, opens one connection per message, closes after the ACK, and refuses n / c / k', async () => {
    const h = await setup({ kind: 'per-message', probeMs: 50, preSendMs: 0, closeAfterAckMs: 0 })

    await h.simulator.start()
    await until(() => h.simulator.stats.probes >= 2)
    await h.simulator.run('1 2')

    assert.equal(h.simulator.stats.matchedOk, 2)
    assert.equal(h.simulator.stats.opened, 2, 'one connection per message')

    await h.simulator.run('n')
    await h.simulator.run('c')

    const summary = await h.simulator.finish()

    assert.equal(summary.ok, true)
    await h.capture.stop()
    assert.equal(h.capture.stats.frames, 2)
    assert.ok(h.capture.stats.connections >= 4, 'two result connections plus probes')
    assert.deepEqual(h.rawFiles(), h.sentFiles())
    assert.match(h.simulatorOutput(), /probe #1: connected/)
    assert.match(h.simulatorOutput(), /not available for the per-message connection model/)
    assert.match(h.captureOutput(), /0 bytes in 0 chunk\(s\), 0 frame\(s\)/)
  })

  it('marks a message as failed when the receiver cannot be reached, without retrying', async () => {
    const h = await setup({ kind: 'per-message', probeMs: 0, preSendMs: 0, closeAfterAckMs: 0 }, { listen: false })

    await h.simulator.start()
    await h.simulator.run('1')

    const summary = await h.simulator.finish()

    assert.equal(summary.exitCode, 1)
    assert.equal(summary.stats.connectFailed, 1)
    assert.equal(summary.stats.sent, 1)
    assert.match(h.simulatorOutput(), /could not connect to 127\.0\.0\.1:\d+ \(the analyzer does not retry a result\)/)
  })

  it('closes the connection itself on an ACK timeout', async () => {
    const h = await setup({ kind: 'per-message', probeMs: 0, preSendMs: 0, closeAfterAckMs: 0 }, { capture: { sendAck: false }, simulator: { ackTimeoutMs: 200 } })

    await h.simulator.start()
    await h.simulator.run('1')

    assert.equal(h.simulator.stats.timedOut, 1)
    await until(() => h.simulator.stats.closedByUs + h.simulator.stats.closedWithError >= 1)

    const summary = await h.simulator.finish()

    assert.equal(summary.exitCode, 1)
    await h.capture.stop()
    assert.equal(h.capture.stats.frames, 1)
    assert.ok(h.simulator.stats.closedByUs + h.simulator.stats.closedWithError >= 1)
  })
})

describe('loopback, random result values', () => {
  const PERSISTENT: ConnectionModel = { kind: 'persistent', retryMs: 0 }
  const SEED = 20_251_008
  const SOURCE = Buffer.from(RESULT_MESSAGE, 'utf-8')
  const RANDOMIZING = { fixtureLines: [textLine(RESULT_MESSAGE, 0)], profile: { randomize: randomizeResults } }

  /** The text after `random values: ` on every line that reports a randomized send. */
  const randomLines = (output: string): string[] => [...output.matchAll(/^\[[^\]]+\] {5}random values: (.*)$/gm)].map((match) => match[1])

  /** The `Settings:` line, without its timestamp. */
  const settingsLine = (output: string): string => /^\[[^\]]+\] (Settings: .*)$/m.exec(output)?.[1] ?? ''

  /** Sends message 1 `times` times with random values on, and returns the bytes sent and the output. */
  const sendRandom = async (seed: number | undefined, times: number): Promise<{ sent: Buffer[], output: string }> => {
    const h = await setup(PERSISTENT, { ...RANDOMIZING, simulator: { random: true, seed } })

    await h.simulator.start()

    for (let n = 1; n <= times; n += 1) {
      await h.simulator.run('1')
      await until(() => h.simulator.stats.matchedOk === n)
    }

    await h.simulator.finish()
    await h.capture.stop()
    assert.deepEqual(h.rawFiles(), h.sentFiles())

    return { sent: h.sentFiles(), output: h.simulatorOutput() }
  }

  it('replaces every result value with a bounded random number and brings its flag in line, leaving every other byte as it was', async () => {
    const h = await setup(PERSISTENT, { ...RANDOMIZING, simulator: { random: true, seed: SEED } })

    await h.simulator.start()
    await h.simulator.run('1')
    await until(() => h.simulator.stats.matchedOk === 1)
    h.simulator.list()

    const summary = await h.simulator.finish()

    await h.capture.stop()
    assert.equal(summary.ok, true)

    const [raw] = h.rawFiles()
    const before = itemsOf(SOURCE)
    const after = itemsOf(raw)

    assert.deepEqual(h.rawFiles(), h.sentFiles(), 'the receiver got exactly the bytes the simulator wrote')
    assert.equal(after.length, before.length)

    for (const [i, item] of before.entries()) {
      const range = randomRange(item)

      if (range === undefined) {
        assert.deepEqual(after[i], item, `${item.name} is not a plain number and is left as it was`)
        continue
      }

      const value = after[i].value
      const position = rangePosition(value, item.low, item.high)

      assert.notEqual(value, item.value, `${item.name} carries a new value`)
      assert.ok(Number(value) >= range.min && Number(value) <= range.max, `${item.name}: ${value} lies within ${range.min} to ${range.max}`)
      assert.equal(value.split('.')[1]?.length ?? 0, range.decimals, `${item.name}: ${value} has ${range.decimals} decimals`)
      assert.equal(after[i].flag, position === undefined ? item.flag : FLAGS[position], `${item.name}: the flag follows the new value`)
    }

    // Writing the original values and flags back gives the source message, byte for byte.
    const restored = rewriteFields(raw, before.flatMap((item, i): FieldEdit[] => [
      { name: item.name, segment: 'OBX', occurrence: i + 1, field: 5, value: item.value },
      { name: `${item.name} flag`, segment: 'OBX', occurrence: i + 1, field: 8, value: item.flag },
    ]))

    assert.deepEqual(restored.bytes, SOURCE)

    const output = h.simulatorOutput()

    assert.match(settingsLine(output), new RegExp(`; patient ids as in the source; random values on \\(seed ${SEED}; --seed ${SEED} repeats them\\)$`))
    assert.match(output, new RegExp(`^\\[[^\\]]+\\] {3}Random values: on \\(seed ${SEED}; "rand off" stops them\\)$`, 'm'))
    assert.deepEqual(randomLines(output), [
      `GLU 98 → ${after[0].value} (59.6 to 160.4), PH 7.074 → ${after[1].value} (7.288 to 7.442), BE 0.4 → ${after[3].value} (-4.2 to 4.2), `
        + `DELTA -1.5 → ${after[4].value} (-3 to 0); left as they were: CRP (not a plain number)`,
    ])
    assert.equal(output.includes('rewrote'), false, 'the random values are not repeated on a "rewrote" line')

    for (const value of PII) assert.equal(output.includes(value), false, `${value} must not appear in the simulator output`)
  })

  it('draws new values on every send, and the same ones again for the same seed (printed when none is given)', async () => {
    const first = await sendRandom(undefined, 2)
    const seed = Number(/random values on \(seed (\d+); --seed \1 repeats them\)$/.exec(settingsLine(first.output))?.[1])

    assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 4_294_967_295, `the start-up line names the seed: ${settingsLine(first.output)}`)
    assert.notDeepEqual(first.sent[0], first.sent[1], 'each send draws new values')

    const again = await sendRandom(seed, 2)

    assert.deepEqual(again.sent, first.sent, 'the same seed and the same commands send the same bytes')
    assert.deepEqual(randomLines(again.output), randomLines(first.output))

    const other = await sendRandom(seed === 0 ? 1 : seed - 1, 2)

    assert.notDeepEqual(other.sent, first.sent, 'another seed sends other values')
  })

  it('resends the values it sent with r, sends the source values after "rand off" and random ones again after "rand on"', async () => {
    const h = await setup(PERSISTENT, { ...RANDOMIZING, simulator: { random: true, seed: SEED } })
    const sourceValues = itemsOf(SOURCE).map((item) => item.value)

    await h.simulator.start()
    await h.simulator.run('1')
    await until(() => h.simulator.stats.matchedOk === 1)
    await h.simulator.run('r')
    await until(() => h.simulator.stats.matchedOk === 2)
    await h.simulator.run('rand off')
    await h.simulator.run('rand')
    await h.simulator.run('1')
    await until(() => h.simulator.stats.matchedOk === 3)
    await h.simulator.run('r')
    await until(() => h.simulator.stats.matchedOk === 4)
    await h.simulator.run('rand on')
    await h.simulator.run('rand')
    await h.simulator.run('1')
    await until(() => h.simulator.stats.matchedOk === 5)

    const summary = await h.simulator.finish()

    await h.capture.stop()
    assert.equal(summary.ok, true)

    const raw = h.rawFiles()
    const values = raw.map((bytes) => itemsOf(bytes).map((item) => item.value))

    assert.deepEqual(raw, h.sentFiles())
    assert.equal(raw.length, 5)
    assert.notDeepEqual(values[0], sourceValues)
    assert.deepEqual(values[1], values[0], 'r resends the random values that were sent')
    assert.notEqual(mshField(raw[1], 7), mshField(raw[0], 7), 'and changes what the profile\'s resend changes')
    assert.deepEqual(raw[2], SOURCE, 'after "rand off" the source bytes are sent')
    assert.deepEqual(values[3], sourceValues, 'and resent')
    assert.notDeepEqual(values[4], sourceValues, 'after "rand on" values are random again')
    assert.notDeepEqual(values[4], values[0], 'drawn afresh')

    const output = h.simulatorOutput()

    assert.equal(randomLines(output).length, 2, 'one random line per randomized send, none for a resend')
    assert.match(output, /random values off: later sends carry the result values from the source/)
    assert.match(output, /Random values: off \("rand on" starts them\)/)
    assert.match(output, new RegExp(`later sends will carry random result values \\(seed ${SEED}; r still resends the values last sent; "rand off" stops them\\)`))
    assert.match(output, new RegExp(`Random values: on \\(seed ${SEED}; "rand off" stops them\\)`))
  })

  it('sends the source bytes unchanged while random values are off', async () => {
    const h = await setup(PERSISTENT, RANDOMIZING)

    await h.simulator.start()
    await h.simulator.run('1')
    await until(() => h.simulator.stats.matchedOk === 1)
    h.simulator.list()
    await h.simulator.finish()
    await h.capture.stop()

    const output = h.simulatorOutput()

    assert.deepEqual(h.sentFiles(), [SOURCE])
    assert.deepEqual(h.rawFiles(), [SOURCE])
    assert.match(settingsLine(output), /; patient ids as in the source; random values off$/)
    assert.match(output, /Random values: off \("rand on" starts them\)/)
    assert.deepEqual(randomLines(output), [])
  })

  it('says random values are not available when the profile does not implement randomize, and changes nothing', async () => {
    const h = await setup(PERSISTENT, { fixtureLines: [textLine(RESULT_MESSAGE, 0)] })

    await h.simulator.start()

    for (const command of ['rand', 'rand on', 'rand off']) await h.simulator.run(command)

    await h.simulator.run('1')
    await until(() => h.simulator.stats.matchedOk === 1)
    h.simulator.list()
    await h.simulator.run('h')
    await h.simulator.finish()
    await h.capture.stop()

    const output = h.simulatorOutput()

    assert.deepEqual(h.sentFiles(), [SOURCE])
    assert.equal(output.match(/ {2}\(not available: the profile does not describe its result values\)$/gm)?.length, 3)
    assert.match(output, /^ {2}rand \[on\|off\] {2}not available: the profile does not describe its result values$/m)
    assert.match(settingsLine(output), /; patient ids as in the source$/)
    assert.equal(/random values/i.test(output), false, 'nothing mentions random values')
  })

  it('refuses an invalid seed, and random values without randomize, before anything starts', async () => {
    for (const seed of [-1, 1.5, 4_294_967_296]) {
      await assert.rejects(
        setup(PERSISTENT, { ...RANDOMIZING, listen: false, simulator: { seed } }),
        { name: 'RangeError', message: `createSimulator: seed must be an integer from 0 to 4294967295, got ${seed}` },
      )
    }

    await assert.rejects(
      setup(PERSISTENT, { fixtureLines: [textLine(RESULT_MESSAGE, 0)], listen: false, simulator: { random: true } }),
      { message: 'createSimulator: random values need a profile that implements randomize()' },
    )
  })
})

describe('simulator output directory', () => {
  /** Writes `files` into `dir` (created when missing). */
  const seed = (dir: string, files: Record<string, Buffer>): void => {
    mkdirSync(dir, { recursive: true })

    for (const [name, bytes] of Object.entries(files)) writeFileSync(path.join(dir, name), bytes)
  }

  /** Closes both tools (both calls are idempotent), so that a failing assertion cannot leave a socket open and hang the file. */
  const closeAll = async (h: Harness): Promise<void> => {
    await h.simulator.finish()
    await h.capture.stop()
  }

  it('refuses a directory that already holds a simulator run, before connecting or writing anything', async (t) => {
    const h = await setup({ kind: 'persistent', retryMs: 0 })
    const earlier = {
      'sent-001.hl7': Buffer.from(message({ controlId: 'CTRL-EARLIER' }), 'utf-8'),
      'simulate.log': Buffer.from('[2025-03-10 10:45:00.000] an earlier run\n', 'utf-8'),
    }

    t.after(() => closeAll(h))
    seed(h.simulatorDir, earlier)

    await assert.rejects(h.simulator.start(), /output directory .+ already holds a simulator run; choose another --out so the sent bytes are not overwritten/)
    // A connection that should not exist gets time to reach the receiver.
    await new Promise((resolve) => { setTimeout(resolve, 100) })

    assert.equal(h.simulatorOutput(), '', 'nothing was printed, so nothing was appended to the log')
    assert.equal(h.simulator.stats.opened, 0)
    assert.equal(h.capture.stats.connections, 0, 'nothing connected to the receiver')
    assert.deepEqual(readdirSync(h.simulatorDir).sort(), Object.keys(earlier).sort())

    for (const [name, bytes] of Object.entries(earlier)) assert.deepEqual(readFileSync(path.join(h.simulatorDir, name)), bytes, `${name} is untouched`)
  })

  it('accepts a directory that holds only a capture\'s files, so both tools can share one', async (t) => {
    const h = await setup({ kind: 'persistent', retryMs: 0 })
    const captured = {
      'raw-001.hl7': Buffer.from(message({ controlId: 'CTRL-CAPTURED' }), 'utf-8'),
      'capture.log': Buffer.from('[2025-03-10 10:45:00.000] a capture\n', 'utf-8'),
      'session.jsonl': Buffer.from(fixture(CONNECTION, textLine(message({ controlId: 'CTRL-CAPTURED' }), 0)), 'utf-8'),
    }

    t.after(() => closeAll(h))
    seed(h.simulatorDir, captured)

    await h.simulator.start()
    await h.simulator.run('1')
    await until(() => h.simulator.stats.matchedOk === 1)

    const summary = await h.simulator.finish()

    await h.capture.stop()
    assert.equal(summary.ok, true)
    assert.deepEqual(h.sentFiles(), h.rawFiles(), 'the run itself is unaffected')
    assert.deepEqual(readdirSync(h.simulatorDir).sort(), [...Object.keys(captured), 'sent-001.hl7', 'simulate.log'].sort())

    for (const [name, bytes] of Object.entries(captured)) assert.deepEqual(readFileSync(path.join(h.simulatorDir, name)), bytes, `${name} is untouched`)
  })
})

describe('capture start-up', () => {
  const SWITCHES = {
    '--swap-header': 'swap the sender and receiver fields of the ACK header',
    '--short-ack': 'leave the optional fields of the ACK empty',
    '--legacy-ack': 'answer with the older ACK layout',
  }

  /** The lines without their timestamps. */
  const unstamped = (text: string): string[] => text.split('\n').map((line) => line.replace(/^\[[^\]]+\] /, ''))

  /** Starts and stops a capture; returns the lines it printed and the lines of its capture.log. */
  const startAndStop = async (switches: Record<string, string> | undefined, given: string[]): Promise<{ printed: string[], logged: string[] }> => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'devkit-start-'))
    const outDir = path.join(root, 'captures', 'capture')
    const out = collect()
    const capture = createCapture({ ...captureProfile(root), switches }, {
      port: 0,
      outDir,
      sendAck: true,
      ackCode: undefined,
      ackDelayMs: 0,
      closeAfterAck: false,
      redact: true,
      switches: new Set(given),
    }, { stdout: out.stream, stderr: out.stream, isTTY: false })

    await capture.listen()
    await capture.stop()

    return { printed: unstamped(out.text()), logged: unstamped(readFileSync(path.join(outDir, 'capture.log'), 'utf-8')) }
  }

  /** The line printed right after the `ACK: ...` settings line. */
  const afterAck = (lines: string[]): string | undefined => lines[lines.findIndex((line) => line.startsWith('ACK: ')) + 1]

  it('prints the profile switches that were given, in declaration order, right after the ACK settings and in capture.log', async () => {
    const { printed, logged } = await startAndStop(SWITCHES, ['--legacy-ack', '--swap-header'])

    assert.equal(afterAck(printed), 'Profile switches: --swap-header, --legacy-ack')
    assert.equal(afterAck(logged), 'Profile switches: --swap-header, --legacy-ack')
  })

  it('lists the available switches when none was given, and prints no such line when the profile declares none', async () => {
    const { printed, logged } = await startAndStop(SWITCHES, [])

    assert.equal(afterAck(printed), 'Profile switches: none given (available: --swap-header, --short-ack, --legacy-ack)')
    assert.equal(afterAck(logged), 'Profile switches: none given (available: --swap-header, --short-ack, --legacy-ack)')

    for (const switches of [undefined, {}]) {
      const plain = await startAndStop(switches, [])

      assert.equal([...plain.printed, ...plain.logged].some((line) => line.startsWith('Profile switches')), false, JSON.stringify(switches))
    }
  })
})
