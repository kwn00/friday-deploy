import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LeaderboardEntry } from '@friday-deploy/shared';
import { findMine, type MyPlace } from './mine';

const entry = (rank: number, over: Partial<LeaderboardEntry>): LeaderboardEntry => ({ rank, names: ['x'], time: 100, kills: 10, level: 3, at: 1, ...over });

test('내 기록 찾기: 함께 한 판은 팀 합계가 아니라 내 이름 자리의 처치 수로 찾는다', () => {
  const entries = [
    entry(1, { names: ['다른팀', '사람'], killsBy: [30, 20], kills: 50, time: 90 }),
    entry(2, { names: ['호스트', '게스트'], killsBy: [27, 24], kills: 51, time: 31, level: 2 }),
    entry(3, { names: ['호스트', '게스트'], killsBy: [9, 3], kills: 12, time: 31 }),
  ];
  const guest: MyPlace = { board: 'coop', rank: 2, name: '게스트', time: 31, kills: 24, level: 1 };
  assert.equal(findMine(entries, guest), 2, '내 레벨·처치 수는 팀의 값과 다르지만 내 줄을 찾는다');
  assert.equal(findMine(entries, { ...guest, name: '호스트', kills: 27, level: 2 }), 2);
  // 시작 직후에 들어와 내 시간이 판 전체보다 몇 초 짧아도 찾는다. 너무 차이 나면 다른 판이다.
  assert.equal(findMine(entries, { ...guest, time: 28 }), 2);
  assert.equal(findMine(entries, { ...guest, time: 20 }), -1);
  // 이름이나 처치 수가 다르면 내 기록이 아니다
  assert.equal(findMine(entries, { ...guest, name: '남' }), -1);
  assert.equal(findMine(entries, { ...guest, kills: 25 }), -1);
});

test('내 기록 찾기: 혼자 한 판, 순위가 밀린 경우, 같은 값이 여럿인 경우, 예전 방식의 기록', () => {
  const entries = [
    entry(1, { names: ['dev'], killsBy: [40], kills: 40, time: 120 }),
    entry(2, { names: ['dev'], killsBy: [10], kills: 10, time: 100 }),
    entry(3, { names: ['dev'], killsBy: [10], kills: 10, time: 100 }),
    entry(4, { names: ['old'], kills: 7, time: 80, level: 2 }),
  ];
  const mine: MyPlace = { board: 'solo', rank: 3, name: 'dev', time: 100, kills: 10, level: 3 };
  assert.equal(findMine(entries, mine), 3, '같은 값이 둘이면 알려준 순위에 가까운 것');
  assert.equal(findMine(entries, { ...mine, rank: 1 }), 2, '그 사이 순위가 밀렸어도 내용으로 찾는다');
  assert.equal(findMine(entries, { ...mine, name: 'old', time: 80, kills: 7, level: 2, rank: 4 }), 4, '개인별 값이 없는 기록은 시간·처치 수·레벨로');
  assert.equal(findMine(entries, { ...mine, name: 'old', time: 80, kills: 7, level: 9, rank: 4 }), -1);
  assert.equal(findMine([], mine), -1);
});
