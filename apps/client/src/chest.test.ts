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
  // 항목 안의 띄어쓰기는 줄이 바뀌지 않는 공백이다 (아래 검사)
  const text = (items: Parameters<typeof chestText>[0], heal: number): string => chestText(items, heal).replace(/\u00a0/g, ' ');
  assert.equal(text(['console_log', 'rubber_duck'], 0), '🎁 보물상자: console.log() +1, 러버덕 +1');
  assert.equal(text(['rubber_duck', 'coffee', 'rubber_duck'], 0), '🎁 보물상자: 러버덕 +2, 아이스 아메리카노 +1');
  assert.equal(text([], 30), '🎁 보물상자: 체력 +30');
  assert.equal(text(['coffee'], 29.6), '🎁 보물상자: 아이스 아메리카노 +1, 체력 +30');
  assert.equal(text([], 0), '🎁 보물상자: 더 올릴 것이 없어요');
  // 진화한 것은 앞에 따로 알린다
  assert.equal(text(['rubber_duck', 'debugger'], 0), '🎁 보물상자: ✨ 디버거 진화!, 러버덕 +1');
  assert.equal(text(['friday_deploy', 'monitoring', 'coffee', 'coffee', 'regex'], 0), '🎁 보물상자: ✨ 금요일 배포 진화!, ✨ 24시간 모니터링 진화!, 아이스 아메리카노 +2, 정규표현식 +1');
  assert.deepEqual(parseChest({ t: 'chest', items: ['debugger'], heal: 0 }), { t: 'chest', items: ['debugger'], heal: 0 }, '진화한 무기도 아는 강화다');
});

test('chest: 좁은 화면에서는 쉼표 뒤에서만 줄이 바뀐다 (한 항목이 두 줄로 갈라지지 않는다)', () => {
  const t = chestText(['dual_monitor', 'two_factor'], 0);
  // 줄이 바뀔 수 있는 보통 공백은 머리말 뒤와 쉼표 뒤뿐이다
  assert.deepEqual(t.split(' '), ['🎁', '보물상자:', '듀얼\u00a0모니터\u00a0+1,', '2단계\u00a0인증\u00a0+1']);
});
