// Public-repository hygiene check, run by `npm test` (pretest) and by CI.
//
// Everything in this repository is published, so nothing in it may reference internal systems,
// internal tickets, specific analyzers or bytes captured from real devices. The patterns below are
// deliberately broad; a false positive is cheaper than a leak. Only README.zh.md may contain
// Han characters (it is the Traditional Chinese companion of the README).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const FORBIDDEN = [
  /TRD-\d+/, /atlassian/i, /gitlab/i, /git\.nxvet/i, /nxvet\.io/i, /doc\/memory/,
  /\beaglenos\b/i, /\begi30\b/i, /\bEG-i30\b/i, /\bvcheck\b/i, /\bc10\b/i, /\bskyla\b/i, /\bvb1\b/i, /\bv200\b/i,
  /\bLIS Server\b/, /\bBNCA\b/, /\bBNCP\b/, /\bDIB0\d\d\b/, /\b99VC/, /\bPresurgical\b/,
  /1789386076393/, /1e084bb0/, /42134e14/, /EN10224080021/, /\b10\.0\.[12]\.\d+\b/,
  /\bMerik\b/,
]
const HAN = /\p{Script=Han}/u
const HAN_ALLOWED = new Set(['README.zh.md'])

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf-8' })
  .split('\n')
  // The pattern list itself and the lock file (registry URLs, integrity hashes) are not scanned.
  .filter((name) => name !== '' && name !== 'package-lock.json' && name !== 'scripts/check-public.mjs')

let problems = 0

for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf-8')
  } catch {
    continue
  }
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    for (const pattern of FORBIDDEN) {
      if (pattern.test(line)) {
        problems += 1
        console.error(`${file}:${index + 1}: matches ${pattern}`)
        break
      }
    }
    if (HAN_ALLOWED.has(file) === false && HAN.test(line)) {
      problems += 1
      console.error(`${file}:${index + 1}: Han characters are only allowed in README.zh.md`)
    }
  })
}

if (problems > 0) {
  console.error(`check-public: ${problems} problem(s) found`)
  process.exit(1)
}

console.log(`check-public: ${files.length} file(s) clean`)
