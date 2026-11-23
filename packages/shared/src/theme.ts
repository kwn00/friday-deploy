/**
 * 화면 테마 (계절·행사 스킨).
 *
 * 테마는 색·배경·캐릭터 장식 같은 "보이는 것"만 바꾼다. 게임 규칙과 판정, 리더보드에는 영향이 없다.
 * 테마의 실제 내용(색, 그림)은 apps/client/src/themes.ts 에 있다.
 *
 * 어떤 테마를 쓸지는 날짜로 정한다: 화면을 불러올 때 themeAt(Date.now()) 로 아래 THEME_SCHEDULE 에서 고른다.
 * 기간이 끝나면 배포하지 않아도 다음에 화면을 불러올 때 기본 화면으로 돌아간다 (이미 열려 있는 화면은 새로고침할 때까지 그대로).
 * 보이는 것만 바꾸므로 브라우저 시계를 그대로 믿는다 (시계가 틀린 기기는 다른 테마를 볼 뿐이다).
 *
 * 다음에 테마를 넣으려면 (예: 내년 크리스마스, 할로윈):
 *   1. 새 테마면 THEME_IDS 에 이름을 넣고 apps/client/src/themes.ts 에 한 벌을 만든다 (있는 테마를 다시 쓰면 건너뛴다)
 *   2. THEME_SCHEDULE 에 기간을 적는다. 시각은 한국 시각(+09:00)을 붙여 적고, until 은 그 시각 "전까지"다
 *   theme.test.ts 가 시각 모양, 순서, 겹침을 확인한다.
 * 나중에 관리자 화면에서 고르게 되면 서버가 테마 이름을 내려주고, 클라이언트는 받은 값으로 applyTheme() 을 부르기만 하면 된다
 * (그래서 서버와 클라이언트가 함께 쓰는 이곳에 둔다. 받은 값은 isThemeId 로 확인한다).
 */
export const THEME_IDS = ['default', 'christmas'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

/** 테마를 쓰는 기간. from 부터(없으면 처음부터) until 전까지. 시각은 ISO 8601 에 시간대를 붙여 적는다 ('2026-12-26T00:00:00+09:00') */
export interface ThemePeriod {
  id: ThemeId;
  from?: string;
  until: string;
}

/** 테마 일정 (시간 순서). 어느 기간에도 들지 않으면 기본 테마 */
export const THEME_SCHEDULE: readonly ThemePeriod[] = [
  // 크리스마스: 12월 26일 0시(한국 시각)가 되면 기본 화면으로 돌아간다
  { id: 'christmas', until: '2026-12-26T00:00:00+09:00' },
];

/** ms(Date.now() 같은 밀리초 시각)에 쓸 테마. 시계 값이 이상하면(NaN 등) 기본 */
export function themeAt(ms: number, schedule: readonly ThemePeriod[] = THEME_SCHEDULE): ThemeId {
  for (const p of schedule) {
    if ((p.from === undefined || ms >= Date.parse(p.from)) && ms < Date.parse(p.until)) return p.id;
  }
  return 'default';
}

/** 밖에서 온 값(나중에 서버나 관리자 화면에서 받을 값)이 테마 이름인지 확인한다 */
export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v);
}
