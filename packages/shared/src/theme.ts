/**
 * 화면 테마 (계절·행사 스킨).
 *
 * 테마는 색·배경·캐릭터 장식 같은 "보이는 것"만 바꾼다. 게임 규칙과 판정, 리더보드에는 영향이 없다.
 * 테마의 실제 내용(색, 그림)은 apps/client/src/themes.ts 에 있다.
 *
 * 지금 쓰는 테마를 바꾸려면 아래 ACTIVE_THEME 한 줄만 고친다.
 * 나중에 관리자 화면에서 고르게 되면 서버가 이 값을 정해 내려주고, 클라이언트는 받은 값으로 applyTheme() 을 부르기만 하면 된다
 * (그래서 서버와 클라이언트가 함께 쓰는 이곳에 둔다).
 */
export const THEME_IDS = ['default', 'christmas'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

/** 지금 쓰는 테마 (개발자 토글). 'default' 로 돌리면 원래 화면이다 */
export const ACTIVE_THEME: ThemeId = 'christmas';

/** 밖에서 온 값(나중에 서버나 관리자 화면에서 받을 값)이 테마 이름인지 확인한다 */
export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v);
}
