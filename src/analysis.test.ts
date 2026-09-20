import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from './db.js'
import { createStorage, type Storage } from './storage.js'
import { createAudioStorage, type AudioStorage } from './audio-storage.js'
import {
  createAnalysisRunner,
  createGeminiGenerator,
  createGenerator,
  createOpenRouterGenerator,
  SEGMENT_ATTEMPTS,
  type AnalysisRequest,
} from './analysis.js'
import { UNTITLED_MEETING_TITLE } from './constants.js'
import type { MeetingSession } from './types.js'

const session = (overrides: Partial<MeetingSession> = {}): MeetingSession => ({
  id: 1,
  title: UNTITLED_MEETING_TITLE,
  status: 'completed',
  duration: 60,
  created_at: '2026-09-17T00:00:00.000Z',
  parts_count: 1,
  audio_url: '/api/recordings/1/audio',
  ...overrides,
})

const request = (overrides: Partial<AnalysisRequest> = {}): AnalysisRequest => ({
  sessionId: 1,
  title: UNTITLED_MEETING_TITLE,
  durationSeconds: 60,
  provider: 'gemini (test)',
  kind: 'gemini',
  model: 'gemini-3.6-flash',
  ...overrides,
})

const aiResult = {
  transcript: [{ id: 't-1', timestamp: '00:00', seconds: 0, speaker: 'Speaker 1', text: 'Hello.' }],
  summary: { overview: 'A sync.', key_points: [], action_items: [], decisions: [] },
  suggestedTitle: 'Weekly Sync',
}

describe('analysis runner', () => {
  let dir: string
  let storage: Storage

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meetutu-analysis-'))
    storage = createStorage(openDatabase(join(dir, 'test.db')))
    storage.putSession(session())
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports processing as soon as the job is started', async () => {
    const runner = createAnalysisRunner({
      storage,
      generate: () => new Promise(() => {}),
    })

    await runner.start(request())

    expect(runner.status(1).status).toBe('processing')
    expect(storage.getAnalysisJob(1)?.status).toBe('processing')
  })

  it('finishes a job that outlives the start() call — no 30s ceiling like waitUntil', async () => {
    const runner = createAnalysisRunner({
      storage,
      generate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return aiResult
      },
    })

    await runner.start(request())
    expect(runner.status(1).status).toBe('processing')

    await runner.whenIdle()

    const done = runner.status(1)
    expect(done.status).toBe('done')
    expect(done.data?.transcript).toHaveLength(1)
    expect(storage.getTranscript(1)).toHaveLength(1)
    expect(storage.getSummary(1)?.overview).toBe('A sync.')
  })

  it('marks the session as having a transcript and summary', async () => {
    const runner = createAnalysisRunner({ storage, generate: async () => aiResult })

    await runner.start(request())
    await runner.whenIdle()

    const updated = storage.getSession(1)
    expect(updated?.has_transcription).toBe(true)
    expect(updated?.has_summary).toBe(true)
  })

  it('adopts the AI title only while the meeting is still untitled', async () => {
    const runner = createAnalysisRunner({ storage, generate: async () => aiResult })

    await runner.start(request())
    await runner.whenIdle()
    expect(storage.getSession(1)?.title).toBe('Weekly Sync')

    storage.putSession(session({ title: 'My Own Title' }))
    await runner.start(request({ title: 'My Own Title' }))
    await runner.whenIdle()
    expect(storage.getSession(1)?.title).toBe('My Own Title')
  })

  it('records a failure durably instead of leaving the client polling forever', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const runner = createAnalysisRunner({
      storage,
      generate: async () => {
        throw new Error('Gemini API error (400): nope')
      },
    })

    await runner.start(request())
    await runner.whenIdle()

    expect(runner.status(1)).toMatchObject({ status: 'error', error: 'Gemini API error (400): nope' })
    expect(storage.getAnalysisJob(1)?.status).toBe('error')
  })

  it('reports done from stored results after a process restart loses the in-memory job', async () => {
    const first = createAnalysisRunner({ storage, generate: async () => aiResult })
    await first.start(request())
    await first.whenIdle()

    const restarted = createAnalysisRunner({ storage, generate: async () => aiResult })

    const status = restarted.status(1)
    expect(status.status).toBe('done')
    expect(status.data?.transcript).toHaveLength(1)
  })

  it('reports a failure recorded before a restart', async () => {
    storage.putAnalysisJob(1, { status: 'error', error: 'boom', provider: 'gemini (test)' })
    const runner = createAnalysisRunner({ storage, generate: async () => aiResult })

    expect(runner.status(1)).toMatchObject({ status: 'error', error: 'boom' })
  })

  it('reports not_found for a session that was never analyzed', () => {
    const runner = createAnalysisRunner({ storage, generate: async () => aiResult })
    expect(runner.status(404).status).toBe('not_found')
  })

  it('forgets a job when its session is deleted', async () => {
    const runner = createAnalysisRunner({ storage, generate: async () => aiResult })
    await runner.start(request())
    await runner.whenIdle()

    storage.deleteSession(1)
    runner.forget(1)

    expect(runner.status(1).status).toBe('not_found')
  })
})

describe('gemini generator', () => {
  let dir: string
  let audio: AudioStorage
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meetutu-generator-'))
    audio = createAudioStorage(join(dir, 'audio'))
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  const geminiOk = () =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    transcript: aiResult.transcript,
                    summary: aiResult.summary,
                    suggested_title: 'Weekly Sync',
                  }),
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )

  it('inlines audio that is below the upload threshold', async () => {
    const urls: string[] = []
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      urls.push(String(url))
      return geminiOk()
    }) as unknown as typeof fetch

    await audio.putPart(1, 1, new Uint8Array([1, 2, 3, 4]))
    const generate = createGeminiGenerator({
      audio,
      apiKey: 'key',
      apiUrl: 'https://gemini.test/v1beta',
      inlineMaxBytes: 1024,
    })

    const result = await generate(request())

    expect(urls.some((u) => u.includes('/upload/v1beta/files'))).toBe(false)
    expect(result.suggestedTitle).toBe('Weekly Sync')
  })

  it('streams audio above the threshold through the Files API', async () => {
    const urls: string[] = []
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const href = String(url)
      urls.push(href)
      if (href.endsWith('/upload/v1beta/files')) {
        return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.test/s' } })
      }
      if (href === 'https://upload.test/s') {
        return new Response(
          JSON.stringify({ file: { name: 'files/a', uri: 'https://files.test/a', mimeType: 'audio/mpeg', state: 'ACTIVE' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return geminiOk()
    }) as unknown as typeof fetch

    await audio.putPart(1, 1, new Uint8Array(64))
    const generate = createGeminiGenerator({
      audio,
      apiKey: 'key',
      apiUrl: 'https://gemini.test/v1beta',
      inlineMaxBytes: 8,
    })

    await generate(request())

    expect(urls.some((u) => u.includes('/upload/v1beta/files'))).toBe(true)
  })

  it('fails clearly when the session has no audio', async () => {
    const generate = createGeminiGenerator({ audio, apiKey: 'key' })
    await expect(generate(request())).rejects.toThrow(/no audio/i)
  })

  it('dispatches an openrouter request to OpenRouter, not Gemini', async () => {
    const calledUrls: string[] = []
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calledUrls.push(String(url))
      const sentAudio = String(init?.body).includes('input_audio')
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify(
                  sentAudio ? { transcript: aiResult.transcript } : { summary: aiResult.summary }
                ),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    await audio.putPart(1, 1, new Uint8Array([1, 2, 3, 4]))
    const generate = createGenerator({
      audio,
      config: {
        port: 8787,
        host: '0.0.0.0',
        dataDir: '.',
        authUsername: 'admin',
        authPassword: 'secret',
        aiProvider: 'openrouter',
        geminiApiKey: 'gemini-key',
        geminiApiUrl: 'https://gemini.test/v1beta',
        geminiModel: 'gemini-3.6-flash',
        openrouterModel: 'google/gemini-3.8-flash',
        corsOrigins: ['*'],
      },
    })

    const result = await generate(
      request({ kind: 'openrouter', model: 'google/gemini-3.8-flash', openrouterKey: 'or-key' })
    )

    expect(calledUrls.every((url) => url.includes('openrouter.ai'))).toBe(true)
    expect(result.transcript).toHaveLength(1)
    expect(result.summary.overview).toBe('A sync.')
  })
})

describe('openrouter generator', () => {
  let dir: string
  let audio: AudioStorage
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meetutu-openrouter-'))
    audio = createAudioStorage(join(dir, 'audio'))
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  const orOk = (payload: unknown) =>
    new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  it('transcribes every segment then analyzes the merged transcript', async () => {
    // Arrange: four 15-minute segments' worth of audio, scaled down 1000x.
    const bodies: any[] = []
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      const sentAudio = JSON.stringify(body).includes('input_audio')
      return orOk(
        sentAudio
          ? { transcript: [{ id: 't-1', timestamp: '00:01', seconds: 1, speaker: 'Andi (Host)', text: 'Hi.' }] }
          : { summary: aiResult.summary, suggested_title: 'Weekly Sync' }
      )
    }) as unknown as typeof fetch

    const bytes = new Uint8Array(1440)
    for (let i = 0; i < bytes.length; i += 360) {
      bytes[i] = 0xff
      bytes[i + 1] = 0xfb
    }
    await audio.putPart(1, 1, bytes)

    const generate = createOpenRouterGenerator({ audio, maxSegmentSeconds: 900, maxSegmentBytes: 360 })

    // Act
    const result = await generate(
      request({ kind: 'openrouter', model: 'google/gemini-3.8-flash', openrouterKey: 'or-key', durationSeconds: 3600 })
    )

    // Assert: four transcription calls with audio, then one text-only analysis.
    const withAudio = bodies.filter((body) => JSON.stringify(body).includes('input_audio'))
    expect(withAudio).toHaveLength(4)
    expect(JSON.stringify(bodies[bodies.length - 1])).not.toContain('input_audio')
    expect(result.transcript).toHaveLength(4)
    expect(result.suggestedTitle).toBe('Weekly Sync')
  })

  it('reports progress through both stages', async () => {
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) =>
      String(init?.body).includes('input_audio')
        ? orOk({ transcript: [] })
        : orOk({ summary: aiResult.summary })
    ) as unknown as typeof fetch

    await audio.putPart(1, 1, new Uint8Array([0xff, 0xfb, 0, 0]))
    const generate = createOpenRouterGenerator({ audio })
    const stages: string[] = []

    await generate(request({ kind: 'openrouter', openrouterKey: 'or-key' }), {
      onProgress: (progress) => stages.push(progress.stage),
    })

    expect(stages).toEqual(['transcribing', 'analyzing'])
  })

  it('fails clearly when no OpenRouter key was supplied', async () => {
    await audio.putPart(1, 1, new Uint8Array([1, 2, 3, 4]))
    const generate = createOpenRouterGenerator({ audio })

    await expect(generate(request({ kind: 'openrouter' }))).rejects.toThrow(/OpenRouter API key/i)
  })

  // A provider that dies mid-generation answers 200 with finish_reason "error"
  // and either no content or half a JSON object. Observed on a real 19-minute
  // recording: part 2 of 5 failed that way twice while the same slice
  // transcribed fine on the next attempt.
  const orUnusable = (content?: string) =>
    new Response(JSON.stringify({ choices: [{ finish_reason: 'error', message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  const transcribed = { transcript: [{ id: 't-1', timestamp: '00:01', seconds: 1, speaker: 'Andi', text: 'Hi.' }] }

  async function runWithAudioResponses(responses: Response[]): Promise<{
    result: Promise<{ transcript: unknown[] }>
    audioCalls: () => number
  }> {
    let audioCalls = 0
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (!String(init?.body).includes('input_audio')) return orOk({ summary: aiResult.summary })
      const response = responses[Math.min(audioCalls, responses.length - 1)]
      audioCalls++
      return response.clone()
    }) as unknown as typeof fetch

    await audio.putPart(1, 1, new Uint8Array([0xff, 0xfb, 0, 0]))
    const generate = createOpenRouterGenerator({ audio })
    return {
      result: generate(request({ kind: 'openrouter', openrouterKey: 'or-key' })),
      audioCalls: () => audioCalls,
    }
  }

  it('retries a segment whose response came back empty', async () => {
    const { result, audioCalls } = await runWithAudioResponses([orUnusable(), orOk(transcribed)])

    expect((await result).transcript).toHaveLength(1)
    expect(audioCalls()).toBe(2)
  })

  it('retries a segment whose JSON came back truncated', async () => {
    const truncated = new Response(
      JSON.stringify({ choices: [{ finish_reason: 'error', message: { content: '{"transcript": [{"text": "cut' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
    const { result, audioCalls } = await runWithAudioResponses([truncated, orOk(transcribed)])

    expect((await result).transcript).toHaveLength(1)
    expect(audioCalls()).toBe(2)
  })

  it('gives up on a segment that stays unusable, naming the part', async () => {
    const { result, audioCalls } = await runWithAudioResponses([orUnusable()])

    await expect(result).rejects.toThrow(/part 1 of 1/)
    expect(audioCalls()).toBe(SEGMENT_ATTEMPTS)
  })

  it('does not retry a rejected request — a bad key stays bad', async () => {
    const rejected = new Response('{"error":{"message":"No auth credentials found"}}', { status: 401 })
    const { result, audioCalls } = await runWithAudioResponses([rejected])

    await expect(result).rejects.toThrow(/401/)
    expect(audioCalls()).toBe(1)
  })
})

describe('long-meeting segmentation', () => {
  let dir: string
  let audio: AudioStorage
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meetutu-segments-'))
    audio = createAudioStorage(join(dir, 'audio'))
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  const jsonOk = (payload: unknown) =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  // A two-hour recording at the 32 kbps the recorder produces, shrunk by a
  // factor of 1000 so the test stays fast; the segment caps are scaled to match.
  const TWO_HOURS = 7200
  const RECORDING_BYTES = 2880

  async function putRecording(bytes = RECORDING_BYTES): Promise<void> {
    const audioBytes = new Uint8Array(bytes)
    // A frame header at the head of every 360-byte slice, so alignment is a no-op.
    for (let i = 0; i < bytes; i += 360) {
      audioBytes[i] = 0xff
      audioBytes[i + 1] = 0xfb
    }
    await audio.putPart(1, 1, audioBytes)
  }

  function segmentedGenerator() {
    return createGeminiGenerator({
      audio,
      apiKey: 'key',
      apiUrl: 'https://gemini.test/v1beta',
      maxSegmentSeconds: 900,
      maxSegmentBytes: 400,
    })
  }

  it('transcribes a long recording in segments and summarizes once', async () => {
    // Arrange
    const bodies: string[] = []
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      bodies.push(body)
      if (body.includes('"inlineData"')) {
        return jsonOk({
          transcript: [{ id: 't-1', timestamp: '00:05', seconds: 5, speaker: 'Speaker 1', text: 'Part.' }],
        })
      }
      return jsonOk({
        summary: { overview: 'Long meeting.', key_points: [], action_items: [], decisions: [] },
        suggested_title: 'Quarterly Planning',
      })
    }) as unknown as typeof fetch
    await putRecording()

    // Act
    const result = await segmentedGenerator()(request({ durationSeconds: TWO_HOURS }), {})

    // Assert
    const transcriptionCalls = bodies.filter((body) => body.includes('"inlineData"'))
    expect(transcriptionCalls).toHaveLength(8)
    expect(result.transcript).toHaveLength(8)
    expect(result.summary.overview).toBe('Long meeting.')
    expect(result.suggestedTitle).toBe('Quarterly Planning')
  })

  it('merges segment transcripts into one rising timeline', async () => {
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      if (body.includes('"inlineData"')) {
        return jsonOk({
          transcript: [{ id: 't-1', timestamp: '00:05', seconds: 5, speaker: 'Speaker 1', text: 'Part.' }],
        })
      }
      return jsonOk({ summary: { overview: 'ok', key_points: [], action_items: [], decisions: [] } })
    }) as unknown as typeof fetch
    await putRecording()

    const result = await segmentedGenerator()(request({ durationSeconds: TWO_HOURS }), {})

    expect(result.transcript.map((item) => item.seconds)).toEqual([5, 905, 1805, 2705, 3605, 4505, 5405, 6305])
    expect(result.transcript[7].timestamp).toBe('105:05')
    expect(new Set(result.transcript.map((item) => item.id)).size).toBe(8)
  })

  it('analyzes the merged transcript rather than re-sending the audio', async () => {
    let summaryBody = ''
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      if (body.includes('"inlineData"')) {
        return jsonOk({
          transcript: [{ id: 't-1', timestamp: '00:05', seconds: 5, speaker: 'Speaker 1', text: 'Budget approved.' }],
        })
      }
      summaryBody = body
      return jsonOk({ summary: { overview: 'ok', key_points: [], action_items: [], decisions: [] } })
    }) as unknown as typeof fetch
    await putRecording()

    await segmentedGenerator()(request({ durationSeconds: TWO_HOURS }), {})

    expect(summaryBody).toContain('Budget approved.')
    expect(summaryBody).not.toContain('inlineData')
  })

  it('reports segment progress while it works', async () => {
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      if (body.includes('"inlineData"')) {
        return jsonOk({ transcript: [] })
      }
      return jsonOk({ summary: { overview: 'ok', key_points: [], action_items: [], decisions: [] } })
    }) as unknown as typeof fetch
    await putRecording()

    const updates: string[] = []
    await segmentedGenerator()(request({ durationSeconds: TWO_HOURS }), {
      onProgress: (progress) => updates.push(`${progress.stage} ${progress.completedSegments}/${progress.totalSegments}`),
    })

    expect(updates[0]).toBe('transcribing 1/8')
    expect(updates.at(-1)).toBe('analyzing 8/8')
  })

  it('transcribes then analyzes even for a short meeting, never in one call', async () => {
    // Arrange: transcription and analysis are separate steps regardless of
    // length — the model is never asked to summarize straight off the audio.
    const bodies: string[] = []
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      bodies.push(body)
      if (body.includes('"inlineData"')) {
        return jsonOk({
          transcript: [{ id: 't-1', timestamp: '00:00', seconds: 0, speaker: 'Andi (Host)', text: 'Hi.' }],
        })
      }
      return jsonOk({ summary: { overview: 'Short.', key_points: [], action_items: [], decisions: [] } })
    }) as unknown as typeof fetch
    await putRecording(360)

    // Act
    const result = await segmentedGenerator()(request({ durationSeconds: 90 }), {})

    // Assert
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toContain('"inlineData"')
    expect(bodies[1]).not.toContain('"inlineData"')
    expect(result.transcript[0].speaker).toBe('Andi (Host)')
    expect(result.summary.overview).toBe('Short.')
  })

  it('reuses speaker labels from earlier segments in later ones', async () => {
    // Arrange: each segment is a separate call, so the model has to be told
    // who has already been identified or "Speaker 1" drifts between people.
    const prompts: string[] = []
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      if (body.includes('"inlineData"')) {
        prompts.push(JSON.parse(body).contents[0].parts[0].text)
        return jsonOk({
          transcript: [{ id: 't-1', timestamp: '00:01', seconds: 1, speaker: 'Dewi (Finance)', text: 'Yes.' }],
        })
      }
      return jsonOk({ summary: { overview: 'ok', key_points: [], action_items: [], decisions: [] } })
    }) as unknown as typeof fetch
    await putRecording()

    // Act
    await segmentedGenerator()(request({ durationSeconds: TWO_HOURS }), {})

    // Assert
    expect(prompts[0]).not.toContain('Dewi (Finance)')
    expect(prompts[1]).toContain('Dewi (Finance)')
    expect(prompts[1]).toContain('Yes.')
  })

  it('uploads an oversized segment through the Files API instead of inlining it', async () => {
    const urls: string[] = []
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url)
      urls.push(href)
      if (href.endsWith('/upload/v1beta/files')) {
        return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.test/s' } })
      }
      if (href === 'https://upload.test/s') {
        return new Response(
          JSON.stringify({ file: { name: 'files/a', uri: 'https://files.test/a', mimeType: 'audio/mpeg', state: 'ACTIVE' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      const body = String(init?.body ?? '')
      if (body.includes('"fileData"')) return jsonOk({ transcript: [] })
      return jsonOk({ summary: { overview: 'ok', key_points: [], action_items: [], decisions: [] } })
    }) as unknown as typeof fetch
    await putRecording()

    const generate = createGeminiGenerator({
      audio,
      apiKey: 'key',
      apiUrl: 'https://gemini.test/v1beta',
      maxSegmentSeconds: 900,
      maxSegmentBytes: 400,
      inlineMaxBytes: 100,
    })
    await generate(request({ durationSeconds: TWO_HOURS }), {})

    expect(urls.filter((url) => url.endsWith('/upload/v1beta/files'))).toHaveLength(8)
  })

  it('names the failing segment when one of them errors', async () => {
    let call = 0
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      call++
      if (call === 3) return new Response('kaboom', { status: 403 })
      const body = String(init?.body ?? '')
      if (body.includes('"inlineData"')) return jsonOk({ transcript: [] })
      return jsonOk({ summary: { overview: 'ok', key_points: [], action_items: [], decisions: [] } })
    }) as unknown as typeof fetch
    await putRecording()

    await expect(segmentedGenerator()(request({ durationSeconds: TWO_HOURS }), {})).rejects.toThrow(/part 3 of 8/)
  })
})
