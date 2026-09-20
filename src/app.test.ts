import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { openDatabase } from './db.js'
import { createStorage, type Storage } from './storage.js'
import { createAudioStorage, type AudioStorage } from './audio-storage.js'
import { createAnalysisRunner, type AnalysisGenerator, type AnalysisRunner } from './analysis.js'
import { createApp } from './app.js'
import { computeAuthToken } from './auth.js'
import type { Config } from './config.js'
import { UNTITLED_MEETING_TITLE } from './constants.js'

const config: Config = {
  port: 8787,
  host: '0.0.0.0',
  dataDir: '.',
  authUsername: 'admin',
  authPassword: 'secret',
  aiProvider: 'gemini',
  geminiApiKey: 'gemini-key',
  geminiApiUrl: 'https://gemini.test/v1beta',
  geminiModel: 'gemini-3.6-flash',
  openrouterModel: 'google/gemini-3.8-flash',
  corsOrigins: ['*'],
}

const TOKEN = computeAuthToken(config.authUsername, config.authPassword)
const auth = { Authorization: `Bearer ${TOKEN}` }
const json = { 'Content-Type': 'application/json', ...auth }

const aiResult = {
  transcript: [{ id: 't-1', timestamp: '00:00', seconds: 0, speaker: 'Speaker 1', text: 'Hello.' }],
  summary: {
    overview: 'A sync.',
    key_points: [{ text: 'Shipped the thing.' }],
    action_items: [{ id: 'act-1', task: 'Follow up', assignee: 'Akbar', status: 'pending' as const }],
    decisions: [],
  },
  suggestedTitle: 'Weekly Sync',
}

describe('meetutu backend app', () => {
  let dir: string
  let storage: Storage
  let audio: AudioStorage
  let analysis: AnalysisRunner
  let app: Hono
  let generate: AnalysisGenerator
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meetutu-app-'))
    storage = createStorage(openDatabase(join(dir, 'test.db')))
    audio = createAudioStorage(join(dir, 'audio'))
    generate = async () => aiResult
    analysis = createAnalysisRunner({ storage, generate: (req) => generate(req) })
    app = createApp({ config, storage, audio, analysis })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const createSession = async (title?: string) => {
    const res = await app.request('/api/session', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ id: 1, ...(title ? { title } : {}) }),
    })
    return res.json() as Promise<{ id: number; title: string }>
  }

  describe('auth', () => {
    it('serves health without a token', async () => {
      const res = await app.request('/api/health')
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ status: 'ok', app: 'meetutu', storage: 'filesystem' })
    })

    it('rejects an API call with no token', async () => {
      const res = await app.request('/api/sessions')
      expect(res.status).toBe(401)
    })

    it('rejects an API call with the wrong token', async () => {
      const res = await app.request('/api/sessions', { headers: { Authorization: 'Bearer nope' } })
      expect(res.status).toBe(401)
    })

    it('issues a token for the configured credentials', async () => {
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'secret' }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true, token: TOKEN })
    })

    it('rejects bad credentials', async () => {
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'wrong' }),
      })
      expect(res.status).toBe(401)
    })

    it('answers a CORS preflight without a token', async () => {
      const res = await app.request('/api/sessions', {
        method: 'OPTIONS',
        headers: { Origin: 'https://meetutu.app', 'Access-Control-Request-Method': 'GET' },
      })
      expect(res.status).toBe(204)
    })
  })

  describe('sessions', () => {
    it('creates a session with the default title', async () => {
      const body = await createSession()
      expect(body.title).toBe(UNTITLED_MEETING_TITLE)
      expect(body.id).toBe(1)
    })

    it('lists sessions newest first', async () => {
      await createSession()
      await app.request('/api/session', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ id: 2 }),
      })

      const res = await app.request('/api/sessions', { headers: auth })
      const body: any = await res.json()
      expect(body.success).toBe(true)
      expect(body.data.map((s: any) => s.id)).toEqual([2, 1])
    })

    it('returns 404 for a session that does not exist', async () => {
      const res = await app.request('/api/sessions/999', { headers: auth })
      expect(res.status).toBe(404)
    })

    it('renames a session', async () => {
      await createSession()
      const res = await app.request('/api/sessions/1', {
        method: 'PATCH',
        headers: json,
        body: JSON.stringify({ title: 'Renamed', duration: 90 }),
      })
      const body: any = await res.json()
      expect(body.data.title).toBe('Renamed')
      expect(body.data.duration).toBe(90)
      expect(storage.getSession(1)?.title).toBe('Renamed')
    })

    it('deletes a session, its audio, and its analysis job', async () => {
      await createSession()
      await audio.putPart(1, 1, new Uint8Array([1, 2, 3]))
      storage.putAnalysisJob(1, { status: 'done' })

      const res = await app.request('/api/sessions/1', { method: 'DELETE', headers: auth })

      expect(res.status).toBe(200)
      expect(storage.getSession(1)).toBeUndefined()
      expect(await audio.getLayout(1)).toBeNull()
      expect(analysis.status(1).status).toBe('not_found')
    })

    it('marks a session completed when processing finishes', async () => {
      await createSession()
      const res = await app.request('/api/process', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ id: 1, payload: { duration: 120 } }),
      })

      expect(await res.json()).toMatchObject({ success: true, status: 'completed', sessionId: 1 })
      expect(storage.getSession(1)).toMatchObject({ status: 'completed', duration: 120 })
    })
  })

  describe('audio upload and playback', () => {
    it('hands back the upload URL shape the audio engine expects', async () => {
      const res = await app.request('/api/presign-part', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ id: 1, partNumber: 2 }),
      })
      expect(await res.json()).toEqual({ data: { url: '/api/recordings/1/parts/2' } })
    })

    it('stores an uploaded part and exposes its ETag to the browser', async () => {
      const res = await app.request('/api/recordings/1/parts/1', {
        method: 'PUT',
        headers: auth,
        body: new Uint8Array([1, 2, 3]),
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('ETag')).toBeTruthy()
      expect(res.headers.get('Access-Control-Expose-Headers')).toContain('ETag')
      expect(await res.json()).toMatchObject({ success: true, sessionId: 1, partNumber: 1, size: 3 })
    })

    it('accepts a part uploaded through the query-string form', async () => {
      const res = await app.request('/api/presign-part?id=1&part=3', {
        method: 'PUT',
        headers: auth,
        body: new Uint8Array([7]),
      })
      expect(res.status).toBe(200)
      expect(await audio.getPart(1, 3)).toEqual(new Uint8Array([7]))
    })

    it('streams a single part back', async () => {
      await audio.putPart(1, 1, new Uint8Array([1, 2, 3]))
      const res = await app.request('/api/recordings/1/parts/1', { headers: auth })

      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('audio/mpeg')
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    })

    it('404s on a part that was never uploaded', async () => {
      const res = await app.request('/api/recordings/1/parts/5', { headers: auth })
      expect(res.status).toBe(404)
    })

    it('streams the whole recording as one MP3', async () => {
      await audio.putPart(1, 1, new Uint8Array([1, 2]))
      await audio.putPart(1, 2, new Uint8Array([3, 4]))

      const res = await app.request('/api/recordings/1/audio', { headers: auth })

      expect(res.headers.get('Content-Type')).toBe('audio/mpeg')
      expect(res.headers.get('Content-Length')).toBe('4')
      expect(res.headers.get('Accept-Ranges')).toBe('bytes')
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
    })

    it('answers HEAD on the recording with the size and no body', async () => {
      await audio.putPart(1, 1, new Uint8Array([1, 2]))
      const res = await app.request('/api/recordings/1/audio', { method: 'HEAD', headers: auth })

      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Length')).toBe('2')
    })

    it('404s the recording of a session with no audio', async () => {
      const res = await app.request('/api/recordings/9/audio', { headers: auth })
      expect(res.status).toBe(404)
    })

    it('tracks the highest part number on the session', async () => {
      await createSession()
      await app.request('/api/add-part', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ id: 1, payload: { part_number: 4 } }),
      })

      expect(storage.getSession(1)?.parts_count).toBe(4)
    })
  })

  describe('analysis', () => {
    it('accepts a transcribe request and reports the result once the job lands', async () => {
      await createSession()
      await audio.putPart(1, 1, new Uint8Array([1, 2, 3]))

      const res = await app.request('/api/recordings/1/transcribe', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(202)
      expect(await res.json()).toMatchObject({ success: true, sessionId: 1, status: 'processing' })

      await analysis.whenIdle()

      const status = await app.request('/api/recordings/1/analysis-status', { headers: auth })
      const body: any = await status.json()
      expect(body.status).toBe('done')
      expect(body.data.transcript).toHaveLength(1)
    })

    it('refuses to transcribe a session with no audio', async () => {
      await createSession()
      const res = await app.request('/api/recordings/1/transcribe', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(404)
      expect((await res.json() as any).error).toMatch(/no audio/i)
    })

    it('surfaces an analysis failure through the status endpoint', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await createSession()
      await audio.putPart(1, 1, new Uint8Array([1]))
      generate = async () => {
        throw new Error('Gemini API error (400): nope')
      }

      await app.request('/api/recordings/1/transcribe', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({}),
      })
      await analysis.whenIdle()

      const body: any = await (await app.request('/api/recordings/1/analysis-status', { headers: auth })).json()
      expect(body).toMatchObject({ status: 'error', error: 'Gemini API error (400): nope' })
    })

    it('reports not_found for a session that was never analyzed', async () => {
      const body: any = await (await app.request('/api/recordings/7/analysis-status', { headers: auth })).json()
      expect(body.status).toBe('not_found')
    })

    it('caps runaway custom instructions before they reach the model', async () => {
      await createSession()
      await audio.putPart(1, 1, new Uint8Array([1]))
      let seen: string | undefined
      generate = async (req) => {
        seen = req.customInstructions
        return aiResult
      }

      await app.request('/api/recordings/1/transcribe', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ customInstructions: 'x'.repeat(900) }),
      })
      await analysis.whenIdle()

      expect(seen).toHaveLength(500)
    })

    it('rejects an OpenRouter run with no key configured', async () => {
      await createSession()
      await audio.putPart(1, 1, new Uint8Array([1]))
      const res = await app.request('/api/recordings/1/transcribe', {
        method: 'POST',
        headers: { ...json, 'X-AI-Provider': 'openrouter' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(400)
      expect((await res.json() as any).error).toMatch(/OpenRouter/)
    })

    it('returns the stored transcript and summary', async () => {
      storage.putTranscript(1, aiResult.transcript)
      storage.putSummary(1, aiResult.summary)

      const transcript: any = await (await app.request('/api/recordings/1/transcription', { headers: auth })).json()
      const summary: any = await (await app.request('/api/recordings/1/summary', { headers: auth })).json()

      expect(transcript.data).toHaveLength(1)
      expect(summary.data.overview).toBe('A sync.')
    })

    it('returns a null summary before analysis has run', async () => {
      const body: any = await (await app.request('/api/recordings/3/summary', { headers: auth })).json()
      expect(body.data).toBeNull()
    })

    it('saves client-supplied intelligence', async () => {
      await createSession()
      const res = await app.request('/api/recordings/1/save-intelligence', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ transcript: aiResult.transcript, summary: aiResult.summary }),
      })

      const body: any = await res.json()
      expect(body.data.transcript).toHaveLength(1)
      expect(storage.getSession(1)?.has_summary).toBe(true)
    })

    it('toggles an action item', async () => {
      storage.putSummary(1, aiResult.summary)
      const res = await app.request('/api/recordings/1/action-items/act-1', {
        method: 'PATCH',
        headers: json,
        body: JSON.stringify({ status: 'completed' }),
      })

      expect((await res.json() as any).data.status).toBe('completed')
      expect(storage.getSummary(1)?.action_items[0].status).toBe('completed')
    })

    it('404s an action item that is not in the summary', async () => {
      storage.putSummary(1, aiResult.summary)
      const res = await app.request('/api/recordings/1/action-items/act-9', {
        method: 'PATCH',
        headers: json,
        body: JSON.stringify({ status: 'completed' }),
      })
      expect(res.status).toBe(404)
    })
  })

  describe('chat', () => {
    beforeEach(() => {
      storage.putTranscript(1, aiResult.transcript)
      storage.putSummary(1, aiResult.summary)
    })

    it('answers using the meeting as context', async () => {
      let body: any
      globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'It went well.' }] } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch

      const res = await app.request('/api/recordings/1/chat', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ message: 'How did it go?' }),
      })

      expect(await res.json()).toMatchObject({ success: true, reply: 'It went well.' })
      expect(body.systemInstruction.parts[0].text).toContain('Shipped the thing.')
    })

    it('requires a message', async () => {
      const res = await app.request('/api/recordings/1/chat', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ message: '   ' }),
      })
      expect(res.status).toBe(400)
    })

    it('refuses to chat about a meeting with no transcript or summary', async () => {
      const res = await app.request('/api/recordings/8/chat', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ message: 'hi' }),
      })
      expect(res.status).toBe(400)
    })

    it('returns 502 when the model call fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      globalThis.fetch = vi.fn(async () => new Response('boom', { status: 403 })) as unknown as typeof fetch

      const res = await app.request('/api/recordings/1/chat', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ message: 'hi' }),
      })
      expect(res.status).toBe(502)
    })

    it('routes chat to OpenRouter when asked, with a key supplied by the client', async () => {
      let sentAuth: string | undefined
      globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        sentAuth = (init?.headers as Record<string, string>).Authorization
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Via OpenRouter.' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch

      const res = await app.request('/api/recordings/1/chat', {
        method: 'POST',
        headers: { ...json, 'X-AI-Provider': 'openrouter', 'X-OpenRouter-Key': 'or-key' },
        body: JSON.stringify({ message: 'hi', history: [{ role: 'user', content: 'earlier' }] }),
      })

      expect(await res.json()).toMatchObject({ success: true, reply: 'Via OpenRouter.' })
      expect(sentAuth).toBe('Bearer or-key')
    })

    it('rejects an OpenRouter chat with no key available', async () => {
      const res = await app.request('/api/recordings/1/chat', {
        method: 'POST',
        headers: { ...json, 'X-AI-Provider': 'openrouter' },
        body: JSON.stringify({ message: 'hi' }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('provider connectivity checks', () => {
    it('reports a successful Gemini round trip', async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"status":"connected"}' }] } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      ) as unknown as typeof fetch

      const res = await app.request('/api/ai/gemini-test', { method: 'POST', headers: json, body: '{}' })
      const body: any = await res.json()

      expect(body.success).toBe(true)
      expect(body.data.candidate).toContain('connected')
    })

    it('reports a failed Gemini round trip as a 500', async () => {
      globalThis.fetch = vi.fn(async () => new Response('denied', { status: 403 })) as unknown as typeof fetch

      const res = await app.request('/api/ai/gemini-test', { method: 'POST', headers: json, body: '{}' })
      expect(res.status).toBe(500)
    })

    it('verifies an OpenRouter key', async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ data: { label: 'my key' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      ) as unknown as typeof fetch

      const res = await app.request('/api/ai/verify-key', {
        method: 'POST',
        headers: { ...json, 'X-OpenRouter-Key': 'or-key' },
        body: '{}',
      })
      expect(await res.json()).toEqual({ success: true, data: { label: 'my key' } })
    })

    it('rejects an invalid OpenRouter key', async () => {
      globalThis.fetch = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch

      const res = await app.request('/api/ai/verify-key', {
        method: 'POST',
        headers: { ...json, 'X-OpenRouter-Key': 'bad' },
        body: '{}',
      })
      expect(res.status).toBe(401)
    })

    it('requires a key to verify', async () => {
      const res = await app.request('/api/ai/verify-key', { method: 'POST', headers: json, body: '{}' })
      expect(res.status).toBe(400)
    })
  })

  describe('usage', () => {
    const openrouterConfig: Config = { ...config, aiProvider: 'openrouter', openrouterApiKey: 'or-key' }

    const keyPayload = {
      data: {
        label: 'sk-or-v1-e29...245',
        limit: 3,
        limit_remaining: 2.74341375,
        usage: 0.25658625,
        usage_daily: 0.1,
        usage_weekly: 0.2,
        usage_monthly: 0.25658625,
        is_free_tier: false,
        expires_at: null,
      },
    }
    const creditsPayload = { data: { total_credits: 5, total_usage: 0.25711213 } }

    const ok = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })

    function stubOpenRouter(overrides: { key?: Response; credits?: Response } = {}): () => string[] {
      const urls: string[] = []
      globalThis.fetch = vi.fn(async (url: string | URL) => {
        const href = String(url)
        urls.push(href)
        if (href.endsWith('/credits')) return (overrides.credits ?? ok(creditsPayload)).clone()
        return (overrides.key ?? ok(keyPayload)).clone()
      }) as unknown as typeof fetch
      return () => urls
    }

    it('requires a token', async () => {
      const res = await app.request('/api/usage')
      expect(res.status).toBe(401)
    })

    it('reports spend and quota for the configured OpenRouter key', async () => {
      stubOpenRouter()
      const usageApp = createApp({ config: openrouterConfig, storage, audio, analysis })

      const res = await usageApp.request('/api/usage', { headers: auth })
      const body = (await res.json()) as any

      expect(res.status).toBe(200)
      expect(body.data.provider).toBe('openrouter')
      expect(body.data.model).toBe('google/gemini-3.8-flash')
      expect(body.data.key).toMatchObject({
        label: 'sk-or-v1-e29...245',
        spend: 0.25658625,
        limit: 3,
        remaining: 2.74341375,
        isFreeTier: false,
      })
      expect(body.data.credits).toEqual({ granted: 5, spend: 0.25711213, remaining: 5 - 0.25711213 })
      expect(body.data.unavailable).toBeNull()
    })

    it('never puts the API key itself in the response', async () => {
      stubOpenRouter()
      const usageApp = createApp({ config: openrouterConfig, storage, audio, analysis })

      const res = await usageApp.request('/api/usage', { headers: auth })

      expect(await res.text()).not.toContain('or-key')
    })

    it('counts the meetings and audio the backend has analyzed', async () => {
      stubOpenRouter()
      storage.putSession({
        id: 1,
        title: 'Analyzed',
        status: 'completed',
        duration: 600,
        created_at: '2026-09-20T00:00:00.000Z',
        parts_count: 1,
        audio_url: '/api/recordings/1/audio',
        has_transcription: true,
        has_summary: true,
      })
      storage.putSession({
        id: 2,
        title: 'Not analyzed yet',
        status: 'completed',
        duration: 300,
        created_at: '2026-09-20T01:00:00.000Z',
        parts_count: 1,
        audio_url: '/api/recordings/2/audio',
      })
      const usageApp = createApp({ config: openrouterConfig, storage, audio, analysis })

      const body = (await (await usageApp.request('/api/usage', { headers: auth })).json()) as any

      expect(body.data.meetings).toEqual({ total: 2, analyzed: 1, audioSeconds: 900 })
    })

    // The local half of the dashboard is still worth showing when OpenRouter
    // is unreachable — and the reason belongs on screen, not in a 502 the page
    // can only render as "failed to load".
    it('still answers with local counts when OpenRouter cannot be reached', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      stubOpenRouter({ key: new Response('down', { status: 503 }) })
      const usageApp = createApp({ config: openrouterConfig, storage, audio, analysis })

      const body = (await (await usageApp.request('/api/usage', { headers: auth })).json()) as any

      expect(body.success).toBe(true)
      expect(body.data.key).toBeNull()
      expect(body.data.unavailable).toMatch(/503/)
      expect(body.data.meetings.total).toBe(0)
    })

    // Google publishes no spend or quota API, so there is nothing to show but
    // the truth about why.
    it('says so when the configured provider reports no usage at all', async () => {
      const body = (await (await app.request('/api/usage', { headers: auth })).json()) as any

      expect(body.data.provider).toBe('gemini')
      expect(body.data.key).toBeNull()
      expect(body.data.unavailable).toMatch(/gemini/i)
    })

    it('keeps the key stats when only the credits call fails', async () => {
      stubOpenRouter({ credits: new Response('nope', { status: 403 }) })
      const usageApp = createApp({ config: openrouterConfig, storage, audio, analysis })

      const body = (await (await usageApp.request('/api/usage', { headers: auth })).json()) as any

      expect(body.data.key.spend).toBe(0.25658625)
      expect(body.data.credits).toBeNull()
    })
  })
})
