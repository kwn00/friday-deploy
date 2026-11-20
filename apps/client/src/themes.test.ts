import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ACTIVE_THEME, GAME_TAGLINE, THEME_IDS, isThemeId } from '@friday-deploy/shared';
import { DEV_A, DEV_B, PAL } from './art';
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

test('theme: 캐릭터 그림은 폭이 같고, 팔레트에 있는 색만 쓰고, 몸은 기본 그림과 같은 자리에 있다 (보이는 몸 = 맞는 몸)', () => {
  for (const t of ALL_THEMES) {
    for (const [f, rows] of t.dev.entries()) {
      const extra = rows.length - DEV_A.length;
      assert.ok(extra >= 0 && extra % 2 === 0, `${t.id}: 위로 솟은 만큼 아래에 빈 줄을 붙여 가운데를 맞춘다 (${rows.length}줄)`);
      const rise = extra / 2;
      for (const row of rows) {
        assert.equal(row.length, DEV_A[0]!.length, `${t.id}: ${row}`);
        for (const ch of row) assert.ok(ch === '.' || Object.hasOwn(PAL, ch), `${t.id}: 팔레트에 없는 글자 ${ch}`);
      }
      for (const row of rows.slice(rows.length - rise)) assert.match(row, /^\.+$/, `${t.id}: 아래에 붙인 줄은 비어 있다`);
      // 다리·몸통(아래 절반)은 기본 그림과 같다: 장식은 위쪽만 바꾼다
      const base = f === 0 ? DEV_A : DEV_B;
      const half = Math.floor(base.length / 2);
      assert.deepEqual(rows.slice(rise + half, rise + base.length), base.slice(half), `${t.id}: 몸 아래 절반`);
    }
  }
});

test('theme: 크리스마스 산타 모자는 머리 위로 솟는다', () => {
  assert.ok(THEMES.christmas.dev[0].length > DEV_A.length);
});

test('theme: 내리는 것은 너무 많지 않다 (화면 1만 픽셀당 3개 이하, 속도는 낮은 값이 먼저)', () => {
  for (const t of ALL_THEMES) {
    if (!t.weather) continue;
    assert.ok(t.weather.density > 0 && t.weather.density <= 3, t.id);
    assert.ok(t.weather.speed[0] > 0 && t.weather.speed[0] <= t.weather.speed[1], t.id);
    assert.ok(t.weather.colors.length > 0, t.id);
  }
});
