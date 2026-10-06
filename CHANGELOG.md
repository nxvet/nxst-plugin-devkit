# Changelog

All notable changes to `@nxvet/nxst-plugin-devkit` are recorded here. The package follows
[semantic versioning](https://semver.org/); the profile interfaces (`SimulatorProfile`,
`CaptureProfile`) and the command-line flags of `runSimulator` / `runCapture` are the public
contract.

## 1.0.0 — unreleased

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
