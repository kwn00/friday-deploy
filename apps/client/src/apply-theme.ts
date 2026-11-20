/**
 * 테마를 화면에 입힌다: CSS 변수, 타이틀 문구, 브라우저 테마 색, 캔버스(렌더러).
 * 게임 중에도 다시 부를 수 있다 (나중에 서버가 테마를 바꿔 내려주면 받은 값으로 부르기만 하면 된다).
 */
import { ACTIVE_THEME, type ThemeId } from '@friday-deploy/shared';
import { THEMES, type Theme, type UiToken } from './themes';

/** 테마가 바뀔 때 함께 바꿔야 하는 것 (렌더러 등) */
export interface ThemeTarget {
  setTheme(theme: Theme): void;
}

let current: Theme = THEMES[ACTIVE_THEME];

export function currentTheme(): Theme {
  return current;
}

export function applyTheme(id: ThemeId, targets: readonly ThemeTarget[] = []): Theme {
  const theme = THEMES[id];
  current = theme;
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  for (const [key, value] of Object.entries(theme.ui) as [UiToken, string][]) root.style.setProperty(`--${key}`, value);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.ui.bg);
  const tagline = document.getElementById('tagline-text');
  if (tagline) tagline.textContent = theme.tagline;
  for (const t of targets) t.setTheme(theme);
  return theme;
}
