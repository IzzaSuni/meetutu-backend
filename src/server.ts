import { serve } from '@hono/node-server'
import { join, resolve } from 'node:path'
import { createApp } from './app.js'
import { createAnalysisRunner, createGenerator } from './analysis.js'
import { createAudioStorage } from './audio-storage.js'
import { loadConfig } from './config.js'
import { openDatabase } from './db.js'
import { createStorage } from './storage.js'

function main(): void {
  const config = loadConfig()
  const dataDir = resolve(config.dataDir)

  const storage = createStorage(openDatabase(join(dataDir, 'meetutu.db')))

  // Jobs live in this process. Anything still "processing" belongs to a
  // previous life of it and will never finish, so say so instead of leaving
  // the client polling a ghost.
  const reaped = storage.failStaleAnalysisJobs(
    'The server restarted while this meeting was being analyzed. Run the analysis again.',
  )
  if (reaped > 0) {
    console.warn(`failed ${reaped} analysis job(s) left processing by a previous run`)
  }

  const audio = createAudioStorage(join(dataDir, 'audio'))
  const analysis = createAnalysisRunner({ storage, generate: createGenerator({ audio, config }) })
  const app = createApp({ config, storage, audio, analysis })

  const server = serve(
    {
      fetch: app.fetch,
      port: config.port,
      hostname: config.host,
      // A meeting upload is one large body; the default 10s socket timeout is
      // far too short for an hour of audio over a slow uplink.
      serverOptions: { requestTimeout: 0, headersTimeout: 120_000 },
    },
    (info) => {
      console.log(`meetutu backend listening on http://${config.host}:${info.port} (data: ${dataDir})`)
    }
  )

  // Let in-flight analysis finish before the process goes away, so a deploy
  // doesn't strand a half-transcribed meeting.
  const shutdown = (signal: string) => {
    console.log(`${signal} received — draining analysis jobs`)
    server.close(() => {
      analysis.whenIdle().finally(() => process.exit(0))
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main()
