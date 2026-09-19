import type { TranscriptItem } from './types.js'

/**
 * How much transcript to hand the chat model.
 *
 * A 90-120 minute meeting transcribes to roughly 100-140k characters, so the
 * old 12k budget covered about the first eight minutes and every answer about
 * the rest of the meeting was wrong with confidence. 200k characters is ~50k
 * tokens — a twentieth of the model's input window.
 */
export const MAX_CHAT_CONTEXT_CHARS = 200_000

export const TRANSCRIPT_ELISION_MARKER = '\n[... middle of the meeting omitted for length ...]\n'

/** Share of the budget spent on the opening of the meeting; the rest goes to the end. */
const HEAD_SHARE = 0.4

function formatLine(item: TranscriptItem): string {
  return `[${item.timestamp}] ${item.speaker}: ${item.text}`
}

/**
 * Renders a transcript for the chat prompt, trimming from the middle when it
 * is too long. Trimming from the end — what a plain `.slice()` does — throws
 * away decisions and action items, which is exactly what gets asked about.
 */
export function buildTranscriptContext(
  transcript: TranscriptItem[],
  maxChars: number = MAX_CHAT_CONTEXT_CHARS,
): string {
  const lines = transcript.map(formatLine)
  const full = lines.join('\n')
  if (full.length <= maxChars) return full

  const headBudget = Math.floor(maxChars * HEAD_SHARE)
  const head: string[] = []
  let headChars = 0
  for (const line of lines) {
    if (headChars + line.length > headBudget) break
    head.push(line)
    headChars += line.length + 1
  }

  const tail: string[] = []
  let tailChars = 0
  for (let i = lines.length - 1; i >= head.length; i--) {
    if (tailChars + lines[i].length > maxChars - headChars) break
    tail.unshift(lines[i])
    tailChars += lines[i].length + 1
  }

  return `${head.join('\n')}${TRANSCRIPT_ELISION_MARKER}${tail.join('\n')}`
}
