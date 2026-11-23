import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THEME_SCHEDULE, isThemeId, themeAt, type ThemePeriod } from './index';

const at = (iso: string): number => Date.parse(iso);

test('테마 일정: 크리스마스는 2026-12-26 0시(한국 시각) 전까지, 그 뒤는 기본', () => {
  assert.equal(themeAt(at('2026-11-23T12:00:00+09:00')), 'christmas');
  assert.equal(themeAt(at('2026-12-25T23:59:59+09:00')), 'christmas');
  assert.equal(themeAt(at('2026-12-25T23:59:59.999+09:00')), 'christmas');
  assert.equal(themeAt(at('2026-12-26T00:00:00+09:00')), 'default');
  // 같은 순간을 다른 시간대로 적어도 같다 (한국 0시 = 협정 세계시 전날 15시)
  assert.equal(themeAt(at('2026-12-25T14:59:59Z')), 'christmas');
  assert.equal(themeAt(at('2026-12-25T15:00:00Z')), 'default');
  assert.equal(themeAt(at('2026-12-27T12:00:00+09:00')), 'default');
  assert.equal(themeAt(at('2027-06-01T00:00:00+09:00')), 'default');
});

test('테마 일정: 시계 값이 이상하면 기본', () => {
  assert.equal(themeAt(Number.NaN), 'default');
  assert.equal(themeAt(Number.POSITIVE_INFINITY), 'default');
});

test('테마 일정: from 이 있으면 그 시각부터, 기간 밖은 기본, 앞의 기간이 먼저', () => {
  const schedule: ThemePeriod[] = [
    { id: 'christmas', from: '2027-12-01T00:00:00+09:00', until: '2027-12-26T00:00:00+09:00' },
  ];
  assert.equal(themeAt(at('2027-11-30T23:59:59+09:00'), schedule), 'default');
  assert.equal(themeAt(at('2027-12-01T00:00:00+09:00'), schedule), 'christmas');
  assert.equal(themeAt(at('2027-12-26T00:00:00+09:00'), schedule), 'default');
  assert.equal(themeAt(at('2027-12-10T00:00:00+09:00'), []), 'default');
});

test('테마 일정: 시각은 시간대까지 적었고, 시간 순서이며 겹치지 않는다', () => {
  let prevUntil = -Infinity;
  for (const p of THEME_SCHEDULE) {
    assert.ok(isThemeId(p.id), p.id);
    for (const t of [p.from, p.until]) {
      if (t === undefined) continue;
      // 시간대가 없으면 기기의 시간대로 읽혀 나라마다 바뀌는 시각이 달라진다
      assert.match(t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/, `${p.id}: ${t}`);
      assert.ok(Number.isFinite(at(t)), `${p.id}: ${t}`);
    }
    const from = p.from === undefined ? -Infinity : at(p.from);
    assert.ok(from < at(p.until), `${p.id}: from 이 until 보다 앞`);
    assert.ok(from >= prevUntil, `${p.id}: 앞 기간과 겹친다`);
    prevUntil = at(p.until);
  }
});
