import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DT, addPlayer, buildSnapshot, pickOffer, step } from '@friday-deploy/shared';
import { cryptoRand, newWorld } from './world';

test('cryptoRand: 버퍼를 다시 채우는 경계를 넘어서도 [0,1) 범위이고 값이 반복되지 않는다', () => {
  const rand = cryptoRand();
  const seen = new Set<number>();
  for (let i = 0; i < 2000; i++) {
    const v = rand();
    assert.ok(v >= 0 && v < 1, String(v));
    seen.add(v);
  }
  assert.ok(seen.size > 1990, `서로 다른 값 ${seen.size}개`);
  // 두 생성기는 서로 다른 값을 낸다
  const other = cryptoRand();
  assert.notEqual(rand(), other());
});

test('newWorld: 판마다 스폰과 레벨업 선택지가 다르다 (예측할 수 있는 고정 시드가 아니다)', () => {
  const trace = (): string => {
    const w = newWorld();
    const p = addPlayer(w, 'a');
    const offers: string[] = [];
    for (let i = 0; i < 400; i++) {
      p.hp = 1e9;
      if (i % 40 === 0) {
        p.xp = p.xpNext;
        w.gems.push({ id: 900_000 + i, x: p.x, y: p.y, v: 1 });
      }
      if (p.offers) {
        offers.push(p.offers.join('+'));
        pickOffer(w, p.id, 0);
      }
      step(w, DT);
    }
    const snap = buildSnapshot(w, p.id)!;
    return JSON.stringify([snap.e.slice(0, 12).map((e) => [e[1], Math.round(e[2] - p.x), Math.round(e[3] - p.y)]), offers]);
  };
  const runs = new Set([trace(), trace(), trace(), trace()]);
  assert.equal(runs.size, 4);
});
