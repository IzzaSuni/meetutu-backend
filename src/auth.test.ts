import { describe, it, expect } from 'vitest'
import { computeAuthToken } from './auth.js'

describe('computeAuthToken', () => {
  it('derives the SHA-256 hex digest of "username:password"', () => {
    // Same derivation the Cloudflare Worker used, so a token already held by a
    // signed-in browser keeps working against this backend.
    expect(computeAuthToken('admin', 'secret')).toBe(
      '901b281c4e0c4007e8526ef27153b79330811e733976d5e65c8343a39e54ec81'
    )
  })

  it('produces a different token for a different password', () => {
    expect(computeAuthToken('admin', 'a')).not.toBe(computeAuthToken('admin', 'b'))
  })
})
