import { describe, it, expect } from 'vitest'
import { createCircuit, ALERT_THRESHOLD } from './circuit.js'

describe('createCircuit — 안 되는 API를 계속 두드려 예산을 태우지 않는다', () => {
  it('성공 상태에서는 배수가 1이다', () => {
    const c = createCircuit()
    c.recordSuccess()
    expect(c.intervalMultiplier()).toBe(1)
  })

  it('연속 실패가 늘수록 주기를 늘린다', () => {
    const c = createCircuit()
    c.recordFailure()
    expect(c.intervalMultiplier()).toBe(2)
    c.recordFailure()
    expect(c.intervalMultiplier()).toBe(4)
    c.recordFailure()
    expect(c.intervalMultiplier()).toBe(8)
  })

  it('배수에는 상한이 있다', () => {
    const c = createCircuit()
    for (let i = 0; i < 20; i += 1) c.recordFailure()
    expect(c.intervalMultiplier()).toBe(32)
  })

  it('성공하면 즉시 회복된다', () => {
    const c = createCircuit()
    c.recordFailure(); c.recordFailure()
    c.recordSuccess()
    expect(c.intervalMultiplier()).toBe(1)
    expect(c.consecutiveFailures()).toBe(0)
  })

  it('연속 실패 수를 노출한다 — 알림 판단에 쓴다', () => {
    const c = createCircuit()
    c.recordFailure(); c.recordFailure()
    expect(c.consecutiveFailures()).toBe(2)
  })

  it('알림 임계는 5회다', () => expect(ALERT_THRESHOLD).toBe(5))
})
