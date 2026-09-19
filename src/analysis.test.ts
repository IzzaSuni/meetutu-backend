import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from './db.js'
import { createStorage, type Storage } from './storage.js'
import { createAudioStorage, type AudioStorage } from './audio-storage.js'
import { createAnalysisRunner, createGeminiGenerator, createGenerator, type AnalysisRequest } from './analysis.js'
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
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      calledUrls.push(String(url))
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ transcript: aiResult.transcript, summary: aiResult.summary }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const generate = createGenerator({
      audio,
      config: {
        port: 8787,
        host: '0.0.0.0',
        dataDir: '.',
        authUsername: 'admin',
        authPassword: 'secret',
        geminiApiKey: 'gemini-key',
        geminiApiUrl: 'https://gemini.test/v1beta',
        geminiModel: 'gemini-3.6-flash',
        corsOrigins: ['*'],
      },
    })

    const result = await generate(
      request({ kind: 'openrouter', model: 'anthropic/claude-3.5-haiku', openrouterKey: 'or-key' })
    )

    expect(calledUrls[0]).toContain('openrouter.ai')
    expect(result.transcript).toHaveLength(1)
  })
})
