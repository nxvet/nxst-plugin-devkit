// Guards the published surface of the package.
//
// The package is imported by its own name, so Node resolves it through the `exports` map of
// package.json (package self-reference) and loads the compiled `dist/`, exactly as a consumer
// would. A broken `exports` map, a missing build output, a `.ts` import specifier that was not
// rewritten, or a symbol that was added or removed without updating this list fails here.
// `npm test` builds `dist/` first (see `pretest`).
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import type {
  AckContext,
  AckVerdict,
  Capture,
  CaptureEvent,
  CaptureOptions,
  CaptureProfile,
  CaptureStats,
  CaptureSummary,
  Command,
  ConnectionModel,
  Description,
  FieldEdit,
  FixtureOptions,
  FixtureResult,
  FixtureStep,
  FrameVerdict,
  Io,
  Logger,
  LoggerOptions,
  Message,
  MessageSet,
  MessageState,
  ParsedCaptureArgs,
  ParsedSimulatorArgs,
  RawFile,
  RedactionRule,
  RedactionSpec,
  Redactor,
  Replacement,
  RewriteResult,
  SegmentView,
  Simulator,
  SimulatorOptions,
  SimulatorProfile,
  SimulatorStats,
  Summary,
} from '@nxvet/nxst-plugin-devkit'
import * as published from '@nxvet/nxst-plugin-devkit'

/**
 * Every runtime export, sorted. The type-only import above makes the type check fail when a
 * declared type goes missing from the published declarations.
 */
const EXPECTED_RUNTIME_EXPORTS = [
  'UsageError',
  'allocateOutDir',
  'buildFixture',
  'createCapture',
  'createLogger',
  'createRedactor',
  'createSimulator',
  'describePatientIdOverride',
  'describeState',
  'formatHl7DateTime',
  'formatTable',
  'letteredLabel',
  'messagesFromFixture',
  'messagesFromRawFiles',
  'numberedLabel',
  'parseCaptureArgs',
  'parseCommand',
  'parseFixtureSteps',
  'parseSimulatorArgs',
  'redactChunks',
  'residualCheck',
  'rewriteFields',
  'runCapture',
  'runSimulator',
  'splitChunks',
  'spreadsheetLetters',
  'validatePatientId',
  'wrapFrame',
]

interface PackageJson {
  name: string
  types: string
  files: string[]
  exports: Record<string, string | Record<string, string>>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const packageRoot = new URL('../', import.meta.url)
const packageJson = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf-8')) as PackageJson

/** True when `target` (a `./`-relative path) is shipped by one of the `files` entries. */
const isShipped = (target: string): boolean => {
  const relative = target.replace(/^\.\//, '')

  return relative === 'package.json'
    || packageJson.files.some((entry) => relative === entry || relative.startsWith(`${entry}/`))
}

describe('published entry point', () => {
  it('exposes exactly the documented runtime exports', () => {
    assert.deepEqual(Object.keys(published).sort(), [...EXPECTED_RUNTIME_EXPORTS].sort())
  })

  it('exposes functions (and one error class) only', () => {
    for (const name of EXPECTED_RUNTIME_EXPORTS) {
      assert.equal(typeof published[name as keyof typeof published], 'function', `${name} should be a function`)
    }

    assert.ok(new published.UsageError('x', 'usage') instanceof Error)
  })

  it('resolves to the compiled JavaScript in dist/, not to the TypeScript sources', () => {
    const resolved = fileURLToPath(import.meta.resolve('@nxvet/nxst-plugin-devkit'))

    assert.equal(resolved, fileURLToPath(new URL('dist/index.js', packageRoot)))
  })

  it('works end to end through the package name', () => {
    const text = 'MSH|^~\\&|DEMO||||20250310104500||ORU^R01|CTRL-1|P|2.4\rPID|1||PX-1||Zorblax\r'
    const edit: FieldEdit = { name: 'MSH-10', segment: 'MSH', field: 10, value: 'CTRL-2' }
    const rewritten: RewriteResult = published.rewriteFields(Buffer.from(text, 'utf-8'), [edit])
    const spec: RedactionSpec = [{ kind: 'petName', segment: 'PID', field: 5, label: (n) => `Pet${n}` }]
    const redactor: Redactor = published.createRedactor(spec)
    const events: CaptureEvent[] = [
      { kind: 'connection', connection: 1, atMs: 0 },
      { kind: 'data', connection: 1, atMs: 5, bytes: published.wrapFrame(rewritten.bytes) },
    ]
    const options: FixtureOptions = { instrument: 'Demo', tool: 'test', capturedAt: new Date(0), redactor }
    const result: FixtureResult = published.buildFixture(events, options)
    const set: MessageSet = published.messagesFromFixture(result.text)
    const [first]: Message[] = set.messages
    const command: Command = published.parseCommand('1 id=PX-2')
    const state: MessageState = { sent: 0, pending: 0, timedOut: 0, connectFailed: 0 }
    const steps: FixtureStep[] = published.parseFixtureSteps(result.text)
    const raw: RawFile = { name: 'raw-1.hl7', bytes: first.bytes }
    const rule: RedactionRule = spec[0]
    const found: Replacement[] = redactor.findInMessage(rewritten.bytes)
    const view: SegmentView = { name: 'PID', field: () => '' }

    assert.equal(first.bytes.toString('utf-8').includes('Zorblax'), false)
    assert.equal(first.bytes.toString('utf-8').includes('CTRL-2'), true)
    assert.equal(command.kind, 'send')
    assert.equal(published.describeState(state, 0), 'not sent')
    assert.ok(steps.length > 0)
    assert.equal(published.messagesFromRawFiles([raw]).messages.length, 1)
    assert.equal(rule.kind, 'petName')
    assert.deepEqual(found.map((entry) => [entry.kind, entry.value]), [['petName', 'Pet1']])
    assert.equal(view.name, 'PID')
    assert.equal(published.splitChunks(first.bytes, 10).length > 1, true)
    assert.equal(published.formatTable(['a'], [['b']]).length, 2)
    assert.equal(published.formatHl7DateTime('20250310104500'), '2025-03-10 10:45:00')
    assert.equal(published.validatePatientId('PX-2'), undefined)
    assert.match(published.describePatientIdOverride(undefined), /none/)
    assert.deepEqual(published.residualCheck([first.bytes], redactor), [])
    assert.equal(published.redactChunks([first.bytes], redactor).length, 1)
    assert.deepEqual([published.spreadsheetLetters(27), published.numberedLabel('ID-', 4)(12), published.letteredLabel('Pet')(2)], ['AA', 'ID-0012', 'PetB'])
  })

  it('exposes the simulator and capture entry points with their option types', () => {
    const model: ConnectionModel = { kind: 'persistent', retryMs: 0 }
    const profile: SimulatorProfile = {
      name: 'Demo',
      prompt: 'demo> ',
      rootDir: fileURLToPath(packageRoot),
      defaults: { port: 5000, ackTimeoutMs: 1000, chunkBytes: 0, gapMs: 0 },
      connection: model,
      menuColumns: ['id'],
      describe: (): Description => ({ controlId: 'CTRL-1', cells: ['CTRL-1'], summary: 'demo', ackExpected: true }),
      resend: (bytes): RewriteResult => ({ bytes: Buffer.from(bytes), applied: [], skipped: [] }),
      fresh: (bytes): RewriteResult => ({ bytes: Buffer.from(bytes), applied: [], skipped: [] }),
      setPatientId: (bytes): RewriteResult => ({ bytes: Buffer.from(bytes), applied: [], skipped: [] }),
      evaluateAck: (): AckVerdict => ({ code: 'AA', ok: true, notes: [], warnings: [] }),
    }
    const parsed: ParsedSimulatorArgs = published.parseSimulatorArgs(profile, ['--help'])
    const captureProfile: CaptureProfile = {
      name: 'Demo',
      rootDir: fileURLToPath(packageRoot),
      defaults: { port: 5000 },
      redaction: [],
      ackCodes: ['AA'],
      onFrame: (): FrameVerdict => ({ controlId: 'CTRL-1', summary: 'demo', ack: { code: 'AA', text: '' } }),
      buildAck: (_frame, _verdict, context: AckContext) => `MSH|^~\\&|R||D||20250310104500||ACK|${context.sequence}|P|2.4\rMSA|${context.code}|CTRL-1\r`,
    }
    const parsedCapture: ParsedCaptureArgs = published.parseCaptureArgs(captureProfile, ['--help'])
    const io: Io = { stdout: process.stdout, stderr: process.stderr, isTTY: false }
    const logger: Logger = published.createLogger(io, {} satisfies LoggerOptions)
    const options: SimulatorOptions | undefined = undefined
    const captureOptions: CaptureOptions | undefined = undefined
    const stats: SimulatorStats | undefined = undefined
    const captureStats: CaptureStats | undefined = undefined
    const summary: Summary | undefined = undefined
    const captureSummary: CaptureSummary | undefined = undefined
    const simulator: Simulator | undefined = undefined
    const capture: Capture | undefined = undefined

    assert.equal(parsed.kind, 'help')
    assert.equal(parsedCapture.kind, 'help')
    assert.equal(typeof logger.say, 'function')
    assert.equal(typeof published.allocateOutDir, 'function')
    assert.equal(options, undefined)
    assert.equal(captureOptions, undefined)
    assert.equal(stats, undefined)
    assert.equal(captureStats, undefined)
    assert.equal(summary, undefined)
    assert.equal(captureSummary, undefined)
    assert.equal(simulator, undefined)
    assert.equal(capture, undefined)
  })
})

describe('package.json', () => {
  it('has no runtime dependencies and declares the HL7 parser as a peer dependency', () => {
    assert.equal(packageJson.dependencies, undefined)
    assert.ok(packageJson.peerDependencies?.['@nxvet/nxst-hl7-parser'])
  })

  it('points every exports target and the types entry at a file that exists and is shipped', () => {
    const targets = [packageJson.types]

    for (const value of Object.values(packageJson.exports)) {
      targets.push(...(typeof value === 'string' ? [value] : Object.values(value)))
    }

    for (const target of targets) {
      assert.equal(existsSync(new URL(target, packageRoot)), true, `${target} should exist after the build`)
      assert.equal(isShipped(target), true, `${target} should be covered by the "files" list`)
    }
  })

  it('ships the documentation, the changelog and the license', () => {
    for (const file of ['README.md', 'README.zh.md', 'CHANGELOG.md', 'LICENSE']) {
      assert.equal(packageJson.files.includes(file), true, `${file} should be in "files"`)
      assert.equal(existsSync(new URL(file, packageRoot)), true, `${file} should exist`)
    }
  })
})
