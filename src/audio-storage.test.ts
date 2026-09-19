import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAudioStorage, type AudioStorage } from './audio-storage.js'

const bytes = (...values: number[]) => new Uint8Array(values)

describe('audio storage (filesystem-backed)', () => {
  let dir: string
  let audio: AudioStorage

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meetutu-audio-'))
    audio = createAudioStorage(join(dir, 'audio'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('stores a part and reads it back', async () => {
    await audio.putPart(1, 1, bytes(1, 2, 3))
    expect(await audio.getPart(1, 1)).toEqual(bytes(1, 2, 3))
  })

  it('returns undefined for a part that was never uploaded', async () => {
    expect(await audio.getPart(1, 9)).toBeUndefined()
  })

  it('returns no layout for a session with no audio', async () => {
    expect(await audio.getLayout(1)).toBeNull()
  })

  it('orders parts numerically, not lexicographically', async () => {
    await audio.putPart(1, 2, bytes(2))
    await audio.putPart(1, 10, bytes(10))
    await audio.putPart(1, 1, bytes(1))

    const layout = await audio.getLayout(1)
    expect(layout?.parts.map((p) => p.partNumber)).toEqual([1, 2, 10])
    expect(layout?.totalBytes).toBe(3)
  })

  it('concatenates all parts in order when reading the whole recording', async () => {
    await audio.putPart(1, 1, bytes(1, 2))
    await audio.putPart(1, 2, bytes(3, 4))

    expect(await audio.readAll(1)).toEqual(bytes(1, 2, 3, 4))
  })

  it('returns undefined when reading the whole recording of an empty session', async () => {
    expect(await audio.readAll(42)).toBeUndefined()
  })

  it('reads a byte range that straddles a part boundary', async () => {
    await audio.putPart(1, 1, bytes(1, 2, 3))
    await audio.putPart(1, 2, bytes(4, 5, 6))
    const layout = await audio.getLayout(1)

    expect(await audio.readRange(layout!, 2, 3)).toEqual(bytes(3, 4, 5))
  })

  it('reads a range contained entirely within one part', async () => {
    await audio.putPart(1, 1, bytes(1, 2, 3))
    await audio.putPart(1, 2, bytes(4, 5, 6))
    const layout = await audio.getLayout(1)

    expect(await audio.readRange(layout!, 4, 2)).toEqual(bytes(5, 6))
  })

  it('overwrites a re-uploaded part rather than appending to it', async () => {
    await audio.putPart(1, 1, bytes(1, 2, 3))
    await audio.putPart(1, 1, bytes(9))

    expect(await audio.readAll(1)).toEqual(bytes(9))
  })

  it('deletes only the requested session audio', async () => {
    await audio.putPart(1, 1, bytes(1))
    await audio.putPart(2, 1, bytes(2))

    await audio.deleteSession(1)

    expect(await audio.getLayout(1)).toBeNull()
    expect(await audio.readAll(2)).toEqual(bytes(2))
  })

  it('deleting a session with no audio is a no-op, not an error', async () => {
    await expect(audio.deleteSession(999)).resolves.toBeUndefined()
  })

  it('rejects a session id that tries to escape the audio directory', async () => {
    await expect(audio.putPart('../../etc' as unknown as number, 1, bytes(1))).rejects.toThrow(/invalid/i)
  })
})
