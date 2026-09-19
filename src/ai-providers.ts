import { UNTITLED_MEETING_TITLE } from './constants.js'
import type { ChatTurn, MeetingSummary, TranscriptItem } from './types.js'

// Official Google Generative Language API — no shared/community proxy.
// The API key comes from the environment, never from the browser.
export const DEFAULT_GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta'
export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash'
export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-3.5-haiku'

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
  candidates?: Array<{ content?: { parts?: GeminiCandidatePart[] } }>
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string } }>
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

const GEMINI_RETRYABLE_STATUS = new Set([429, 500, 502, 503])
const GEMINI_MAX_RETRIES = 2
const GEMINI_RETRY_BASE_DELAY_MS = 400

// Google's Generative Language API occasionally answers a perfectly valid
// request with "User location is not supported" (FAILED_PRECONDITION, HTTP
// 400) depending on the egress path, then succeeds on an immediate retry. A
// short retry rides that out instead of surfacing a one-off transient failure
// as if the account were permanently blocked.
function isRetryableGeminiError(status: number, errorText: string): boolean {
  if (GEMINI_RETRYABLE_STATUS.has(status)) return true
  return status === 400 && errorText.includes('FAILED_PRECONDITION')
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function fetchGeminiWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
    const res = await fetch(url, init)
    if (res.ok) return res

    const errorText = await res.text()
    if (attempt < GEMINI_MAX_RETRIES && isRetryableGeminiError(res.status, errorText)) {
      await sleep(GEMINI_RETRY_BASE_DELAY_MS * (attempt + 1))
      continue
    }
    throw new Error(`Gemini API error (${res.status}): ${errorText}`)
  }
  // Unreachable — the loop above always either returns or throws.
  throw new Error('Gemini API error: exhausted retries')
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

function buildAnalysisPrompt(params: {
  title: string
  durationSeconds: number
  hasAudio: boolean
  needsGeneratedTitle: boolean
  customInstructions?: string
}): string {
  return `You are meetutu AI, a world-class executive meeting intelligence engine.
${params.hasAudio ? 'Listen to this recorded audio file and transcribe all spoken dialogue verbatim.' : 'Analyze this meeting session.'}
Generate:
1. Detailed chronological dialogue transcript segments with timestamps (e.g. "00:00", "00:15") and realistic speaker labels (e.g. "Speaker 1 (Host)", "Speaker 2 (Participant)").
2. A structured executive meeting summary with:
   - overview: Concise 2-3 sentence executive synopsis.
   - key_points: Array of 3-6 specific bullet takeaways. Each is an object with "text" and "timestamps" — an array of { timestamp, seconds } pointing to every transcript moment that discusses this point (usually 1, sometimes more if it recurs).
   - action_items: Array of objects with { id, task, assignee, status: "pending" | "completed", timestamps }, where timestamps follows the same { timestamp, seconds } format pointing to where the action was raised.
   - decisions: Array of objects, same shape as key_points ({ text, timestamps }).
   - sentiment: String describing overall tone (e.g. "Positive & Collaborative").
Every "seconds" value (in transcript and in summary timestamps) MUST be the actual integer second offset into the recording, and every "timestamp" string MUST be the matching "MM:SS" formatting of that same value.
${params.needsGeneratedTitle ? '3. A concise, specific meeting title (3-8 words) summarizing what was actually discussed — no generic placeholders.' : ''}
${params.customInstructions ? `\nThe user has given you these additional instructions for how to generate this summary — follow them closely, adjusting tone/focus/language/structure as asked, while still returning the exact JSON schema below:\n"""\n${params.customInstructions}\n"""\n` : ''}

Meeting Title: ${params.title || '(not provided — generate one from the actual content)'}
Duration: ${params.durationSeconds || 30} seconds

You MUST return ONLY a JSON object matching this exact schema:
{
  "transcript": [
    { "id": "t-1", "timestamp": "00:00", "seconds": 0, "speaker": "Speaker 1 (Host)", "text": "..." }
  ],
  "summary": {
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
  }${params.needsGeneratedTitle ? ',\n  "suggested_title": "..."' : ''}
}`
}

function parseAnalysisJson(rawText: string, source: 'Gemini' | 'OpenRouter'): AiAnalysisResult {
  let raw = rawText.trim()
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  }

  const parsed = JSON.parse(raw)
  if (!parsed.transcript || !parsed.summary) {
    throw new Error(`${source} response did not match expected transcript/summary format`)
  }

  return {
    transcript: parsed.transcript,
    summary: parsed.summary,
    suggestedTitle: parsed.suggested_title,
  }
}

export async function callOpenRouterAI(params: {
  apiKey: string
  model?: string
  title: string
  durationSeconds: number
  customInstructions?: string
}): Promise<AiAnalysisResult> {
  const model = params.model || DEFAULT_OPENROUTER_MODEL
  const needsGeneratedTitle = !params.title || params.title === UNTITLED_MEETING_TITLE

  const systemPrompt = buildAnalysisPrompt({
    title: params.title,
    durationSeconds: params.durationSeconds,
    hasAudio: false,
    needsGeneratedTitle,
    customInstructions: params.customInstructions,
  })

  const userPrompt = `Meeting Title: ${params.title || '(not provided — generate one from the actual content)'}
Duration: ${params.durationSeconds || 30} seconds
Please generate the comprehensive transcript and executive meeting summary according to the schema.`

  const res = await fetch(OPENROUTER_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'HTTP-Referer': OPENROUTER_APP_URL,
      'X-Title': OPENROUTER_APP_TITLE,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
  })

  if (!res.ok) {
    throw new Error(`OpenRouter API error (${res.status}): ${await res.text()}`)
  }

  const data = (await res.json()) as OpenRouterResponse
  const content = data.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('Empty response from OpenRouter AI')
  }

  return parseAnalysisJson(content, 'OpenRouter')
}

export async function callGeminiGatewayAI(params: {
  apiUrl?: string
  apiKey: string
  model?: string
  title: string
  durationSeconds: number
  audioBuffer?: ArrayBuffer
  /** Reference to audio already uploaded via the Files API — preferred over audioBuffer for long recordings. */
  audioFile?: GeminiUploadedFile
  customInstructions?: string
  cfAigToken?: string
}): Promise<AiAnalysisResult> {
  const baseUrl = (params.apiUrl || DEFAULT_GEMINI_API_URL).replace(/\/$/, '')
  const model = params.model || DEFAULT_GEMINI_MODEL
  const needsGeneratedTitle = !params.title || params.title === UNTITLED_MEETING_TITLE

  const prompt = buildAnalysisPrompt({
    title: params.title,
    durationSeconds: params.durationSeconds,
    hasAudio: Boolean(params.audioBuffer || params.audioFile),
    needsGeneratedTitle,
    customInstructions: params.customInstructions,
  })

  const parts: Array<Record<string, unknown>> = [{ text: prompt }]

  if (params.audioFile) {
    parts.push({
      fileData: {
        mimeType: params.audioFile.mimeType,
        fileUri: params.audioFile.fileUri,
      },
    })
  } else if (params.audioBuffer && params.audioBuffer.byteLength > 0) {
    parts.push({
      inlineData: {
        mimeType: 'audio/mp3',
        data: Buffer.from(params.audioBuffer).toString('base64'),
      },
    })
  }

  const res = await fetchGeminiWithRetry(`${baseUrl}/models/${model}:generateContent`, {
    method: 'POST',
    headers: buildGeminiHeaders(params.apiKey, params.cfAigToken),
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  })

  const json = (await res.json()) as GeminiResponse
  const candidate = json.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text
  if (!candidate) {
    throw new Error('Empty response from Gemini API')
  }

  return parseAnalysisJson(candidate, 'Gemini')
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

  const res = await fetch(OPENROUTER_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'HTTP-Referer': OPENROUTER_APP_URL,
      'X-Title': OPENROUTER_APP_TITLE,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: buildChatSystemPrompt(params) },
        ...params.history.map((turn) => ({ role: turn.role, content: turn.content })),
        { role: 'user', content: params.message },
      ],
      temperature: 0.4,
    }),
  })

  if (!res.ok) {
    throw new Error(`OpenRouter API error (${res.status}): ${await res.text()}`)
  }

  const data = (await res.json()) as OpenRouterResponse
  const content = data.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('Empty response from OpenRouter AI')
  }
  return content.trim()
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
