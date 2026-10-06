// In-process loopback: a capture (playing the receiver) and a simulator (playing the analyzer)
// talk over a real TCP port, with synthetic profiles. This pins the mechanics the plugins rely
// on: the bytes that arrive are the bytes that were sent, ACKs are matched, timeouts never
// resend, both connection models behave, the exit code reflects the run, and no personal data
// from the messages reaches the output.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'

import { component, field, findSegment, hl7Timestamp, parseMessage } from '@nxvet/nxst-hl7-parser'

import type { CaptureOptions, CaptureProfile } from '../src/capture.ts'
import { createCapture } from '../src/capture.ts'
import { rewriteFields } from '../src/edit.ts'
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

interface Harness {
  root: string
  port: number
  capture: ReturnType<typeof createCapture>
  simulator: ReturnType<typeof createSimulator>
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
  options: { listen?: boolean, fixtureLines?: string[], capture?: Partial<CaptureOptions>, simulator?: Partial<SimulatorOptions> } = {},
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
  const simulator = createSimulator(simulatorProfile(root, connection), {
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
