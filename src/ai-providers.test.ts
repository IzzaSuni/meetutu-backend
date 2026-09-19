import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  GEMINI_UPLOAD_CHUNK_BYTES,
  callGeminiChat,
  callGeminiGatewayAI,
  fetchGeminiWithRetry,
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

describe('callGeminiGatewayAI', () => {
  it('references an already-uploaded file instead of inlining audio bytes', async () => {
    let body: any
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return jsonResponse(geminiCandidate(AI_RESULT))
    }) as unknown as typeof fetch

    const result = await callGeminiGatewayAI({
      apiKey: 'key',
      title: 'Untitled Meeting',
      durationSeconds: 60,
      audioFile: { fileUri: 'https://files.test/abc', mimeType: 'audio/mpeg' },
    })

    const parts = body.contents[0].parts
    expect(parts.some((p: any) => p.inlineData)).toBe(false)
    expect(parts.find((p: any) => p.fileData).fileData).toEqual({
      mimeType: 'audio/mpeg',
      fileUri: 'https://files.test/abc',
    })
    expect(result.suggestedTitle).toBe('Weekly Sync')
  })

  it('inlines a small audio buffer as base64', async () => {
    let body: any
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return jsonResponse(geminiCandidate(AI_RESULT))
    }) as unknown as typeof fetch

    await callGeminiGatewayAI({
      apiKey: 'key',
      title: 'Sync',
      durationSeconds: 10,
      audioBuffer: new Uint8Array([1, 2, 3]).buffer,
    })

    const inline = body.contents[0].parts.find((p: any) => p.inlineData)
    expect(inline.inlineData.data).toBe(Buffer.from([1, 2, 3]).toString('base64'))
  })

  it('rejects a response that is missing the transcript/summary shape', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(geminiCandidate({ nope: true }))) as unknown as typeof fetch

    await expect(
      callGeminiGatewayAI({ apiKey: 'key', title: 'Sync', durationSeconds: 10 })
    ).rejects.toThrow(/expected transcript\/summary/)
  })

  it('strips a fenced code block before parsing', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify(AI_RESULT) + '\n```' }] } }],
      })
    ) as unknown as typeof fetch

    const result = await callGeminiGatewayAI({ apiKey: 'key', title: 'Sync', durationSeconds: 10 })
    expect(result.transcript).toHaveLength(1)
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
