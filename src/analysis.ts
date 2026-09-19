import {
  analyzeTranscriptWithGemini,
  analyzeTranscriptWithOpenRouter,
  transcribeAudioSegmentWithGemini,
  transcribeAudioSegmentWithOpenRouter,
  uploadAudioToGeminiFiles,
  type AiAnalysisResult,
  type GeminiUploadedFile,
  type TranscriptAnalysis,
} from './ai-providers.js'
import { AUDIO_CONTENT_TYPE, AUDIO_FILE_EXTENSION, UNTITLED_MEETING_TITLE } from './constants.js'
import { findMp3FrameStart, planAudioSegments, type AudioSegment } from './segmentation.js'
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

/** Coarse progress for a long job, so a client polling status can show more than a spinner. */
export interface AnalysisProgress {
  stage: 'transcribing' | 'analyzing'
  completedSegments: number
  totalSegments: number
}

export interface AnalysisHooks {
  onProgress?: (progress: AnalysisProgress) => void
}

export type AnalysisGenerator = (request: AnalysisRequest, hooks?: AnalysisHooks) => Promise<AiAnalysisResult>

export interface AnalysisStatus {
  status: AnalysisJobStatus | 'not_found'
  provider?: string
  error?: string
  progress?: AnalysisProgress
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
      const result = await deps.generate(request, {
        // Progress is deliberately in-memory only: a restart kills the job
        // anyway, so a durable progress row could only ever be misleading.
        onProgress: (progress) => {
          const job = jobs.get(sessionId)
          if (job?.status === 'processing') jobs.set(sessionId, { ...job, progress })
        },
      })

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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/**
 * What a provider has to supply for the two pipeline steps. Only the transport
 * differs between providers — the prompts, the segmentation and the order of
 * the steps are the same everywhere, and live in `createPipelineGenerator`.
 */
interface PipelineSteps {
  transcribeSegment(params: {
    request: AnalysisRequest
    bytes: Uint8Array
    segment: AudioSegment
    segmentCount: number
    knownSpeakers: string[]
    precedingContext?: string
  }): Promise<TranscriptItem[]>
  analyzeTranscript(params: { request: AnalysisRequest; transcript: TranscriptItem[] }): Promise<TranscriptAnalysis>
}

/**
 * The pipeline, in two steps: transcribe the audio (separating and naming the
 * speakers), then analyze the resulting transcript. The model is never asked
 * to summarize straight off the audio — a summary is only ever derived from a
 * transcript that exists.
 */
function createPipelineGenerator(deps: {
  audio: AudioStorage
  steps: PipelineSteps
  maxSegmentSeconds?: number
  maxSegmentBytes?: number
}): AnalysisGenerator {
  return async (request, hooks = {}) => {
    const layout = await deps.audio.getLayout(request.sessionId)
    if (!layout) {
      throw new Error('No audio recording found for this session yet.')
    }

    const segments = planAudioSegments({
      totalBytes: layout.totalBytes,
      durationSeconds: request.durationSeconds,
      maxSegmentSeconds: deps.maxSegmentSeconds,
      maxSegmentBytes: deps.maxSegmentBytes,
    })
    if (segments.length === 0) {
      throw new Error('The recording for this session is empty.')
    }

    const transcript = await transcribeRecording({
      audio: deps.audio,
      steps: deps.steps,
      layout,
      segments,
      request,
      hooks,
    })

    hooks.onProgress?.({
      stage: 'analyzing',
      completedSegments: segments.length,
      totalSegments: segments.length,
    })

    const { summary, suggestedTitle } = await deps.steps.analyzeTranscript({ request, transcript })
    return { transcript, summary, suggestedTitle }
  }
}

/** The Gemini path: audio goes to Google directly, large slices via the Files API. */
export function createGeminiGenerator(deps: {
  audio: AudioStorage
  apiKey: string
  apiUrl?: string
  cfAigToken?: string
  inlineMaxBytes?: number
  maxSegmentSeconds?: number
  maxSegmentBytes?: number
}): AnalysisGenerator {
  const inlineMaxBytes = deps.inlineMaxBytes ?? GEMINI_INLINE_AUDIO_MAX_BYTES

  return createPipelineGenerator({
    audio: deps.audio,
    maxSegmentSeconds: deps.maxSegmentSeconds,
    maxSegmentBytes: deps.maxSegmentBytes,
    steps: {
      async transcribeSegment({ request, bytes, segment, segmentCount, knownSpeakers, precedingContext }) {
        // Inlining costs roughly 4x the slice size in peak memory (raw bytes +
        // base64 + JSON body), so anything large is streamed off disk into the
        // Files API instead and referenced by URI.
        let audioFile: GeminiUploadedFile | undefined
        let audioBuffer: ArrayBuffer | undefined
        if (bytes.byteLength > inlineMaxBytes) {
          const slice = toArrayBuffer(bytes)
          audioFile = await uploadAudioToGeminiFiles({
            apiKey: deps.apiKey,
            cfAigToken: deps.cfAigToken,
            byteLength: slice.byteLength,
            mimeType: AUDIO_CONTENT_TYPE,
            displayName: `meetutu-session-${request.sessionId}-part-${segment.index + 1}.${AUDIO_FILE_EXTENSION}`,
            readChunk: async (offset, length) => new Uint8Array(slice, offset, length),
          })
        } else {
          audioBuffer = toArrayBuffer(bytes)
        }

        return transcribeAudioSegmentWithGemini({
          apiUrl: deps.apiUrl,
          apiKey: deps.apiKey,
          model: request.model,
          cfAigToken: deps.cfAigToken,
          audioBuffer,
          audioFile,
          segment,
          segmentCount,
          knownSpeakers,
          precedingContext,
          customInstructions: request.customInstructions,
        })
      },

      analyzeTranscript: ({ request, transcript }) =>
        analyzeTranscriptWithGemini({
          apiUrl: deps.apiUrl,
          apiKey: deps.apiKey,
          model: request.model,
          cfAigToken: deps.cfAigToken,
          title: request.title,
          durationSeconds: request.durationSeconds,
          transcript,
          customInstructions: request.customInstructions,
        }),
    },
  })
}

/**
 * The OpenRouter path. Same two steps, but every slice travels inline as
 * base64: OpenRouter takes audio only in the request body, so there is no
 * upload threshold to cross and the segment byte cap is what keeps a request
 * sendable.
 *
 * The key is per request rather than per process — a client may supply its own.
 */
export function createOpenRouterGenerator(deps: {
  audio: AudioStorage
  maxSegmentSeconds?: number
  maxSegmentBytes?: number
}): AnalysisGenerator {
  function keyFor(request: AnalysisRequest): string {
    if (!request.openrouterKey) {
      throw new Error('No OpenRouter API key configured.')
    }
    return request.openrouterKey
  }

  return createPipelineGenerator({
    audio: deps.audio,
    maxSegmentSeconds: deps.maxSegmentSeconds,
    maxSegmentBytes: deps.maxSegmentBytes,
    steps: {
      transcribeSegment: ({ request, bytes, segment, segmentCount, knownSpeakers, precedingContext }) =>
        transcribeAudioSegmentWithOpenRouter({
          apiKey: keyFor(request),
          model: request.model,
          audioBuffer: toArrayBuffer(bytes),
          segment,
          segmentCount,
          knownSpeakers,
          precedingContext,
          customInstructions: request.customInstructions,
        }),

      analyzeTranscript: ({ request, transcript }) =>
        analyzeTranscriptWithOpenRouter({
          apiKey: keyFor(request),
          model: request.model,
          title: request.title,
          durationSeconds: request.durationSeconds,
          transcript,
          customInstructions: request.customInstructions,
        }),
    },
  })
}

/** How many trailing lines of the previous segment to show the model for continuity. */
const CONTINUITY_LINES = 3

function renderContinuity(transcript: TranscriptItem[]): string | undefined {
  if (transcript.length === 0) return undefined
  return transcript
    .slice(-CONTINUITY_LINES)
    .map((item) => `[${item.timestamp}] ${item.speaker}: ${item.text}`)
    .join('\n')
}

/**
 * Step 1: audio in, speaker-attributed transcript out.
 *
 * Segments run sequentially on purpose. Beyond memory and rate limits, each
 * one is told which speakers the earlier segments already identified and how
 * the conversation was going at the cut, so one person keeps one label across
 * the whole meeting instead of becoming "Speaker 1" again in every part.
 */
async function transcribeRecording(params: {
  audio: AudioStorage
  steps: PipelineSteps
  layout: Awaited<ReturnType<AudioStorage['getLayout']>>
  segments: AudioSegment[]
  request: AnalysisRequest
  hooks: AnalysisHooks
}): Promise<TranscriptItem[]> {
  const { audio, steps, layout, segments, request, hooks } = params
  if (!layout) throw new Error('No audio recording found for this session yet.')

  const transcript: TranscriptItem[] = []
  const speakers: string[] = []

  for (const segment of segments) {
    const raw = await audio.readRange(layout, segment.byteOffset, segment.byteLength)
    // A byte-boundary cut lands mid-frame; drop the partial frame at the front
    // so the decoder on the provider's side starts cleanly. The first segment
    // starts at the real beginning of the file and is left alone.
    const bytes = segment.index === 0 ? raw : raw.subarray(findMp3FrameStart(raw))

    // Say which part failed: with eight of them, "API error (403)" on its own
    // leaves no way to tell a transient blip from a bad slice.
    const items = await steps.transcribeSegment({
      request,
      bytes,
      segment,
      segmentCount: segments.length,
      knownSpeakers: speakers,
      precedingContext: renderContinuity(transcript),
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        message.includes(`part ${segment.index + 1} of `)
          ? message
          : `Failed on part ${segment.index + 1} of ${segments.length} of the recording: ${message}`,
      )
    })
    transcript.push(...items)
    for (const item of items) {
      if (item.speaker && !speakers.includes(item.speaker)) speakers.push(item.speaker)
    }

    hooks.onProgress?.({
      stage: 'transcribing',
      completedSegments: segment.index + 1,
      totalSegments: segments.length,
    })
  }

  return transcript
}

/** Dispatches to the provider the request asked for. */
export function createGenerator(deps: { audio: AudioStorage; config: Config }): AnalysisGenerator {
  const openrouter = createOpenRouterGenerator({ audio: deps.audio })
  const gemini = createGeminiGenerator({
    audio: deps.audio,
    // Checked per request instead of at construction: a Gemini key is optional
    // on an OpenRouter-only deploy.
    apiKey: deps.config.geminiApiKey ?? '',
    apiUrl: deps.config.geminiApiUrl,
    cfAigToken: deps.config.cfAigToken,
  })

  return async (request, hooks) => {
    if (request.kind === 'openrouter') {
      return openrouter(request, hooks)
    }
    if (!deps.config.geminiApiKey) {
      throw new Error('No Gemini API key configured.')
    }
    return gemini(request, hooks)
  }
}
