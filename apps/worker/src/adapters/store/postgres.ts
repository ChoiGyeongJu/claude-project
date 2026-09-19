import { and, asc, desc, eq, gte, isNotNull, lt, lte, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { NormalizedEvent, Tier } from '@app/shared'
import type { EventStore, PendingOutbox } from '../../ports/store.js'
import { apiUsage, events, outbox } from './schema.js'

export type Db = PostgresJsDatabase<Record<string, never>>

const VALID_TIERS: readonly Tier[] = ['critical', 'high', 'normal']

function isTier(value: string): value is Tier {
  return (VALID_TIERS as readonly string[]).includes(value)
}

/**
 * jsonb 컬럼은 Date 타입이 없어 왕복하면 occurredAt/firstSeenAt이 ISO 문자열로 저장된다.
 * NormalizedEvent는 이 둘을 Date로 못박아 두므로, 반환 직전에 되살린다.
 */
type StoredEventPayload = Omit<NormalizedEvent, 'occurredAt' | 'firstSeenAt'> & {
  occurredAt: string | null
  firstSeenAt: string
}

function rehydrateEvent(payload: unknown): NormalizedEvent {
  const raw = payload as StoredEventPayload
  return {
    ...raw,
    occurredAt: raw.occurredAt ? new Date(raw.occurredAt) : null,
    firstSeenAt: new Date(raw.firstSeenAt),
  }
}

export function createPostgresStore(db: Db): EventStore {
  return {
    async recordEvent(event, verdict, opts) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .insert(events)
          .values({
            sourceId: event.sourceId,
            externalId: event.externalId,
            occurredAt: event.occurredAt,
            firstSeenAt: event.firstSeenAt,
            title: event.title,
            url: event.url,
            corpName: event.subject?.name ?? null,
            ticker: event.subject?.ticker ?? null,
            market: event.subject?.market ?? null,
            verdict: verdict.action,
            tier: verdict.action === 'pass' ? verdict.tier : null,
            rule: verdict.action === 'pass' ? verdict.rule : verdict.reason,
            raw: event.raw,
          })
          .onConflictDoNothing()
          .returning({ id: events.id })

        const inserted = rows[0]
        if (!inserted) return false // 중복 — outbox를 건드리지 않는다

        if (opts.enqueue && verdict.action === 'pass' && opts.expiresAt) {
          await tx
            .insert(outbox)
            .values({
              eventId: inserted.id,
              tier: verdict.tier,
              payload: event as unknown as Record<string, unknown>,
              status: 'pending',
              attempts: 0,
              nextAttemptAt: event.firstSeenAt,
              expiresAt: opts.expiresAt,
            })
            .returning({ id: outbox.id })
        }
        return true
      })
    },

    async claimPending(now, limit) {
      const rows = await db
        .select()
        .from(outbox)
        .where(and(eq(outbox.status, 'pending'), lte(outbox.nextAttemptAt, now)))
        // critical을 항상 먼저 고려한다 — outbox가 nextAttemptAt 기준으로만 정렬되면
        // limit 경계에서 critical(TTL 5분)이 non-critical 뒤로 밀려 claim되기 전에
        // 만료될 수 있다. Task 13이 배치 "안"에서 tier를 나누는 것과는 별개로,
        // 배치 "경계"에서부터 critical을 우선해야 한다.
        .orderBy(
          sql`CASE WHEN ${outbox.tier} = 'critical' THEN 0 ELSE 1 END`,
          asc(outbox.nextAttemptAt),
        )
        .limit(limit)

      const pending: PendingOutbox[] = []
      for (const r of rows) {
        if (!isTier(r.tier)) {
          // DB에는 CHECK 제약이 없어 손상되거나 예상치 못한 tier 값이 들어올 수 있다.
          // 이 한 행 때문에 전체 디스패치 루프를 멈추지 않도록 건너뛰고, 원인 추적을 위해 크게 로그를 남긴다.
          console.error(
            `[postgres-store] claimPending: outbox row ${r.id} has invalid tier "${r.tier}" — skipping`,
          )
          continue
        }
        pending.push({
          id: r.id,
          eventId: r.eventId,
          tier: r.tier,
          event: rehydrateEvent(r.payload),
          attempts: r.attempts,
          expiresAt: r.expiresAt,
        })
      }
      return pending
    },

    async markSent(id) {
      await db.update(outbox).set({ status: 'sent' }).where(eq(outbox.id, id))
    },

    async markFailed(id, error, nextAttemptAt, attempts) {
      await db
        .update(outbox)
        .set({ attempts, lastError: error, nextAttemptAt })
        .where(eq(outbox.id, id))
    },

    async markDead(id, error) {
      await db.update(outbox).set({ status: 'dead', lastError: error }).where(eq(outbox.id, id))
    },

    async incrementApiUsage(sourceId, kstDate) {
      const rows = await db
        .insert(apiUsage)
        .values({ usageDate: kstDate, sourceId, callCount: 1 })
        .onConflictDoUpdate({
          target: [apiUsage.usageDate, apiUsage.sourceId],
          set: { callCount: sql`${apiUsage.callCount} + 1` },
        })
        .returning({ callCount: apiUsage.callCount })
      return rows[0]?.callCount ?? 0
    },

    async getApiUsage(sourceId, kstDate) {
      const rows = await db
        .select({ c: apiUsage.callCount })
        .from(apiUsage)
        .where(and(eq(apiUsage.usageDate, kstDate), eq(apiUsage.sourceId, sourceId)))
      return rows[0]?.c ?? 0
    },

    async digestFor(kstDate) {
      const dayStart = new Date(`${kstDate}T00:00:00+09:00`)
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000)

      const sentRows = await db.select({ tier: outbox.tier, n: sql<number>`count(*)::int` })
        .from(outbox)
        .innerJoin(events, eq(outbox.eventId, events.id))
        .where(and(
          eq(outbox.status, 'sent'),
          gte(events.firstSeenAt, dayStart),
          lt(events.firstSeenAt, dayEnd),
        ))
        .groupBy(outbox.tier)

      const sent = { critical: 0, high: 0, normal: 0 }
      for (const r of sentRows) {
        if (r.tier === 'critical' || r.tier === 'high' || r.tier === 'normal') sent[r.tier] = r.n
      }

      const deadRows = await db.select({ n: sql<number>`count(*)::int` })
        .from(outbox)
        .innerJoin(events, eq(outbox.eventId, events.id))
        .where(and(
          eq(outbox.status, 'dead'),
          gte(events.firstSeenAt, dayStart),
          lt(events.firstSeenAt, dayEnd),
        ))

      const missed = await db.select({
        title: events.title, corpName: events.corpName, ticker: events.ticker,
      }).from(events).where(and(
        eq(events.verdict, 'drop'),
        eq(events.rule, 'no-keyword-match'),
        gte(events.firstSeenAt, dayStart),
        lt(events.firstSeenAt, dayEnd),
      )).limit(50)

      // outbox.lastError는 자유 텍스트이지만 재시도/dead 경로 모두 같은 문자열(예: 'dart-timeout')을
      // 남기므로 그룹핑이 유효하다. Top 5만 — 나머지 전부를 나열하면 다이제스트가 읽히지 않아
      // (읽히지 않는 다이제스트는 없는 것과 같다) 신호가 오히려 묻힌다.
      const errorRows = await db.select({
        err: outbox.lastError, n: sql<number>`count(*)::int`,
      }).from(outbox)
        .innerJoin(events, eq(outbox.eventId, events.id))
        .where(and(
          isNotNull(outbox.lastError),
          gte(events.firstSeenAt, dayStart),
          lt(events.firstSeenAt, dayEnd),
        ))
        .groupBy(outbox.lastError)
        .orderBy(desc(sql`count(*)`))
        .limit(5)

      const errorCounts: Record<string, number> = {}
      for (const r of errorRows) if (r.err) errorCounts[r.err] = r.n

      // 잘리지 않은 총계를 따로 센다 — 50건 상한에 걸린 날 "50건"으로 보이면
      // 심각도가 과소 표시되고, 운영자는 문제가 작다고 오판한다.
      const missedTotalRows = await db.select({ n: sql<number>`count(*)::int` })
        .from(events).where(and(
          eq(events.verdict, 'drop'),
          eq(events.rule, 'no-keyword-match'),
          gte(events.firstSeenAt, dayStart),
          lt(events.firstSeenAt, dayEnd),
        ))

      return {
        sent,
        dead: deadRows[0]?.n ?? 0,
        missedCandidates: missed,
        errorCounts,
        missedTotal: missedTotalRows[0]?.n ?? 0,
      }
    },
  }
}
