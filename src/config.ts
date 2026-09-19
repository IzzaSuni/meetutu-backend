import { DEFAULT_GEMINI_API_URL, DEFAULT_GEMINI_MODEL, DEFAULT_OPENROUTER_MODEL } from './ai-providers.js'

export interface Config {
  port: number
  host: string
  dataDir: string
  authUsername: string
  authPassword: string
  geminiApiKey: string
  geminiApiUrl: string
  geminiModel: string
  openrouterApiKey?: string
  openrouterModel?: string
  cfAigToken?: string
  corsOrigins: string[]
}

export type Env = Record<string, string | undefined>

const DEFAULT_PORT = 8787
const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_DATA_DIR = './data'
const MAX_PORT = 65535

function required(env: Env, key: string): string {
  const value = env[key]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return value
}

function optional(env: Env, key: string): string | undefined {
  const value = env[key]?.trim()
  return value ? value : undefined
}

function parsePort(raw: string | undefined): number {
  if (!raw) return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(`Invalid PORT: ${raw}`)
  }
  return port
}

/**
 * Validates the environment up front so a misconfigured deploy fails at boot
 * with a named variable rather than 500ing on the first real request.
 */
export function loadConfig(env: Env = process.env): Config {
  return {
    port: parsePort(optional(env, 'PORT')),
    host: optional(env, 'HOST') ?? DEFAULT_HOST,
    dataDir: optional(env, 'DATA_DIR') ?? DEFAULT_DATA_DIR,
    authUsername: required(env, 'AUTH_USERNAME'),
    authPassword: required(env, 'AUTH_PASSWORD'),
    geminiApiKey: required(env, 'GEMINI_API_KEY'),
    geminiApiUrl: optional(env, 'GEMINI_API_URL') ?? DEFAULT_GEMINI_API_URL,
    geminiModel: optional(env, 'GEMINI_MODEL') ?? DEFAULT_GEMINI_MODEL,
    openrouterApiKey: optional(env, 'OPENROUTER_API_KEY'),
    openrouterModel: optional(env, 'OPENROUTER_MODEL') ?? DEFAULT_OPENROUTER_MODEL,
    cfAigToken: optional(env, 'CF_AIG_TOKEN'),
    corsOrigins: (optional(env, 'CORS_ORIGINS') ?? '*')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  }
}
