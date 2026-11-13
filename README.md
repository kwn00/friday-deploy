# Friday Deploy (금요일 배포)

> 금요일 저녁 배포에서 살아남기

개발자 컨셉의 픽셀아트 서바이버(로그라이트 호드 서바이벌) 웹 게임.
버그·NullPointerException·Merge Conflict·레거시 코드가 몰려오는 금요일 저녁, `console.log()` 하나 들고 살아남으세요.

- **장르**: 자동 공격 서바이버 (이동만 조작, 레벨업 시 3택 1)
- **플랫폼**: 웹 (모바일 퍼스트, 적응형 캔버스 + 반응형 UI)
- **멀티**: 서버 권위 구조. 현재 솔로 + 최대 4인 co-op 방(β) 뼈대 포함
- **아트**: 외부 이미지 없이 코드로 구운 픽셀 스프라이트

## 컨셉

| 구분 | 내용 |
| --- | --- |
| 플레이어 | 후드티 + 헤드폰 + 노트북의 온콜 개발자 |
| 적 | 🐞 버그 · 👻 NullPointerException · 🔀 Merge Conflict · 💧 Memory Leak · 🖥️ 레거시 코드(보스) |
| 무기 | `console.log()` · 🦆 러버덕 · 🔣 정규표현식 · 🤖 AI 에이전트(15% 확률로 할루시네이션) |
| 패시브 | ☕ 아이스 아메리카노 · ⌨️ 기계식 키보드 · 📋 Stack Overflow · 📦 npm install · 🌙 다크 모드 |
| 경험치 | 초록색 커밋 조각. 다 모으면 **PR Merged!** (레벨업) |
| 게임오버 | `Segmentation fault (core dumped)` |

콘텐츠는 전부 `packages/shared/src/content.ts` 한 파일에 데이터로 정의되어 있어 쉽게 추가할 수 있습니다.

## 구조

```
packages/shared   프로토콜 · 메시지 검증 · 콘텐츠 정의 · 결정론적 시뮬레이션 (서버/클라 공용)
apps/server       Node + ws. 권위 서버: 게임 루프, 방(Room), 세션, 레이트리밋, 정적 파일 서빙
apps/client       Vite + TypeScript + Canvas 2D. 입력 전송과 렌더링만 담당
docs/SECURITY.md  치팅 방지 설계와 위협 모델
```

```
[Client]  입력 의도(dx, dy / 선택지 번호)  ──▶  [Server] 검증 → 시뮬레이션(20Hz)
[Client]  ◀── 내 시야 범위의 스냅샷 ──────────  [Server] 결과 계산 + 서명
```

## 실행

```bash
npm install
npm run dev        # 서버(8787) + 클라이언트(5173) 동시 실행
```

```bash
npm run typecheck  # 타입 검사
npm test           # 프로토콜 검증 / 시뮬레이션 테스트
```

프로덕션 (서버 한 프로세스가 API · WebSocket · 정적 파일을 모두 서빙):

```bash
npm run build
SESSION_SECRET="$(openssl rand -base64 48)" npm start
```

환경 변수는 `.env.example` 참고. 프로덕션에서 `SESSION_SECRET` 이 없으면 서버가 기동을 거부합니다.

## 반응형 / 적응형

- **모바일 퍼스트 CSS**: 기본 = 세로 폰, 이후 `480 / 768 / 1024 / 1440px` 브레이크포인트로 확장 (`apps/client/src/style.css`)
- **가로 폰 전용 레이아웃**: `orientation: landscape and max-height: 480px`
- **입력 장치 기준 분기**: 화면 크기가 아니라 `hover` / `pointer` 미디어 쿼리로 터치·키보드 안내 전환
- **적응형 캔버스**: 기기 해상도에 맞춰 논리 해상도를 정수 배율로 계산 → 어떤 화면에서도 픽셀이 뭉개지지 않음
- 노치 대응(`safe-area-inset`), `100dvh`, 48px 터치 타깃, `prefers-reduced-motion`

## 보안 (요약)

클라이언트는 **아무것도 결정하지 않습니다.** 자세한 내용은 [docs/SECURITY.md](docs/SECURITY.md).

- 서버 권위 시뮬레이션: 위치·체력·경험치·드롭·점수 전부 서버 계산
- 클라이언트 메시지는 4종뿐이며 전부 스키마/범위 검증, 위반 누적 시 차단
- 서버 발급 HMAC 세션 토큰(단기·1회용), Origin 검사, 연결/메시지 레이트리밋, 프레임 크기 제한
- 시야 밖 정보는 전송하지 않음(맵핵 방지), RNG 시드 비공개
- 게임 결과는 서버가 서명 → 추후 리더보드는 서명된 결과만 수용
- CSP 등 보안 헤더, DOM 은 `textContent` 만 사용(XSS 차단)

## 로드맵

- [ ] 로비/방 코드, 친구 초대, 재접속
- [ ] 계정 연동(OAuth) 및 서명된 결과 기반 리더보드
- [ ] 클라이언트 예측 + 바이너리 스냅샷(델타 압축)
- [ ] 콘텐츠 확장: 무기 진화(예: 러버덕 + Stack Overflow), 스테이지, 사운드
- [ ] 픽셀 폰트 내장, PWA
