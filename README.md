# @nxvet/nxst-plugin-devkit

English · [Traditional Chinese](README.zh.md)

Development-time toolkit for [NxVet SyncTool](https://www.npmjs.com/package/@nxvet/nxst-plugin)
device plugins: an **instrument simulator** that drives a real SyncTool with bytes captured from the
real analyzer, and a **live-capture server** that records a real analyzer and turns the session into
a replay fixture.

Analyzers are usually borrowed and have to go back. Once they are gone, the SDK's replay harness
still exercises the plugin's driver, but nothing can reach a running SyncTool: the harness never
really listens on a port. This package fills that gap. The simulator opens a real TCP connection to
the plugin's port and behaves the way the analyzer did on the wire; the capture tool is its mirror
image and is how those bytes and habits were recorded in the first place.

- **Instrument semantics stay in the plugin.** Which message is a QC result, how an ACK is judged,
  which fields a resend renews, which fields hold personal data, how the analyzer uses TCP — all of
  that is supplied through a *profile* object. The toolkit owns only the mechanics.
- **Byte-exact.** Messages are sent exactly as captured; the few fields a run may change (control
  id, timestamp, patient id) are edited in place with the byte-range helpers of
  [`@nxvet/nxst-hl7-parser`](https://www.npmjs.com/package/@nxvet/nxst-hl7-parser).
- **No personal data in the output.** Frames are never printed. The list, the log and the summary
  only show what the profile returns, and fixtures are redacted before they are written.
- **Testable core, thin CLI.** `createSimulator` and `createCapture` work through an `io` object
  and never exit; `runSimulator` and `runCapture` are the command-line wrappers.

---

## Installation

```bash
npm install --save-dev @nxvet/nxst-plugin-devkit @nxvet/nxst-hl7-parser
```

Requires **Node 22 or newer**. `@nxvet/nxst-hl7-parser` is a peer dependency: the plugin already
depends on it, and one copy guarantees that the capture tool frames bytes exactly like the driver.
The package is ESM and ships compiled JavaScript with type declarations.

The toolkit is a development dependency. It is imported by the plugin's `tools/*.ts` scripts, which
are never bundled into the `.nxplugin`.

> **Type-only exports must be imported with `import type`.** Plugin tools run under Node's type
> stripping, which does not remove a bare `import { SimulatorProfile }` of something that has no
> runtime value; that import fails at load time. Write
> `import type { SimulatorProfile } from '@nxvet/nxst-plugin-devkit'`.

---

## The simulator

A plugin's `tools/simulate.ts` builds a `SimulatorProfile` and hands it to `runSimulator`:

```ts
// tools/simulate.ts
import path from 'node:path'

import type { AckVerdict, Description, SimulatorProfile } from '@nxvet/nxst-plugin-devkit'
import { rewriteFields, runSimulator } from '@nxvet/nxst-plugin-devkit'
import { component, field, findSegment, hl7Timestamp, parseMessage } from '@nxvet/nxst-hl7-parser'

import { parseResult } from '../src/protocol.ts' // the plugin's own parser: the code that ships

const decode = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf-8')

const profile: SimulatorProfile = {
  name: 'Demo analyzer',
  prompt: 'demo> ',
  rootDir: path.resolve(import.meta.dirname, '..'),
  defaults: { port: 5100, ackTimeoutMs: 10_000, chunkBytes: 0, gapMs: 200 },
  // The demo analyzer connects at power-on and keeps the connection open.
  connection: { kind: 'persistent', retryMs: 1500 },
  menuColumns: ['type', 'patient', 'expected'],

  describe(bytes, now): Description {
    const text = decode(bytes)
    const segments = parseMessage(text)
    const msh = findSegment(segments, 'MSH')
    const pid = findSegment(segments, 'PID')
    const controlId = field(msh, 10).trim()
    const patient = component(field(pid, 3), 1).trim() || '(none)'
    const outcome = parseResult(text) // what the driver would do with this message

    return {
      controlId,
      cells: [pid === undefined ? 'QC' : 'patient', patient, outcome.kind === 'upload' ? `upload ${outcome.items.length} items` : `skip (${outcome.reason})`],
      summary: `${pid === undefined ? 'QC' : 'patient'} message ${controlId} for ${patient}`,
      ackExpected: controlId !== '',
    }
  },

  // What the real analyzer changes when the operator resends a result: here only the timestamp.
  resend: (bytes, now) => rewriteFields(bytes, [{ name: 'MSH-7', segment: 'MSH', field: 7, value: hl7Timestamp(now) }]),

  // --fresh: a control id the receiver has not seen, plus the current timestamp.
  fresh(bytes, now, seen) {
    let id = now.getTime()

    while (seen.has(String(id))) id += 1

    return rewriteFields(bytes, [
      { name: 'MSH-10', segment: 'MSH', field: 10, value: String(id) },
      { name: 'MSH-7', segment: 'MSH', field: 7, value: hl7Timestamp(now) },
    ])
  },

  setPatientId: (bytes, id) => rewriteFields(bytes, [{ name: 'PID-3.1', segment: 'PID', field: 3, component: 1, value: id }]),

  evaluateAck(ackText): AckVerdict {
    const msa = findSegment(parseMessage(ackText), 'MSA')
    const code = field(msa, 1).trim()

    return { code, ok: code === 'AA', notes: [], warnings: code === 'AA' ? [] : ['the receiver did not accept the message'] }
  },
}

void runSimulator(profile)
```

An analyzer that opens one connection per result, closes it after the ACK and probes the receiver
while idle uses the other connection model:

```ts
connection: { kind: 'per-message', probeMs: 10_000, preSendMs: 300, closeAfterAckMs: 3 },
```

Run it with `node tools/simulate.ts` (or an npm script). On a terminal it connects (or starts
probing), prints the message list and waits for commands:

```
  #  type     patient   expected          size    status
  1  patient  PX-1234   upload 26 items   2059 B  not sent
  2  patient  PX-2345   upload 26 items   2066 B  sent 1×, last AA 3 s ago
  3  QC       (none)    skip (qc)         848 B   not sent
  Patient id override: none ("id <value>" sets it; "<n> id=<value>" applies once)
demo> 2
```

When stdin is not a terminal, every line is a command, so a run can be scripted:
`printf '1 2\nw 500\nq\n' | node tools/simulate.ts`. The exit code then tells whether every message
was acknowledged and accepted.

### Commands

| Command | Effect |
|---|---|
| `3`, `3 5 8`, `3,5` | send those messages; in the per-message model each waits for its ACK before the next |
| `s`, `s 3` | send the next message, or message 3 |
| `a` | send every message not yet sent |
| `r` | resend the last message the way the analyzer would (`profile.resend`) |
| `... id=A123` | apply patient id `A123` to that command only (`3 id=A123`, `s id=A123`, `a id=A123`; not `r`) |
| `id A123` / `id` / `id -` | set the patient id for every later send / show it / clear it |
| `l` | print the list again, with the current status of each message |
| `n` / `c` / `k` | persistent model only: open another connection, close the current one (FIN), destroy it |
| `w 500` | wait 500 ms (for piped runs) |
| `h` | help |
| `q` | wait for ACKs in flight, print the summary, close everything |

A `0`, an unknown word, or a command with extra arguments is rejected: a typo must never send
something by accident.

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--host`, `--port` | `127.0.0.1`, `profile.defaults.port` | the receiver |
| `--source` | `<rootDir>/fixtures/session.jsonl` | a replay fixture, a directory of `raw-NNN.hl7` files, or one message file |
| `--gap <ms>` / `--gap real` | `profile.defaults.gapMs` | pause between messages sent by one command; `real` replays the captured gaps |
| `--ack-timeout <ms>` | `profile.defaults.ackTimeoutMs` | how long to wait for an ACK; a timeout is logged and never resent |
| `--chunk <bytes>`, `--chunk-gap <ms>` | `profile.defaults.chunkBytes`, 10 | write each frame in pieces (the way TCP may split it); whether the receiver sees separate chunks depends on the network |
| `--patient-id <id>` | – | initial value of the patient id override |
| `--fresh` | off | renew the control id and timestamp of every message (`profile.fresh`), so a receiver that de-duplicates sees new results |
| `--retry <ms>` | `connection.retryMs` | persistent model: reconnect delay after a refused connection or a close by the receiver (0 = never) |
| `--probe <ms>`, `--pre-send <ms>` | `connection.probeMs`, `connection.preSendMs` | per-message model: idle probe interval (0 = none) and the delay between connecting and sending |
| `--hold <s>` | 0 | keep connections open this long after `q` |
| `--out <dir>` | `<rootDir>/captures/simulate-<date>` | where `sent-NNN.hl7` (the bytes actually sent) and `simulate.log` go; numbered `-2`, `-3` when the day already has results; an explicit directory that already holds `sent-NNN.hl7` or `simulate.log` is refused (exit 1), while a capture's files do not count, so both tools may share one directory |
| `--list` | – | print the list and exit |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | every message sent was acknowledged with an ACK the profile accepted (`ok: true`) |
| 1 | at least one message was not: timed out, not accepted, could not connect, write failed |
| 2 | usage error |
| 130 | interrupted twice |

A message whose `Description.ackExpected` is false (the plugin would not answer it, or it has no
control id) may time out without failing the run.

### What the toolkit does and does not do

| It does | It does not |
|---|---|
| send the captured frame content byte for byte, wrapped in MLLP | change any byte the profile did not ask to change |
| match each ACK to the message in flight with the same MSA-2 (oldest first) | answer anything the receiver sends: a frame that is not an ACK, an unmatched or duplicate ACK, bytes outside a frame are logged and ignored |
| time out and move on | resend on a timeout (that is the analyzer's decision, expressed through `resend`) |
| keep one receive buffer per connection | print frame contents, ever |
| count the facts the profile reports in `tally` and print them in the summary | know what any field means |

---

## The capture tool

A plugin's `tools/live-capture.ts` builds a `CaptureProfile` and hands it to `runCapture`:

```ts
// tools/live-capture.ts
import path from 'node:path'

import type { CaptureProfile, FrameVerdict } from '@nxvet/nxst-plugin-devkit'
import { runCapture } from '@nxvet/nxst-plugin-devkit'
import { field, findSegment, parseMessage } from '@nxvet/nxst-hl7-parser'

import { buildAck, parseResult } from '../src/protocol.ts'

// The plugin's own MSA-1 codes. The type parameter makes `buildAck` receive one of these, not a string.
type AckCode = 'AA' | 'AE'

const profile: CaptureProfile<AckCode> = {
  name: 'Demo analyzer',
  rootDir: path.resolve(import.meta.dirname, '..'),
  defaults: { port: 5100 },
  // Which fields hold personal data; the same original always gets the same placeholder.
  redaction: [
    { kind: 'patientId', segment: 'PID', field: 3, component: 1, everyRepetition: true, label: (n) => `TEST-${String(n).padStart(4, '0')}` },
    { kind: 'petName', segment: 'PID', field: 5, label: (n) => `TestPet${n}` },
  ],
  ackCodes: ['AA', 'AE'],

  onFrame(frame, receivedAt, say): FrameVerdict<AckCode> {
    const text = Buffer.from(frame).toString('utf-8')
    const controlId = field(findSegment(parseMessage(text), 'MSH'), 10).trim()
    const outcome = parseResult(text)

    // Print the real values of whatever the documentation leaves open (never personal data).
    say(`    MSH-16 = ${JSON.stringify(field(findSegment(parseMessage(text), 'MSH'), 16))}`)

    return {
      controlId,
      summary: outcome.kind === 'upload' ? `would upload ${outcome.items.length} items` : `would skip: ${outcome.reason}`,
      payloadHash: outcome.kind === 'upload' ? outcome.hash : undefined,
      ack: controlId === '' ? null : { code: 'AA', text: 'Message accepted' },
    }
  },

  buildAck: (frame, verdict, { sequence, code }) => buildAck(Buffer.from(frame).toString('utf-8'), code, String(sequence)),
}

void runCapture(profile)
```

`node tools/live-capture.ts` listens on the plugin's port, prints the machine's addresses to type
into the analyzer, and for every frame writes `raw-NNN.hl7` (the exact bytes), logs the connection
timing (when the analyzer opened, sent, closed; how long after the ACK) and prints what the plugin
made of it. Stopping the tool (Ctrl-C) writes `session.jsonl`, a fixture for the SDK's replay
harness with every chunk boundary preserved and personal data redacted.

| Flag | Meaning |
|---|---|
| `--port <n>` | port to listen on (default `profile.defaults.port`) |
| `--out <dir>` | output directory (default `<rootDir>/captures/capture-<date>`); refuses to overwrite an earlier capture |
| `--no-ack` | never answer: what does the analyzer do without an ACK? |
| `--ack-code <code>` | answer with this MSA-1 code instead of the plugin's (one of `profile.ackCodes`) |
| `--ack-delay <ms>` | answer this long after the frame arrived: probe the analyzer's ACK timeout |
| `--close-after-ack` | close the connection right after each ACK |
| `--no-redact` | write the fixture without redaction (local debugging only; never commit it) |
| `profile.switches` | any extra switches the profile declares are passed to `buildAck` (for example to try another ACK header layout) |

Resends are detected by control id and compared by raw bytes and by `payloadHash`, so a run shows
whether the analyzer's "send again" produces identical bytes or new ones.

---

## Fixtures, redaction and field edits

These helpers are what the two tools are built from and can be used on their own.

| Function | Purpose |
|---|---|
| `parseFixtureSteps(text)` | the SDK fixture line rules (blank lines and `//` comments skipped, `hex` / `text` data, `connection` / `close` / `error` events, pauses), with the line number in every error |
| `messagesFromFixture(text)` | the messages of a fixture, each with the connection it arrived on and the gap since the previous one; bytes are joined within one connection only, and anything dropped is reported |
| `messagesFromRawFiles(files)` | messages from `raw-NNN.hl7` files, sorted by their number |
| `buildFixture(events, options)` | capture events to a fixture, chunk boundaries preserved; connections that overlapped are replayed one after another and the header says so |
| `createRedactor(spec)` | a redactor for the configured fields (`segment`, `field`, optional `component`, `everyRepetition`, a `when` predicate for generic segments such as OBX); the same original always gets the same placeholder |
| `redactChunks(chunks, redactor)` | redacts a connection's chunks without moving a boundary into the middle of a value |
| `residualCheck(streams, redactor)` | warnings for originals that survived in fields the spec does not cover; an original equal to a placeholder (as when an already-redacted fixture is captured again) is skipped, since its hits cannot be told apart from the placeholder |
| `rewriteFields(bytes, edits)` | byte-exact edits of fields, repetitions or components; a missing field is reported, never synthesised |
| `wrapFrame(bytes)`, `splitChunks(bytes, size)` | MLLP framing without decoding; fixed-size pieces |
| `parseCommand(line)`, `formatTable`, `describeState`, `validatePatientId` | the pure half of the interactive mode |

---

## Personal data

The toolkit never prints frame contents and never writes them anywhere but the raw and sent files,
which belong under the plugin's `captures/` directory (keep it ignored by version control; both
tools warn when `--out` points elsewhere). Everything printed about a message comes from the
profile: `Description.cells` and `summary`, `FrameVerdict.summary`, the lines `onFrame` prints.
**A profile must not put names, owners or other personal data into those strings.** Patient ids are
the plugin's own decision (the drivers log them).

Fixtures written by the capture tool are redacted with the profile's `RedactionSpec`, every other
byte unchanged, and the header lists how many distinct values were replaced per kind. Review a
fixture by hand before committing it: only the configured fields are redacted.

---

## Relation to the SDK's replay harness

`nxst-plugin dev --fixture` replays a fixture *into the plugin's driver* through a mock SDK; it is
how a plugin is tested without hardware and without SyncTool. This toolkit sits on the other side:
the capture tool produces those fixtures from a real analyzer, and the simulator plays the fixture
*into a real SyncTool* so the whole path (device status, upload, de-duplication, restarts) can be
exercised after the analyzer is gone.

---

## Testing a plugin's profile

The two tools can be pointed at each other on one machine: start `tools/live-capture.ts` on a free
port, then run `printf 'a\nw 1000\nq\n' | node tools/simulate.ts --port <that port>`. The capture's
`raw-NNN.hl7` files must be byte-identical to the simulator's `sent-NNN.hl7` files, every message
must be acknowledged, and the simulator must exit with 0. The capture's `--no-ack`, `--ack-code`
and `--ack-delay` then let you check how the simulator (and the real analyzer's habits it encodes)
react to a misbehaving receiver.

The interactive mode is best checked by hand in a terminal: the list appears on start, typing a
number sends that message, the prompt is redrawn when an ACK arrives, and Ctrl-C prints the summary.

---

## Versioning

The package follows semantic versioning. The profile interfaces (`SimulatorProfile`,
`CaptureProfile`) and the command-line flags are the public contract: a field removed or a flag
whose meaning changes is a major version. New optional profile fields and new flags are minor
versions.

## License

Apache-2.0
