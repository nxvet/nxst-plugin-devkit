# Changelog

All notable changes to `@nxvet/nxst-plugin-devkit` are recorded here. The package follows
[semantic versioning](https://semver.org/); the profile interfaces (`SimulatorProfile`,
`CaptureProfile`) and the command-line flags of `runSimulator` / `runCapture` are the public
contract.

## 1.2.0 — 2026-10-08

### Added

- **Simulator**: random result values. With `--random`, or `rand on` at the prompt, every exam
  result value of each message sent is first replaced with a bounded random number, so one capture
  yields any number of different results. A profile opts in with the new optional
  `SimulatorProfile.randomize(bytes, randomValue)`: it asks `randomValue({ name, value, low, high })`
  for each value the plugin would upload, writes the new value in place, brings whatever the analyzer
  derives from it (an abnormal flag) in line, and reports in `skipped` the values it left alone. A
  value that is not a plain number (`<50.0`, `>99`, `/`, `-`, `18.4 *`, empty) is left as it is.
  The new value is drawn from the reference range widened by a fifth of its span on each side, never
  below 0 when low is not negative (7.31 to 7.42 gives 7.288 to 7.442, 0 to 5 gives 0 to 6), or from
  0 to twice the value when there is no usable range (0 to 1 for 0), with as many decimals as the
  most precise of value, low and high. One seeded generator serves the run; while random values are
  on its seed is printed at start, under the list and by `rand on`, and `--seed <n>` sends the same
  values again for the same commands. `r` resends the values that were sent, as the analyzer does.
  Each randomized send logs the values drawn with their ranges, and the ones left as they were;
  `rand` shows the state and the seed, `rand off` goes back to the captured values. `--random`,
  `--seed` and the `rand` commands are only available for a profile that implements `randomize`
  (otherwise the flags are a usage error that says why); a profile without it behaves exactly as
  before. Because each randomized send carries new values, a receiver that de-duplicates by content
  takes it as a new result even without `--fresh`.
- **Random values**: the helpers behind it, for profiles and their tests: `randomRange(input)`,
  `createRandomValue(random, onPick?)`, `seededRandom(seed)` (mulberry32; a seed that is not an
  integer from 0 to 4294967295 throws a `RangeError`) and `rangePosition(value, low, high)` (below,
  within or above a reference range, for recomputing a flag), with the types `ResultValue`,
  `RandomRange`, `RandomPick` and `RandomValue`. Bounds are computed as exact decimals, never in
  floating point: 7.31 to 7.42 widens to exactly 7.288, not 7.287999999999999.
- **Field edits**: `FieldEdit.occurrence` makes `rewriteFields` edit the nth segment with a name,
  for example OBX-5 of the third OBX (`{ segment: 'OBX', occurrence: 3, field: 5 }`). Without it
  the first is edited, exactly as before. An occurrence the message does not have is reported in
  `skipped` (`no OBX segment #7 (the message has 3)`) and nothing is synthesised; an occurrence that
  is not a positive safe integer throws a `RangeError`.

## 1.1.0 — 2026-10-07

### Added

- **Redaction**: three helpers for the `label` of a `RedactionRule`, so a profile no longer writes
  its own. `numberedLabel(prefix, digits)` numbers placeholders: `numberedLabel('TEST-', 4)` gives
  `TEST-0001`, `TEST-0002`, ..., and a wider number simply grows (`TEST-10000`).
  `letteredLabel(prefix)` letters them: `letteredLabel('TestPet')` gives `TestPetA` to `TestPetZ`,
  then `TestPetAA`. `spreadsheetLetters(n)` is that letter sequence on its own (spreadsheet column
  names: 1 is `A`, 27 is `AA`, 703 is `AAA`), so it never runs out. The labels keep no state: the
  same n always gives the same placeholder. A `digits` or n that is not a positive safe integer
  throws a `RangeError`. Prefixes are not checked; `createRedactor` still rejects a placeholder
  that contains an HL7 delimiter or a line break.

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
