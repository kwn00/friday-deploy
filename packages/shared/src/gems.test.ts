import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DT, MAX_GEMS, addPlayer, buildSnapshot, createWorld, decodeSnapshot, encodeSnapshot, pickOffer, step, type Enemy, type World } from './index';
import { damage } from './combat';

const bug = (id: number, x: number, y: number): Enemy => ({ id, type: 'bug', x, y, hp: 1, spd: 1, frozen: 0, kbTaken: 0, resFreeze: 0, kbTime: 0, kbMult: 0, vx: 0, vy: 0, life: 0, hit: false });
/** 땅에 경험치를 MAX_GEMS 개 깐다: (x, y) 에서 오른쪽으로 1px 씩 (마지막 것이 가장 멀다) */
function fill(w: World, x: number, y: number): void {
  for (let i = 0; i < MAX_GEMS; i++) w.gems.push({ id: 100_000 + i, x: x + i, y, v: 1 });
}
const total = (w: World): number => w.gems.reduce((n, g) => n + g.v, 0);

test('경험치: 땅에 가득해도 잡은 자리에 떨어지고, 가장 먼 것을 합쳐 총량과 개수가 그대로다', () => {
  const w = createWorld(1);
  const p = addPlayer(w, 'a');
  fill(w, p.x + 5000, p.y);
  damage(w, bug(1, p.x + 50, p.y), 10, p);
  assert.equal(w.gems.length, MAX_GEMS);
  assert.equal(total(w), MAX_GEMS + 1);
  const g = w.gems.at(-1)!;
  assert.deepEqual([g.x, g.y, g.v], [p.x + 50, p.y, 2], '버그(1) + 가장 먼 경험치(1)');
  assert.ok(!w.gems.some((x) => x.id === 100_000 + MAX_GEMS - 1), '가장 먼 것이 없어졌다');
});

test('경험치: 끌려오는 중인 경험치는 아무리 멀어도 없애지 않는다', () => {
  const w = createWorld(2);
  const p = addPlayer(w, 'a');
  fill(w, p.x + 5000, p.y);
  const farthest = w.gems.at(-1)!;
  farthest.to = p.id;
  damage(w, bug(1, p.x + 50, p.y), 10, p);
  assert.ok(w.gems.includes(farthest));
  assert.ok(!w.gems.some((x) => x.id === 100_000 + MAX_GEMS - 2), '그다음으로 먼 것이 없어진다');
});

test('경험치: 함께 하는 판에서는 살아 있는 모두에게서 먼 것을 고른다 (쓰러진 사람은 세지 않는다)', () => {
  const w = createWorld(3);
  const a = addPlayer(w, 'a');
  const b = addPlayer(w, 'b');
  fill(w, a.x + 5000, a.y);
  // b 는 가장 먼 쪽 끝에 서 있다: 그 근처 경험치는 b 에게 가깝다
  b.x = a.x + 5000 + MAX_GEMS;
  b.y = a.y;
  damage(w, bug(1, a.x + 50, a.y), 10, a);
  assert.ok(w.gems.some((x) => x.id === 100_000 + MAX_GEMS - 1), 'b 바로 옆의 것은 남는다');
  b.alive = false;
  damage(w, bug(2, a.x + 60, a.y), 10, a);
  assert.ok(!w.gems.some((x) => x.id === 100_000 + MAX_GEMS - 1), 'b 가 쓰러지면 a 에게서 가장 먼 것이 없어진다');
});

test('보스 체력바: 서버가 보스의 남은 비율(올림)만 보내고, 이진 스냅샷을 거쳐도 같다. 쓰러뜨릴 수 없는 적과 졸개는 빠진다', () => {
  const w = createWorld(5);
  const p = addPlayer(w, 'a');
  const base = { spd: 1, frozen: 0, kbTaken: 0, resFreeze: 0, kbTime: 0, kbMult: 0, vx: 0, vy: 0, life: 0, hit: false };
  w.enemies.push({ ...base, id: 901, type: 'boss_bug', x: p.x + 50, y: p.y, hp: 33.2, maxHp: 100 });
  w.enemies.push({ ...base, id: 902, type: 'monolith', x: p.x - 50, y: p.y, hp: 0.01, maxHp: 500 });
  w.enemies.push({ ...base, id: 903, type: 'monday', x: p.x, y: p.y + 50, hp: 655350, maxHp: 655350 });
  w.enemies.push({ ...base, id: 904, type: 'bug', x: p.x, y: p.y - 50, hp: 1, maxHp: 1 });
  const snap = buildSnapshot(w, p.id)!;
  assert.deepEqual(snap.b, [[901, 34], [902, 1]]);
  assert.deepEqual(decodeSnapshot(encodeSnapshot(snap)).b, snap.b);
});

test('보스 체력바: 나타날 때의 체력을 기억한다 (레벨에 따라 커진 체력이 기준)', () => {
  const w = createWorld(6);
  const p = addPlayer(w, 'a');
  p.level = 12;
  for (let i = 0; i < 20 * 60 * 2 && !w.enemies.some((e) => e.type === 'boss_bug'); i++) {
    p.hp = 1e9;
    step(w, DT);
    if (p.offers) pickOffer(w, p.id, 0);
  }
  const boss = w.enemies.find((e) => e.type === 'boss_bug');
  assert.ok(boss, '1분에 왕버그가 나온다');
  assert.ok(boss!.maxHp! >= 50 * 12, `${boss!.maxHp}`);
});
