import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Derives an opaque bearer token from the configured credentials. Keeps the
 * plaintext password out of the browser while needing no session store, and
 * matches the Cloudflare Worker's derivation byte for byte so an already
 * signed-in client keeps working after the cutover.
 */
export function computeAuthToken(username: string, password: string): string {
  return createHash('sha256').update(`${username}:${password}`).digest('hex')
}

/** Constant-time comparison so a token can't be recovered one byte at a time. */
export function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
