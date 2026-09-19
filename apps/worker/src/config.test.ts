import { describe, it, expect } from 'vitest'
import { loadConfig } from './config.js'

const valid = {
  DATABASE_URL: 'postgres://localhost/app',
  DART_API_KEY: 'k'.repeat(40),
  TELEGRAM_BOT_TOKEN: 't',
  TELEGRAM_CHAT_ID: '-100',
  LLM_API_KEY: 'l',
}

describe('loadConfig', () => {
  it('필수 값이 모두 있으면 파싱한다', () => {
    const c = loadConfig(valid)
    expect(c.dartApiKey).toBe('k'.repeat(40))
    expect(c.telegram.chatId).toBe('-100')
  })

  it('필수 값이 빠지면 어떤 키인지 알려주며 던진다', () => {
    const { DART_API_KEY, ...rest } = valid
    expect(() => loadConfig(rest)).toThrow(/DART_API_KEY/)
  })

  it('DART 키는 40자여야 한다', () => {
    expect(() => loadConfig({ ...valid, DART_API_KEY: 'short' })).toThrow(/DART_API_KEY/)
  })

  it('heartbeat URL은 선택이며 없으면 null이다', () => {
    expect(loadConfig(valid).heartbeatUrl).toBeNull()
  })

  it('heartbeat URL이 있으면 담는다', () => {
    expect(loadConfig({ ...valid, HEARTBEAT_URL: 'https://hc.test/x' }).heartbeatUrl)
      .toBe('https://hc.test/x')
  })
})
