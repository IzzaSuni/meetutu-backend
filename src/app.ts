import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { createHash } from 'node:crypto'
import {
  DEFAULT_OPENROUTER_MODEL,
  callGeminiChat,
  callOpenRouterChat,
  fetchGeminiWithRetry,
} from './ai-providers.js'
import type { AnalysisRequest, AnalysisRunner } from './analysis.js'
import type { AudioStorage } from './audio-storage.js'
import { computeAuthToken, tokensMatch } from './auth.js'
import { buildTranscriptContext } from './chat-context.js'
import type { Config } from './config.js'
import { AUDIO_CONTENT_TYPE, UNTITLED_MEETING_TITLE } from './constants.js'
import type { Storage } from './storage.js'
import type { ChatTurn, MeetingSession, MeetingSummary, SummaryItem } from './types.js'

export interface AppDeps {
  config: Config
  storage: Storage
  audio: AudioStorage
  analysis: AnalysisRunner
}

const PUBLIC_API_PATHS = new Set(['/api/health', '/api/auth/login'])

const MAX_CUSTOM_INSTRUCTION_CHARS = 500
const MAX_CHAT_MESSAGE_CHARS = 2000
const MAX_CHAT_HISTORY_TURNS = 20

interface RequestBody {
  [key: string]: unknown
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<RequestBody> {
  const body = await c.req.json().catch(() => ({}))
  return (body && typeof body === 'object' ? body : {}) as RequestBody
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function buildSummaryText(summary: MeetingSummary | undefined): string {
  if (!summary) return ''
  const textOf = (item: SummaryItem | string) => (typeof item === 'string' ? item : item.text)
  return [
    summary.overview ? `Overview: ${summary.overview}` : '',
    summary.key_points?.length ? `Key Points:\n${summary.key_points.map((p) => `- ${textOf(p)}`).join('\n')}` : '',
    summary.decisions?.length ? `Decisions:\n${summary.decisions.map((d) => `- ${textOf(d)}`).join('\n')}` : '',
    summary.action_items?.length
      ? `Action Items:\n${summary.action_items.map((a) => `- ${a.task} (${a.assignee}, ${a.status})`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function createApp(deps: AppDeps): Hono {
  const { config, storage, audio, analysis } = deps
  const expectedToken = computeAuthToken(config.authUsername, config.authPassword)
  const app = new Hono()

  app.use(
    '*',
    cors({
      origin: config.corsOrigins.length === 1 ? config.corsOrigins[0] : config.corsOrigins,
      allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'ETag', 'X-AI-Provider', 'X-OpenRouter-Key', 'X-OpenRouter-Model'],
      exposeHeaders: ['ETag', 'Content-Type'],
    })
  )

  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'OPTIONS' || PUBLIC_API_PATHS.has(c.req.path)) {
      return next()
    }

    const providedToken = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!tokensMatch(providedToken, expectedToken)) {
      return c.json({ success: false, error: 'Unauthorized' }, 401)
    }

    return next()
  })

  app.post('/api/auth/login', async (c) => {
    const body = await readJson(c)
    if (body.username !== config.authUsername || body.password !== config.authPassword) {
      return c.json({ success: false, error: 'Invalid username or password.' }, 401)
    }
    return c.json({ success: true, token: expectedToken })
  })

  app.get('/api/health', (c) =>
    c.json({
      status: 'ok',
      app: 'meetutu',
      storage: 'filesystem',
      timestamp: new Date().toISOString(),
    })
  )

  // ---------------------------------------------------------------- sessions

  app.get('/api/sessions', (c) => c.json({ success: true, data: storage.listSessions() }))

  app.get('/api/sessions/:id', (c) => {
    const session = storage.getSession(Number(c.req.param('id')))
    if (!session) {
      return c.json({ success: false, error: 'Session not found' }, 404)
    }
    return c.json({ success: true, data: session })
  })

  app.patch('/api/sessions/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const body = await readJson(c)
    const existing = storage.getSession(id) ?? {
      id,
      title: str(body.title) || 'Meeting Session',
      status: 'recording' as const,
      duration: 0,
      created_at: new Date().toISOString(),
      parts_count: 0,
      audio_url: `/api/recordings/${id}/audio`,
    }

    const updated: MeetingSession = {
      ...existing,
      ...(body.status ? { status: body.status as MeetingSession['status'] } : {}),
      ...(body.title ? { title: String(body.title) } : {}),
      ...(body.duration !== undefined ? { duration: Number(body.duration) } : {}),
    }
    storage.putSession(updated)
    return c.json({ success: true, data: updated })
  })

  // Removes the session row, its transcript/summary, its analysis job, and the
  // recorded audio — a delete that left any of these behind used to make the
  // session reappear on the next refresh.
  app.delete('/api/sessions/:id', async (c) => {
    const id = Number(c.req.param('id'))
    storage.deleteSession(id)
    await audio.deleteSession(id)
    analysis.forget(id)
    return c.json({ success: true, id })
  })

  app.post('/api/session', async (c) => {
    const body = await readJson(c)
    const sessionId = Number(body.id ?? Date.now())
    const session: MeetingSession = {
      id: sessionId,
      title: str(body.title) || UNTITLED_MEETING_TITLE,
      status: 'recording',
      duration: 0,
      created_at: new Date().toISOString(),
      parts_count: 0,
      audio_url: `/api/recordings/${sessionId}/audio`,
    }
    storage.putSession(session)
    return c.json({ id: sessionId, title: session.title, created_at: session.created_at })
  })

  app.post('/api/process', async (c) => {
    const body = await readJson(c)
    const payload = (body.payload ?? {}) as RequestBody
    const sessionId = Number(body.id ?? body.sessionId ?? Date.now())
    const duration = Number(payload.duration ?? body.duration ?? 0)

    const existing = storage.getSession(sessionId)
    const session: MeetingSession = existing ?? {
      id: sessionId,
      title: 'Meeting Recording',
      status: 'completed',
      duration,
      created_at: new Date().toISOString(),
      parts_count: 1,
      audio_url: `/api/recordings/${sessionId}/audio`,
    }

    storage.putSession({
      ...session,
      status: 'completed',
      duration: duration > 0 ? duration : session.duration,
    })

    return c.json({ success: true, status: 'completed', sessionId })
  })

  // ------------------------------------------------------------------- audio

  // Matches @rakamin-eng/audio-engine PresignPartOutput. There is no signed
  // URL to hand out here: the client uploads straight back to this server.
  app.post('/api/presign-part', async (c) => {
    const body = await readJson(c)
    const sessionId = Number(body.id ?? body.sessionId ?? Date.now())
    const partNumber = Number(body.partNumber ?? 1)
    return c.json({ data: { url: `/api/recordings/${sessionId}/parts/${partNumber}` } })
  })

  async function storePart(c: Context, sessionId: number, partNumber: number): Promise<Response> {
    const arrayBuffer = await c.req.arrayBuffer()
    const data = new Uint8Array(arrayBuffer)

    try {
      await audio.putPart(sessionId, partNumber, data)
    } catch (error: unknown) {
      return c.json({ success: false, error: error instanceof Error ? error.message : 'Invalid part' }, 400)
    }

    // The audio engine reconciles uploaded parts by ETag, so give it a stable
    // content-derived one instead of an opaque counter.
    const etag = createHash('sha256').update(data).digest('hex').slice(0, 32)
    c.header('ETag', `"${etag}"`)
    c.header('Access-Control-Expose-Headers', 'ETag')

    return c.json({ success: true, sessionId, partNumber, etag, size: data.byteLength })
  }

  app.put('/api/presign-part', (c) =>
    storePart(
      c,
      Number(c.req.query('id') ?? c.req.query('sessionId') ?? Date.now()),
      Number(c.req.query('part') ?? c.req.query('partNumber') ?? 1)
    )
  )

  app.put('/api/recordings/:sessionId/parts/:partNumber', (c) =>
    storePart(c, Number(c.req.param('sessionId')), Number(c.req.param('partNumber')))
  )

  app.get('/api/recordings/:sessionId/parts/:partNumber', async (c) => {
    const part = await audio.getPart(Number(c.req.param('sessionId')), Number(c.req.param('partNumber')))
    if (!part) {
      return c.text('Part not found', 404)
    }
    return new Response(part, { status: 200, headers: { 'Content-Type': AUDIO_CONTENT_TYPE } })
  })

  app.post('/api/add-part', async (c) => {
    const body = await readJson(c)
    const payload = (body.payload ?? {}) as RequestBody
    const sessionId = Number(body.id ?? body.sessionId ?? 0)
    const partNumber = Number(payload.part_number ?? body.partNumber ?? 1)

    const session = sessionId ? storage.getSession(sessionId) : undefined
    if (session) {
      storage.putSession({ ...session, parts_count: Math.max(session.parts_count, partNumber) })
    }

    return c.json({ success: true, partNumber, status: 'recorded' })
  })

  app.get('/api/recordings/:sessionId/audio', async (c) => {
    const recording = await audio.readAll(Number(c.req.param('sessionId')))
    if (!recording) {
      return c.text('Recording audio not found', 404)
    }
    return new Response(recording, {
      status: 200,
      headers: {
        'Content-Type': AUDIO_CONTENT_TYPE,
        'Content-Length': String(recording.byteLength),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
      },
    })
  })

  app.on('HEAD', '/api/recordings/:sessionId/audio', async (c) => {
    const layout = await audio.getLayout(Number(c.req.param('sessionId')))
    if (!layout) {
      return c.body(null, 404)
    }
    return c.body(null, 200, {
      'Content-Type': AUDIO_CONTENT_TYPE,
      'Content-Length': String(layout.totalBytes),
      'Accept-Ranges': 'bytes',
    })
  })

  // ------------------------------------------------------------ intelligence

  app.get('/api/recordings/:sessionId/transcription', (c) => {
    const sessionId = Number(c.req.param('sessionId'))
    return c.json({ success: true, sessionId, data: storage.getTranscript(sessionId) })
  })

  app.get('/api/recordings/:sessionId/summary', (c) => {
    const sessionId = Number(c.req.param('sessionId'))
    return c.json({ success: true, sessionId, data: storage.getSummary(sessionId) ?? null })
  })

  // Kicks off transcription + summary as a background job and returns 202
  // immediately — poll /analysis-status for the result. Unlike the Workers
  // version, the job is not bounded by the response lifetime.
  app.post('/api/recordings/:sessionId/transcribe', async (c) => {
    const sessionId = Number(c.req.param('sessionId'))
    const session = storage.getSession(sessionId)
    const body = await readJson(c)

    const providerPreference = c.req.header('X-AI-Provider') || str(body.provider) || 'gemini-gateway'
    // Bound the user-supplied instructions so a runaway prompt can't blow up
    // token usage on a single regenerate request.
    const customInstructions =
      typeof body.customInstructions === 'string'
        ? body.customInstructions.trim().slice(0, MAX_CUSTOM_INSTRUCTION_CHARS)
        : undefined

    let request: AnalysisRequest

    if (providerPreference === 'openrouter') {
      const openrouterKey = c.req.header('X-OpenRouter-Key') || str(body.apiKey) || config.openrouterApiKey
      const model =
        c.req.header('X-OpenRouter-Model') || str(body.model) || config.openrouterModel || DEFAULT_OPENROUTER_MODEL

      if (!openrouterKey) {
        return c.json({ success: false, error: 'No OpenRouter API key configured.', sessionId }, 400)
      }

      request = {
        sessionId,
        title: session?.title || UNTITLED_MEETING_TITLE,
        durationSeconds: session?.duration || 30,
        provider: `openrouter (${model})`,
        kind: 'openrouter',
        model,
        customInstructions,
        openrouterKey,
      }
    } else {
      // Never let request headers or body override the Gemini URL or key: that
      // key is a real, billable secret, and honoring a client-supplied URL
      // would let a caller redirect it to an endpoint of their choosing.
      const model = str(body.model) || config.geminiModel

      const layout = await audio.getLayout(sessionId).catch(() => null)
      if (!layout) {
        return c.json({ success: false, error: 'No audio recording found for this session yet.', sessionId }, 404)
      }

      request = {
        sessionId,
        title: session?.title || UNTITLED_MEETING_TITLE,
        durationSeconds: session?.duration || 30,
        provider: `gemini (${model})`,
        kind: 'gemini',
        model,
        customInstructions,
      }
    }

    await analysis.start(request)
    return c.json({ success: true, sessionId, status: 'processing' }, 202)
  })

  app.get('/api/recordings/:sessionId/analysis-status', (c) => {
    const sessionId = Number(c.req.param('sessionId'))
    return c.json({ success: true, sessionId, ...analysis.status(sessionId) })
  })

  app.patch('/api/recordings/:sessionId/action-items/:actionId', async (c) => {
    const sessionId = Number(c.req.param('sessionId'))
    const actionId = c.req.param('actionId')
    const body = await readJson(c)

    const summary = storage.getSummary(sessionId)
    if (!summary) {
      return c.json({ success: false, error: 'Summary not found' }, 404)
    }

    const item = summary.action_items.find((action) => action.id === actionId)
    if (!item) {
      return c.json({ success: false, error: 'Action item not found' }, 404)
    }

    const updated = { ...item, ...(body.status ? { status: body.status as typeof item.status } : {}) }
    storage.putSummary(sessionId, {
      ...summary,
      action_items: summary.action_items.map((action) => (action.id === actionId ? updated : action)),
    })

    return c.json({ success: true, data: updated })
  })

  app.post('/api/recordings/:sessionId/save-intelligence', async (c) => {
    const sessionId = Number(c.req.param('sessionId'))
    const body = await readJson(c)

    if (Array.isArray(body.transcript)) {
      storage.putTranscript(sessionId, body.transcript)
    }
    if (body.summary && typeof body.summary === 'object') {
      storage.putSummary(sessionId, body.summary as MeetingSummary)
    }

    const session = storage.getSession(sessionId)
    if (session) {
      storage.putSession({ ...session, has_transcription: true, has_summary: true })
    }

    return c.json({
      success: true,
      sessionId,
      data: {
        transcript: storage.getTranscript(sessionId),
        summary: storage.getSummary(sessionId),
      },
    })
  })

  // Chat with a session's transcript + summary as context. Stateless per
  // request — the client sends the running conversation as `history`.
  app.post('/api/recordings/:sessionId/chat', async (c) => {
    const sessionId = Number(c.req.param('sessionId'))
    const session = storage.getSession(sessionId)
    const body = await readJson(c)

    const message =
      typeof body.message === 'string' ? body.message.trim().slice(0, MAX_CHAT_MESSAGE_CHARS) : ''
    if (!message) {
      return c.json({ success: false, error: 'A message is required.' }, 400)
    }

    const transcript = storage.getTranscript(sessionId)
    const summary = storage.getSummary(sessionId)
    if (transcript.length === 0 && !summary) {
      return c.json(
        { success: false, error: 'This meeting has no transcript or summary yet — generate one first.' },
        400
      )
    }

    const history: ChatTurn[] = Array.isArray(body.history)
      ? (body.history as ChatTurn[])
          .filter((turn) => turn && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string')
          .slice(-MAX_CHAT_HISTORY_TURNS)
          .map((turn) => ({ role: turn.role, content: String(turn.content).slice(0, MAX_CHAT_MESSAGE_CHARS) }))
      : []

    const transcriptText = buildTranscriptContext(transcript)
    const summaryText = buildSummaryText(summary)
    const title = session?.title || UNTITLED_MEETING_TITLE
    const providerPreference = c.req.header('X-AI-Provider') || str(body.provider) || 'gemini-gateway'

    try {
      if (providerPreference === 'openrouter') {
        const openrouterKey = c.req.header('X-OpenRouter-Key') || str(body.apiKey) || config.openrouterApiKey
        const model =
          c.req.header('X-OpenRouter-Model') || str(body.model) || config.openrouterModel || DEFAULT_OPENROUTER_MODEL
        if (!openrouterKey) {
          return c.json({ success: false, error: 'No OpenRouter API key configured.', sessionId }, 400)
        }

        const reply = await callOpenRouterChat({
          apiKey: openrouterKey,
          model,
          title,
          transcriptText,
          summaryText,
          history,
          message,
        })
        return c.json({ success: true, sessionId, provider: `openrouter (${model})`, reply })
      }

      const model = str(body.model) || config.geminiModel
      const reply = await callGeminiChat({
        apiUrl: config.geminiApiUrl,
        apiKey: config.geminiApiKey,
        model,
        title,
        transcriptText,
        summaryText,
        history,
        message,
        cfAigToken: config.cfAigToken,
      })
      return c.json({ success: true, sessionId, provider: `gemini (${model})`, reply })
    } catch (error: unknown) {
      console.error('[meetutu chat error]:', error)
      const errorMessage = error instanceof Error ? error.message : 'AI chat error'
      return c.json({ success: false, error: errorMessage, sessionId }, 502)
    }
  })

  // Verifies Gemini connectivity from the server's own network path.
  app.post('/api/ai/gemini-test', async (c) => {
    const body = await readJson(c)
    const model = str(body.model) || config.geminiModel

    try {
      const res = await fetchGeminiWithRetry(
        `${config.geminiApiUrl.replace(/\/$/, '')}/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': config.geminiApiKey,
            ...(config.cfAigToken ? { 'cf-aig-authorization': `Bearer ${config.cfAigToken}` } : {}),
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `Respond with JSON: {"status":"connected","model":"${model}"}` }] }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        }
      )
      const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
      return c.json({
        success: true,
        data: { model, candidate: data.candidates?.[0]?.content?.parts?.[0]?.text },
      })
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to reach Gemini API'
      return c.json({ success: false, error: errorMessage }, 500)
    }
  })

  // Verifies an OpenRouter key before the client commits to using it.
  app.post('/api/ai/verify-key', async (c) => {
    const body = await readJson(c)
    const apiKey = c.req.header('X-OpenRouter-Key') || str(body.apiKey) || config.openrouterApiKey
    if (!apiKey) {
      return c.json({ success: false, error: 'No API key provided' }, 400)
    }

    try {
      const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!res.ok) {
        return c.json({ success: false, error: `Invalid key: ${await res.text()}` }, 401)
      }
      const data = (await res.json()) as { data?: unknown }
      return c.json({ success: true, data: data.data ?? { label: 'Valid Key' } })
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Network error verifying key'
      return c.json({ success: false, error: errorMessage }, 500)
    }
  })

  return app
}
