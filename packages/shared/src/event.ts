export type Market = 'Y' | 'K'
export type Tier = 'critical' | 'high' | 'normal'

export type EventSubject = {
  name: string
  ticker?: string
  market?: Market
}

export type NormalizedEvent = {
  sourceId: string
  externalId: string
  occurredAt: Date | null
  firstSeenAt: Date
  title: string
  url: string
  subject?: EventSubject
  raw: unknown
}

export type Verdict =
  | { action: 'drop'; reason: string }
  | { action: 'pass'; tier: Tier; rule: string }

export function isPass(v: Verdict): v is Extract<Verdict, { action: 'pass' }> {
  return v.action === 'pass'
}
