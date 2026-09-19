import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from './db.js'
import { createStorage, type Storage } from './storage.js'
import type { MeetingSession, MeetingSummary, TranscriptItem } from './types.js'

const baseSession: MeetingSession = {
  id: 1,
  title: 'Sprint Review',
  status: 'completed',
  duration: 120,
  created_at: '2026-09-17T00:00:00.000Z',
  parts_count: 1,
  audio_url: '/api/recordings/1/audio',
  has_transcription: false,
  has_summary: false,
}

describe('storage (SQLite-backed)', () => {
  let dir: string
  let storage: Storage

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meetutu-storage-'))
    storage = createStorage(openDatabase(join(dir, 'test.db')))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a session', () => {
    storage.putSession(baseSession)
    expect(storage.getSession(1)).toEqual(baseSession)
  })

  it('returns undefined for a session that does not exist', () => {
    expect(storage.getSession(404)).toBeUndefined()
  })

  it('lists sessions newest first', () => {
    storage.putSession({ ...baseSession, id: 1, created_at: '2026-09-17T00:00:00.000Z' })
    storage.putSession({ ...baseSession, id: 2, title: 'Standup', created_at: '2026-09-17T01:00:00.000Z' })
    expect(storage.listSessions().map((s) => s.id)).toEqual([2, 1])
  })

  it('updates a session in place rather than inserting a duplicate', () => {
    storage.putSession(baseSession)
    storage.putSession({ ...baseSession, title: 'Renamed' })
    expect(storage.listSessions()).toHaveLength(1)
    expect(storage.getSession(1)?.title).toBe('Renamed')
  })

  it('round-trips a transcript and a summary', () => {
    const transcript: TranscriptItem[] = [
      { id: 't-1', timestamp: '00:00', seconds: 0, speaker: 'Speaker 1', text: 'Hello.' },
    ]
    const summary: MeetingSummary = {
      overview: 'A quick sync.',
      key_points: [],
      action_items: [],
      decisions: [],
    }

    storage.putTranscript(5, transcript)
    storage.putSummary(5, summary)

    expect(storage.getTranscript(5)).toEqual(transcript)
    expect(storage.getSummary(5)).toEqual(summary)
  })

  it('returns an empty transcript and no summary before analysis has run', () => {
    expect(storage.getTranscript(77)).toEqual([])
    expect(storage.getSummary(77)).toBeUndefined()
  })

  it('round-trips an analysis job so a restart does not lose a failure', () => {
    storage.putAnalysisJob(42, { status: 'error', error: 'Gemini API error (400)', provider: 'gemini' })
    const job = storage.getAnalysisJob(42)
    expect(job?.status).toBe('error')
    expect(job?.error).toBe('Gemini API error (400)')
    expect(job?.provider).toBe('gemini')
    expect(job?.updated_at).toBeTruthy()
  })

  it('moves an analysis job from processing to done in place', () => {
    storage.putAnalysisJob(43, { status: 'processing', provider: 'gemini' })
    storage.putAnalysisJob(43, { status: 'done', provider: 'gemini' })
    expect(storage.getAnalysisJob(43)?.status).toBe('done')
  })

  it('deletes a session with its transcript, summary, and job row', () => {
    storage.putSession(baseSession)
    storage.putTranscript(1, [{ id: 't-1', timestamp: '00:00', seconds: 0, speaker: 'S1', text: 'Hi.' }])
    storage.putSummary(1, { overview: 'x', key_points: [], action_items: [], decisions: [] })
    storage.putAnalysisJob(1, { status: 'done' })

    storage.deleteSession(1)

    expect(storage.getSession(1)).toBeUndefined()
    expect(storage.getTranscript(1)).toEqual([])
    expect(storage.getSummary(1)).toBeUndefined()
    expect(storage.getAnalysisJob(1)).toBeUndefined()
  })

  it('reopens an existing database file with its rows intact — a restart keeps the data', () => {
    const path = join(dir, 'persist.db')
    createStorage(openDatabase(path)).putSession(baseSession)

    const reopened = createStorage(openDatabase(path))
    expect(reopened.getSession(1)).toEqual(baseSession)
  })
})
