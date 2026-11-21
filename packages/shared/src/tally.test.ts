import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DT, OFFER_TIMEOUT, addPlayer, createWorld, newTally, pickOffer, step, type Player, type UpgradeId, type World } from './index';

/** 적이 나오지 않고 무기도 쏘지 않는 월드 (레벨업은 경험치를 직접 놓아서 일으킨다) */
function quiet(seed: number): { w: World; p: Player } {
  const w = createWorld(seed);
  const p = addPlayer(w, 'a');
  p.cd.console_log = 1e9;
  w.itemCd = 1e9;
  return { w, p };
}
function still(w: World): void {
  w.wave = Math.floor((w.time + DT) / 60);
  w.spawnCd = 1e9;
  step(w, DT);
}
/** 발밑에 다음 레벨까지의 경험치를 놓고 한 틱: 선택지가 뜬다 */
function levelUpNow(w: World, p: Player): UpgradeId[] {
  w.gems.push({ id: w.nextId++, x: p.x, y: p.y, v: p.xpNext - p.xp });
  still(w);
  assert.ok(p.offers, '선택지가 떴다');
  return [...p.offers];
}
const sum = (m: Partial<Record<UpgradeId, number>>): number => Object.values(m).reduce((a, b) => a + (b ?? 0), 0);

test('아이템 통계 횟수: 새 캐릭터는 아무것도 세지 않았다', () => {
  const { p } = quiet(1);
  assert.deepEqual(p.tally, newTally());
});

test('아이템 통계 횟수: 선택지에 나온 것, 직접 고른 것, 시간이 지나 자동으로 골라진 것을 따로 센다 (서버가 센다)', () => {
  const { w, p } = quiet(2);
  const first = levelUpNow(w, p);
  for (const id of first) assert.equal(p.tally.offered[id], 1, `${id} 가 선택지에 한 번 나왔다`);
  assert.equal(sum(p.tally.offered), first.length);
  assert.ok(pickOffer(w, p.id, 1));
  assert.deepEqual(p.tally.picked, { [first[1]!]: 1 }, '두 번째 것을 직접 골랐다');
  assert.deepEqual(p.tally.auto, {});

  // 잘못된 선택(없는 번호)은 세지 않는다
  const second = levelUpNow(w, p);
  assert.equal(pickOffer(w, p.id, 99), false);
  assert.equal(sum(p.tally.picked), 1);
  // 고르지 않고 시간이 지나면 서버가 첫 번째 것을 대신 고른다: 자동으로 센다
  for (let i = 0; i < Math.ceil(OFFER_TIMEOUT / DT) + 2 && p.offers; i++) still(w);
  assert.equal(p.offers, null, '시간이 지나 골라졌다');
  assert.deepEqual(p.tally.auto, { [second[0]!]: 1 });
  assert.equal(sum(p.tally.picked), 1, '자동 선택은 직접 고른 것에 들어가지 않는다');
  assert.equal(sum(p.tally.offered), first.length + second.length);
});

test('아이템 통계 횟수: 보물상자로 오른 것을 센다', () => {
  const { w, p } = quiet(3);
  p.up = { console_log: 1, regex: 1 };
  w.items.push({ id: w.nextId++, kind: 'chest', x: p.x + 3, y: p.y, ttl: Infinity, chest: [1, 0, 0, 0] });
  w.events.length = 0;
  still(w);
  const ev = w.events.find((e) => e.type === 'chest');
  assert.ok(ev && ev.type === 'chest' && ev.items.length === 1, '상자가 열려 하나가 올랐다');
  assert.deepEqual(p.tally.chest, { [ev.items[0]!]: 1 });
  assert.equal(sum(p.tally.offered), 0, '상자는 선택지가 아니다');
});
