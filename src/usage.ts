import type { MeetingSession } from './types.js'

/**
 * What the account behind the configured key has spent, and what is left.
 *
 * Two independent numbers, and the dashboard needs both: `key` is the spend
 * limit set on this one API key, `credits` is the balance of the whole
 * OpenRouter account funding it. A key can be well under its own limit while
 * the account it draws on is empty, and vice versa.
 */
export interface KeyUsage {
  /** OpenRouter's own masked form, e.g. "sk-or-v1-e29...245" — never the key. */
  label: string
  spend: number
  spendToday: number
  spendThisWeek: number
  spendThisMonth: number
  /** Null when the key has no spend limit of its own. */
  limit: number | null
  remaining: number | null
  isFreeTier: boolean
  expiresAt: string | null
}

export interface CreditUsage {
  granted: number
  spend: number
  remaining: number
}

export interface ProviderUsage {
  key: KeyUsage
  /** Null when the credits endpoint refused — key stats are still worth showing. */
  credits: CreditUsage | null
}

/** What this backend itself has done, which no provider API can report. */
export interface MeetingUsage {
  total: number
  analyzed: number
  audioSeconds: number
}

const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/auth/key'
const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits'

interface KeyResponse {
  data?: {
    label?: string
    usage?: number
    usage_daily?: number
    usage_weekly?: number
    usage_monthly?: number
    limit?: number | null
    limit_remaining?: number | null
    is_free_tier?: boolean
    expires_at?: string | null
  }
}

interface CreditsResponse {
  data?: { total_credits?: number; total_usage?: number }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function nullableNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Reads the key's own stats. A failure here fails the whole call: without
 * them there is no usage to report.
 */
async function fetchKeyUsage(apiKey: string): Promise<KeyUsage> {
  const res = await fetch(OPENROUTER_KEY_URL, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!res.ok) {
    throw new Error(`OpenRouter refused the usage request (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }

  const data = ((await res.json()) as KeyResponse).data ?? {}
  return {
    label: data.label ?? 'OpenRouter key',
    spend: num(data.usage),
    spendToday: num(data.usage_daily),
    spendThisWeek: num(data.usage_weekly),
    spendThisMonth: num(data.usage_monthly),
    limit: nullableNum(data.limit),
    remaining: nullableNum(data.limit_remaining),
    isFreeTier: Boolean(data.is_free_tier),
    expiresAt: data.expires_at ?? null,
  }
}

/**
 * Reads the account balance. Deliberately best-effort: a key scoped to
 * inference alone cannot read it, and that is no reason to blank out a
 * dashboard whose main numbers already arrived.
 */
async function fetchCreditUsage(apiKey: string): Promise<CreditUsage | null> {
  const res = await fetch(OPENROUTER_CREDITS_URL, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!res.ok) return null

  const data = ((await res.json()) as CreditsResponse).data
  if (!data) return null

  const granted = num(data.total_credits)
  const spend = num(data.total_usage)
  return { granted, spend, remaining: granted - spend }
}

/** Both halves at once — they are independent, so neither waits on the other. */
export async function fetchOpenRouterUsage(apiKey: string): Promise<ProviderUsage> {
  const [key, credits] = await Promise.all([
    fetchKeyUsage(apiKey),
    fetchCreditUsage(apiKey).catch(() => null),
  ])
  return { key, credits }
}

/**
 * Counts what has actually been analyzed. `analyzed` follows the summary flag
 * rather than the session count: a recording that was uploaded but never sent
 * to a model cost nothing, and counting it would make the per-meeting cost on
 * screen look better than it is.
 */
export function summarizeMeetings(sessions: MeetingSession[]): MeetingUsage {
  return sessions.reduce<MeetingUsage>(
    (totals, session) => ({
      total: totals.total + 1,
      analyzed: totals.analyzed + (session.has_summary ? 1 : 0),
      audioSeconds: totals.audioSeconds + num(session.duration),
    }),
    { total: 0, analyzed: 0, audioSeconds: 0 },
  )
}
