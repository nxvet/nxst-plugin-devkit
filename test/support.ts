// Synthetic HL7 material shared by the test files. Nothing here comes from a real analyzer.
import { MLLP_CR, MLLP_END, MLLP_START } from '@nxvet/nxst-hl7-parser'

export const SB = Buffer.from([MLLP_START])
export const EB_CR = Buffer.from([MLLP_END, MLLP_CR])

export interface MessageFields {
  controlId?: string
  messageTime?: string
  /** The whole PID segment; pass `null` for a message without PID (a QC-style message). */
  pid?: string | null
  patientId?: string
  petName?: string
  owner?: string
  vet?: string
  obx?: string[]
}

/** A result message in a generic HL7 v2 shape; every segment ends with `\r`. */
export const message = (fields: MessageFields = {}): string => {
  const pid = fields.pid === undefined
    ? `PID|1||${fields.patientId ?? 'PX-1234'}^^^^^Demo Clinic||${fields.petName ?? 'Zorblax'}||20240101|M|||||||||||||${fields.owner ?? 'Quillfeather'}`
    : fields.pid

  return [
    `MSH|^~\\&|DEMO^1.0||RECEIVER||${fields.messageTime ?? '20250310104500'}||ORU^R01|${fields.controlId ?? 'CTRL-1'}|P|2.4|||NE|AL||UNICODE UTF-8`,
    ...(pid === null ? [] : [pid]),
    `PV1||O|||||${fields.vet ?? 'Dr. Marrowind'}`,
    'OBR|1|||X000^Panel^DEMO|||20250310103045',
    ...(fields.obx ?? [
      'OBX|1|NM|X001^GLU^DEMO||98|mg/dL|74-146|||F|||20250310103045',
      'OBX|2|NM|X002^BUN^DEMO||12|mg/dL|7-27|||F|||20250310103045',
    ]),
    '',
  ].join('\r')
}

/** Wraps a message in MLLP framing, as the analyzer would send it. */
export const frame = (text: string): Buffer => Buffer.concat([SB, Buffer.from(text, 'utf-8'), EB_CR])

export const hexLine = (bytes: Uint8Array, delayMs: number): string => JSON.stringify({ delayMs, hex: Buffer.from(bytes).toString('hex') })

export const textLine = (text: string, delayMs: number): string => JSON.stringify({ delayMs, text: `\u000b${text}\u001c\r` })

export const fixture = (...lines: string[]): string => `${lines.join('\n')}\n`

export const CONNECTION = '{"delayMs":0,"event":"connection"}'

/** The JSON steps of a fixture (comments and blank lines skipped, as the replay harness does). */
export const steps = (text: string): Array<Record<string, unknown>> => text
  .split('\n')
  .filter((line) => line.trim() !== '' && line.trim().startsWith('//') === false)
  .map((line) => JSON.parse(line) as Record<string, unknown>)

/** The data steps of a fixture concatenated, in order. */
export const replayedBytes = (text: string): Buffer => Buffer.concat(steps(text)
  .filter((step) => typeof step.hex === 'string')
  .map((step) => Buffer.from(step.hex as string, 'hex')))

/** Every substring of `value` with at least `min` characters, for "no fragment survives" checks. */
export const fragments = (value: string, min = 4): string[] => {
  const out: string[] = []

  for (let start = 0; start < value.length; start += 1) {
    for (let end = start + min; end <= value.length; end += 1) out.push(value.slice(start, end))
  }

  return out
}
