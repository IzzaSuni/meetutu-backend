import {
  callGeminiGatewayAI,
  callOpenRouterAI,
  uploadAudioToGeminiFiles,
  type AiAnalysisResult,
} from './ai-providers.js'
import { AUDIO_CONTENT_TYPE, AUDIO_FILE_EXTENSION, UNTITLED_MEETING_TITLE } from './constants.js'
import type { AudioStorage } from './audio-storage.js'
import type { Config } from './config.js'
import type { Storage } from './storage.js'
import type { AnalysisJobStatus, MeetingSummary, TranscriptItem } from './types.js'

/**
 * Audio small enough to inline as base64 in the generateContent request.
 * Above this the server streams it to the Gemini Files API instead: inlining
 * costs roughly 4x the file size in peak memory (raw bytes + base64 + JSON
 * body), which is what made long meetings fall over on Workers.
 */
export const GEMINI_INLINE_AUDIO_MAX_BYTES = 6 * 1024 * 1024

export interface AnalysisRequest {
  sessionId: number
  title: string
  durationSeconds: number
  /** Human-readable label stored with the job, e.g. "gemini (gemini-3.6-flash)". */
  provider: string
  kind: 'gemini' | 'openrouter'
  model: string
  customInstructions?: string
  openrouterKey?: string
}

export type AnalysisGenerator = (request: AnalysisRequest) => Promise<AiAnalysisResult>

export interface AnalysisStatus {
  status: AnalysisJobStatus | 'not_found'
  provider?: string
  error?: string
  data?: { transcript: TranscriptItem[]; summary?: MeetingSummary; suggested_title?: string }
}

export interface AnalysisRunner {
  /** Records the job as processing, then runs it to completion in the background. */
  start(request: AnalysisRequest): Promise<void>
  status(sessionId: number): AnalysisStatus
  /** Drops a session's in-memory job — used when the session itself is deleted. */
  forget(sessionId: number): void
  /** Resolves once every in-flight job has settled. Used by tests and shutdown. */
  whenIdle(): Promise<void>
}

/**
 * Runs meeting analysis as an in-process background job.
 *
 * This is the reason the backend exists: on Cloudflare Workers the job could
 * only live inside `ctx.waitUntil()`, which is cut off 30 seconds after the
 * response is sent, so a long recording could never finish transcribing. Here
 * the job simply runs until it is done.
 */
export function createAnalysisRunner(deps: { storage: Storage; generate: AnalysisGenerator }): AnalysisRunner {
  const jobs = new Map<number, AnalysisStatus>()
  const inFlight = new Set<Promise<void>>()

  async function run(request: AnalysisRequest): Promise<void> {
    const { sessionId, provider } = request
    try {
      const result = await deps.generate(request)

      deps.storage.putTranscript(sessionId, result.transcript)
      deps.storage.putSummary(sessionId, result.summary)

      const session = deps.storage.getSession(sessionId)
      if (session) {
        deps.storage.putSession({
          ...session,
          has_transcription: true,
          has_summary: true,
          title:
            result.suggestedTitle && (!session.title || session.title === UNTITLED_MEETING_TITLE)
              ? result.suggestedTitle
              : session.title,
        })
      }

      jobs.set(sessionId, {
        status: 'done',
        provider,
        data: {
          transcript: result.transcript,
          summary: result.summary,
          suggested_title: result.suggestedTitle,
        },
      })
      deps.storage.putAnalysisJob(sessionId, { status: 'done', provider })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'AI analysis failed'
      console.error(`[meetutu analysis error] session ${sessionId}:`, error)
      jobs.set(sessionId, { status: 'error', provider, error: message })
      deps.storage.putAnalysisJob(sessionId, { status: 'error', provider, error: message })
    }
  }

  return {
    async start(request) {
      jobs.set(request.sessionId, { status: 'processing', provider: request.provider })
      deps.storage.putAnalysisJob(request.sessionId, { status: 'processing', provider: request.provider })

      const job = run(request).finally(() => {
        inFlight.delete(job)
      })
      inFlight.add(job)
    },

    status(sessionId) {
      const job = jobs.get(sessionId)
      if (job) return job

      // No in-memory job: either the process restarted or this session was
      // analyzed long ago. Stored results are the authoritative answer, and a
      // durable job row is the only thing that can tell a still-running job
      // apart from one that already failed.
      const transcript = deps.storage.getTranscript(sessionId)
      const summary = deps.storage.getSummary(sessionId)
      if (transcript.length > 0 || summary) {
        return { status: 'done', data: { transcript, summary } }
      }

      const durable = deps.storage.getAnalysisJob(sessionId)
      if (durable) {
        return { status: durable.status, provider: durable.provider, error: durable.error }
      }

      return { status: 'not_found' }
    },

    forget(sessionId) {
      jobs.delete(sessionId)
    },

    async whenIdle() {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight])
      }
    },
  }
}

/** Builds the Gemini analysis path: stream audio off disk, then ask for the transcript. */
export function createGeminiGenerator(deps: {
  audio: AudioStorage
  apiKey: string
  apiUrl?: string
  cfAigToken?: string
  inlineMaxBytes?: number
}): AnalysisGenerator {
  const inlineMaxBytes = deps.inlineMaxBytes ?? GEMINI_INLINE_AUDIO_MAX_BYTES

  return async (request) => {
    const layout = await deps.audio.getLayout(request.sessionId)
    if (!layout) {
      throw new Error('No audio recording found for this session yet.')
    }

    // Long recordings go through the Files API so their bytes are streamed to
    // Google a chunk at a time and referenced by URI — the server never holds
    // the whole meeting, let alone its base64 expansion.
    const audioFile =
      layout.totalBytes > inlineMaxBytes
        ? await uploadAudioToGeminiFiles({
            apiKey: deps.apiKey,
            cfAigToken: deps.cfAigToken,
            byteLength: layout.totalBytes,
            mimeType: AUDIO_CONTENT_TYPE,
            displayName: `meetutu-session-${request.sessionId}.${AUDIO_FILE_EXTENSION}`,
            readChunk: (offset, length) => deps.audio.readRange(layout, offset, length),
          })
        : undefined

    let audioBuffer: ArrayBuffer | undefined
    if (!audioFile) {
      const bytes = await deps.audio.readRange(layout, 0, layout.totalBytes)
      audioBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    }

    return callGeminiGatewayAI({
      apiUrl: deps.apiUrl,
      apiKey: deps.apiKey,
      model: request.model,
      title: request.title,
      durationSeconds: request.durationSeconds,
      audioBuffer,
      audioFile,
      customInstructions: request.customInstructions,
      cfAigToken: deps.cfAigToken,
    })
  }
}

/** Dispatches to the provider the request asked for. */
export function createGenerator(deps: { audio: AudioStorage; config: Config }): AnalysisGenerator {
  const gemini = createGeminiGenerator({
    audio: deps.audio,
    apiKey: deps.config.geminiApiKey,
    apiUrl: deps.config.geminiApiUrl,
    cfAigToken: deps.config.cfAigToken,
  })

  return async (request) => {
    if (request.kind === 'openrouter') {
      if (!request.openrouterKey) {
        throw new Error('No OpenRouter API key configured.')
      }
      return callOpenRouterAI({
        apiKey: request.openrouterKey,
        model: request.model,
        title: request.title,
        durationSeconds: request.durationSeconds,
        customInstructions: request.customInstructions,
      })
    }
    return gemini(request)
  }
}
