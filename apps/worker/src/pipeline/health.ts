export type Heartbeat = { ping(): Promise<void> }

export type HeartbeatConfig = {
  url: string | null
  fetchImpl?: typeof fetch
}

/**
 * 외부 감시 서비스에 생존 신호를 보낸다.
 * 반드시 워커 외부의 서비스를 가리켜야 한다 — 같은 VM에 두면 VM이 죽을 때 감시도 같이 죽는다.
 */
export function createHeartbeat(cfg: HeartbeatConfig): Heartbeat {
  const doFetch = cfg.fetchImpl ?? fetch
  return {
    async ping(): Promise<void> {
      if (!cfg.url) return
      try {
        await doFetch(cfg.url)
      } catch {
        // 감시 서비스 장애가 워커를 멈추게 해서는 안 된다
      }
    },
  }
}
