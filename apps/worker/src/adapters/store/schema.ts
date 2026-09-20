import {
  bigint, bigserial, date, index, integer, jsonb, pgTable,
  primaryKey, text, timestamp, unique,
} from 'drizzle-orm/pg-core'

export const events = pgTable('events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  sourceId: text('source_id').notNull(),
  externalId: text('external_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
  title: text('title').notNull(),
  url: text('url').notNull(),
  corpName: text('corp_name'),
  ticker: text('ticker'),
  market: text('market'),
  verdict: text('verdict').notNull(),
  tier: text('tier'),
  rule: text('rule').notNull(),
  raw: jsonb('raw').notNull(),
}, (t) => ({
  uq: unique('events_source_external_uq').on(t.sourceId, t.externalId),
  // 다이제스트의 5개 집계 쿼리가 전부 first_seen_at 범위로 하루를 자르고,
  // lastEventKstDate 가 기동마다 이 컬럼의 최대값을 찾는다.
  firstSeenIdx: index('events_first_seen_at_idx').on(t.firstSeenAt),
}))

export const outbox = pgTable('outbox', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  eventId: bigint('event_id', { mode: 'number' }).notNull().references(() => events.id),
  tier: text('tier').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastError: text('last_error'),
}, (t) => ({
  // claimPending 은 매 사이클 실행되고 where(status='pending' AND next_attempt_at <= now)
  // 로 좁힌다. 인덱스가 없으면 outbox 전체를 순차 스캔하며, sent/dead 가 쌓일수록
  // 그 비용이 단조 증가한다 — 매 폴링 사이클에 그대로 얹힌다.
  pendingIdx: index('outbox_status_next_attempt_idx').on(t.status, t.nextAttemptAt),
}))

export const apiUsage = pgTable('api_usage', {
  usageDate: date('usage_date').notNull(),
  sourceId: text('source_id').notNull(),
  callCount: integer('call_count').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.usageDate, t.sourceId] }),
}))
