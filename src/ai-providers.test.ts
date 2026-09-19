import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  GEMINI_MAX_OUTPUT_TOKENS,
  GEMINI_UPLOAD_CHUNK_BYTES,
  analyzeTranscriptWithGemini,
  callGeminiChat,
  fetchGeminiWithRetry,
  transcribeAudioSegmentWithGemini,
  uploadAudioToGeminiFiles,
} from './ai-providers.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

const AI_RESULT = {
  transcript: [{ id: 't-1', timestamp: '00:00', seconds: 0, speaker: 'Speaker 1', text: 'Hello.' }],
  summary: { overview: 'A sync.', key_points: [], action_items: [], decisions: [] },
  suggested_title: 'Weekly Sync',
}

function geminiCandidate(payload: unknown) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }
}

describe('fetchGeminiWithRetry', () => {
  it('retries a 503 and returns the eventual success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('overloaded', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const res = await fetchGeminiWithRetry('https://example.test', { method: 'POST' })

    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a non-retryable 403 and surfaces the status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(fetchGeminiWithRetry('https://example.test', {})).rejects.toThrow(/403/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('uploadAudioToGeminiFiles', () => {
  it('uploads in chunks, finalizes the last one, and returns the ACTIVE file reference', async () => {
    const byteLength = GEMINI_UPLOAD_CHUNK_BYTES + 1024
    const commands: string[] = []
    const offsets: string[] = []

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url)
      if (href.endsWith('/upload/v1beta/files')) {
        return new Response('{}', {
          status: 200,
          headers: { 'x-goog-upload-url': 'https://upload.test/session' },
        })
      }
      if (href === 'https://upload.test/session') {
        const headers = init?.headers as Record<string, string>
        commands.push(headers['X-Goog-Upload-Command'])
        offsets.push(headers['X-Goog-Upload-Offset'])
        return jsonResponse({
          file: { name: 'files/abc', uri: 'https://files.test/abc', mimeType: 'audio/mpeg', state: 'ACTIVE' },
        })
      }
      throw new Error(`unexpected fetch: ${href}`)
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await uploadAudioToGeminiFiles({
      apiKey: 'key',
      byteLength,
      mimeType: 'audio/mpeg',
      displayName: 'session.mp3',
      readChunk: async (_offset, length) => new Uint8Array(length),
    })

    expect(commands).toEqual(['upload', 'upload, finalize'])
    expect(offsets).toEqual(['0', String(GEMINI_UPLOAD_CHUNK_BYTES)])
    expect(result).toEqual({ fileUri: 'https://files.test/abc', mimeType: 'audio/mpeg' })
  })

  it('polls until the uploaded file leaves PROCESSING', async () => {
    let statusCalls = 0
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/upload/v1beta/files')) {
        return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.test/s' } })
      }
      if (href === 'https://upload.test/s') {
        return jsonResponse({ file: { name: 'files/abc', uri: 'u', state: 'PROCESSING' } })
      }
      statusCalls++
      return jsonResponse({ state: statusCalls < 2 ? 'PROCESSING' : 'ACTIVE', mimeType: 'audio/mpeg' })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await uploadAudioToGeminiFiles({
      apiKey: 'key',
      byteLength: 4,
      mimeType: 'audio/mpeg',
      displayName: 'session.mp3',
      readChunk: async (_o, l) => new Uint8Array(l),
      pollIntervalMs: 1,
    })

    expect(statusCalls).toBe(2)
    expect(result.fileUri).toBe('u')
  })

  it('throws when Google reports the upload as FAILED', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url)
      if (href.endsWith('/upload/v1beta/files')) {
        return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.test/s' } })
      }
      if (href === 'https://upload.test/s') {
        return jsonResponse({ file: { name: 'files/abc', uri: 'u', state: 'PROCESSING' } })
      }
      return jsonResponse({ state: 'FAILED' })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      uploadAudioToGeminiFiles({
        apiKey: 'key',
        byteLength: 4,
        mimeType: 'audio/mpeg',
        displayName: 'session.mp3',
        readChunk: async (_o, l) => new Uint8Array(l),
        pollIntervalMs: 1,
      })
    ).rejects.toThrow(/FAILED/)
  })

  it('refuses to upload an empty recording', async () => {
    await expect(
      uploadAudioToGeminiFiles({
        apiKey: 'key',
        byteLength: 0,
        mimeType: 'audio/mpeg',
        displayName: 'session.mp3',
        readChunk: async () => new Uint8Array(0),
      })
    ).rejects.toThrow(/empty/i)
  })
})

describe('transcribeAudioSegmentWithGemini (audio handling)', () => {
  const SEGMENT = { index: 0, byteOffset: 0, byteLength: 3, startSeconds: 0, durationSeconds: 60 }
  const TRANSCRIPT_ONLY = {
    transcript: [{ id: 't-1', timestamp: '00:00', seconds: 0, speaker: 'Andi (Host)', text: 'Hello.' }],
  }

  it('references an already-uploaded file instead of inlining audio bytes', async () => {
    let body: any
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return jsonResponse(geminiCandidate(TRANSCRIPT_ONLY))
    }) as unknown as typeof fetch

    const items = await transcribeAudioSegmentWithGemini({
      apiKey: 'key',
      audioFile: { fileUri: 'https://files.test/abc', mimeType: 'audio/mpeg' },
      segment: SEGMENT,
      segmentCount: 1,
    })

    const parts = body.contents[0].parts
    expect(parts.some((p: any) => p.inlineData)).toBe(false)
    expect(parts.find((p: any) => p.fileData).fileData).toEqual({
      mimeType: 'audio/mpeg',
      fileUri: 'https://files.test/abc',
    })
    expect(items[0].speaker).toBe('Andi (Host)')
  })

  it('inlines a small audio buffer as base64', async () => {
    let body: any
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return jsonResponse(geminiCandidate(TRANSCRIPT_ONLY))
    }) as unknown as typeof fetch

    await transcribeAudioSegmentWithGemini({
      apiKey: 'key',
      audioBuffer: new Uint8Array([1, 2, 3]).buffer,
      segment: SEGMENT,
      segmentCount: 1,
    })

    const inline = body.contents[0].parts.find((p: any) => p.inlineData)
    expect(inline.inlineData.data).toBe(Buffer.from([1, 2, 3]).toString('base64'))
  })

  it('strips a fenced code block before parsing', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify(TRANSCRIPT_ONLY) + '\n```' }] } }],
      })
    ) as unknown as typeof fetch

    const items = await transcribeAudioSegmentWithGemini({
      apiKey: 'key',
      audioBuffer: new Uint8Array([1]).buffer,
      segment: SEGMENT,
      segmentCount: 1,
    })
    expect(items).toHaveLength(1)
  })
})

describe('speaker identification', () => {
  const SEGMENT = { index: 1, byteOffset: 0, byteLength: 3, startSeconds: 900, durationSeconds: 900 }

  function captureTranscriptionPrompt(): { prompt: () => string } {
    let captured = ''
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)).contents[0].parts[0].text
      return jsonResponse(geminiCandidate({ transcript: [] }))
    }) as unknown as typeof fetch
    return { prompt: () => captured }
  }

  it('asks for real names and one label per voice', async () => {
    // Arrange
    const captured = captureTranscriptionPrompt()

    // Act
    await transcribeAudioSegmentWithGemini({
      apiKey: 'k',
      audioBuffer: new Uint8Array([1]).buffer,
      segment: SEGMENT,
      segmentCount: 2,
    })

    // Assert
    expect(captured.prompt()).toMatch(/real name/i)
    expect(captured.prompt()).toMatch(/never invent a name/i)
  })

  it('carries the speakers found so far into a later segment', async () => {
    // Arrange: without this, "Speaker 1" in part 2 can be a different person
    // than "Speaker 1" in part 1.
    const captured = captureTranscriptionPrompt()

    // Act
    await transcribeAudioSegmentWithGemini({
      apiKey: 'k',
      audioBuffer: new Uint8Array([1]).buffer,
      segment: SEGMENT,
      segmentCount: 2,
      knownSpeakers: ['Dewi (Finance)', 'Bagus'],
    })

    // Assert
    expect(captured.prompt()).toContain('Dewi (Finance)')
    expect(captured.prompt()).toContain('Bagus')
  })

  it('shows the model the lines immediately before the cut', async () => {
    // Arrange
    const captured = captureTranscriptionPrompt()

    // Act
    await transcribeAudioSegmentWithGemini({
      apiKey: 'k',
      audioBuffer: new Uint8Array([1]).buffer,
      segment: SEGMENT,
      segmentCount: 2,
      precedingContext: '[14:45] Dewi (Finance): so about the budget—',
    })

    // Assert
    expect(captured.prompt()).toContain('so about the budget—')
  })

  it('sends no roster on the first segment', async () => {
    const captured = captureTranscriptionPrompt()

    await transcribeAudioSegmentWithGemini({
      apiKey: 'k',
      audioBuffer: new Uint8Array([1]).buffer,
      segment: { index: 0, byteOffset: 0, byteLength: 3, startSeconds: 0, durationSeconds: 900 },
      segmentCount: 2,
    })

    expect(captured.prompt()).not.toMatch(/already been identified/i)
  })
})

describe('callGeminiChat', () => {
  it('sends history as alternating roles and returns the reply text', async () => {
    let body: any
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return jsonResponse({ candidates: [{ content: { parts: [{ text: ' Sure thing. ' }] } }] })
    }) as unknown as typeof fetch

    const reply = await callGeminiChat({
      apiKey: 'key',
      title: 'Sync',
      transcriptText: 'a transcript',
      summaryText: 'a summary',
      history: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
      message: 'what happened?',
    })

    expect(reply).toBe('Sure thing.')
    expect(body.contents.map((cnt: any) => cnt.role)).toEqual(['user', 'model', 'user'])
    expect(body.systemInstruction.parts[0].text).toContain('a transcript')
  })

  it('throws when Gemini returns no text part', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ candidates: [] })) as unknown as typeof fetch

    await expect(
      callGeminiChat({
        apiKey: 'key',
        title: 'Sync',
        transcriptText: '',
        summaryText: '',
        history: [],
        message: 'hi',
      })
    ).rejects.toThrow(/Empty response/)
  })
})

describe('output-token truncation', () => {
  it('reports a truncated analysis instead of failing on malformed JSON', async () => {
    // Arrange: Gemini stops mid-object when the transcript outgrows the cap.
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [
          { finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"transcript":[{"id":"t-1"' }] } },
        ],
      }),
    ) as unknown as typeof fetch

    // Act / Assert
    await expect(
      transcribeAudioSegmentWithGemini({
        apiKey: 'k',
        audioBuffer: new Uint8Array([1]).buffer,
        segment: { index: 0, byteOffset: 0, byteLength: 1, startSeconds: 0, durationSeconds: 900 },
        segmentCount: 8,
      }),
    ).rejects.toThrow(/output limit/i)
  })

  it('surfaces a non-STOP finish reason that returned no text at all', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] })) as unknown as typeof fetch

    await expect(
      analyzeTranscriptWithGemini({ apiKey: 'k', title: 'Sync', durationSeconds: 60, transcript: [] }),
    ).rejects.toThrow(/SAFETY/)
  })

  it('asks for the full output budget', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(geminiCandidate({ summary: AI_RESULT.summary })))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await analyzeTranscriptWithGemini({ apiKey: 'k', title: 'Sync', durationSeconds: 60, transcript: [] })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.generationConfig.maxOutputTokens).toBe(GEMINI_MAX_OUTPUT_TOKENS)
  })
})

describe('transcribeAudioSegmentWithGemini', () => {
  const segmentAudio = () => new Uint8Array([1, 2, 3]).buffer as ArrayBuffer

  it('shifts segment timestamps by the segment offset', async () => {
    // Arrange: the model numbers each segment from zero; the merged transcript
    // has to be in absolute meeting time.
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        geminiCandidate({
          transcript: [
            { id: 't-1', timestamp: '00:10', seconds: 10, speaker: 'Speaker 1', text: 'Second segment.' },
          ],
        }),
      ),
    ) as unknown as typeof fetch

    // Act
    const items = await transcribeAudioSegmentWithGemini({
      apiKey: 'k',
      audioBuffer: segmentAudio(),
      segment: { index: 1, byteOffset: 0, byteLength: 3, startSeconds: 900, durationSeconds: 900 },
      segmentCount: 2,
    })

    // Assert
    expect(items).toEqual([
      { id: 't-2-1', timestamp: '15:10', seconds: 910, speaker: 'Speaker 1', text: 'Second segment.' },
    ])
  })

  it('formats hour-long offsets as total minutes so timestamps stay sortable', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        geminiCandidate({
          transcript: [{ id: 't-1', timestamp: '00:05', seconds: 5, speaker: 'Speaker 2', text: 'Late.' }],
        }),
      ),
    ) as unknown as typeof fetch

    const items = await transcribeAudioSegmentWithGemini({
      apiKey: 'k',
      audioBuffer: segmentAudio(),
      segment: { index: 7, byteOffset: 0, byteLength: 3, startSeconds: 6300, durationSeconds: 900 },
      segmentCount: 8,
    })

    expect(items[0]).toMatchObject({ seconds: 6305, timestamp: '105:05' })
  })

  it('rejects a segment response that is missing its transcript', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(geminiCandidate({ notes: 'nothing here' }))) as unknown as typeof fetch

    await expect(
      transcribeAudioSegmentWithGemini({
        apiKey: 'k',
        audioBuffer: segmentAudio(),
        segment: { index: 0, byteOffset: 0, byteLength: 3, startSeconds: 0, durationSeconds: 900 },
        segmentCount: 2,
      }),
    ).rejects.toThrow(/transcript/i)
  })
})

describe('analyzeTranscriptWithGemini', () => {
  const transcript = [{ id: 't-1', timestamp: '00:00', seconds: 0, speaker: 'Speaker 1', text: 'Ship on Friday.' }]

  it('summarizes from transcript text without re-sending the audio', async () => {
    // Arrange
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        geminiCandidate({
          summary: { overview: 'Ship talk.', key_points: [], action_items: [], decisions: [], sentiment: 'Positive' },
          suggested_title: 'Ship Decision',
        }),
      ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    // Act
    const result = await analyzeTranscriptWithGemini({
      apiKey: 'k',
      title: '',
      durationSeconds: 7200,
      transcript,
    })

    // Assert
    expect(result.summary.overview).toBe('Ship talk.')
    expect(result.suggestedTitle).toBe('Ship Decision')
    const body = (fetchMock.mock.calls[0][1] as RequestInit).body as string
    expect(body).toContain('Ship on Friday.')
    expect(body).not.toContain('inlineData')
  })

  it('rejects a response with no summary object', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(geminiCandidate({ suggested_title: 'Only a title' }))) as unknown as typeof fetch

    await expect(
      analyzeTranscriptWithGemini({ apiKey: 'k', title: 'Sync', durationSeconds: 60, transcript }),
    ).rejects.toThrow(/summary/i)
  })
})
