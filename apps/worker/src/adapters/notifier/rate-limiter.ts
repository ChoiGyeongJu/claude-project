/** 텔레그램 같은 채팅 한도는 분당 약 20건. 429를 맞기 전에 우리가 먼저 조인다. */
export const MESSAGES_PER_MINUTE = 15

export type TokenBucket = { tryTake(now: Date): boolean }

export function createTokenBucket(opts: {
  capacity: number
  refillPerMinute: number
}): TokenBucket {
  let tokens = opts.capacity
  let lastRefill: number | null = null
  const refillIntervalMs = 60_000 / opts.refillPerMinute

  return {
    tryTake(now: Date): boolean {
      const t = now.getTime()
      if (lastRefill === null) lastRefill = t

      const gained = Math.floor((t - lastRefill) / refillIntervalMs)
      if (gained > 0) {
        tokens = Math.min(opts.capacity, tokens + gained)
        lastRefill += gained * refillIntervalMs
      }

      if (tokens <= 0) return false
      tokens -= 1
      return true
    },
  }
}
