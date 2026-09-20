import { AUDIO_FILE_EXTENSION, UNTITLED_MEETING_TITLE } from './constants.js'
import type { AudioSegment } from './segmentation.js'
import type { ChatTurn, MeetingSummary, TranscriptItem } from './types.js'

// Official Google Generative Language API — no shared/community proxy.
// The API key comes from the environment, never from the browser.
export const DEFAULT_GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta'
export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash'
/**
 * Whatever model this points at must accept audio input: the first step of the
 * pipeline sends it the recording. Gemini 3.8 Flash takes text/image/audio/
 * video, with the same 1M-token context and 65,536-token output ceiling as the
 * native Gemini path assumes.
 */
export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-3.8-flash'

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_APP_TITLE = 'meetutu meeting recorder'
const OPENROUTER_APP_URL = 'https://meetutu.app'

export interface AiAnalysisResult {
  transcript: TranscriptItem[]
  summary: MeetingSummary
  suggestedTitle?: string
}

interface GeminiCandidatePart {
  text?: string
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiCandidatePart[] }; finishReason?: string }>
}

/** The output ceiling of gemini-3.x-flash. Asked for explicitly rather than left to the default. */
export const GEMINI_MAX_OUTPUT_TOKENS = 65_536

/**
 * The request was accepted and billed, but what came back cannot be used: no
 * content at all, or content that is not the JSON it was asked for. A provider
 * that fails mid-generation reports it this way — HTTP 200, `finish_reason:
 * "error"`, and either an empty message or half a JSON object — so the status
 * code gives the caller nothing to go on.
 *
 * Distinct from every other failure here because it is the one worth trying
 * again: the same audio and the same prompt usually succeed on the next
 * attempt, where a rejected key or an oversized response never will.
 */
export class UnusableModelResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnusableModelResponseError'
  }
}

/**
 * Pulls the text out of a candidate, turning a truncated or blocked response
 * into a clear error. Without this a response cut off at the output limit
 * arrives as half a JSON object and fails as an unexplained parse error after
 * the caller has already spent minutes on the request.
 */
function readGeminiText(json: GeminiResponse, what: string): string {
  const candidate = json.candidates?.[0]
  const text = candidate?.content?.parts?.find((part) => part.text)?.text

  if (candidate?.finishReason === 'MAX_TOKENS') {
    throw new Error(
      `Gemini hit its output limit while ${what}, so the response was cut off. The recording is too long to return in one piece.`,
    )
  }
  if (!text) {
    throw new UnusableModelResponseError(
      candidate?.finishReason
        ? `Empty response from Gemini API while ${what} (finishReason: ${candidate.finishReason})`
        : 'Empty response from Gemini API',
    )
  }
  return text
}

/** "MM:SS", counting past 59 minutes rather than wrapping, so timestamps stay sortable. */
function formatTimestamp(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds))
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
  /** OpenRouter reports some provider-side failures in a 200 body rather than the status. */
  error?: { code?: number; message?: string }
}

/**
 * Pulls the text out of a completion, turning a truncated, blocked or
 * body-reported failure into a clear error rather than an unexplained
 * `JSON.parse` failure minutes into a long job. Mirrors `readGeminiText`.
 */
function readOpenRouterText(json: OpenRouterResponse, what: string): string {
  if (json.error?.message) {
    throw new Error(`OpenRouter error while ${what}: ${json.error.message}`)
  }

  const choice = json.choices?.[0]
  if (choice?.finish_reason === 'length') {
    throw new Error(
      `OpenRouter hit its output limit while ${what}, so the response was cut off. The recording is too long to return in one piece.`,
    )
  }

  const content = choice?.message?.content
  if (!content) {
    throw new UnusableModelResponseError(
      choice?.finish_reason
        ? `Empty response from OpenRouter while ${what} (finish_reason: ${choice.finish_reason})`
        : 'Empty response from OpenRouter AI',
    )
  }
  return content
}

type OpenRouterContentPart =
  | { type: 'text'; text: string }
  | { type: 'input_audio'; input_audio: { data: string; format: string } }

/**
 * One JSON-returning completion. `max_tokens` is deliberately left unset: the
 * ceiling differs per model, and asking for more than a model allows is an
 * outright 400 — omitting it gives the provider default, which is the model's
 * own maximum. Truncation is caught by `finish_reason` instead.
 */
async function requestOpenRouterJson(params: {
  apiKey: string
  model: string
  content: OpenRouterContentPart[] | string
  what: string
}): Promise<string> {
  const res = await fetchWithRetry(
    OPENROUTER_CHAT_URL,
    {
      method: 'POST',
      headers: buildOpenRouterHeaders(params.apiKey),
      body: JSON.stringify({
        model: params.model,
        messages: [{ role: 'user', content: params.content }],
        response_format: { type: 'json_object' },
      }),
    },
    'OpenRouter API',
  )

  return readOpenRouterText((await res.json()) as OpenRouterResponse, params.what)
}

function buildOpenRouterHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': OPENROUTER_APP_URL,
    'X-Title': OPENROUTER_APP_TITLE,
    'Content-Type': 'application/json',
  }
}

// When GEMINI_API_URL is repointed at a Cloudflare AI Gateway
// (gateway.ai.cloudflare.com), the gateway itself requires this header on
// every request in addition to Google's own x-goog-api-key — unrelated to
// and layered on top of the Gemini key, not a replacement for it.
function buildGeminiHeaders(apiKey: string, cfAigToken?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
    ...(cfAigToken ? { 'cf-aig-authorization': `Bearer ${cfAigToken}` } : {}),
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503])
const MAX_RETRIES = 2
const RETRY_BASE_DELAY_MS = 400

// Google's Generative Language API occasionally answers a perfectly valid
// request with "User location is not supported" (FAILED_PRECONDITION, HTTP
// 400) depending on the egress path, then succeeds on an immediate retry. A
// short retry rides that out instead of surfacing a one-off transient failure
// as if the account were permanently blocked.
function isGeminiLocationBlip(status: number, errorText: string): boolean {
  return status === 400 && errorText.includes('FAILED_PRECONDITION')
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
  alsoRetryable?: (status: number, errorText: string) => boolean,
): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, init)
    if (res.ok) return res

    const errorText = await res.text()
    const retryable = RETRYABLE_STATUS.has(res.status) || (alsoRetryable?.(res.status, errorText) ?? false)
    if (attempt < MAX_RETRIES && retryable) {
      await sleep(RETRY_BASE_DELAY_MS * (attempt + 1))
      continue
    }
    throw new Error(`${label} error (${res.status}): ${errorText}`)
  }
  // Unreachable — the loop above always either returns or throws.
  throw new Error(`${label} error: exhausted retries`)
}

export async function fetchGeminiWithRetry(url: string, init: RequestInit): Promise<Response> {
  return fetchWithRetry(url, init, 'Gemini API', isGeminiLocationBlip)
}

/**
 * Google's Files API always lives on Google's own host. GEMINI_API_URL may
 * point at a Cloudflare AI Gateway, which proxies `:generateContent` — the
 * upload endpoints are a different path shape that the gateway is not
 * documented to pass through, and a file uploaded with the same API key is
 * visible to `:generateContent` either way, so uploads go direct.
 */
const GEMINI_FILES_HOST = 'https://generativelanguage.googleapis.com'

/**
 * Resumable-upload chunk size. Google requires every non-final chunk to be a
 * multiple of 256 KiB; 8 MiB keeps the number of round trips small while
 * bounding how much audio the process holds at once.
 */
export const GEMINI_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024

// Google transcodes a long recording for a while before the file goes ACTIVE.
const FILE_ACTIVE_POLL_INTERVAL_MS = 3000
const FILE_ACTIVE_MAX_POLLS = 200

export interface GeminiUploadedFile {
  fileUri: string
  mimeType: string
}

interface GeminiFileResource {
  name?: string
  uri?: string
  mimeType?: string
  state?: string
}

/**
 * Uploads audio to the Gemini Files API and returns a reference usable as a
 * `fileData` part. Audio is pulled through `readChunk` a slice at a time so
 * the caller can stream it straight off disk without ever materializing the
 * whole recording — inlining it as base64 costs roughly 4x the file size in
 * peak memory.
 */
export async function uploadAudioToGeminiFiles(params: {
  apiKey: string
  cfAigToken?: string
  byteLength: number
  mimeType: string
  displayName: string
  readChunk: (offset: number, length: number) => Promise<Uint8Array>
  pollIntervalMs?: number
}): Promise<GeminiUploadedFile> {
  if (params.byteLength <= 0) {
    throw new Error('Cannot upload empty audio to the Gemini Files API')
  }

  const startRes = await fetch(`${GEMINI_FILES_HOST}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': params.apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(params.byteLength),
      'X-Goog-Upload-Header-Content-Type': params.mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: params.displayName } }),
  })
  if (!startRes.ok) {
    throw new Error(`Gemini Files API error (${startRes.status}): ${await startRes.text()}`)
  }

  const uploadUrl = startRes.headers.get('x-goog-upload-url')
  if (!uploadUrl) {
    throw new Error('Gemini Files API did not return an upload URL')
  }

  let uploaded: GeminiFileResource | null = null
  for (let offset = 0; offset < params.byteLength; offset += GEMINI_UPLOAD_CHUNK_BYTES) {
    const length = Math.min(GEMINI_UPLOAD_CHUNK_BYTES, params.byteLength - offset)
    const chunk = await params.readChunk(offset, length)
    const isFinal = offset + length >= params.byteLength

    const chunkRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(length),
        'X-Goog-Upload-Offset': String(offset),
        'X-Goog-Upload-Command': isFinal ? 'upload, finalize' : 'upload',
      },
      body: chunk,
    })
    if (!chunkRes.ok) {
      throw new Error(`Gemini Files API upload error (${chunkRes.status}): ${await chunkRes.text()}`)
    }
    if (isFinal) {
      const finalizeJson = (await chunkRes.json().catch(() => null)) as { file?: GeminiFileResource } | null
      uploaded = finalizeJson?.file ?? null
    }
  }

  if (!uploaded?.name || !uploaded?.uri) {
    throw new Error('Gemini Files API did not return an uploaded file reference')
  }

  return waitForActiveGeminiFile({
    apiKey: params.apiKey,
    file: { name: uploaded.name, uri: uploaded.uri, mimeType: uploaded.mimeType, state: uploaded.state },
    pollIntervalMs: params.pollIntervalMs ?? FILE_ACTIVE_POLL_INTERVAL_MS,
  })
}

// An uploaded file is transcoded server-side by Google before it can be
// referenced; generateContent fails outright if the file is still PROCESSING.
async function waitForActiveGeminiFile(params: {
  apiKey: string
  file: { name: string; uri: string; mimeType?: string; state?: string }
  pollIntervalMs: number
}): Promise<GeminiUploadedFile> {
  let state = params.file.state
  let mimeType = params.file.mimeType

  for (let attempt = 0; state !== 'ACTIVE' && attempt < FILE_ACTIVE_MAX_POLLS; attempt++) {
    if (state === 'FAILED') break
    await sleep(params.pollIntervalMs)

    const statusRes = await fetch(`${GEMINI_FILES_HOST}/v1beta/${params.file.name}`, {
      headers: { 'x-goog-api-key': params.apiKey },
    })
    if (!statusRes.ok) {
      throw new Error(`Gemini Files API status error (${statusRes.status}): ${await statusRes.text()}`)
    }
    const status = (await statusRes.json()) as GeminiFileResource
    state = status.state
    mimeType = status.mimeType || mimeType
  }

  if (state === 'FAILED') {
    throw new Error(`Gemini Files API reported the uploaded audio as FAILED (${params.file.name})`)
  }
  if (state !== 'ACTIVE') {
    throw new Error('Gemini Files API did not finish processing the uploaded audio in time')
  }

  return { fileUri: params.file.uri, mimeType: mimeType || 'audio/mp3' }
}

// Shared by the single-shot analysis prompt and the summarize-a-merged-
// transcript prompt so both paths describe the same summary shape.
const SUMMARY_FIELDS_SPEC = `   - overview: Concise 2-3 sentence executive synopsis.
   - key_points: Array of 3-6 specific bullet takeaways. Each is an object with "text" and "timestamps" — an array of { timestamp, seconds } pointing to every transcript moment that discusses this point (usually 1, sometimes more if it recurs).
   - action_items: Array of objects with { id, task, assignee, status: "pending" | "completed", timestamps }, where timestamps follows the same { timestamp, seconds } format pointing to where the action was raised.
   - decisions: Array of objects, same shape as key_points ({ text, timestamps }).
   - sentiment: String describing overall tone (e.g. "Positive & Collaborative").`

const SUMMARY_JSON_SCHEMA = `  "summary": {
    "overview": "...",
    "key_points": [
      { "text": "...", "timestamps": [{ "timestamp": "00:12", "seconds": 12 }] }
    ],
    "action_items": [
      { "id": "act-1", "task": "...", "assignee": "...", "status": "pending", "timestamps": [{ "timestamp": "00:45", "seconds": 45 }] }
    ],
    "decisions": [
      { "text": "...", "timestamps": [{ "timestamp": "01:10", "seconds": 70 }] }
    ],
    "sentiment": "..."
  }`

function stripCodeFence(rawText: string): string {
  const raw = rawText.trim()
  if (!raw.startsWith('```')) return raw
  return raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
}

export interface TranscriptionSegmentParams {
  segment: AudioSegment
  segmentCount: number
  /** Speaker labels already established in earlier segments of this meeting. */
  knownSpeakers?: string[]
  /** The last few transcript lines before this slice, for continuity across the cut. */
  precedingContext?: string
  customInstructions?: string
}

/**
 * The step-1 prompt. Shared by every provider: which model hears the audio is
 * a transport detail, but what we ask of it — verbatim text, one label per
 * voice, real names only when the audio says them — must not drift between
 * providers, or the same meeting gets a different transcript depending on
 * routing.
 */
function buildSegmentTranscriptionPrompt(params: TranscriptionSegmentParams): string {
  const { segment } = params
  const partLabel = params.segmentCount > 1 ? `part ${segment.index + 1} of ${params.segmentCount} of ` : ''
  const knownSpeakers = params.knownSpeakers?.filter(Boolean) ?? []

  return `You are meetutu AI, transcribing ${partLabel}a meeting recording.
Listen to this audio and transcribe all spoken dialogue verbatim, as chronological lines with timestamps.

SEPARATE THE VOICES. Every line belongs to exactly one speaker, and the same voice must always carry the same label. When two people talk over each other, write one line each rather than merging them.

IDENTIFY THE PEOPLE. Use a person's real name whenever the audio itself reveals it — they introduce themselves, someone addresses them by name, they sign off with their name. Write it as "Name (Role)" when the role is also clear, e.g. "Andi (Host)" or "Rina (Product)"; otherwise just the name. Fall back to "Speaker 1", "Speaker 2", ... only for a voice whose name is never spoken. NEVER INVENT A NAME that was not said in the audio, and never guess a name from the meeting title.
${knownSpeakers.length > 0 ? `\nThese speakers have already been identified earlier in this meeting:\n${knownSpeakers.map((name) => `- ${name}`).join('\n')}\nReuse those exact labels whenever you hear the same person again. Add a new label only for a genuinely new voice.\n` : ''}${params.precedingContext ? `\nThe meeting was already in progress; these are the last lines before this clip starts:\n"""\n${params.precedingContext}\n"""\n` : ''}
Timestamps must be relative to the START OF THIS AUDIO CLIP, beginning at 00:00 — do not try to account for earlier parts of the meeting.
Transcribe only what is actually spoken. Do not summarize, do not add commentary, and do not invent dialogue to fill silence.
${params.customInstructions ? `\nThe user has asked for this transcript to follow these instructions where they apply to transcription (language, formatting, terminology):\n"""\n${params.customInstructions}\n"""\n` : ''}
This clip is about ${segment.durationSeconds} seconds long.

Return ONLY a JSON object matching this exact schema:
{
  "transcript": [
    { "id": "t-1", "timestamp": "00:00", "seconds": 0, "speaker": "Andi (Host)", "text": "..." }
  ]
}`
}

/**
 * The model only heard one slice, so it numbers its timestamps from zero and
 * restarts its ids. Both are rewritten into meeting time here rather than
 * trusting the model to do arithmetic it cannot check.
 */
function parseSegmentTranscript(rawText: string, segment: AudioSegment, segmentCount: number): TranscriptItem[] {
  const partLabel = `part ${segment.index + 1} of ${segmentCount}`

  // A generation that dies partway through still returns HTTP 200 with the
  // prefix it managed to produce, so the break surfaces here as a parse error
  // rather than as anything the response envelope admitted to.
  let parsed: { transcript?: unknown }
  try {
    parsed = JSON.parse(stripCodeFence(rawText))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new UnusableModelResponseError(`Malformed transcript JSON for ${partLabel}: ${message}`)
  }

  if (!Array.isArray(parsed.transcript)) {
    throw new UnusableModelResponseError(`No transcript returned for ${partLabel}`)
  }

  return (parsed.transcript as TranscriptItem[]).map((item, position) => {
    const seconds = segment.startSeconds + Math.max(0, Number(item.seconds) || 0)
    return {
      ...item,
      id: `t-${segment.index + 1}-${position + 1}`,
      seconds,
      timestamp: formatTimestamp(seconds),
    }
  })
}

export interface TranscriptAnalysisParams {
  title: string
  durationSeconds: number
  transcript: TranscriptItem[]
  customInstructions?: string
}

/** The step-2 prompt. Text only — the audio was already heard during step 1. */
function buildTranscriptAnalysisPrompt(params: TranscriptAnalysisParams, needsGeneratedTitle: boolean): string {
  const transcriptText = params.transcript
    .map((item) => `[${item.timestamp} | ${item.seconds}s] ${item.speaker}: ${item.text}`)
    .join('\n')

  return `You are meetutu AI, a world-class executive meeting intelligence engine.
Below is the full verbatim transcript of a meeting, with the speaker and the exact second offset of every line. Produce a structured executive summary of it.
Refer to people by the speaker labels used in the transcript — assignees on action items must be one of those labels, or "Unassigned" when the transcript does not say who owns it.
${SUMMARY_FIELDS_SPEC}
Every "seconds" value MUST be copied from the transcript lines you are citing, and every "timestamp" string MUST be the matching "MM:SS" formatting of that same value.
${needsGeneratedTitle ? 'Also produce a concise, specific meeting title (3-8 words) summarizing what was actually discussed — no generic placeholders.' : ''}
${params.customInstructions ? `\nThe user has given you these additional instructions — follow them closely, adjusting tone/focus/language/structure as asked, while still returning the exact JSON schema below:\n"""\n${params.customInstructions}\n"""\n` : ''}

Meeting Title: ${params.title || '(not provided — generate one from the actual content)'}
Duration: ${params.durationSeconds || 30} seconds

## Transcript
${transcriptText}

Return ONLY a JSON object matching this exact schema:
{
${SUMMARY_JSON_SCHEMA}${needsGeneratedTitle ? ',\n  "suggested_title": "..."' : ''}
}`
}

export interface TranscriptAnalysis {
  summary: MeetingSummary
  suggestedTitle?: string
}

function parseTranscriptAnalysis(rawText: string, source: 'Gemini' | 'OpenRouter'): TranscriptAnalysis {
  let parsed: { summary?: unknown; suggested_title?: string }
  try {
    parsed = JSON.parse(stripCodeFence(rawText))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new UnusableModelResponseError(`Malformed summary JSON from ${source}: ${message}`)
  }

  if (!parsed.summary) {
    throw new UnusableModelResponseError(`${source} response did not include a summary`)
  }
  return { summary: parsed.summary as MeetingSummary, suggestedTitle: parsed.suggested_title }
}

function needsGeneratedTitle(title: string): boolean {
  return !title || title === UNTITLED_MEETING_TITLE
}

/**
 * Step 1 of the pipeline: turn audio into a speaker-attributed transcript.
 *
 * This is the only call that ever hears the recording. It transcribes one
 * slice of it — a 90-120 minute meeting does not fit in one response (see
 * segmentation.ts) — separates the voices, and names them where the audio
 * says who they are.
 *
 * The model only hears this slice, so it numbers its timestamps from zero and
 * knows nothing about who spoke earlier; timestamps are shifted back into
 * meeting time here, and `knownSpeakers`/`precedingContext` carry the identity
 * of the people already found into the next slice.
 */
export async function transcribeAudioSegmentWithGemini(
  params: TranscriptionSegmentParams & {
    apiUrl?: string
    apiKey: string
    model?: string
    cfAigToken?: string
    audioBuffer?: ArrayBuffer
    audioFile?: GeminiUploadedFile
  },
): Promise<TranscriptItem[]> {
  const baseUrl = (params.apiUrl || DEFAULT_GEMINI_API_URL).replace(/\/$/, '')
  const model = params.model || DEFAULT_GEMINI_MODEL
  const { segment } = params

  const partLabel = params.segmentCount > 1 ? `part ${segment.index + 1} of ${params.segmentCount} of ` : ''
  const prompt = buildSegmentTranscriptionPrompt(params)

  const parts: Array<Record<string, unknown>> = [{ text: prompt }]
  if (params.audioFile) {
    parts.push({ fileData: { mimeType: params.audioFile.mimeType, fileUri: params.audioFile.fileUri } })
  } else if (params.audioBuffer && params.audioBuffer.byteLength > 0) {
    parts.push({ inlineData: { mimeType: 'audio/mp3', data: Buffer.from(params.audioBuffer).toString('base64') } })
  }

  const res = await fetchGeminiWithRetry(`${baseUrl}/models/${model}:generateContent`, {
    method: 'POST',
    headers: buildGeminiHeaders(params.apiKey, params.cfAigToken),
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS },
    }),
  })

  const json = (await res.json()) as GeminiResponse
  const text = readGeminiText(json, `transcribing ${partLabel}the recording`)
  return parseSegmentTranscript(text, segment, params.segmentCount)
}

/**
 * Step 1 over OpenRouter. Same prompt and same post-processing as the Gemini
 * path; the difference is transport. OpenRouter takes audio only as inline
 * base64 — there is no files API to stream a large slice through — so a
 * segment has to be small enough to sit in the request body, which is what
 * `MAX_SEGMENT_BYTES` in segmentation.ts guarantees.
 */
export async function transcribeAudioSegmentWithOpenRouter(
  params: TranscriptionSegmentParams & {
    apiKey: string
    model?: string
    audioBuffer?: ArrayBuffer
  },
): Promise<TranscriptItem[]> {
  const { segment } = params
  if (!params.audioBuffer || params.audioBuffer.byteLength === 0) {
    // Without audio the model would happily write a plausible meeting from the
    // prompt alone. Refuse instead of returning fiction.
    throw new Error(`No audio to transcribe for part ${segment.index + 1} of ${params.segmentCount}`)
  }

  const partLabel = params.segmentCount > 1 ? `part ${segment.index + 1} of ${params.segmentCount} of ` : ''
  const text = await requestOpenRouterJson({
    apiKey: params.apiKey,
    model: params.model || DEFAULT_OPENROUTER_MODEL,
    what: `transcribing ${partLabel}the recording`,
    content: [
      { type: 'text', text: buildSegmentTranscriptionPrompt(params) },
      {
        type: 'input_audio',
        input_audio: { data: Buffer.from(params.audioBuffer).toString('base64'), format: AUDIO_FILE_EXTENSION },
      },
    ],
  })

  return parseSegmentTranscript(text, segment, params.segmentCount)
}

/**
 * Step 2 of the pipeline: analyze the finished transcript.
 *
 * Text only — the audio was already heard during transcription, and re-sending
 * two hours of it would cost another ~230k input tokens for no extra
 * information. It also means the analysis reasons over named speakers rather
 * than over sound.
 */
export async function analyzeTranscriptWithGemini(
  params: TranscriptAnalysisParams & {
    apiUrl?: string
    apiKey: string
    model?: string
    cfAigToken?: string
  },
): Promise<TranscriptAnalysis> {
  const baseUrl = (params.apiUrl || DEFAULT_GEMINI_API_URL).replace(/\/$/, '')
  const model = params.model || DEFAULT_GEMINI_MODEL
  const prompt = buildTranscriptAnalysisPrompt(params, needsGeneratedTitle(params.title))

  const res = await fetchGeminiWithRetry(`${baseUrl}/models/${model}:generateContent`, {
    method: 'POST',
    headers: buildGeminiHeaders(params.apiKey, params.cfAigToken),
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS },
    }),
  })

  const json = (await res.json()) as GeminiResponse
  return parseTranscriptAnalysis(readGeminiText(json, 'analyzing the transcript'), 'Gemini')
}

/** Step 2 over OpenRouter. Text only, same prompt as the Gemini path. */
export async function analyzeTranscriptWithOpenRouter(
  params: TranscriptAnalysisParams & {
    apiKey: string
    model?: string
  },
): Promise<TranscriptAnalysis> {
  const text = await requestOpenRouterJson({
    apiKey: params.apiKey,
    model: params.model || DEFAULT_OPENROUTER_MODEL,
    what: 'analyzing the transcript',
    content: buildTranscriptAnalysisPrompt(params, needsGeneratedTitle(params.title)),
  })

  return parseTranscriptAnalysis(text, 'OpenRouter')
}

function buildChatSystemPrompt(params: { title: string; transcriptText: string; summaryText: string }): string {
  return `You are meetutu AI, a helpful assistant answering questions about a specific recorded meeting titled "${params.title}".
Base every answer only on the meeting summary and transcript provided below — they are your only source of truth for this conversation. If the answer isn't contained in them, say so honestly instead of guessing. Keep answers concise and conversational.

## Meeting Summary
${params.summaryText || '(no summary available)'}

## Meeting Transcript
${params.transcriptText || '(no transcript available)'}`
}

export async function callOpenRouterChat(params: {
  apiKey: string
  model?: string
  title: string
  transcriptText: string
  summaryText: string
  history: ChatTurn[]
  message: string
}): Promise<string> {
  const model = params.model || DEFAULT_OPENROUTER_MODEL

  const res = await fetchWithRetry(
    OPENROUTER_CHAT_URL,
    {
      method: 'POST',
      headers: buildOpenRouterHeaders(params.apiKey),
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: buildChatSystemPrompt(params) },
          ...params.history.map((turn) => ({ role: turn.role, content: turn.content })),
          { role: 'user', content: params.message },
        ],
        temperature: 0.4,
      }),
    },
    'OpenRouter API',
  )

  return readOpenRouterText((await res.json()) as OpenRouterResponse, 'answering a question about the meeting').trim()
}

export async function callGeminiChat(params: {
  apiUrl?: string
  apiKey: string
  model?: string
  title: string
  transcriptText: string
  summaryText: string
  history: ChatTurn[]
  message: string
  cfAigToken?: string
}): Promise<string> {
  const baseUrl = (params.apiUrl || DEFAULT_GEMINI_API_URL).replace(/\/$/, '')
  const model = params.model || DEFAULT_GEMINI_MODEL

  const contents = [
    ...params.history.map((turn) => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.content }],
    })),
    { role: 'user', parts: [{ text: params.message }] },
  ]

  const res = await fetchGeminiWithRetry(`${baseUrl}/models/${model}:generateContent`, {
    method: 'POST',
    headers: buildGeminiHeaders(params.apiKey, params.cfAigToken),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: buildChatSystemPrompt(params) }] },
      contents,
    }),
  })

  const json = (await res.json()) as GeminiResponse
  const reply = json.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text
  if (!reply) {
    throw new Error('Empty response from Gemini API')
  }
  return reply.trim()
}
