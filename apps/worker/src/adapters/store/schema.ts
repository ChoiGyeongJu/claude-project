import {
  bigint, bigserial, date, integer, jsonb, pgTable,
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
})

export const apiUsage = pgTable('api_usage', {
  usageDate: date('usage_date').notNull(),
  sourceId: text('source_id').notNull(),
  callCount: integer('call_count').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.usageDate, t.sourceId] }),
}))
