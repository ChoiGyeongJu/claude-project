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
import { runLoop, createSleeper } from './pipeline/cycle.js'

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' })

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

  let shuttingDown = false
  const sleeper = createSleeper()

  // Docker stop·호스트 재부팅은 SIGTERM 으로 온다. 핸들러가 없으면 발송 직후
  // markSent 직전에 죽어 재시작 시 중복 알림이 나간다 — 매 재배포마다 발생한다.
  // sleep 이 중단 불가능하면 주말 sleep(5분)이나 서킷 백오프(80초) 중에 신호가
  // 와도 그게 끝나야 루프 조건을 다시 보는데, Docker 기본 유예(10초)가 먼저
  // 끝나 SIGKILL 이 떨어진다 — wakeNow() 로 대기 중이면 즉시 깨운다.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      if (shuttingDown) process.exit(1) // 두 번째 신호는 즉시 종료
      shuttingDown = true
      log.info({ sig }, 'shutdown requested — finishing current cycle')
      sleeper.wakeNow()
    })
  }
  log.info('worker started')

  await runLoop(
    { source, store, notifier, summarizer, heartbeat, circuit, log },
    { lastDigestDate: kstDateString(new Date()), heartbeatFailures: 0 },
    sleeper,
    { shouldStop: () => shuttingDown },
  )

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
