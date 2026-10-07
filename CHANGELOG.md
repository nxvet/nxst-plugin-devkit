# Changelog

All notable changes to `@nxvet/nxst-plugin-devkit` are recorded here. The package follows
[semantic versioning](https://semver.org/); the profile interfaces (`SimulatorProfile`,
`CaptureProfile`) and the command-line flags of `runSimulator` / `runCapture` are the public
contract.

## 1.0.1 — 2026-10-07

### Fixed

- **Simulator**: an explicit `--out` that already holds a simulator run (`sent-NNN.hl7` or
  `simulate.log`) is refused before anything is connected, sent or written, the way the capture
  tool refuses a directory holding a capture; the sent files used to be overwritten and the log
  appended to. Each tool checks only its own files, so a capture and a simulator run may share one
  directory. `runSimulator` reports a start-up failure on stderr and exits with 1.
- **Capture**: `--help` named the default output directory `captures/<date>`; it is
  `captures/capture-<date>`.
- **Capture**: `--ack-code` is matched without regard to case (`ae` selects `AE`) and passed on in
  the profile's own spelling.
- **Capture**: the profile's own switches are printed at start-up (the ones given, or "none given"
  with the ones available), so `capture.log` shows which were used.
- **Redaction**: `residualCheck`, and with it the fixture written by the capture tool, no longer
  warns about an original that equals a placeholder the redactor has issued, as happens when an
  already-redacted fixture is captured again; such hits cannot be told apart from the placeholders.
  A real original that survives is still reported.

### Changed

- **Simulator**: a relative `--source` path is now taken from the current directory, like `--out`
  of both tools; it used to be taken from the plugin directory (`rootDir`). The defaults still live
  under `rootDir`. This only makes a difference when a tool is started outside the plugin
  directory: `npm run` starts scripts in the package directory.

## 1.0.0 — 2026-10-06

Initial release.

- **Simulator** (`createSimulator` / `runSimulator`): plays an analyzer towards a real receiver
  with captured messages. Two connection models (persistent connection; one connection per
  message with idle probes), an interactive mode (message list, send by number, resend, patient id
  override), ACK matching by MSA-2, timeouts without resend, byte-exact `sent-NNN.hl7` files, a
  summary and an exit code.
- **Capture** (`createCapture` / `runCapture`): listens like the receiver, records raw frames
  byte for byte, answers with the plugin's ACK (or deliberately not, late, or with another code),
  detects resends, and writes a redacted replay fixture when stopped.
- **Fixtures** (`parseFixtureSteps`, `messagesFromFixture`, `messagesFromRawFiles`,
  `buildFixture`), **redaction** (`createRedactor`, `redactChunks`, `residualCheck`), **field
  edits** (`rewriteFields`, `wrapFrame`, `splitChunks`) and the **interactive-mode helpers**
  (`parseCommand`, `formatTable`, `describeState`, `validatePatientId`).
