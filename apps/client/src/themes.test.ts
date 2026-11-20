import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ACTIVE_THEME, GAME_TAGLINE, THEME_IDS, isThemeId } from '@friday-deploy/shared';
import { DEV_A, PAL } from './art';
import { ALL_THEMES, THEMES, type UiToken } from './themes';

const COLOR = /^#[0-9a-f]{6}$/i;
const RGB = /^\d{1,3}, \d{1,3}, \d{1,3}$/;

test('theme: 쓰고 있는 테마가 목록에 있다', () => {
  assert.ok(isThemeId(ACTIVE_THEME));
  assert.ok(THEMES[ACTIVE_THEME]);
  assert.equal(isThemeId('nope'), false);
  assert.equal(isThemeId(1), false);
});

test('theme: 테마 이름마다 한 벌씩 있고, 이름이 맞다', () => {
  assert.deepEqual(
    ALL_THEMES.map((t) => t.id),
    [...THEME_IDS],
  );
  for (const id of THEME_IDS) assert.equal(THEMES[id].id, id);
});

test('theme: 색은 모두 #rrggbb 또는 "r, g, b" 모양이다', () => {
  for (const t of ALL_THEMES) {
    for (const [key, value] of Object.entries(t.ui)) {
      const ok = key.endsWith('-rgb') ? RGB.test(value) : COLOR.test(value);
      assert.ok(ok, `${t.id} ${key}: ${value}`);
    }
    for (const c of [t.floor.base, t.floor.tile, t.floor.dot, ...t.floor.glyphColors]) assert.match(c, COLOR, t.id);
    for (const c of t.weather?.colors ?? []) assert.match(c, COLOR, t.id);
    assert.ok(t.floor.glyphs.length > 0, t.id);
    assert.ok(t.tagline.length > 0 && t.tagline.length <= 24, `${t.id}: 타이틀 문구는 짧게`);
  }
});

test('theme: 기본 테마는 원래 문구를 쓰고, style.css 의 첫 화면 색과 같다', () => {
  assert.equal(THEMES.default.tagline, GAME_TAGLINE);
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  for (const [key, value] of Object.entries(THEMES.default.ui) as [UiToken, string][]) {
    const m = root.match(new RegExp(`--${key}:\\s*([^;]+);`));
    assert.ok(m, `style.css :root 에 --${key} 가 없다`);
    assert.equal(m[1]!.trim(), value, `--${key}`);
  }
});

test('theme: 캐릭터 그림은 기본 그림과 크기가 같고 팔레트에 있는 색만 쓴다 (보이는 크기 = 맞는 크기)', () => {
  for (const t of ALL_THEMES) {
    for (const rows of t.dev) {
      assert.equal(rows.length, DEV_A.length, t.id);
      for (const row of rows) {
        assert.equal(row.length, DEV_A[0]!.length, `${t.id}: ${row}`);
        for (const ch of row) assert.ok(ch === '.' || Object.hasOwn(PAL, ch), `${t.id}: 팔레트에 없는 글자 ${ch}`);
      }
    }
  }
});

test('theme: 내리는 것은 너무 많지 않다 (화면 1만 픽셀당 3개 이하, 속도는 낮은 값이 먼저)', () => {
  for (const t of ALL_THEMES) {
    if (!t.weather) continue;
    assert.ok(t.weather.density > 0 && t.weather.density <= 3, t.id);
    assert.ok(t.weather.speed[0] > 0 && t.weather.speed[0] <= t.weather.speed[1], t.id);
    assert.ok(t.weather.colors.length > 0, t.id);
  }
});
