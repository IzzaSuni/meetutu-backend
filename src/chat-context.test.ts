import { describe, expect, test } from 'vitest'

import { MAX_CHAT_CONTEXT_CHARS, TRANSCRIPT_ELISION_MARKER, buildTranscriptContext } from './chat-context.js'
import type { TranscriptItem } from './types.js'

function transcript(lineCount: number, textLength = 80): TranscriptItem[] {
  return Array.from({ length: lineCount }, (_, i) => ({
    id: `t-${i + 1}`,
    timestamp: `${String(Math.floor((i * 15) / 60)).padStart(2, '0')}:${String((i * 15) % 60).padStart(2, '0')}`,
    seconds: i * 15,
    speaker: 'Speaker 1 (Host)',
    text: `${i}`.padEnd(textLength, 'x'),
  }))
}

describe('buildTranscriptContext', () => {
  test('passes a whole two-hour transcript through untouched', () => {
    // Arrange: 120 minutes at one line per 15 seconds.
    const items = transcript(480)

    // Act
    const context = buildTranscriptContext(items)

    // Assert
    expect(context).toContain(items[0].text)
    expect(context).toContain(items[479].text)
    expect(context).not.toContain(TRANSCRIPT_ELISION_MARKER)
    expect(context.length).toBeLessThanOrEqual(MAX_CHAT_CONTEXT_CHARS)
  })

  test('keeps the end of the meeting when a transcript has to be trimmed', () => {
    // Arrange: decisions land at the end, so a plain head-slice loses the part
    // people actually ask about.
    const items = transcript(4000, 200)

    // Act
    const context = buildTranscriptContext(items)

    // Assert
    expect(context).toContain(items[0].text)
    expect(context).toContain(items[3999].text)
    expect(context).toContain(TRANSCRIPT_ELISION_MARKER)
    expect(context.length).toBeLessThanOrEqual(MAX_CHAT_CONTEXT_CHARS + TRANSCRIPT_ELISION_MARKER.length)
  })

  test('returns an empty string for an empty transcript', () => {
    expect(buildTranscriptContext([])).toBe('')
  })

  test('respects a caller-supplied budget', () => {
    // Arrange
    const items = transcript(50)

    // Act
    const context = buildTranscriptContext(items, 400)

    // Assert
    expect(context).toContain(TRANSCRIPT_ELISION_MARKER)
    expect(context.length).toBeLessThanOrEqual(400 + TRANSCRIPT_ELISION_MARKER.length)
  })
})
