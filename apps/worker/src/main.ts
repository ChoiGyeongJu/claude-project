import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import pino from 'pino'
import { budgetGuard, kstDateString } from './core/budget.js'
import { ALERT_THRESHOLD, createCircuit } from './core/circuit.js'
import { pollIntervalMs } from './core/schedule.js'
import { loadConfig } from './config.js'
import { createDartSource } from './adapters/sources/dart.js'
import { createPostgresStore, type Db } from './adapters/store/postgres.js'
import { createTelegramNotifier } from './adapters/notifier/telegram.js'
import { createLlmSummarizer } from './adapters/summarizer/llm.js'
import { runIngest } from './pipeline/ingest.js'
import { runDispatch } from './pipeline/dispatch.js'
import { runDigest } from './pipeline/digest.js'
import { createHeartbeat } from './pipeline/health.js'

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
  log.info('worker started')

  for (;;) {
    const now = new Date()
    const kstDate = kstDateString(now)

    try {
      const used = await store.incrementApiUsage(source.id, kstDate)
      const ingest = await runIngest({ source, store }, now)
      const dispatch = await runDispatch({ store, notifier, summarizer }, now)

      circuit.recordSuccess()
      if (ingest.recorded > 0 || dispatch.sent > 0) {
        log.info({ ingest, dispatch, used }, 'cycle')
      }

      // 자정이 지나면 전날 다이제스트를 보낸다
      if (kstDate !== lastDigestDate) {
        await runDigest({ store, notifier, sourceId: source.id }, lastDigestDate)
        lastDigestDate = kstDate
      }

      // heartbeat 이 확인되지 않으면(URL 오타·계정 만료 포함) 연속 실패를 센다.
      // 이 값이 0이 아니면 감시망이 뚫린 것이므로 다이제스트에 반드시 드러나야 한다.
      heartbeatFailures = (await heartbeat.ping()) ? 0 : heartbeatFailures + 1

      const base = budgetGuard(used, pollIntervalMs(now))
      await sleep(base)
    } catch (err) {
      circuit.recordFailure()
      const failures = circuit.consecutiveFailures()
      log.error({ err, failures }, 'cycle failed')

      // `=== ALERT_THRESHOLD` 로 두면 안 된다: 전면 장애(DART·텔레그램 동시 불통) 시
      // 5회째의 단 한 번뿐인 발송이 조용히 실패하고 failures 는 6,7,8... 로 올라가
      // 다시 5가 되지 않으므로 장애 전 구간에 알림이 0건 간다.
      if (failures >= ALERT_THRESHOLD && failures % ALERT_THRESHOLD === 0) {
        await notifier.send(
          `⚠️ 워커 연속 실패 ${failures}회` +
          (heartbeatFailures > 0 ? `\n⚠️ heartbeat 미확인 ${heartbeatFailures}회 — 감시망 점검 필요` : ''),
        ).catch(() => {})
      }

      await sleep(pollIntervalMs(new Date()) * circuit.intervalMultiplier())
    }
  }
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
