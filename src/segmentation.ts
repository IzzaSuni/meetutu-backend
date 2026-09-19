/**
 * Splitting a long recording into transcription-sized pieces.
 *
 * A 90-120 minute meeting is well inside Gemini's *input* budget (audio costs
 * 32 tokens/second, so two hours is ~230k of the model's ~1M input tokens),
 * but a verbatim transcript of it is not inside the 65,536-token *output*
 * budget: two hours of speech is roughly 17k words, and once every line
 * carries id/timestamp/seconds/speaker JSON around it the response lands in
 * the same order of magnitude as the cap. Asking for it in one call risks a
 * truncated response after ten minutes of work.
 *
 * So the audio is cut into segments, each transcribed on its own with an
 * absolute time offset, and the summary is produced afterwards from the merged
 * transcript.
 */

export interface AudioSegment {
  index: number
  byteOffset: number
  byteLength: number
  /** Offset of this segment within the full recording, in seconds. */
  startSeconds: number
  durationSeconds: number
}

/**
 * Longest stretch of audio to transcribe in one call. 15 minutes of speech is
 * ~2k words, comfortably inside the output budget even with JSON overhead.
 */
export const MAX_SEGMENT_SECONDS = 900

/**
 * Largest segment to send in one request. The generateContent request limit is
 * 20 MB in total and base64 inflates bytes by ~4/3, so 6 MiB of audio leaves
 * plenty of headroom for the prompt.
 */
export const MAX_SEGMENT_BYTES = 6 * 1024 * 1024

/** 32 kbps mono — what the browser recorder encodes — as bytes per second. */
export const ASSUMED_BYTES_PER_SECOND = 4000

export function planAudioSegments(params: {
  totalBytes: number
  durationSeconds: number
  maxSegmentSeconds?: number
  maxSegmentBytes?: number
}): AudioSegment[] {
  const { totalBytes } = params
  if (totalBytes <= 0) return []

  const maxSegmentSeconds = params.maxSegmentSeconds ?? MAX_SEGMENT_SECONDS
  const maxSegmentBytes = params.maxSegmentBytes ?? MAX_SEGMENT_BYTES

  // The recording is constant-bitrate MP3, so byte offset and playback time are
  // proportional; that is what lets a byte range stand in for a time range.
  const bytesPerSecond =
    params.durationSeconds > 0 ? totalBytes / params.durationSeconds : ASSUMED_BYTES_PER_SECOND

  // Slice by bytes, derived from whichever cap binds first, so a segment can
  // never exceed the request limit no matter what bitrate the audio is.
  const segmentBytes = Math.max(1, Math.min(maxSegmentBytes, Math.floor(maxSegmentSeconds * bytesPerSecond)))

  const segments: AudioSegment[] = []
  for (let byteOffset = 0, index = 0; byteOffset < totalBytes; byteOffset += segmentBytes, index++) {
    const byteLength = Math.min(segmentBytes, totalBytes - byteOffset)
    segments.push({
      index,
      byteOffset,
      byteLength,
      startSeconds: Math.round(byteOffset / bytesPerSecond),
      durationSeconds: Math.round(byteLength / bytesPerSecond),
    })
  }

  return segments
}

/** How far into a slice to look for a frame header before giving up. */
const FRAME_SCAN_BYTES = 4096

/**
 * Finds the first MPEG audio frame header in a slice.
 *
 * Cutting a recording on a byte boundary usually lands mid-frame, and the
 * partial frame at the front is garbage to a decoder. The sync word is eleven
 * set bits: `0xFF` followed by a byte whose top three bits are set. Returns 0
 * when nothing is found, so a slice is passed through unchanged rather than
 * silently losing audio.
 */
export function findMp3FrameStart(bytes: Uint8Array, scanBytes: number = FRAME_SCAN_BYTES): number {
  const limit = Math.min(bytes.length - 1, scanBytes)
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) return i
  }
  return 0
}
