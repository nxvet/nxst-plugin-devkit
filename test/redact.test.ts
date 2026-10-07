import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { component, extractMllpFrames, field, findSegment, findSegments, parseMessage } from '@nxvet/nxst-hl7-parser'

import type { RedactionRule, Redactor } from '../src/redact.ts'
import { createRedactor, redactChunks, residualCheck } from '../src/redact.ts'
import { fragments, frame, message } from './support.ts'

const patientId: RedactionRule = { kind: 'patientId', segment: 'PID', field: 3, component: 1, everyRepetition: true, label: (n) => `TEST-${String(n).padStart(4, '0')}` }
const petName: RedactionRule = { kind: 'petName', segment: 'PID', field: 5, label: (n) => `TestPet${String.fromCharCode(64 + n)}` }
const owner: RedactionRule = { kind: 'owner', segment: 'PID', field: 21, label: (n) => `TEST-OWNER-${n}` }
const vet: RedactionRule = { kind: 'vet', segment: 'PV1', field: 7, label: () => 'TestVet' }
const SPEC = [patientId, petName, owner, vet]

const originals = { patientId: 'PX-90817', petName: 'Mizzleton Fluffington', owner: 'Quinnfrey Hollowmere', vet: 'Dr. Vexley Marrowind' }

const pidOf = (text: string) => findSegment(parseMessage(text), 'PID')

describe('createRedactor', () => {
  it('replaces each configured field and keeps every other byte', () => {
    const text = message(originals)
    const out = createRedactor(SPEC).redactText(text)
    const pid = pidOf(out)
    const pv1 = findSegment(parseMessage(out), 'PV1')

    assert.equal(field(pid, 3), 'TEST-0001^^^^^Demo Clinic')
    assert.equal(field(pid, 5), 'TestPetA')
    assert.equal(field(pid, 21), 'TEST-OWNER-1')
    assert.equal(field(pv1, 7), 'TestVet')
    assert.equal(out.replace(/TEST-0001|TestPetA|TEST-OWNER-1|TestVet/g, 'X'), text.replace(/PX-90817|Mizzleton Fluffington|Quinnfrey Hollowmere|Dr\. Vexley Marrowind/g, 'X'))
  })

  it('leaves no fragment of any original in the output', () => {
    const out = createRedactor(SPEC).redactText(message(originals))

    for (const value of Object.values(originals)) {
      for (const piece of fragments(value)) assert.equal(out.includes(piece), false, piece)
    }
  })

  it('maps the same original to the same placeholder across messages and numbers distinct ones', () => {
    const redactor = createRedactor(SPEC)
    const first = redactor.redactText(message({ patientId: 'PX-1', petName: 'Alpha Quux' }))
    const second = redactor.redactText(message({ patientId: 'PX-2', petName: 'Alpha Quux' }))
    const third = redactor.redactText(message({ patientId: 'PX-1', petName: 'Beta Quux' }))

    assert.equal(component(field(pidOf(first), 3), 1), 'TEST-0001')
    assert.equal(component(field(pidOf(second), 3), 1), 'TEST-0002')
    assert.equal(component(field(pidOf(third), 3), 1), 'TEST-0001')
    assert.equal(field(pidOf(first), 5), 'TestPetA')
    assert.equal(field(pidOf(second), 5), 'TestPetA')
    assert.equal(field(pidOf(third), 5), 'TestPetB')
    assert.deepEqual(redactor.counts(), { patientId: 2, petName: 2, owner: 1, vet: 1 })
  })

  it('shares one map between rules of the same kind', () => {
    const spec: RedactionRule[] = [
      { kind: 'patientId', segment: 'PID', field: 3, component: 1, label: (n) => `TEST-${n}` },
      { kind: 'patientId', segment: 'PID', field: 2, label: (n) => `TEST-${n}` },
    ]
    const redactor = createRedactor(spec)
    const out = redactor.redactText(message({ pid: 'PID|1|SAME-ID|SAME-ID^^^^^Clinic' }))

    assert.equal(field(pidOf(out), 2), 'TEST-1')
    assert.equal(field(pidOf(out), 3), 'TEST-1^^^^^Clinic')
    assert.deepEqual(redactor.counts(), { patientId: 1 })
  })

  it('leaves empty and whitespace-only fields alone', () => {
    const redactor = createRedactor(SPEC)
    const out = redactor.redactText(message({ pid: 'PID|1||  ^^^^^Clinic||   ||M' }))

    assert.equal(field(pidOf(out), 3), '  ^^^^^Clinic')
    assert.equal(field(pidOf(out), 5), '   ')
    assert.deepEqual(redactor.counts(), { patientId: 0, petName: 0, owner: 0, vet: 1 })
  })

  it('keeps surrounding whitespace in place and redacts only the trimmed value', () => {
    const out = createRedactor(SPEC).redactText(message({ pid: 'PID|1|| PX-7 ^^^^^Clinic|| Fuzzle ||M' }))

    assert.equal(field(pidOf(out), 3), ' TEST-0001 ^^^^^Clinic')
    assert.equal(field(pidOf(out), 5), ' TestPetA ')
  })

  it('redacts every repetition when asked, and only the first otherwise', () => {
    const every = createRedactor([patientId]).redactText(message({ pid: 'PID|1||A-1^^^^^C1~A-2^^^^^C2' }))
    const first = createRedactor([{ ...patientId, everyRepetition: false }]).redactText(message({ pid: 'PID|1||A-1^^^^^C1~A-2^^^^^C2' }))

    assert.equal(field(pidOf(every), 3), 'TEST-0001^^^^^C1~TEST-0002^^^^^C2')
    assert.equal(field(pidOf(first), 3), 'TEST-0001^^^^^C1~A-2^^^^^C2')
  })

  it('redacts a whole repetition when no component is given', () => {
    const rule: RedactionRule = { kind: 'alias', segment: 'PID', field: 3, everyRepetition: true, label: (n) => `ALIAS-${n}` }
    const out = createRedactor([rule]).redactText(message({ pid: 'PID|1||A-1^^^^^C1~A-2' }))

    assert.equal(field(pidOf(out), 3), 'ALIAS-1~ALIAS-2')
  })

  it('redacts the whole field, repetitions included, when neither component nor everyRepetition is given', () => {
    const out = createRedactor([owner]).redactText(message({ pid: `PID|1||X||Y||||||||||||||||One~Two` }))

    assert.equal(field(pidOf(out), 21), 'TEST-OWNER-1')
  })

  it('applies a rule only where its predicate holds', () => {
    const rule: RedactionRule = {
      kind: 'note',
      segment: 'OBX',
      field: 5,
      when: (segment) => component(segment.field(3), 2) === 'NAME',
      label: (n) => `NOTE-${n}`,
    }
    const obx = ['OBX|1|ST|X009^NAME^DEMO||Mizzleton Fluffington||||||F', 'OBX|2|NM|X001^GLU^DEMO||98|mg/dL||||F']
    const out = createRedactor([rule]).redactText(message({ obx }))
    const [first, second] = findSegments(parseMessage(out), 'OBX')

    assert.equal(field(first, 5), 'NOTE-1')
    assert.equal(field(second, 5), '98')
  })

  it('gives the predicate the segment name and MSH-aware field numbering', () => {
    const seen: Array<[string, string]> = []
    const rule: RedactionRule = { kind: 'x', segment: 'MSH', field: 3, when: (segment) => { seen.push([segment.name, segment.field(10)]); return false }, label: (n) => `X${n}` }

    createRedactor([rule]).redactText(message({ controlId: 'CTRL-9' }))

    assert.deepEqual(seen, [['MSH', 'CTRL-9']])
  })

  it('matches segment names the way the parser does (trimmed) and skips segments without the field', () => {
    const redactor = createRedactor(SPEC)
    const out = redactor.redactText('MSH|^~\\&|DEMO\r PID |1||PX-5\rPV1|1\r')

    assert.equal(field(pidOf(out), 3), 'TEST-0001')
    assert.deepEqual(redactor.counts(), { patientId: 1, petName: 0, owner: 0, vet: 0 })
  })

  it('finds replacements in a stream with several frames and noise, sorted by position', () => {
    const redactor = createRedactor(SPEC)
    const stream = Buffer.concat([Buffer.from('noise'), frame(message({ patientId: 'PX-1' })), frame(message({ patientId: 'PX-2' }))])
    const found = redactor.findInStream(stream)

    assert.deepEqual(found.map((entry) => entry.kind), ['patientId', 'petName', 'owner', 'vet', 'patientId', 'petName', 'owner', 'vet'])
    assert.ok(found.every((entry, index) => index === 0 || entry.start >= found[index - 1].end))
    assert.deepEqual(found.filter((entry) => entry.kind === 'patientId').map((entry) => entry.value), ['TEST-0001', 'TEST-0002'])
  })

  it('redacts a frame that is still open in the stream', () => {
    const redactor = createRedactor(SPEC)
    const open = Buffer.concat([Buffer.from([0x0b]), Buffer.from(message({ patientId: 'PX-OPEN' }), 'utf-8')])
    const found = redactor.findInStream(open)

    assert.equal(found.filter((entry) => entry.kind === 'patientId').length, 1)
  })

  it('exposes originals for the residual check only', () => {
    const redactor = createRedactor(SPEC)

    redactor.redactText(message(originals))

    assert.deepEqual(redactor.originals().map((entry) => entry.kind), ['patientId', 'petName', 'owner', 'vet'])
    assert.deepEqual(redactor.originals().map((entry) => entry.value), Object.values(originals))
    assert.deepEqual(redactor.kinds, ['patientId', 'petName', 'owner', 'vet'])
  })

  it('rejects placeholders that contain delimiters or line breaks, empty placeholders, and placeholders shared by two kinds', () => {
    assert.throws(() => createRedactor([{ kind: 'a', segment: 'PID', field: 3, label: () => 'A|B' }]), /delimiter or a line break/)
    assert.throws(() => createRedactor([{ kind: 'a', segment: 'PID', field: 3, label: () => 'A\nB' }]), /delimiter or a line break/)
    assert.throws(() => createRedactor([{ kind: 'a', segment: 'PID', field: 3, label: () => '' }]), /is empty/)
    assert.throws(() => createRedactor([
      { kind: 'a', segment: 'PID', field: 3, label: (n) => `SAME-${n}` },
      { kind: 'b', segment: 'PID', field: 5, label: (n) => `SAME-${n}` },
    ]), /produce the same placeholder/)
    assert.throws(() => createRedactor([{ kind: '', segment: 'PID', field: 3, label: () => 'X' }]), /empty kind/)
    assert.throws(() => createRedactor([{ kind: 'a', segment: 'PID', field: 0, label: () => 'X' }]), /positive integer/)
  })

  it('accepts a constant placeholder and placeholders of different kinds that merely share a prefix', () => {
    assert.doesNotThrow(() => createRedactor(SPEC))
  })
})

describe('redactChunks', () => {
  const text = message(originals)
  const whole = frame(text)
  const expected = frame(createRedactor(SPEC).redactText(text))

  it('keeps the number of chunks and the bytes outside the redacted values', () => {
    const cut = 40
    const out = redactChunks([whole.subarray(0, cut), whole.subarray(cut)], createRedactor(SPEC))

    assert.equal(out.length, 2)
    assert.deepEqual(Buffer.concat(out), expected)
    assert.deepEqual(out[0], expected.subarray(0, cut))
  })

  it('moves a boundary inside an original to the end of the placeholder so no half survives', () => {
    const start = whole.indexOf(Buffer.from('Mizzleton'))

    for (const cut of [start, start + 1, start + 5, start + 'Mizzleton Fluffington'.length - 1, start + 'Mizzleton Fluffington'.length]) {
      const out = redactChunks([whole.subarray(0, cut), whole.subarray(cut)], createRedactor(SPEC))
      const joined = Buffer.concat(out)

      assert.deepEqual(joined, expected, `cut at ${cut}`)

      for (const piece of out) {
        for (const fragment of fragments('Mizzleton Fluffington')) assert.equal(piece.includes(fragment), false, `cut ${cut}: fragment "${fragment}"`)
      }
    }
  })

  it('handles a cut inside the field a predicate reads, because the predicate sees the joined stream', () => {
    const rule: RedactionRule = { kind: 'note', segment: 'OBX', field: 5, when: (segment) => component(segment.field(3), 2) === 'NAME', label: (n) => `NOTE-${n}` }
    const obx = ['OBX|1|ST|X009^NAME^DEMO||Mizzleton Fluffington||||||F']
    const framed = frame(message({ obx }))
    const cut = framed.indexOf(Buffer.from('NAME')) + 2
    const out = redactChunks([framed.subarray(0, cut), framed.subarray(cut)], createRedactor([rule]))
    const { frames } = extractMllpFrames(Buffer.concat(out))

    assert.equal(field(findSegments(parseMessage(frames[0]), 'OBX')[0], 5), 'NOTE-1')
  })

  it('redacts a value that spans two frames worth of chunks and keeps placeholders consistent across frames', () => {
    const second = frame(message({ patientId: 'PX-90817', petName: 'Other Pet' }))
    const stream = Buffer.concat([whole, second])
    const out = redactChunks([stream.subarray(0, 700), stream.subarray(700, 1400), stream.subarray(1400)], createRedactor(SPEC))
    const { frames } = extractMllpFrames(Buffer.concat(out))

    assert.equal(frames.length, 2)
    assert.equal(component(field(pidOf(frames[0]), 3), 1), 'TEST-0001')
    assert.equal(component(field(pidOf(frames[1]), 3), 1), 'TEST-0001')
    assert.equal(field(pidOf(frames[1]), 5), 'TestPetB')
  })

  it('returns a chunk unchanged when nothing in it needs redaction, and an empty list for no chunks', () => {
    const plain = Buffer.from('noise before any frame')

    assert.deepEqual(redactChunks([plain], createRedactor(SPEC)), [plain])
    assert.deepEqual(redactChunks([], createRedactor(SPEC)), [])
  })
})

describe('residualCheck', () => {
  it('reports an original that survived, without printing it', () => {
    const redactor = createRedactor(SPEC)
    const out = redactor.redactText(message(originals))
    const warnings = residualCheck([Buffer.from(`${out}Mizzleton Fluffington`)], redactor)

    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /"petName" original \(21 bytes\) still appears 1 time\(s\)/)
    assert.equal(warnings[0].includes('Mizzleton'), false)
  })

  it('is silent when every original is gone and skips originals shorter than the minimum', () => {
    const redactor = createRedactor(SPEC)
    const out = redactor.redactText(message({ ...originals, patientId: 'A1' }))

    assert.deepEqual(residualCheck([Buffer.from(out)], redactor), [])
    assert.deepEqual(residualCheck([Buffer.from(`${out}A1A1`)], redactor), [])
    assert.equal(residualCheck([Buffer.from(`${out}A1A1`)], redactor, 2).length, 1)
  })

  it('skips originals that are placeholders themselves, as when an already-redacted message is redacted again', () => {
    const redacted = createRedactor(SPEC).redactText(message(originals))
    const redactor = createRedactor(SPEC)
    const out = redactor.redactText(redacted)

    assert.equal(out, redacted, 'every placeholder maps to itself')
    assert.deepEqual(redactor.originals().map((entry) => entry.value), ['TEST-0001', 'TestPetA', 'TEST-OWNER-1', 'TestVet'])
    assert.deepEqual(residualCheck([Buffer.from(out)], redactor), [])
  })

  it('skips an original that equals the placeholder of another one, as when only some redacted messages are sent, or in another order', () => {
    for (const ids of [['TEST-0002', 'TEST-0003'], ['TEST-0002', 'TEST-0001']]) {
      const redactor = createRedactor(SPEC)
      const out = ids.map((id) => redactor.redactText(message({ patientId: id, petName: 'TestPetA', owner: 'TEST-OWNER-1', vet: 'TestVet' })))

      assert.deepEqual(out.map((text) => component(field(pidOf(text), 3), 1)), ['TEST-0001', 'TEST-0002'], `${ids.join(', ')}: renumbered from 1`)
      assert.deepEqual(residualCheck([Buffer.from(out.join(''))], redactor), [], ids.join(', '))
    }
  })

  it('still reports a real original that survived next to originals that are placeholders', () => {
    const redactor = createRedactor(SPEC)
    const obx = ['OBX|1|ST|X009^NOTE^DEMO||Mizzleton Fluffington||||||F']
    const out = redactor.redactText(message({ patientId: 'TEST-0002', petName: 'Mizzleton Fluffington', owner: 'TEST-OWNER-1', vet: 'TestVet', obx }))
    const warnings = residualCheck([Buffer.from(out)], redactor)

    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /"petName" original \(21 bytes\) still appears 1 time\(s\)/)
    assert.equal(warnings[0].includes('Mizzleton'), false)
  })

  it('checks every original of a redactor that createRedactor did not make, since its placeholders are unknown', () => {
    const redactor = createRedactor(SPEC)
    const out = redactor.redactText(createRedactor(SPEC).redactText(message(originals)))
    const wrapped: Redactor = { ...redactor }

    assert.deepEqual(residualCheck([Buffer.from(out)], redactor), [])
    assert.equal(residualCheck([Buffer.from(out)], wrapped).length, 4)
  })
})
