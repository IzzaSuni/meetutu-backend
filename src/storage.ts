import type { AppDatabase } from './db.js'
import type { AnalysisJobRecord, MeetingSession, MeetingSummary, TranscriptItem } from './types.js'

export interface Storage {
  listSessions(): MeetingSession[]
  getSession(id: number): MeetingSession | undefined
  putSession(session: MeetingSession): void
  deleteSession(id: number): void
  getTranscript(sessionId: number): TranscriptItem[]
  putTranscript(sessionId: number, transcript: TranscriptItem[]): void
  getSummary(sessionId: number): MeetingSummary | undefined
  putSummary(sessionId: number, summary: MeetingSummary): void
  getAnalysisJob(sessionId: number): AnalysisJobRecord | undefined
  putAnalysisJob(sessionId: number, job: Omit<AnalysisJobRecord, 'updated_at'>): void
}

interface SessionRow {
  id: number
  title: string
  status: string
  duration: number
  created_at: string
  parts_count: number
  audio_url: string
  has_transcription: number
  has_summary: number
}

interface JsonRow {
  data: string
}

interface AnalysisJobRow {
  status: string
  error: string | null
  provider: string | null
  updated_at: string
}

function toSession(row: SessionRow): MeetingSession {
  return {
    id: row.id,
    title: row.title,
    status: row.status as MeetingSession['status'],
    duration: row.duration,
    created_at: row.created_at,
    parts_count: row.parts_count,
    audio_url: row.audio_url,
    has_transcription: row.has_transcription === 1,
    has_summary: row.has_summary === 1,
  }
}

export function createStorage(db: AppDatabase): Storage {
  const statements = {
    listSessions: db.prepare('SELECT * FROM sessions ORDER BY created_at DESC, id DESC'),
    getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    putSession: db.prepare(`
      INSERT INTO sessions (id, title, status, duration, created_at, parts_count, audio_url, has_transcription, has_summary)
      VALUES (@id, @title, @status, @duration, @created_at, @parts_count, @audio_url, @has_transcription, @has_summary)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        status = excluded.status,
        duration = excluded.duration,
        created_at = excluded.created_at,
        parts_count = excluded.parts_count,
        audio_url = excluded.audio_url,
        has_transcription = excluded.has_transcription,
        has_summary = excluded.has_summary
    `),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    deleteTranscript: db.prepare('DELETE FROM transcripts WHERE session_id = ?'),
    deleteSummary: db.prepare('DELETE FROM summaries WHERE session_id = ?'),
    deleteAnalysisJob: db.prepare('DELETE FROM analysis_jobs WHERE session_id = ?'),
    getTranscript: db.prepare('SELECT data FROM transcripts WHERE session_id = ?'),
    putTranscript: db.prepare(`
      INSERT INTO transcripts (session_id, data) VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET data = excluded.data
    `),
    getSummary: db.prepare('SELECT data FROM summaries WHERE session_id = ?'),
    putSummary: db.prepare(`
      INSERT INTO summaries (session_id, data) VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET data = excluded.data
    `),
    getAnalysisJob: db.prepare('SELECT status, error, provider, updated_at FROM analysis_jobs WHERE session_id = ?'),
    putAnalysisJob: db.prepare(`
      INSERT INTO analysis_jobs (session_id, status, error, provider, updated_at)
      VALUES (@session_id, @status, @error, @provider, @updated_at)
      ON CONFLICT(session_id) DO UPDATE SET
        status = excluded.status,
        error = excluded.error,
        provider = excluded.provider,
        updated_at = excluded.updated_at
    `),
  }

  // One transaction so a session can never survive its own transcript.
  const deleteEverything = db.transaction((id: number) => {
    statements.deleteTranscript.run(id)
    statements.deleteSummary.run(id)
    statements.deleteAnalysisJob.run(id)
    statements.deleteSession.run(id)
  })

  return {
    listSessions() {
      return (statements.listSessions.all() as SessionRow[]).map(toSession)
    },

    getSession(id) {
      const row = statements.getSession.get(id) as SessionRow | undefined
      return row ? toSession(row) : undefined
    },

    putSession(session) {
      statements.putSession.run({
        id: session.id,
        title: session.title,
        status: session.status,
        duration: session.duration,
        created_at: session.created_at,
        parts_count: session.parts_count,
        audio_url: session.audio_url,
        has_transcription: session.has_transcription ? 1 : 0,
        has_summary: session.has_summary ? 1 : 0,
      })
    },

    deleteSession(id) {
      deleteEverything(id)
    },

    getTranscript(sessionId) {
      const row = statements.getTranscript.get(sessionId) as JsonRow | undefined
      return row ? (JSON.parse(row.data) as TranscriptItem[]) : []
    },

    putTranscript(sessionId, transcript) {
      statements.putTranscript.run(sessionId, JSON.stringify(transcript))
    },

    getSummary(sessionId) {
      const row = statements.getSummary.get(sessionId) as JsonRow | undefined
      return row ? (JSON.parse(row.data) as MeetingSummary) : undefined
    },

    putSummary(sessionId, summary) {
      statements.putSummary.run(sessionId, JSON.stringify(summary))
    },

    getAnalysisJob(sessionId) {
      const row = statements.getAnalysisJob.get(sessionId) as AnalysisJobRow | undefined
      if (!row) return undefined
      return {
        status: row.status as AnalysisJobRecord['status'],
        error: row.error ?? undefined,
        provider: row.provider ?? undefined,
        updated_at: row.updated_at,
      }
    },

    putAnalysisJob(sessionId, job) {
      statements.putAnalysisJob.run({
        session_id: sessionId,
        status: job.status,
        error: job.error ?? null,
        provider: job.provider ?? null,
        updated_at: new Date().toISOString(),
      })
    },
  }
}
