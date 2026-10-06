import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MLLP_CR, MLLP_END, MLLP_START, extractMllpFrames, field, findSegment, parseMessage } from '@nxvet/nxst-hl7-parser'

import { rewriteFields, splitChunks, wrapFrame } from '../src/edit.ts'
import { message } from './support.ts'

/** The original with one plain-text substitution, to assert "only that field differs". */
const expectBytes = (text: string, from: string, to: string): Buffer => {
  assert.equal(text.includes(from), true, `test material lacks ${from}`)

  return Buffer.from(text.replace(from, to), 'utf-8')
}

describe('rewriteFields', () => {
  const original = message()
  const bytes = Buffer.from(original, 'utf-8')

  it('changes only the named field (MSH-10) and leaves the input untouched', () => {
    const out = rewriteFields(bytes, [{ name: 'MSH-10', segment: 'MSH', field: 10, value: 'CTRL-99' }])

    assert.deepEqual(out.bytes, expectBytes(original, '|ORU^R01|CTRL-1|', '|ORU^R01|CTRL-99|'))
    assert.deepEqual(out.applied, ['MSH-10'])
    assert.deepEqual(out.skipped, [])
    assert.deepEqual(bytes, Buffer.from(original, 'utf-8'))
  })

  it('changes MSH-7 only', () => {
    const out = rewriteFields(bytes, [{ name: 'MSH-7', segment: 'MSH', field: 7, value: '20251231235959' }])

    assert.deepEqual(out.bytes, expectBytes(original, '||20250310104500||', '||20251231235959||'))
  })

  it('applies several edits in one pass, in the order given', () => {
    const out = rewriteFields(bytes, [
      { name: 'MSH-10', segment: 'MSH', field: 10, value: 'CTRL-2' },
      { name: 'MSH-7', segment: 'MSH', field: 7, value: '20251231235959' },
    ])
    const msh = findSegment(parseMessage(out.bytes.toString('utf-8')), 'MSH')

    assert.equal(field(msh, 10), 'CTRL-2')
    assert.equal(field(msh, 7), '20251231235959')
    assert.deepEqual(out.applied, ['MSH-10', 'MSH-7'])
  })

  it('replaces one component and keeps the other components and repetitions', () => {
    const text = message({ pid: 'PID|1||PX-1111^^^NXVET^MR~PX-2222^^^OTHER' })
    const out = rewriteFields(Buffer.from(text, 'utf-8'), [{ name: 'PID-3.1', segment: 'PID', field: 3, component: 1, value: 'TEST-9999' }])

    assert.deepEqual(out.bytes, expectBytes(text, 'PID|1||PX-1111^^^NXVET^MR~PX-2222', 'PID|1||TEST-9999^^^NXVET^MR~PX-2222'))
  })

  it('addresses a later repetition when asked', () => {
    const text = message({ pid: 'PID|1||A-1^^^C1~A-2^^^C2' })
    const out = rewriteFields(Buffer.from(text, 'utf-8'), [{ name: 'PID-3[2].1', segment: 'PID', field: 3, repetition: 2, component: 1, value: 'B-2' }])

    assert.equal(field(findSegment(parseMessage(out.bytes.toString('utf-8')), 'PID'), 3), 'A-1^^^C1~B-2^^^C2')
  })

  it('inserts into an empty field or component instead of skipping', () => {
    const empty = message({ pid: 'PID|1|||||||M' })
    const out = rewriteFields(Buffer.from(empty, 'utf-8'), [{ name: 'PID-3.1', segment: 'PID', field: 3, component: 1, value: 'TEST-9999' }])

    assert.deepEqual(out.bytes, expectBytes(empty, 'PID|1|||||||M', 'PID|1||TEST-9999|||||M'))
    assert.deepEqual(out.applied, ['PID-3.1'])
  })

  it('skips, without synthesising, a missing segment, a short segment, a missing repetition or a missing component', () => {
    const short = 'MSH|^~\\&|DEMO\rPID|1\r'
    const out = rewriteFields(Buffer.from(short, 'utf-8'), [
      { name: 'MSH-10', segment: 'MSH', field: 10, value: 'X' },
      { name: 'PID-3.1', segment: 'PID', field: 3, component: 1, value: 'X' },
      { name: 'OBR-7', segment: 'OBR', field: 7, value: 'X' },
      { name: 'PID-1[2]', segment: 'PID', field: 1, repetition: 2, value: 'X' },
      { name: 'PID-1.3', segment: 'PID', field: 1, component: 3, value: 'X' },
    ])

    assert.deepEqual(out.bytes, Buffer.from(short, 'utf-8'))
    assert.deepEqual(out.applied, [])
    assert.deepEqual(out.skipped.map((entry) => entry.name), ['MSH-10', 'PID-3.1', 'OBR-7', 'PID-1[2]', 'PID-1.3'])
    assert.match(out.skipped[0].reason, /fewer than 10 fields/)
    assert.match(out.skipped[2].reason, /no OBR segment/)
    assert.match(out.skipped[3].reason, /no repetition 2/)
    assert.match(out.skipped[4].reason, /no component 3/)
  })

  it('returns an identical copy when there are no edits', () => {
    assert.deepEqual(rewriteFields(bytes, []), { bytes: Buffer.from(original, 'utf-8'), applied: [], skipped: [] })
  })

  it('edits the first segment of a repeated name only', () => {
    const text = message({ obx: ['OBX|1|NM|X001^GLU^DEMO||98', 'OBX|2|NM|X002^BUN^DEMO||12'] })
    const out = rewriteFields(Buffer.from(text, 'utf-8'), [{ name: 'OBX-5', segment: 'OBX', field: 5, value: '0' }])

    assert.deepEqual(out.bytes, expectBytes(text, 'X001^GLU^DEMO||98', 'X001^GLU^DEMO||0'))
  })

  it('leaves a byte that is not valid UTF-8 elsewhere in the message untouched', () => {
    const weird = Buffer.concat([Buffer.from(message().replace('\r', '\r'), 'utf-8').subarray(0, -1), Buffer.from([0xff, 0x0d])])
    const out = rewriteFields(weird, [{ name: 'MSH-10', segment: 'MSH', field: 10, value: 'CTRL-7' }])

    assert.equal(out.bytes.indexOf(Buffer.from([0xff, 0x0d])), out.bytes.length - 2)
    assert.equal(out.bytes.length, weird.length - 'CTRL-1'.length + 'CTRL-7'.length)
  })

  it('throws when two edits overlap', () => {
    assert.throws(() => rewriteFields(bytes, [
      { name: 'a', segment: 'MSH', field: 10, value: 'X' },
      { name: 'b', segment: 'MSH', field: 10, value: 'Y' },
    ]), RangeError)
  })
})

describe('wrapFrame', () => {
  it('adds <SB> and <EB><CR> around the bytes and round-trips through the parser', () => {
    const bytes = Buffer.from(message(), 'utf-8')
    const wrapped = wrapFrame(bytes)

    assert.equal(wrapped[0], MLLP_START)
    assert.deepEqual(wrapped.subarray(wrapped.length - 2), Buffer.from([MLLP_END, MLLP_CR]))
    assert.deepEqual(extractMllpFrames(wrapped).frames, [message()])
  })

  it('does not decode the bytes', () => {
    const wrapped = wrapFrame(Buffer.from([0xff, 0xfe]))

    assert.deepEqual(wrapped, Buffer.from([MLLP_START, 0xff, 0xfe, MLLP_END, MLLP_CR]))
  })
})

describe('splitChunks', () => {
  const bytes = Buffer.from('0123456789')

  it('cuts at the given size with a shorter last chunk, and concatenates back to the input', () => {
    const chunks = splitChunks(bytes, 4)

    assert.deepEqual(chunks.map((chunk) => chunk.toString()), ['0123', '4567', '89'])
    assert.deepEqual(Buffer.concat(chunks), bytes)
  })

  it('returns a single independent copy for 0, negative, fractional, NaN or not-smaller sizes', () => {
    for (const size of [0, -1, 2.5, 10, 11, Number.NaN]) {
      const chunks = splitChunks(bytes, size)

      assert.equal(chunks.length, 1, `size=${size}`)
      assert.deepEqual(chunks[0], bytes)
      assert.notEqual(chunks[0].buffer, bytes.buffer)
    }
  })

  it('splits a frame larger than a typical TCP segment into segment-sized pieces', () => {
    const big = wrapFrame(Buffer.alloc(3000, 0x41))
    const chunks = splitChunks(big, 1448)

    assert.deepEqual(chunks.map((chunk) => chunk.length), [1448, 1448, 107])
  })
})
