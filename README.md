# MarketRadar (마켓레이더)

> 시장을 움직이는 신호만 골라 실시간으로 알립니다.

DART 전자공시를 장중 2.5초 주기로 폴링해 주가 영향이 큰 공시만 선별·요약하여
텔레그램으로 전달하는 상주 워커.

- 설계: [`docs/superpowers/specs/2026-09-19-realtime-disclosure-alert-design.md`](docs/superpowers/specs/2026-09-19-realtime-disclosure-alert-design.md)
- 구현 계획: [`docs/superpowers/plans/2026-09-19-dart-alert-worker.md`](docs/superpowers/plans/2026-09-19-dart-alert-worker.md)
- 배포: [`docs/deploy-oci.md`](docs/deploy-oci.md)

## 개발

```bash
pnpm install
pnpm test
pnpm typecheck
```

## 고지

본 서비스는 정보 제공 목적이며 투자 권유가 아닙니다.
호재/악재 판단, 목표가, 매매 의견을 생성하지 않습니다.
