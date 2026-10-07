import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { field, findSegment, parseMessage } from '@nxvet/nxst-hl7-parser'

import type { CaptureEvent } from '../src/fixture.ts'
import { buildFixture, messagesFromFixture, messagesFromRawFiles, parseFixtureSteps } from '../src/fixture.ts'
import { createRedactor } from '../src/redact.ts'
import { CONNECTION, EB_CR, SB, fixture, fragments, frame, hexLine, message, replayedBytes, steps, textLine } from './support.ts'

const controlIdOf = (bytes: Uint8Array): string => field(findSegment(parseMessage(Buffer.from(bytes).toString('utf-8')), 'MSH'), 10)

describe('messagesFromFixture with text lines', () => {
  const text = fixture(
    '// a comment line',
    CONNECTION,
    textLine(message({ controlId: 'CTRL-1' }), 0),
    textLine(message({ controlId: 'CTRL-2' }), 101208),
    textLine(message({ controlId: 'CTRL-3', pid: null }), 3457),
    '{"delayMs":500}',
  )
  const set = messagesFromFixture(text)

  it('yields one message per line, numbered from 1, with the delays as written', () => {
    assert.equal(set.messages.length, 3)
    assert.deepEqual(set.messages.map((entry) => entry.index), [1, 2, 3])
    assert.deepEqual(set.messages.map((entry) => entry.delayMs), [0, 101208, 3457])
    assert.deepEqual(set.messages.map((entry) => entry.connection), [1, 1, 1])
    assert.equal(set.connections, 1)
  })

  it('returns the frame content without MLLP framing, byte for byte', () => {
    assert.deepEqual(set.messages[0].bytes, Buffer.from(message({ controlId: 'CTRL-1' }), 'utf-8'))
    assert.equal(controlIdOf(set.messages[2].bytes), 'CTRL-3')
  })

  it('drops nothing', () => {
    assert.deepEqual(set.discarded, [])
    assert.deepEqual(set.incomplete, [])
  })
})

describe('messagesFromFixture with hex chunks', () => {
  it('joins a frame split across chunks into one message and sums the delays up to the completing chunk', () => {
    const whole = frame(message({ controlId: 'A' }))
    const cut = Math.floor(whole.length / 2)
    const set = messagesFromFixture(fixture(CONNECTION, hexLine(whole.subarray(0, cut), 366), hexLine(whole.subarray(cut), 3)))

    assert.equal(set.messages.length, 1)
    assert.equal(set.messages[0].delayMs, 369)
    assert.deepEqual(set.messages[0].bytes, Buffer.from(message({ controlId: 'A' }), 'utf-8'))
  })

  it('gives the second frame in one chunk a delay of 0', () => {
    const set = messagesFromFixture(fixture(
      CONNECTION,
      hexLine(Buffer.concat([frame(message({ controlId: 'A' })), frame(message({ controlId: 'B', pid: null }))]), 120),
    ))

    assert.deepEqual(set.messages.map((entry) => entry.delayMs), [120, 0])
    assert.deepEqual(set.messages.map((entry) => controlIdOf(entry.bytes)), ['A', 'B'])
  })

  it('accumulates delays across close, empty connection, error and wait lines, and numbers connections', () => {
    const set = messagesFromFixture(fixture(
      CONNECTION,
      '{"delayMs":1,"event":"close"}',
      '{"delayMs":10003,"event":"connection"}',
      '{"delayMs":1,"event":"close"}',
      '{"delayMs":6350,"event":"connection"}',
      '{"delayMs":5}',
      '{"delayMs":2,"event":"error","message":"boom"}',
      '{"delayMs":100,"event":"connection"}',
      hexLine(frame(message({ controlId: 'A' })), 40),
      '{"delayMs":32,"event":"close"}',
      '{"delayMs":500}',
    ))

    assert.equal(set.connections, 4)
    assert.equal(set.messages.length, 1)
    assert.equal(set.messages[0].delayMs, 1 + 10003 + 1 + 6350 + 5 + 2 + 100 + 40)
    assert.equal(set.messages[0].connection, 4)
  })

  it('never joins bytes across connections: a frame cut by a close is reported incomplete', () => {
    const whole = frame(message({ controlId: 'A' }))
    const half = Math.floor(whole.length / 2)
    const set = messagesFromFixture(fixture(
      CONNECTION,
      hexLine(whole.subarray(0, half), 10),
      '{"delayMs":1,"event":"close"}',
      '{"delayMs":1,"event":"connection"}',
      hexLine(whole.subarray(half), 10),
      hexLine(frame(message({ controlId: 'B' })), 10),
    ))

    assert.deepEqual(set.messages.map((entry) => controlIdOf(entry.bytes)), ['B'])
    assert.deepEqual(set.incomplete, [{ connection: 1, bytes: half }])
    assert.deepEqual(set.discarded, [{ connection: 2, bytes: whole.length - half }])
  })

  it('counts noise before <SB> without producing a message', () => {
    const set = messagesFromFixture(fixture(CONNECTION, hexLine(Buffer.from('garbage'), 5), hexLine(frame(message({ controlId: 'A' })), 5)))

    assert.equal(set.messages.length, 1)
    assert.deepEqual(set.discarded, [{ connection: 1, bytes: 7 }])
  })

  it('treats data before any connection line as connection 1', () => {
    const set = messagesFromFixture(fixture(hexLine(frame(message({ controlId: 'A' })), 0)))

    assert.equal(set.connections, 1)
    assert.deepEqual(set.messages.map((entry) => entry.connection), [1])
  })

  it('reports a frame still open at the end of the file', () => {
    const whole = frame(message({ controlId: 'A' }))
    const set = messagesFromFixture(fixture(CONNECTION, hexLine(whole.subarray(0, whole.length - 2), 0)))

    assert.deepEqual(set.messages, [])
    assert.deepEqual(set.incomplete, [{ connection: 1, bytes: whole.length - 2 }])
  })
})

describe('parseFixtureSteps', () => {
  it('skips blank lines and comments, strips whitespace in hex, treats empty data as a wait, treats a lone delayMs as a wait', () => {
    const parsed = parseFixtureSteps(fixture(
      '',
      '  // comment',
      '{"delayMs":1,"hex":"0b 4d 53 48 1c 0d"}',
      '{"delayMs":2,"hex":""}',
      '{"delayMs":3}',
      '{"delayMs":4,"event":"connection"}',
      '{"delayMs":5,"text":""}',
    ))

    assert.deepEqual(parsed.map((step) => step.kind), ['data', 'wait', 'wait', 'connection', 'wait'])
    assert.deepEqual(parsed.map((step) => step.line), [3, 4, 5, 6, 7])
    assert.deepEqual(parsed[0].kind === 'data' ? parsed[0].bytes : undefined, Buffer.from([0x0b, 0x4d, 0x53, 0x48, 0x1c, 0x0d]))
  })

  it('lets hex take precedence over event on the same line', () => {
    assert.equal(parseFixtureSteps('{"delayMs":0,"hex":"0b","event":"close"}\n')[0].kind, 'data')
  })

  it('defaults delayMs to 0 and rejects invalid values with the line number', () => {
    assert.equal(parseFixtureSteps('{"event":"connection"}\n')[0].delayMs, 0)
    assert.throws(() => parseFixtureSteps('\n{"delayMs":-1,"event":"close"}\n'), /line 2 has an invalid delayMs/)
    assert.throws(() => parseFixtureSteps('{"delayMs":"abc","hex":"0b"}\n'), /line 1 has an invalid delayMs/)
  })

  it('rejects unknown lines and broken JSON with the line number', () => {
    assert.throws(() => parseFixtureSteps('{"delayMs":0,"event":"connection"}\n{"delayMs":1,"foo":"bar"}\n'), /line 2 needs hex, text, event/)
    assert.throws(() => parseFixtureSteps('{"delayMs":0,"event":"wat"}\n'), /line 1 needs hex, text, event/)
    assert.throws(() => parseFixtureSteps('not json\n'), /line 1 is not valid JSON/)
  })
})

describe('messagesFromRawFiles', () => {
  it('sorts by the trailing number (raw-2 before raw-10), one message per file, no timing', () => {
    const set = messagesFromRawFiles([
      { name: 'raw-10.hl7', bytes: Buffer.from(message({ controlId: 'ten' }), 'utf-8') },
      { name: 'raw-2.hl7', bytes: Buffer.from(message({ controlId: 'two' }), 'utf-8') },
      { name: 'raw-001.hl7', bytes: Buffer.from(message({ controlId: 'one' }), 'utf-8') },
    ])

    assert.deepEqual(set.messages.map((entry) => controlIdOf(entry.bytes)), ['one', 'two', 'ten'])
    assert.deepEqual(set.messages.map((entry) => entry.delayMs), [0, 0, 0])
    assert.deepEqual(set.messages.map((entry) => entry.index), [1, 2, 3])
    assert.equal(set.connections, 1)
  })

  it('ignores a digit inside the extension when sorting', () => {
    const set = messagesFromRawFiles([
      { name: 'raw-2.hl7', bytes: Buffer.from(message({ controlId: 'two' }), 'utf-8') },
      { name: 'raw-1.hl7', bytes: Buffer.from(message({ controlId: 'one' }), 'utf-8') },
    ])

    assert.deepEqual(set.messages.map((entry) => controlIdOf(entry.bytes)), ['one', 'two'])
  })

  it('takes a file without framing whole (trailing CR included) and strips the framing from a framed file', () => {
    const bare = Buffer.from(message({ controlId: 'bare' }), 'utf-8')
    const set = messagesFromRawFiles([{ name: 'raw-1.hl7', bytes: bare }, { name: 'raw-2.hl7', bytes: frame(message({ controlId: 'wrapped' })) }])

    assert.deepEqual(set.messages[0].bytes, bare)
    assert.equal(set.messages[0].bytes[set.messages[0].bytes.length - 1], 0x0d)
    assert.deepEqual(set.messages[1].bytes, Buffer.from(message({ controlId: 'wrapped' }), 'utf-8'))
    assert.deepEqual(set.incomplete, [])
  })

  it('reads every frame of a multi-frame file and keeps an unterminated one, reported as incomplete', () => {
    const open = Buffer.concat([SB, Buffer.from(message({ controlId: 'open' }), 'utf-8')])
    const set = messagesFromRawFiles([{ name: 'x.hl7', bytes: Buffer.concat([frame(message({ controlId: 'A' })), open]) }])

    assert.deepEqual(set.messages.map((entry) => controlIdOf(entry.bytes)), ['A', 'open'])
    assert.deepEqual(set.incomplete, [{ connection: 1, bytes: open.length - 1 }])
  })

  it('returns independent copies, not views into the input', () => {
    const input = Buffer.from(message({ controlId: 'A' }), 'utf-8')
    const set = messagesFromRawFiles([{ name: 'raw-1.hl7', bytes: input }])

    input[0] = 0x58

    assert.equal(set.messages[0].bytes[0], 0x4d)
  })
})

const PATIENT_ID_RULE = { kind: 'patientId', segment: 'PID', field: 3, component: 1, everyRepetition: true, label: (n: number) => `TEST-${String(n).padStart(4, '0')}` }
const PET_NAME_RULE = { kind: 'petName', segment: 'PID', field: 5, label: (n: number) => `TestPet${String.fromCharCode(64 + n)}` }
const OWNER_RULE = { kind: 'owner', segment: 'PID', field: 21, label: (n: number) => `TEST-OWNER-${n}` }
const VET_RULE = { kind: 'vet', segment: 'PV1', field: 7, label: () => 'TestVet' }
const SPEC = [PATIENT_ID_RULE, PET_NAME_RULE, OWNER_RULE, VET_RULE]

const capturedAt = new Date('2025-03-10T02:11:42.184Z')
const options = { instrument: 'Demo Analyzer', tool: 'tools/live-capture.ts', capturedAt }

describe('buildFixture', () => {
  it('writes connection, hex chunks with their real boundaries, close and a trailing pause, with delays from the timeline', () => {
    const whole = frame(message())
    const cut = 100
    const events: CaptureEvent[] = [
      { kind: 'connection', connection: 1, atMs: 1000 },
      { kind: 'data', connection: 1, atMs: 1366, bytes: whole.subarray(0, cut) },
      { kind: 'data', connection: 1, atMs: 1369, bytes: whole.subarray(cut) },
      { kind: 'close', connection: 1, atMs: 1401, by: 'peer' },
    ]
    const result = buildFixture(events, { ...options, trailingWaitMs: 250 })
    const lines = steps(result.text)

    assert.deepEqual(lines[0], { delayMs: 0, event: 'connection' })
    assert.equal(lines[1].delayMs, 366)
    assert.equal(lines[2].delayMs, 3)
    assert.deepEqual(lines[3], { delayMs: 32, event: 'close' })
    assert.deepEqual(lines[4], { delayMs: 250 })
    assert.equal(result.connections, 1)
    assert.equal(result.chunks, 2)
    assert.equal(result.serialized, false)
    assert.equal(result.syntheticCloses, 0)
    assert.deepEqual(replayedBytes(result.text), whole)
    assert.match(result.text, /^\/\/ Generated by tools\/live-capture\.ts from a capture of Demo Analyzer\./)
    assert.match(result.text, /WARNING: not redacted/)
    assert.deepEqual(result.replaced, {})
  })

  it('reads back through messagesFromFixture with the same bytes and delays', () => {
    const whole = frame(message({ controlId: 'A' }))
    const events: CaptureEvent[] = [
      { kind: 'connection', connection: 1, atMs: 0 },
      { kind: 'data', connection: 1, atMs: 120, bytes: whole },
      { kind: 'close', connection: 1, atMs: 130, by: 'peer' },
      { kind: 'connection', connection: 2, atMs: 10130 },
      { kind: 'data', connection: 2, atMs: 10140, bytes: frame(message({ controlId: 'B' })) },
    ]
    const set = messagesFromFixture(buildFixture(events, options).text)

    assert.deepEqual(set.messages.map((entry) => controlIdOf(entry.bytes)), ['A', 'B'])
    assert.deepEqual(set.messages.map((entry) => entry.delayMs), [120, 10140 - 120])
    assert.equal(set.connections, 2)
  })

  it('redacts with the given redactor and leaves no fragment of an original anywhere in the file', () => {
    const originals = { patientId: 'PX-90817', petName: 'Mizzleton Fluffington', owner: 'Quinnfrey Hollowmere', vet: 'Dr. Vexley Marrowind' }
    const whole = frame(message(originals))
    const events: CaptureEvent[] = [
      { kind: 'connection', connection: 1, atMs: 0 },
      { kind: 'data', connection: 1, atMs: 10, bytes: whole },
      { kind: 'close', connection: 1, atMs: 20, by: 'peer' },
    ]
    const result = buildFixture(events, { ...options, redactor: createRedactor(SPEC) })

    for (const value of Object.values(originals)) {
      for (const piece of fragments(value)) assert.equal(result.text.includes(piece), false, `fragment "${piece}" must not survive`)
    }

    assert.deepEqual(result.replaced, { patientId: 1, petName: 1, owner: 1, vet: 1 })
    assert.deepEqual(result.warnings, [])
    assert.match(result.text, /Personal data redacted/)

    const [sent] = messagesFromFixture(result.text).messages
    const pid = findSegment(parseMessage(sent.bytes.toString('utf-8')), 'PID')

    assert.equal(field(pid, 3), 'TEST-0001^^^^^Demo Clinic')
    assert.equal(field(pid, 5), 'TestPetA')
    assert.equal(field(pid, 21), 'TEST-OWNER-1')
  })

  it('keeps a chunk boundary that falls inside a redacted value from leaking the first half', () => {
    const text = message({ petName: 'Mizzleton Fluffington' })
    const whole = frame(text)
    const cut = whole.indexOf(Buffer.from('Mizzleton')) + 4
    const events: CaptureEvent[] = [
      { kind: 'connection', connection: 1, atMs: 0 },
      { kind: 'data', connection: 1, atMs: 1, bytes: whole.subarray(0, cut) },
      { kind: 'data', connection: 1, atMs: 2, bytes: whole.subarray(cut) },
    ]
    const result = buildFixture(events, { ...options, redactor: createRedactor(SPEC) })
    const data = steps(result.text).filter((step) => typeof step.hex === 'string')

    assert.equal(data.length, 2)
    assert.equal(result.text.includes('Mizz'), false)
    assert.deepEqual(messagesFromFixture(result.text).messages.length, 1)
  })

  it('serializes overlapping connections, adds a close to the ones left open, and says so in the header', () => {
    const events: CaptureEvent[] = [
      { kind: 'connection', connection: 1, atMs: 0 },
      { kind: 'data', connection: 1, atMs: 10, bytes: frame(message({ controlId: 'A' })) },
      { kind: 'connection', connection: 2, atMs: 20 },
      { kind: 'data', connection: 2, atMs: 30, bytes: frame(message({ controlId: 'B' })) },
    ]
    const result = buildFixture(events, options)
    const set = messagesFromFixture(result.text)

    assert.equal(result.serialized, true)
    assert.equal(result.syntheticCloses, 1)
    assert.match(result.text, /WARNING: connections overlapped/)
    // Both connections stayed open; the first gets a synthetic close so the second lands on its own handle.
    assert.deepEqual(set.messages.map((entry) => controlIdOf(entry.bytes)), ['A', 'B'])
    assert.deepEqual(set.messages.map((entry) => entry.connection), [1, 2])
    assert.equal(steps(result.text).filter((step) => step.event === 'close').length, 1)
  })

  it('puts closed connections before the ones still open when serializing', () => {
    const events: CaptureEvent[] = [
      { kind: 'connection', connection: 1, atMs: 0 },
      { kind: 'data', connection: 1, atMs: 10, bytes: frame(message({ controlId: 'A' })) },
      { kind: 'connection', connection: 2, atMs: 20 },
      { kind: 'data', connection: 2, atMs: 30, bytes: frame(message({ controlId: 'B' })) },
      { kind: 'close', connection: 2, atMs: 40, by: 'peer' },
    ]
    const result = buildFixture(events, options)

    assert.equal(result.serialized, true)
    assert.equal(result.syntheticCloses, 0)
    assert.deepEqual(messagesFromFixture(result.text).messages.map((entry) => controlIdOf(entry.bytes)), ['B', 'A'])
  })

  it('writes an error step and a chunk emptied by redaction as a plain wait', () => {
    const text = message({ petName: 'Mizzleton Fluffington' })
    const whole = frame(text)
    const start = whole.indexOf(Buffer.from('Mizzleton'))
    const end = start + 'Mizzleton Fluffington'.length
    const events: CaptureEvent[] = [
      { kind: 'connection', connection: 1, atMs: 0 },
      { kind: 'data', connection: 1, atMs: 1, bytes: whole.subarray(0, start + 3) },
      { kind: 'data', connection: 1, atMs: 2, bytes: whole.subarray(start + 3, end - 3) },
      { kind: 'data', connection: 1, atMs: 3, bytes: whole.subarray(end - 3) },
      { kind: 'error', connection: 1, atMs: 4, message: 'reset' },
    ]
    const result = buildFixture(events, { ...options, redactor: createRedactor(SPEC) })
    const lines = steps(result.text)

    assert.equal(result.chunks, 2)
    assert.deepEqual(lines[2], { delayMs: 1 })
    assert.deepEqual(lines[4], { delayMs: 1, event: 'error', message: 'reset' })
    assert.deepEqual(replayedBytes(result.text), frame(createRedactor(SPEC).redactText(text)))
  })

  it('warns when an original survives somewhere the spec does not cover', () => {
    const obx = ['OBX|1|ST|X009^NOTE^DEMO||Mizzleton Fluffington||||||F']
    const events: CaptureEvent[] = [
      { kind: 'connection', connection: 1, atMs: 0 },
      { kind: 'data', connection: 1, atMs: 1, bytes: frame(message({ petName: 'Mizzleton Fluffington', obx })) },
    ]
    const result = buildFixture(events, { ...options, redactor: createRedactor(SPEC) })

    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /"petName" original \(21 bytes\) still appears 1 time/)
    assert.equal(result.warnings[0].includes('Mizzleton'), false)
    assert.match(result.text, /\/\/ WARNING: a "petName" original/)
  })

  it('does not warn about originals that are placeholders, as when a redacted fixture is captured again in another order', () => {
    const first = message({ controlId: 'A', patientId: 'TEST-0001', petName: 'TestPetA', owner: 'TEST-OWNER-1', vet: 'TestVet' })
    const second = message({ controlId: 'B', patientId: 'TEST-0002', petName: 'TestPetB', owner: 'TEST-OWNER-2', vet: 'TestVet' })
    const events: CaptureEvent[] = [
      { kind: 'connection', connection: 1, atMs: 0 },
      { kind: 'data', connection: 1, atMs: 10, bytes: frame(second) },
      { kind: 'data', connection: 1, atMs: 20, bytes: frame(first) },
    ]
    const result = buildFixture(events, { ...options, redactor: createRedactor(SPEC) })
    const pids = messagesFromFixture(result.text).messages.map((entry) => field(findSegment(parseMessage(entry.bytes.toString('utf-8')), 'PID'), 3))

    assert.deepEqual(pids, ['TEST-0001^^^^^Demo Clinic', 'TEST-0002^^^^^Demo Clinic'], 'renumbered in the order of arrival')
    assert.deepEqual(result.warnings, [])
    assert.equal(result.text.includes('// WARNING: a "'), false)
  })

  it('handles an empty event list', () => {
    const result = buildFixture([], options)

    assert.equal(result.connections, 0)
    assert.deepEqual(steps(result.text), [{ delayMs: 500 }])
  })
})

describe('frame helpers used by the tests', () => {
  it('build a frame that the parser accepts', () => {
    const bytes = frame('MSH|^~\\&|DEMO')

    assert.equal(bytes[0], SB[0])
    assert.deepEqual(bytes.subarray(bytes.length - 2), EB_CR)
  })
})
