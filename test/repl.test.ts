import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { MessageState } from '../src/repl.ts'
import { describePatientIdOverride, describeState, formatHl7DateTime, formatTable, parseCommand, validatePatientId } from '../src/repl.ts'

describe('parseCommand: sending', () => {
  it('treats bare numbers as the messages to send, separated by spaces or commas', () => {
    assert.deepEqual(parseCommand('3'), { kind: 'send', indexes: [3] })
    assert.deepEqual(parseCommand('  3 5 8 '), { kind: 'send', indexes: [3, 5, 8] })
    assert.deepEqual(parseCommand('3,5'), { kind: 'send', indexes: [3, 5] })
    assert.deepEqual(parseCommand('3, 5,8'), { kind: 'send', indexes: [3, 5, 8] })
  })

  it('decodes s, s n, s n m and a', () => {
    assert.deepEqual(parseCommand('s'), { kind: 'send-next' })
    assert.deepEqual(parseCommand('s 3'), { kind: 'send', indexes: [3] })
    assert.deepEqual(parseCommand('s 3 5'), { kind: 'send', indexes: [3, 5] })
    assert.deepEqual(parseCommand('a'), { kind: 'all' })
  })

  it('attaches a trailing id=<value> to sending commands only, without a patientId key otherwise', () => {
    assert.deepEqual(parseCommand('3 id=A123'), { kind: 'send', indexes: [3], patientId: 'A123' })
    assert.deepEqual(parseCommand('3 5 id=A123'), { kind: 'send', indexes: [3, 5], patientId: 'A123' })
    assert.deepEqual(parseCommand('3,5 id=A123'), { kind: 'send', indexes: [3, 5], patientId: 'A123' })
    assert.deepEqual(parseCommand('s id=A123'), { kind: 'send-next', patientId: 'A123' })
    assert.deepEqual(parseCommand('s 3 id=A123'), { kind: 'send', indexes: [3], patientId: 'A123' })
    assert.deepEqual(parseCommand('a id=A123'), { kind: 'all', patientId: 'A123' })
    assert.deepEqual(parseCommand('3'), { kind: 'send', indexes: [3] })
  })
})

describe('parseCommand: other commands', () => {
  it('decodes the single-word commands and their aliases', () => {
    assert.deepEqual(parseCommand('r'), { kind: 'resend' })
    assert.deepEqual(parseCommand('n'), { kind: 'connect' })
    assert.deepEqual(parseCommand('c'), { kind: 'close' })
    assert.deepEqual(parseCommand('k'), { kind: 'destroy' })
    assert.deepEqual(parseCommand('l'), { kind: 'list' })
    assert.deepEqual(parseCommand('h'), { kind: 'help' })
    assert.deepEqual(parseCommand('?'), { kind: 'help' })
    assert.deepEqual(parseCommand('help'), { kind: 'help' })
    assert.deepEqual(parseCommand('q'), { kind: 'quit' })
    assert.deepEqual(parseCommand('quit'), { kind: 'quit' })
    assert.deepEqual(parseCommand('exit'), { kind: 'quit' })
    assert.deepEqual(parseCommand('w 500'), { kind: 'wait', ms: 500 })
  })

  it('decodes id, id -, and id <value>; the value keeps a comma and is not validated here', () => {
    assert.deepEqual(parseCommand('id'), { kind: 'show-id' })
    assert.deepEqual(parseCommand('id -'), { kind: 'set-id', patientId: undefined })
    assert.deepEqual(parseCommand('id A123'), { kind: 'set-id', patientId: 'A123' })
    assert.deepEqual(parseCommand('  id   A123  '), { kind: 'set-id', patientId: 'A123' })
    assert.deepEqual(parseCommand('id A,1'), { kind: 'set-id', patientId: 'A,1' })
    assert.deepEqual(parseCommand('id A|B'), { kind: 'set-id', patientId: 'A|B' })
    assert.deepEqual(parseCommand('id A 1'), { kind: 'unknown', input: 'id A 1' })
  })

  it('decodes rand, rand on and rand off', () => {
    assert.deepEqual(parseCommand('rand'), { kind: 'show-random' })
    assert.deepEqual(parseCommand('rand on'), { kind: 'set-random', on: true })
    assert.deepEqual(parseCommand('rand off'), { kind: 'set-random', on: false })
    assert.deepEqual(parseCommand('  rand   on  '), { kind: 'set-random', on: true })
  })

  it('rejects anything else that starts with rand as unknown', () => {
    for (const input of ['rand x', 'rand on off', 'rand off on', 'rand on id=1', 'rand id=1', 'rand 1', 'rand ON', 'rand,on', 'random', 'rand-on']) {
      assert.deepEqual(parseCommand(input), { kind: 'unknown', input }, input)
    }
  })

  it('treats an empty line as a no-op', () => {
    assert.deepEqual(parseCommand(''), { kind: 'noop' })
    assert.deepEqual(parseCommand('   '), { kind: 'noop' })
  })

  it('rejects 0, words, bad arguments and extra arguments as unknown, keeping the input', () => {
    for (const input of ['0', '3 0', 'abc', 'w x', 'w', 's x', 'a 3', 'q now', 'r 2', 'l 1', 'n 1', 'c 1', 'k 1']) {
      assert.deepEqual(parseCommand(input), { kind: 'unknown', input }, input)
    }
  })

  it('rejects id= on non-sending commands, an empty id=, a lone id=<value> and a double id=', () => {
    for (const input of ['r id=A123', 'l id=A123', 'w 500 id=A123', 'q id=A123', 'n id=A', '3 id=', 'id=A123', '3 id=A id=B']) {
      assert.deepEqual(parseCommand(input), { kind: 'unknown', input }, input)
    }
  })
})

describe('validatePatientId', () => {
  it('accepts ordinary ids', () => {
    for (const value of ['A123', 'TEST-0001', 'A17231_2', '7939', 'A0028-12', 'ID 1']) {
      assert.equal(validatePatientId(value), undefined, value)
    }
  })

  it('rejects empty values, line breaks and HL7 delimiters with a reason', () => {
    assert.match(validatePatientId('') ?? '', /must not be empty/)
    assert.match(validatePatientId('   ') ?? '', /must not be empty/)
    assert.match(validatePatientId('A\nB') ?? '', /line breaks/)
    assert.match(validatePatientId('A\rB') ?? '', /line breaks/)

    for (const bad of ['A|B', 'A^B', 'A~B', 'A\\B', 'A&B']) {
      assert.match(validatePatientId(bad) ?? '', /delimiters/, bad)
    }
  })
})

describe('describePatientIdOverride', () => {
  it('describes both states', () => {
    assert.equal(describePatientIdOverride('A123'), 'Patient id override: A123 (applied to messages with a PID segment; "id -" clears it)')
    assert.equal(describePatientIdOverride(undefined), 'Patient id override: none ("id <value>" sets it; "<n> id=<value>" applies once)')
  })
})

describe('describeState', () => {
  const now = 1_800_000_000_000
  const fresh = (): MessageState => ({ sent: 0, pending: 0, timedOut: 0, connectFailed: 0 })

  it('covers not sent, sent with last ACK, awaiting, timed out and connect failed', () => {
    assert.equal(describeState(fresh(), now), 'not sent')
    assert.equal(describeState({ ...fresh(), sent: 1, lastAck: { code: 'AA', atMs: now - 3200 } }, now), 'sent 1×, last AA 3 s ago')
    assert.equal(describeState({ ...fresh(), sent: 2, pending: 1, lastAck: { code: 'AE', atMs: now } }, now), 'sent 2×, last AE 0 s ago, awaiting ACK')
    assert.equal(describeState({ ...fresh(), sent: 1, timedOut: 1 }, now), 'sent 1×, timed out 1×')
    assert.equal(describeState({ ...fresh(), sent: 1, pending: 1 }, now), 'sent 1×, awaiting ACK')
    assert.equal(describeState({ ...fresh(), sent: 1, connectFailed: 1 }, now), 'sent 1×, connect failed 1×')
  })

  it('never reports a negative age', () => {
    assert.equal(describeState({ ...fresh(), sent: 1, lastAck: { code: 'AA', atMs: now + 5000 } }, now), 'sent 1×, last AA 0 s ago')
  })
})

describe('formatTable', () => {
  it('pads every column but the last to the widest cell, two spaces between columns', () => {
    const lines = formatTable(['#', 'Patient', 'Expected'], [['[1]', 'PX-1', 'upload 2 items'], ['[10]', 'PX-1234', 'skip']])

    assert.deepEqual(lines, [
      '#     Patient  Expected',
      '[1]   PX-1     upload 2 items',
      '[10]  PX-1234  skip',
    ])
    assert.ok(lines.every((line) => line.endsWith(' ') === false))
  })

  it('counts wide characters as two columns so mixed-width cells still align', () => {
    // Fullwidth Latin letters are East Asian wide characters without being ideographs.
    const wide = String.fromCharCode(0xff21, 0xff22)
    const lines = formatTable(['#', 'Name', 'Value'], [['[1]', 'Ab', 'x'], ['[2]', wide, 'y']])
    const width = (text: string): number => [...text].reduce((sum, ch) => sum + ((ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1), 0)
    const starts = lines.map((line) => width(line.slice(0, line.lastIndexOf(' ') + 1)))

    assert.equal(starts[1], starts[2])
    assert.equal(lines[2], `[2]  ${wide}  y`)
  })

  it('pads short rows with empty cells and truncates long rows', () => {
    const lines = formatTable(['a', 'b'], [['1'], ['1', '2', '3']])

    assert.deepEqual(lines, ['a  b', '1  ', '1  2'])
  })

  it('returns only the header for no rows', () => {
    assert.deepEqual(formatTable(['a', 'b'], []), ['a  b'])
  })
})

describe('formatHl7DateTime', () => {
  it('formats 14 digits, with an offset, or with fractional seconds, as yyyy-MM-dd HH:mm:ss', () => {
    assert.equal(formatHl7DateTime('20250310194116'), '2025-03-10 19:41:16')
    assert.equal(formatHl7DateTime('20250310194116+0800'), '2025-03-10 19:41:16')
    assert.equal(formatHl7DateTime('20250310194116.123'), '2025-03-10 19:41:16')
  })

  it('returns an em dash for a date-only, minute-precision or empty value', () => {
    assert.equal(formatHl7DateTime('20250310'), '—')
    assert.equal(formatHl7DateTime('202503101941'), '—')
    assert.equal(formatHl7DateTime(''), '—')
    assert.equal(formatHl7DateTime('   '), '—')
  })
})
