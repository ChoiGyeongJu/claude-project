import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DART_API_KEY: z.string().length(40, 'DART_API_KEY는 40자여야 합니다'),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  LLM_ENDPOINT: z.string().default('https://api.anthropic.com/v1/messages'),
  HEARTBEAT_URL: z.string().optional(),
})

export type Config = {
  databaseUrl: string
  dartApiKey: string
  telegram: { token: string; chatId: string }
  llm: { apiKey: string; model: string; endpoint: string }
  heartbeatUrl: string | null
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.parse(env)
  return {
    databaseUrl: parsed.DATABASE_URL,
    dartApiKey: parsed.DART_API_KEY,
    telegram: { token: parsed.TELEGRAM_BOT_TOKEN, chatId: parsed.TELEGRAM_CHAT_ID },
    llm: { apiKey: parsed.LLM_API_KEY, model: parsed.LLM_MODEL, endpoint: parsed.LLM_ENDPOINT },
    heartbeatUrl: parsed.HEARTBEAT_URL ?? null,
  }
}
