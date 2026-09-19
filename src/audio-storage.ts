import { mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AUDIO_FILE_EXTENSION } from './constants.js'

export interface AudioPart {
  partNumber: number
  path: string
  size: number
}

export interface AudioLayout {
  sessionId: number
  parts: AudioPart[]
  totalBytes: number
}

export interface AudioStorage {
  putPart(sessionId: number, partNumber: number, data: Uint8Array): Promise<void>
  getPart(sessionId: number, partNumber: number): Promise<Uint8Array | undefined>
  /** Lists a session's parts and sizes without reading a single audio byte. */
  getLayout(sessionId: number): Promise<AudioLayout | null>
  readAll(sessionId: number): Promise<Uint8Array | undefined>
  /** Reads one byte range of a recording, stitching across part boundaries. */
  readRange(layout: AudioLayout, offset: number, length: number): Promise<Uint8Array>
  deleteSession(sessionId: number): Promise<void>
}

const PART_FILE_PATTERN = new RegExp(`^part-(\\d+)\\.${AUDIO_FILE_EXTENSION}$`)

// Session and part numbers land in filesystem paths, so anything that isn't a
// plain non-negative integer is rejected outright rather than sanitized —
// there is no legitimate caller that needs a separator or a traversal segment.
function assertId(value: unknown, label: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 0 || String(value).trim() !== String(id)) {
    throw new Error(`Invalid ${label}: ${String(value)}`)
  }
  return id
}

async function statSize(path: string): Promise<number> {
  const handle = await open(path, 'r')
  try {
    return (await handle.stat()).size
  } finally {
    await handle.close()
  }
}

export function createAudioStorage(rootDir: string): AudioStorage {
  const sessionDir = (sessionId: number) => join(rootDir, 'recordings', String(sessionId))
  const partPath = (sessionId: number, partNumber: number) =>
    join(sessionDir(sessionId), `part-${partNumber}.${AUDIO_FILE_EXTENSION}`)

  const storage: AudioStorage = {
    async putPart(rawSessionId, rawPartNumber, data) {
      const sessionId = assertId(rawSessionId, 'session id')
      const partNumber = assertId(rawPartNumber, 'part number')
      await mkdir(sessionDir(sessionId), { recursive: true })
      await writeFile(partPath(sessionId, partNumber), data)
    },

    async getPart(rawSessionId, rawPartNumber) {
      const sessionId = assertId(rawSessionId, 'session id')
      const partNumber = assertId(rawPartNumber, 'part number')
      try {
        return new Uint8Array(await readFile(partPath(sessionId, partNumber)))
      } catch {
        return undefined
      }
    },

    async getLayout(rawSessionId) {
      const sessionId = assertId(rawSessionId, 'session id')
      let entries: string[]
      try {
        entries = await readdir(sessionDir(sessionId))
      } catch {
        return null
      }

      const parts: AudioPart[] = []
      for (const entry of entries) {
        const match = entry.match(PART_FILE_PATTERN)
        if (!match) continue
        const path = join(sessionDir(sessionId), entry)
        parts.push({ partNumber: Number(match[1]), path, size: await statSize(path) })
      }

      if (parts.length === 0) return null

      // Numeric order, not lexicographic: part-10 comes after part-2.
      parts.sort((a, b) => a.partNumber - b.partNumber)
      const totalBytes = parts.reduce((sum, part) => sum + part.size, 0)
      if (totalBytes === 0) return null

      return { sessionId, parts, totalBytes }
    },

    async readAll(sessionId) {
      const layout = await storage.getLayout(sessionId)
      if (!layout) return undefined
      return storage.readRange(layout, 0, layout.totalBytes)
    },

    async readRange(layout, offset, length) {
      const out = new Uint8Array(length)
      let written = 0
      let partStart = 0

      for (const part of layout.parts) {
        const partEnd = partStart + part.size
        const readStart = Math.max(offset, partStart)
        const readEnd = Math.min(offset + length, partEnd)

        if (readEnd > readStart) {
          const handle = await open(part.path, 'r')
          try {
            const { bytesRead } = await handle.read(out, written, readEnd - readStart, readStart - partStart)
            written += bytesRead
          } finally {
            await handle.close()
          }
        }

        partStart = partEnd
        if (partStart >= offset + length) break
      }

      return written === length ? out : out.subarray(0, written)
    },

    async deleteSession(rawSessionId) {
      const sessionId = assertId(rawSessionId, 'session id')
      await rm(sessionDir(sessionId), { recursive: true, force: true })
    },
  }

  return storage
}
