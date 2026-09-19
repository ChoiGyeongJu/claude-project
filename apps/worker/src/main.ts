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
    } finally {
      // heartbeat 은 반드시 finally 에 둔다. "프로세스가 살아 루프를 돌고 있는가"에
      // 답하는 신호이고, 그 답은 DART 성공 여부와 무관하기 때문이다.
      // try 안에 두면 DART 장애 중 워커가 멀쩡히 백오프하는 동안에도 핑이 끊겨
      // 외부 감시가 "VM 사망"으로 오판하고, 사람이 고칠 수 없고 저절로 낫는 일로
      // 운영자를 호출하게 된다. DART 실패는 서킷 브레이커 알림이 담당한다.
      // ping() 은 절대 throw 하지 않으므로 finally 에서 안전하다.
      heartbeatFailures = (await heartbeat.ping()) ? 0 : heartbeatFailures + 1
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
