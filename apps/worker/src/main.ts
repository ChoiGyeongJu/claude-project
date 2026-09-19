import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import pino from 'pino'
import { kstDateString } from './core/budget.js'
import { createCircuit } from './core/circuit.js'
import { loadConfig } from './config.js'
import { createDartSource } from './adapters/sources/dart.js'
import { createPostgresStore, type Db } from './adapters/store/postgres.js'
import { createTelegramNotifier } from './adapters/notifier/telegram.js'
import { createLlmSummarizer } from './adapters/summarizer/llm.js'
import { createHeartbeat } from './pipeline/health.js'
import { runCycle } from './pipeline/cycle.js'

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' })

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const cfg = loadConfig(process.env)

  const sql = postgres(cfg.databaseUrl)
  const db = drizzle(sql) as unknown as Db
  const store = createPostgresStore(db)
  const source = createDartSource({ apiKey: cfg.dartApiKey })
  const notifier = createTelegramNotifier(cfg.telegram)
  const summarizer = createLlmSummarizer(cfg.llm)
  const heartbeat = createHeartbeat({ url: cfg.heartbeatUrl })
  const circuit = createCircuit()

  let lastDigestDate = kstDateString(new Date())
  let heartbeatFailures = 0
  let shuttingDown = false

  // Docker stop·호스트 재부팅은 SIGTERM 으로 온다. 핸들러가 없으면 발송 직후
  // markSent 직전에 죽어 재시작 시 중복 알림이 나간다 — 매 재배포마다 발생한다.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      if (shuttingDown) process.exit(1) // 두 번째 신호는 즉시 종료
      shuttingDown = true
      log.info({ sig }, 'shutdown requested — finishing current cycle')
    })
  }
  log.info('worker started')

  while (!shuttingDown) {
    const result = await runCycle(
      { source, store, notifier, summarizer, heartbeat, circuit, log },
      { lastDigestDate, heartbeatFailures },
      new Date(),
    )
    lastDigestDate = result.lastDigestDate
    heartbeatFailures = result.heartbeatFailures
    await sleep(result.sleepMs)
  }

  log.info('shutdown complete')
  process.exit(0)
}

// crash-only: 예외를 삼키고 도는 것보다 죽고 재시작하는 편이 안전하다
process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'uncaught exception — exiting')
  process.exit(1)
})
process.on('unhandledRejection', (err) => {
  log.fatal({ err }, 'unhandled rejection — exiting')
  process.exit(1)
})

main().catch((err) => {
  log.fatal({ err }, 'startup failed')
  process.exit(1)
})
