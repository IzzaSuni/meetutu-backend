export interface MeetingSession {
  id: number
  title: string
  status: 'recording' | 'uploading' | 'completed' | 'timeout_failed'
  duration: number
  created_at: string
  parts_count: number
  audio_url: string
  has_transcription?: boolean
  has_summary?: boolean
}

export interface TranscriptItem {
  id: string
  timestamp: string
  seconds: number
  speaker: string
  text: string
}

// A pointer from a summary item back into the transcript — one summary point
// can reference multiple moments in the recording.
export interface SummaryTimestampRef {
  timestamp: string
  seconds: number
}

export interface SummaryItem {
  text: string
  timestamps?: SummaryTimestampRef[]
}

export interface ActionItem {
  id: string
  task: string
  assignee: string
  status: 'pending' | 'in_progress' | 'completed'
  timestamps?: SummaryTimestampRef[]
}

export interface MeetingSummary {
  overview: string
  key_points: SummaryItem[]
  action_items: ActionItem[]
  decisions: SummaryItem[]
  sentiment?: string
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export type AnalysisJobStatus = 'processing' | 'done' | 'error'

export interface AnalysisJobRecord {
  status: AnalysisJobStatus
  error?: string
  provider?: string
  updated_at?: string
}
