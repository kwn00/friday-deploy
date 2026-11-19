import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENEMIES, ENEMY_IDS, FIELD_ITEM_KINDS, SHOT_KINDS } from '@friday-deploy/shared';
import { DEV_A, DEV_B, ENEMY_ART, GEM_ART, ITEM_ART, MISC_ART, PAL, SHOT_ART } from './art';

const all: [string, readonly string[]][] = [
  ['DEV_A', DEV_A],
  ['DEV_B', DEV_B],
  ...Object.entries(ENEMY_ART).map(([k, v]): [string, string[]] => [`enemy ${k}`, v]),
  ...Object.entries(SHOT_ART).map(([k, v]): [string, string[]] => [`shot ${k}`, v]),
  ...Object.entries(ITEM_ART).map(([k, v]): [string, string[]] => [`item ${k}`, v]),
  ...Object.entries(MISC_ART).map(([k, v]): [string, string[]] => [k, v]),
  ...GEM_ART.map((v, i): [string, string[]] => [`gem ${i}`, v]),
];

test('art: 모든 그림은 직사각형이고 팔레트에 있는 색만 쓴다', () => {
  for (const [name, rows] of all) {
    assert.ok(rows.length > 0, name);
    const w = rows[0]!.length;
    for (const row of rows) {
      assert.equal(row.length, w, `${name}: 줄마다 폭이 같아야 한다 (${JSON.stringify(row)})`);
      for (const ch of row) assert.ok(ch === '.' || Object.hasOwn(PAL, ch), `${name}: 팔레트에 없는 글자 ${ch}`);
    }
    assert.ok(rows.some((r) => /[^.]/.test(r)), `${name}: 비어 있다`);
  }
});

test('art: 적·투사체·필드 아이템은 종류마다 그림이 있다 (새 종류를 빠뜨리지 않는다)', () => {
  for (const id of ENEMY_IDS) assert.ok(ENEMY_ART[id], id);
  for (const k of SHOT_KINDS) assert.ok(SHOT_ART[k], k);
  for (const k of FIELD_ITEM_KINDS) assert.ok(ITEM_ART[k], k);
});

test('art: 적의 그림 폭은 서버의 몸 크기(반지름)와 맞는다 (보이는 크기 = 맞는 크기)', () => {
  for (const id of ENEMY_IDS) {
    const w = ENEMY_ART[id][0]!.length;
    const r = ENEMIES[id].r;
    assert.ok(w >= r * 1.6 && w <= r * 2.4, `${id}: 폭 ${w}px, 반지름 ${r}px`);
  }
});
