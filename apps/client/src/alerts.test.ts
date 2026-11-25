import assert from 'node:assert/strict';
import { test } from 'node:test';
import { magnetPeerText, magnetText, noticeRank, refillText } from './alerts';

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

test('alerts: 동료가 자석을 주우면 이름을 정제해서 알리고, 이름을 모르면 동료라고 한다', () => {
  assert.equal(magnetPeerText('kim'), '🧲 kim 님이 자석을 주웠어요! 경험치가 모두 그쪽으로 끌려가요');
  assert.equal(magnetPeerText('<b>x</b>'), '🧲 bxb 님이 자석을 주웠어요! 경험치가 모두 그쪽으로 끌려가요', '모양을 다시 거른다');
  for (const bad of [undefined, null, 3, '']) assert.equal(magnetPeerText(bad), '🧲 동료가 자석을 주웠어요! 경험치가 모두 그쪽으로 끌려가요', String(bad));
});

test('alerts: 한꺼번에 놓이면 보물상자 > 백업 > 자석 > LGTM > 피자 순으로 먼저 알린다 (놓일 때의 비중과 상관없이)', () => {
  const kinds = ['heal', 'levelup', 'magnet', 'revive', 'chest'] as const;
  assert.deepEqual([...kinds].sort((a, b) => noticeRank(a) - noticeRank(b)), ['chest', 'revive', 'magnet', 'levelup', 'heal']);
});
