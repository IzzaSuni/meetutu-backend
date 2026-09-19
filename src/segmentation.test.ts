import { describe, expect, test } from 'vitest'

import {
  ASSUMED_BYTES_PER_SECOND,
  MAX_SEGMENT_BYTES,
  MAX_SEGMENT_SECONDS,
  findMp3FrameStart,
  planAudioSegments,
} from './segmentation.js'

// A 90-120 minute meeting at the 32 kbps mono the recorder produces.
const BYTES_PER_SECOND = 4000

function minutes(count: number): number {
  return count * 60
}

describe('planAudioSegments', () => {
  test('returns a single segment for a recording that fits both limits', () => {
    // Arrange
    const durationSeconds = minutes(10)

    // Act
    const segments = planAudioSegments({
      totalBytes: durationSeconds * BYTES_PER_SECOND,
      durationSeconds,
    })

    // Assert
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ index: 0, byteOffset: 0, startSeconds: 0 })
    expect(segments[0].byteLength).toBe(durationSeconds * BYTES_PER_SECOND)
  })

  test('splits a two-hour recording into whole-minute-aligned segments', () => {
    // Arrange
    const durationSeconds = minutes(120)
    const totalBytes = durationSeconds * BYTES_PER_SECOND

    // Act
    const segments = planAudioSegments({ totalBytes, durationSeconds })

    // Assert
    expect(segments.length).toBe(Math.ceil(durationSeconds / MAX_SEGMENT_SECONDS))
    expect(segments[0].startSeconds).toBe(0)
    expect(segments[1].startSeconds).toBe(MAX_SEGMENT_SECONDS)
  })

  test('segments are contiguous and cover every byte exactly once', () => {
    // Arrange
    const durationSeconds = minutes(97)
    const totalBytes = durationSeconds * BYTES_PER_SECOND

    // Act
    const segments = planAudioSegments({ totalBytes, durationSeconds })

    // Assert
    let expectedOffset = 0
    for (const segment of segments) {
      expect(segment.byteOffset).toBe(expectedOffset)
      expect(segment.byteLength).toBeGreaterThan(0)
      expectedOffset += segment.byteLength
    }
    expect(expectedOffset).toBe(totalBytes)
  })

  test('never produces a segment larger than the byte cap, even at a high bitrate', () => {
    // Arrange: 128 kbps is 4x what the recorder makes, so time-based slicing
    // alone would blow past the inline request limit.
    const durationSeconds = minutes(120)
    const totalBytes = durationSeconds * 16_000

    // Act
    const segments = planAudioSegments({ totalBytes, durationSeconds })

    // Assert
    for (const segment of segments) {
      expect(segment.byteLength).toBeLessThanOrEqual(MAX_SEGMENT_BYTES)
    }
  })

  test('timestamps advance with the byte offset so segment transcripts can be merged', () => {
    // Arrange
    const durationSeconds = minutes(120)

    // Act
    const segments = planAudioSegments({ totalBytes: durationSeconds * BYTES_PER_SECOND, durationSeconds })

    // Assert
    const last = segments[segments.length - 1]
    expect(last.startSeconds).toBeLessThan(durationSeconds)
    expect(last.startSeconds + last.durationSeconds).toBeCloseTo(durationSeconds, 0)
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].startSeconds).toBeGreaterThan(segments[i - 1].startSeconds)
    }
  })

  test('falls back to the recorder bitrate when the stored duration is missing', () => {
    // Arrange: sessions created by an older client can carry duration 0.
    const totalBytes = minutes(120) * ASSUMED_BYTES_PER_SECOND

    // Act
    const segments = planAudioSegments({ totalBytes, durationSeconds: 0 })

    // Assert
    expect(segments.length).toBeGreaterThan(1)
    expect(segments[1].startSeconds).toBe(MAX_SEGMENT_SECONDS)
  })

  test('honours caller-supplied caps', () => {
    // Arrange
    const totalBytes = 1000

    // Act
    const segments = planAudioSegments({
      totalBytes,
      durationSeconds: 100,
      maxSegmentBytes: 400,
      maxSegmentSeconds: 60,
    })

    // Assert
    expect(segments.map((segment) => segment.byteLength)).toEqual([400, 400, 200])
  })

  test('returns no segments for an empty recording', () => {
    // Arrange / Act
    const segments = planAudioSegments({ totalBytes: 0, durationSeconds: 60 })

    // Assert
    expect(segments).toEqual([])
  })
})

describe('findMp3FrameStart', () => {
  test('skips leading bytes left over from a mid-frame cut', () => {
    // Arrange
    const bytes = new Uint8Array([0x11, 0x22, 0x33, 0xff, 0xfb, 0x90, 0x44])

    // Act
    const start = findMp3FrameStart(bytes)

    // Assert
    expect(start).toBe(3)
  })

  test('returns 0 when the slice already starts on a frame header', () => {
    // Arrange
    const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00])

    // Act / Assert
    expect(findMp3FrameStart(bytes)).toBe(0)
  })

  test('returns 0 rather than dropping audio when no sync word is found', () => {
    // Arrange
    const bytes = new Uint8Array(64).fill(0x00)

    // Act / Assert
    expect(findMp3FrameStart(bytes)).toBe(0)
  })

  test('only scans the head of the slice so a sync-less chunk is cheap', () => {
    // Arrange: a valid header far past the scan window must be ignored.
    const bytes = new Uint8Array(5000)
    bytes[4096] = 0xff
    bytes[4097] = 0xfb

    // Act / Assert
    expect(findMp3FrameStart(bytes, 64)).toBe(0)
  })
})
