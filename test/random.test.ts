// Random result values: the range rule, the decimals rule, the draw, the seeded generator and the
// range position used to recompute flags. Every number here is synthetic.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { RandomPick, RandomRange, ResultValue } from '../src/random.ts'
import { createRandomValue, randomRange, rangePosition, seededRandom } from '../src/random.ts'

const result = (value: string, low = '', high = '', name = 'ITEM'): ResultValue => ({ name, value, low, high })

const reference = (min: number, max: number, decimals: number): RandomRange => ({ min, max, decimals, basis: 'reference' })
const fromValue = (min: number, max: number, decimals: number): RandomRange => ({ min, max, decimals, basis: 'value' })

/** The next `n` numbers of a generator. */
const take = (random: () => number, n: number): number[] => Array.from({ length: n }, () => random())

describe('randomRange', () => {
  it('widens the reference range by a fifth of its span on each side, exactly', () => {
    // In floating point, 7.31 - 0.2 * (7.42 - 7.31) is 7.287999999999999 and 0.5 - 0.2 * (1.3 - 0.5)
    // is 0.33999999999999997; the bounds must be exactly 7.288 and 0.34.
    assert.deepEqual(randomRange(result('7.074', '7.31', '7.42')), reference(7.288, 7.442, 3))
    assert.deepEqual(randomRange(result('98', '74', '146')), reference(59.6, 160.4, 0))
    assert.deepEqual(randomRange(result('0.81', '0.5', '1.3')), reference(0.34, 1.46, 2))
  })

  it('does not go below 0 when the reference range starts at 0 or above', () => {
    assert.deepEqual(randomRange(result('2', '0', '5')), reference(0, 6, 0))
    assert.deepEqual(randomRange(result('1.5', '0.5', '9.0')), reference(0, 10.7, 1))
    // A range that starts high enough is widened without reaching 0.
    assert.deepEqual(randomRange(result('15', '10', '20')), reference(8, 22, 0))
  })

  it('widens a range that starts below 0 without clamping', () => {
    assert.deepEqual(randomRange(result('0', '-3', '3')), reference(-4.2, 4.2, 0))
    assert.deepEqual(randomRange(result('-2.5', '-10.6', '1')), reference(-12.92, 3.32, 1))
    assert.deepEqual(randomRange(result('-7', '-9', '-5')), reference(-9.8, -4.2, 0))
  })

  it('gives a one-point range when low equals high', () => {
    assert.deepEqual(randomRange(result('4', '4', '4')), reference(4, 4, 0))
    assert.deepEqual(randomRange(result('4.1', '4.20', '4.2')), reference(4.2, 4.2, 2))
    assert.deepEqual(randomRange(result('1', '-2', '-2')), reference(-2, -2, 0))
  })

  it('runs from 0 to twice the value when there is no usable reference range', () => {
    const cases = [['', ''], ['74', ''], ['', '146'], ['<74', '146'], ['74', 'n/a'], ['146', '74'], ['-', '-']]

    for (const [low, high] of cases) {
      assert.deepEqual(randomRange(result('12', low, high)), fromValue(0, 24, 0), `low ${JSON.stringify(low)}, high ${JSON.stringify(high)}`)
    }
  })

  it('runs from twice a negative value to 0, and from 0 to 1 for a value of 0', () => {
    assert.deepEqual(randomRange(result('-1.5')), fromValue(-3, 0, 1))
    assert.deepEqual(randomRange(result('0')), fromValue(0, 1, 0))
    assert.deepEqual(randomRange(result('0.00')), fromValue(0, 1, 2))
    // Strict deep equality tells -0 from 0, so these also pin "no negative zero".
    assert.deepEqual(randomRange(result('-0')), fromValue(0, 1, 0))
    assert.deepEqual(randomRange(result('-0.0', '5', '1')), fromValue(0, 1, 1))
  })

  it('takes the decimals from the value and the bounds that are plain numbers', () => {
    assert.equal(randomRange(result('7.074', '7.31', '7.42'))?.decimals, 3)
    assert.equal(randomRange(result('7', '7.31', '7.42'))?.decimals, 2)
    assert.equal(randomRange(result('7.1', '<7.310', '7.42'))?.decimals, 2, 'a bound that is not a plain number does not count')
    assert.equal(randomRange(result('12.50'))?.decimals, 2)
    assert.equal(randomRange(result('12', '1.000', 'n/a'))?.decimals, 3, 'a lone bound that is a plain number counts')
  })

  it('accepts a plain number with whitespace around it', () => {
    assert.deepEqual(randomRange(result(' 5.5 ', ' 1.0', '9.0 ')), reference(0, 10.6, 1))
  })

  it('returns undefined for a value that is not a plain number', () => {
    const values = ['<50.0', '>99', '/', '-', '18.4 *', '', '   ', '+5', '.5', '5.', '1e3', '1,5', '0x10', 'NaN', 'Infinity', '--1', '5-', '1.2.3', '12 mg']

    for (const value of values) assert.equal(randomRange(result(value, '1', '9')), undefined, JSON.stringify(value))
  })
})

describe('createRandomValue', () => {
  // Each case with the number of values on its grid, from the smallest to the largest.
  const cases: Array<[ResultValue, number, string, string]> = [
    [result('7.074', '7.31', '7.42'), 155, '7.288', '7.442'],
    [result('98', '74', '146'), 101, '60', '160'],
    [result('-2.5', '-10.6', '1'), 163, '-12.9', '3.3'],
    [result('0', '-3', '3'), 9, '-4', '4'],
    [result('2', '0', '5'), 7, '0', '6'],
    [result('12'), 25, '0', '24'],
    [result('-1.5'), 31, '-3.0', '0.0'],
    [result('0.00'), 101, '0.00', '1.00'],
    [result('4', '4', '4'), 1, '4', '4'],
  ]

  it('draws every value on the decimals grid of the range, and nothing outside it', () => {
    const random = seededRandom(20_251_008)

    for (const [input, size, first, last] of cases) {
      const range = randomRange(input) as RandomRange
      const shape = range.decimals === 0 ? /^-?\d+$/ : new RegExp(`^-?\\d+\\.\\d{${range.decimals}}$`)
      const randomValue = createRandomValue(random)
      const seen = new Set<string>()

      for (let i = 0; i < 10_000; i += 1) {
        const value = randomValue(input) as string
        const n = Number(value)

        assert.match(value, shape, `${input.value}: ${value} has ${range.decimals} decimals`)
        assert.ok(n >= range.min && n <= range.max, `${input.value}: ${value} lies within ${range.min} to ${range.max}`)

        if (n === 0) assert.equal(value.startsWith('-'), false, `${input.value}: ${value} is not a negative zero`)

        seen.add(value)
      }

      const sorted = [...seen].sort((a, b) => Number(a) - Number(b))

      assert.equal(seen.size, size, `${input.value}: every value on the grid is drawn`)
      assert.deepEqual([sorted[0], sorted[sorted.length - 1]], [first, last], `${input.value}: both ends are reachable`)
    }
  })

  it('maps random() onto the grid, from the first value to the last', () => {
    const input = result('7.074', '7.31', '7.42')

    assert.equal(createRandomValue(() => 0)(input), '7.288')
    assert.equal(createRandomValue(() => 0.5)(input), '7.365')
    assert.equal(createRandomValue(() => 1 - 2 ** -53)(input), '7.442')
    assert.equal(createRandomValue(() => 1 - 2 ** -53)(result('5', '1', '9')), '10')
  })

  it('never writes a negative zero', () => {
    // -1.5 draws from -3.0 to 0.0 (31 values); 0.99 picks the last one.
    assert.equal(createRandomValue(() => 0.99)(result('-1.5')), '0.0')
    assert.equal(createRandomValue(() => 0.5)(result('0', '-3', '3')), '0')
    assert.equal(createRandomValue(() => 0)(result('-0.00')), '0.00')
  })

  it('reports each value produced through onPick', () => {
    const picks: RandomPick[] = []
    const randomValue = createRandomValue(() => 0, (pick) => { picks.push(pick) })
    const input = result('7.074', '7.31', '7.42', 'PH')

    assert.equal(randomValue(input), '7.288')
    assert.equal(randomValue(result('12', '', '', 'BUN')), '0')
    assert.deepEqual(picks, [
      { input, range: reference(7.288, 7.442, 3), value: '7.288' },
      { input: result('12', '', '', 'BUN'), range: fromValue(0, 24, 0), value: '0' },
    ])
  })

  it('returns undefined for a value that is not a plain number, without calling random or onPick', () => {
    let draws = 0
    const picks: RandomPick[] = []
    const randomValue = createRandomValue(() => { draws += 1; return 0.5 }, (pick) => { picks.push(pick) })

    for (const value of ['<50.0', '>99', '/', '-', '18.4 *', '']) assert.equal(randomValue(result(value, '0', '50')), undefined, JSON.stringify(value))

    assert.equal(draws, 0)
    assert.deepEqual(picks, [])
  })

  it('takes one number from random() per value', () => {
    let draws = 0
    const randomValue = createRandomValue(() => { draws += 1; return 0.25 })

    randomValue(result('98', '74', '146'))
    randomValue(result('4', '4', '4'))
    assert.equal(draws, 2)
  })

  it('throws a RangeError when random() leaves [0, 1)', () => {
    for (const r of [1, -0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => createRandomValue(() => r)(result('5')), { name: 'RangeError', message: /random\(\) must return a number from 0 up to \(not including\) 1/ }, `r = ${r}`)
    }
  })

  it('gives the same values for the same seed', () => {
    const inputs = cases.map(([input]) => input)
    const draw = (seed: number): Array<string | undefined> => {
      const randomValue = createRandomValue(seededRandom(seed))

      return [...inputs, ...inputs].map((input) => randomValue(input))
    }

    assert.deepEqual(draw(42), draw(42))
    assert.notDeepEqual(draw(42), draw(43))
  })
})

describe('seededRandom', () => {
  it('is mulberry32: the first numbers of a few seeds are pinned, so that a seed keeps repeating its values', () => {
    assert.deepEqual(take(seededRandom(0), 3), [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197])
    assert.deepEqual(take(seededRandom(1), 3), [0.6270739405881613, 0.002735721180215478, 0.5274470399599522])
    assert.deepEqual(take(seededRandom(123), 3), [0.7872516233474016, 0.1785435655619949, 0.49531551403924823])
    assert.deepEqual(take(seededRandom(4_294_967_295), 3), [0.8964226141106337, 0.189478256739676, 0.7156526781618595])
  })

  it('gives the same sequence for the same seed, and another for another seed', () => {
    assert.deepEqual(take(seededRandom(77), 100), take(seededRandom(77), 100))
    assert.notDeepEqual(take(seededRandom(77), 100), take(seededRandom(78), 100))
  })

  it('returns numbers from 0 up to, not including, 1', () => {
    for (const seed of [0, 1, 4_294_967_295]) {
      const numbers = take(seededRandom(seed), 10_000)

      assert.ok(numbers.every((n) => n >= 0 && n < 1), `seed ${seed}`)
      assert.ok(new Set(numbers).size > 9_990, `seed ${seed}: the numbers vary`)
    }
  })

  it('accepts an integer seed from 0 to 4294967295 and rejects anything else', () => {
    for (const seed of [0, 4_294_967_295]) assert.equal(typeof seededRandom(seed)(), 'number')

    for (const seed of [-1, 4_294_967_296, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => seededRandom(seed), { name: 'RangeError', message: `seededRandom: seed must be an integer from 0 to 4294967295, got ${seed}` }, `seed ${seed}`)
    }
  })
})

describe('rangePosition', () => {
  it('places a value below, within or above the range, both ends included', () => {
    assert.equal(rangePosition('7.30', '7.31', '7.42'), 'below')
    assert.equal(rangePosition('7.31', '7.31', '7.42'), 'within')
    assert.equal(rangePosition('7.4', '7.31', '7.42'), 'within')
    assert.equal(rangePosition('7.420', '7.31', '7.42'), 'within')
    assert.equal(rangePosition('7.421', '7.31', '7.42'), 'above')
    assert.equal(rangePosition('-4', '-3', '3'), 'below')
    assert.equal(rangePosition('-3', '-3', '3'), 'within')
    assert.equal(rangePosition('4', '4', '4'), 'within')
    assert.equal(rangePosition(' 5 ', ' 1', '9 '), 'within')
  })

  it('compares exactly, beyond what a double can tell apart', () => {
    assert.equal(rangePosition('0.30000000000000000001', '0.1', '0.3'), 'above')
    assert.equal(rangePosition('9007199254740993', '0', '9007199254740992'), 'above')
  })

  it('returns undefined unless all three are plain numbers and low is not above high', () => {
    const cases = [['<5', '1', '9'], ['', '1', '9'], ['5', '', '9'], ['5', '1', ''], ['5', '1', 'n/a'], ['5', '9', '1'], ['5', '-', '-']]

    for (const [value, low, high] of cases) assert.equal(rangePosition(value, low, high), undefined, JSON.stringify([value, low, high]))
  })
})
