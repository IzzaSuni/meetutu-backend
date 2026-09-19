import { describe, it, expect } from 'vitest'
import { loadConfig } from './config.js'
import { DEFAULT_GEMINI_API_URL, DEFAULT_GEMINI_MODEL, DEFAULT_OPENROUTER_MODEL } from './ai-providers.js'

const required = {
  AUTH_USERNAME: 'admin',
  AUTH_PASSWORD: 'secret',
  OPENROUTER_API_KEY: 'or-key',
}

describe('loadConfig', () => {
  it('reads the required credentials from the environment', () => {
    const config = loadConfig(required)
    expect(config.authUsername).toBe('admin')
    expect(config.authPassword).toBe('secret')
    expect(config.openrouterApiKey).toBe('or-key')
  })

  it('applies defaults for everything optional', () => {
    const config = loadConfig(required)
    expect(config.port).toBe(8787)
    expect(config.host).toBe('0.0.0.0')
    expect(config.aiProvider).toBe('openrouter')
    expect(config.openrouterModel).toBe(DEFAULT_OPENROUTER_MODEL)
    expect(config.geminiApiUrl).toBe(DEFAULT_GEMINI_API_URL)
    expect(config.geminiModel).toBe(DEFAULT_GEMINI_MODEL)
    expect(config.dataDir).toBe('./data')
    expect(config.corsOrigins).toEqual(['*'])
  })

  it('overrides defaults from the environment', () => {
    const config = loadConfig({
      ...required,
      PORT: '3000',
      HOST: '127.0.0.1',
      DATA_DIR: '/srv/meetutu',
      GEMINI_API_KEY: 'gemini-key',
      GEMINI_MODEL: 'gemini-3.6-pro',
      OPENROUTER_MODEL: 'google/gemini-3.8-flash',
      CORS_ORIGINS: 'https://meetutu.app, https://staging.meetutu.app',
    })
    expect(config.port).toBe(3000)
    expect(config.host).toBe('127.0.0.1')
    expect(config.dataDir).toBe('/srv/meetutu')
    expect(config.geminiModel).toBe('gemini-3.6-pro')
    expect(config.openrouterModel).toBe('google/gemini-3.8-flash')
    expect(config.corsOrigins).toEqual(['https://meetutu.app', 'https://staging.meetutu.app'])
  })

  it.each(['AUTH_USERNAME', 'AUTH_PASSWORD', 'OPENROUTER_API_KEY'])(
    'fails fast when %s is missing instead of booting a broken server',
    (key) => {
      const env: Record<string, string | undefined> = { ...required, [key]: undefined }
      expect(() => loadConfig(env)).toThrow(key)
    }
  )

  it('requires the key of whichever provider is the default, not both', () => {
    // Arrange / Act / Assert: an OpenRouter-only deploy needs no Google key…
    expect(() => loadConfig(required)).not.toThrow()

    // …and a Gemini-only deploy needs no OpenRouter key.
    const gemini = { AUTH_USERNAME: 'admin', AUTH_PASSWORD: 'secret', AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'g' }
    expect(loadConfig(gemini).aiProvider).toBe('gemini')
    expect(() => loadConfig({ ...gemini, GEMINI_API_KEY: undefined })).toThrow('GEMINI_API_KEY')
  })

  it('rejects an AI_PROVIDER that is not a provider it can reach', () => {
    expect(() => loadConfig({ ...required, AI_PROVIDER: 'ollama' })).toThrow(/AI_PROVIDER/)
  })

  it('rejects a PORT that is not a usable port number', () => {
    expect(() => loadConfig({ ...required, PORT: 'http' })).toThrow(/PORT/)
    expect(() => loadConfig({ ...required, PORT: '0' })).toThrow(/PORT/)
    expect(() => loadConfig({ ...required, PORT: '70000' })).toThrow(/PORT/)
  })

  it('treats a blank required value as missing', () => {
    expect(() => loadConfig({ ...required, AUTH_PASSWORD: '   ' })).toThrow('AUTH_PASSWORD')
  })
})
