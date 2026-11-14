import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sharesOf } from './shares';

test('기여도: 개인별 처치 수를 %로 바꾸고 합은 항상 100 이다', () => {
  assert.deepEqual(sharesOf([45, 27], 2), [63, 37]); // 62.5 / 37.5 → 소수점이 같으면 앞사람부터 올림
  assert.deepEqual(sharesOf([1, 1, 1], 3), [34, 33, 33]);
  assert.deepEqual(sharesOf([10, 0], 2), [100, 0]);
  assert.deepEqual(sharesOf([7, 5, 3, 1], 4), [44, 31, 19, 6]);
  for (const ks of [[3, 3, 3, 3, 3, 3, 3], [999, 1, 1], [1, 2, 3, 4, 5, 6, 7, 8], [123456, 654321, 111]]) {
    const shares = sharesOf(ks, ks.length)!;
    assert.equal(shares.reduce((a, b) => a + b, 0), 100, JSON.stringify(shares));
    assert.ok(shares.every((v) => Number.isInteger(v) && v >= 0 && v <= 100));
  }
});

test('기여도: 보여줄 것이 없으면 null (혼자 한 판, 예전 기록, 개수 불일치, 처치 0)', () => {
  assert.equal(sharesOf([12], 1), null);
  assert.equal(sharesOf(undefined, 2), null);
  assert.equal(sharesOf([5, 5, 5], 2), null);
  assert.equal(sharesOf([0, 0], 2), null);
});
