// The pure half of the simulator's interactive mode: command parsing, per-message state, and the
// table layout of the message list. Nothing here touches a terminal, a socket or the clock, so
// every rule can be pinned by a unit test.
import { normalizeHl7Date } from '@nxvet/nxst-hl7-parser'

/** One line typed at the prompt (or piped on stdin), decoded. */
export type Command =
  /** Send the listed messages (1-based), optionally with a one-off patient id. */
  | { kind: 'send', indexes: number[], patientId?: string }
  /** `s`: send the next message after the last one sent. */
  | { kind: 'send-next', patientId?: string }
  /** `a`: send every message not yet sent. */
  | { kind: 'all', patientId?: string }
  /** `r`: resend the last message the way the analyzer would. */
  | { kind: 'resend' }
  /** `n`: open another connection (persistent-connection analyzers only). */
  | { kind: 'connect' }
  /** `c`: close the current connection with a FIN. */
  | { kind: 'close' }
  /** `k`: destroy the current connection. */
  | { kind: 'destroy' }
  /** `w <ms>`: pause (useful when commands are piped). */
  | { kind: 'wait', ms: number }
  /** `l`: print the message list again. */
  | { kind: 'list' }
  | { kind: 'help' }
  | { kind: 'quit' }
  /** `id <value>` sets the patient id override; `id -` clears it (`patientId` undefined). */
  | { kind: 'set-id', patientId: string | undefined }
  /** `id`: show the current override. */
  | { kind: 'show-id' }
  | { kind: 'noop' }
  | { kind: 'unknown', input: string }

/** Every token must be an integer of at least 1 (message numbers start at 1). */
const parseIndexes = (tokens: readonly string[]): number[] | undefined => {
  if (tokens.length === 0) return undefined

  const indexes: number[] = []

  for (const token of tokens) {
    if (/^\d+$/.test(token) === false) return undefined

    const value = Number(token)

    if (value < 1) return undefined

    indexes.push(value)
  }

  return indexes
}

/** The trailing `id=<value>` option; an empty value is an input error, decided by the caller. */
const ID_OPTION = /^id=(.*)$/s

type Sendable = Extract<Command, { kind: 'send' | 'send-next' | 'all' }>

/**
 * Decodes one command line.
 *
 * Bare numbers (one or several, separated by spaces or commas) send those messages, so an
 * operator can type what the list shows. `s`, `a` and bare numbers accept a trailing `id=<value>`
 * that applies to that command only; `r` does not (a resend must look like the analyzer's own
 * resend). `id <value>` / `id` / `id -` manage the standing override; its value is split on
 * whitespace only, so a patient id may contain a comma. Anything with extra arguments, a `0`, or
 * an unknown word is `unknown`: a mistyped command must never send something by accident. The
 * patient id format is not validated here (see `validatePatientId`); this is syntax only.
 */
export const parseCommand = (line: string): Command => {
  const trimmed = line.trim()

  if (trimmed === '') return { kind: 'noop' }

  const unknown: Command = { kind: 'unknown', input: trimmed }
  const words = trimmed.split(/\s+/)

  if (words[0] === 'id') {
    if (words.length === 1) return { kind: 'show-id' }
    if (words.length > 2) return unknown

    return { kind: 'set-id', patientId: words[1] === '-' ? undefined : words[1] }
  }

  let patientId: string | undefined
  let body = trimmed
  const option = ID_OPTION.exec(words[words.length - 1])

  if (option !== null) {
    if (option[1] === '' || words.length === 1) return unknown

    patientId = option[1]
    body = words.slice(0, -1).join(' ')
  }

  const sendable = (command: Sendable): Command => (patientId === undefined ? command : { ...command, patientId })
  const tokens = body.split(/[\s,]+/).filter((token) => token !== '')
  const direct = parseIndexes(tokens)

  if (direct !== undefined) return sendable({ kind: 'send', indexes: direct })

  const [head, ...rest] = tokens
  const bare = (command: Command): Command => (rest.length === 0 && patientId === undefined ? command : unknown)

  switch (head) {
    case 's': {
      if (rest.length === 0) return sendable({ kind: 'send-next' })

      const indexes = parseIndexes(rest)

      return indexes === undefined ? unknown : sendable({ kind: 'send', indexes })
    }
    case 'a': return rest.length === 0 ? sendable({ kind: 'all' }) : unknown
    case 'r': return bare({ kind: 'resend' })
    case 'n': return bare({ kind: 'connect' })
    case 'c': return bare({ kind: 'close' })
    case 'k': return bare({ kind: 'destroy' })
    case 'l': return bare({ kind: 'list' })
    case 'h':
    case '?':
    case 'help': return bare({ kind: 'help' })
    case 'q':
    case 'quit':
    case 'exit': return bare({ kind: 'quit' })
    case 'w': {
      if (patientId !== undefined || rest.length !== 1 || /^\d+$/.test(rest[0]) === false) return unknown

      return { kind: 'wait', ms: Number(rest[0]) }
    }
    default: return unknown
  }
}

/**
 * Whether a value can be written into a patient id field: not empty, no line breaks, no HL7
 * delimiters (they would split the field). Returns the reason when it cannot, `undefined` when it can.
 */
export const validatePatientId = (value: string): string | undefined => {
  if (value.trim() === '') return 'patient id must not be empty'
  if (/[\r\n]/.test(value)) return 'patient id must not contain line breaks'
  if (/[|^~\\&]/.test(value)) return 'patient id must not contain HL7 delimiters (| ^ ~ \\ &)'

  return undefined
}

/** The line printed under the message list that states the current patient id override. */
export const describePatientIdOverride = (value: string | undefined): string => (value === undefined
  ? 'Patient id override: none ("id <value>" sets it; "<n> id=<value>" applies once)'
  : `Patient id override: ${value} (applied to messages with a PID segment; "id -" clears it)`)

/** What happened to one message during this run; shown in the list's status column. */
export interface MessageState {
  /** Send attempts, including resends and attempts that could not connect. */
  sent: number
  /** The last ACK matched to this message: its MSA-1 code and when it arrived (epoch ms). */
  lastAck?: { code: string, atMs: number }
  /** Sends still waiting for an ACK. */
  pending: number
  /** Sends whose ACK never came. */
  timedOut: number
  /** Sends that failed because the receiver could not be reached. */
  connectFailed: number
}

/** `not sent` / `sent 2×, last AA 3 s ago, awaiting ACK, timed out 1×, connect failed 1×`. */
export const describeState = (state: MessageState, nowMs: number): string => {
  if (state.sent === 0) return 'not sent'

  const parts = [`sent ${state.sent}×`]

  if (state.lastAck !== undefined) {
    parts.push(`last ${state.lastAck.code} ${Math.max(0, Math.round((nowMs - state.lastAck.atMs) / 1000))} s ago`)
  }

  if (state.pending > 0) parts.push('awaiting ACK')
  if (state.timedOut > 0) parts.push(`timed out ${state.timedOut}×`)
  if (state.connectFailed > 0) parts.push(`connect failed ${state.connectFailed}×`)

  return parts.join(', ')
}

/**
 * Display width on a terminal: East Asian wide characters take two columns, everything else one.
 * Good enough to align a table; it does not try to be exact for every Unicode block.
 */
const displayWidth = (text: string): number => {
  let width = 0

  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const wide = (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe4f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x20000 && code <= 0x3fffd)

    width += wide ? 2 : 1
  }

  return width
}

const padEnd = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - displayWidth(text)))

/**
 * Lays out a table: the header line followed by one line per row, columns separated by two
 * spaces and padded to the widest cell (wide characters counted as two columns). The last column
 * is not padded, so lines do not end in trailing spaces. Rows shorter than the header are padded
 * with empty cells; longer rows are truncated to the header width.
 */
export const formatTable = (header: readonly string[], rows: readonly (readonly string[])[]): string[] => {
  const normalised = rows.map((row) => header.map((_, column) => row[column] ?? ''))
  const table = [header, ...normalised]
  const widths = header.map((_, column) => Math.max(...table.map((row) => displayWidth(row[column]))))

  return table.map((row) => row
    .map((cell, column) => (column === header.length - 1 ? cell : padEnd(cell, widths[column])))
    .join('  '))
}

/** An HL7 timestamp as `yyyy-MM-dd HH:mm:ss` for display, or an em dash when it has fewer than 14 digits. */
export const formatHl7DateTime = (raw: string): string => {
  const value = normalizeHl7Date(raw)

  if (value === undefined) return '—'

  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)} ${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}`
}
