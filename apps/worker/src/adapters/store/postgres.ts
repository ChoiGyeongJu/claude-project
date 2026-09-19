import { and, asc, eq, lte, sql } from 'drizzle-orm'
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

    async markFailed(id, error, nextAttemptAt) {
      await db
        .update(outbox)
        .set({ attempts: sql`${outbox.attempts} + 1`, lastError: error, nextAttemptAt })
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
  }
}
