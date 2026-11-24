import assert from 'node:assert/strict';
import { test } from 'node:test';
import { magnetText, refillText } from './alerts';

test('alerts: 자석 알림은 끌려오는 경험치 수를 말하고, 모양이 이상한 숫자는 쓰지 않는다', () => {
  assert.equal(magnetText(37), '🧲 자석! 경험치 37개가 끌려와요');
  assert.equal(magnetText(0), '🧲 자석! 지금은 끌려올 경험치가 없어요');
  for (const bad of [-1, 1.5, Number.NaN, Infinity, 1e9, '37', null, undefined, {}]) {
    assert.equal(magnetText(bad), '🧲 자석! 맵의 경험치가 모두 끌려와요', String(bad));
  }
});

test('alerts: 체력 채우기 알림은 찬 양을 덧붙이고, 모양이 이상한 숫자는 쓰지 않는다', () => {
  assert.equal(refillText(42), '❤️ 레벨 업! 체력을 가득 채웠어요 (+42)');
  for (const bad of [0, -3, 2.5, Number.NaN, '42', null, undefined]) assert.equal(refillText(bad), '❤️ 레벨 업! 체력을 가득 채웠어요', String(bad));
});
