import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chestText, parseChest } from './chest';

test('chest: 서버가 보낸 보물상자 메시지는 모양이 맞을 때만 받는다', () => {
  assert.deepEqual(parseChest({ t: 'chest', items: ['console_log', 'rubber_duck'], heal: 0 }), { t: 'chest', items: ['console_log', 'rubber_duck'], heal: 0 });
  assert.deepEqual(parseChest({ t: 'chest', items: [], heal: 30 }), { t: 'chest', items: [], heal: 30 });
  // 모르는 강화, 너무 많은 개수, 이상한 회복량, 빠진 필드
  assert.equal(parseChest({ t: 'chest', items: ['nope'], heal: 0 }), null);
  assert.equal(parseChest({ t: 'chest', items: ['__proto__'], heal: 0 }), null);
  assert.equal(parseChest({ t: 'chest', items: Array(6).fill('coffee'), heal: 0 }), null);
  assert.equal(parseChest({ t: 'chest', items: [], heal: -1 }), null);
  assert.equal(parseChest({ t: 'chest', items: [], heal: Number.NaN }), null);
  assert.equal(parseChest({ t: 'chest', items: [], heal: '30' }), null);
  assert.equal(parseChest({ t: 'chest', items: 'coffee', heal: 0 }), null);
  assert.equal(parseChest({ t: 'chest', heal: 0 }), null);
  assert.equal(parseChest(null), null);
  assert.equal(parseChest({ t: 'snap', items: [], heal: 0 }), null);
});

test('chest: 알림 문구는 오른 것을 묶어서 보여 주고, 올릴 것이 없으면 찬 체력을 말한다', () => {
  assert.equal(chestText(['console_log', 'rubber_duck'], 0), '🎁 보물상자: console.log() +1, 러버덕 +1');
  assert.equal(chestText(['rubber_duck', 'coffee', 'rubber_duck'], 0), '🎁 보물상자: 러버덕 +2, 아이스 아메리카노 +1');
  assert.equal(chestText([], 30), '🎁 보물상자: 체력 +30');
  assert.equal(chestText(['coffee'], 29.6), '🎁 보물상자: 아이스 아메리카노 +1, 체력 +30');
  assert.equal(chestText([], 0), '🎁 보물상자: 더 올릴 것이 없어요');
});
