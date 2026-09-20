/** 연속 실패가 이 횟수를 넘으면 운영자에게 알린다. */
export const ALERT_THRESHOLD = 5

const MAX_MULTIPLIER = 32

export type Circuit = {
  recordSuccess(): void
  recordFailure(): void
  intervalMultiplier(): number
  consecutiveFailures(): number
}

export function createCircuit(): Circuit {
  let failures = 0
  return {
    recordSuccess() { failures = 0 },
    recordFailure() { failures += 1 },
    consecutiveFailures() { return failures },
    intervalMultiplier() {
      if (failures === 0) return 1
      return Math.min(2 ** failures, MAX_MULTIPLIER)
    },
  }
}
