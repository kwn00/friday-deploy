import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DT,
  ENEMY_VIEW_RADIUS,
  EVOLUTIONS,
  MAX_GEMS,
  PASSIVE_IDS,
  SHOT_KINDS,
  UPGRADES,
  UPGRADE_IDS,
  WEAPON_IDS,
  WEAPON_SLOTS,
  ZONE_KINDS,
  addPlayer,
  buildSnapshot,
  createWorld,
  decodeSnapshot,
  encodeSnapshot,
  evolutionOf,
  evolutionsUsing,
  evolvedAway,
  isWeapon,
  ownedUpgrades,
  pickOffer,
  readyEvolutions,
  removePlayer,
  step,
  xpForLevel,
  upgradesOf,
  type ChestOdds,
  type Enemy,
  type Player,
  type UpgradeId,
  type World,
} from './index';
import { BREAKPOINT_FREEZE } from './combat';

const enemy = (id: number, x: number, y: number, type: Enemy['type'] = 'merge_conflict', hp = 1e9): Enemy => ({ id, type, x, y, hp, spd: 1, frozen: 0, kbTaken: 0, resFreeze: 0, kbTime: 0, kbMult: 0, vx: 0, vy: 0, life: 0, hit: false });

/** 아무것도 저절로 생기지 않는 월드 (스폰·아이템·레벨업이 끼어들지 않게) */
function quietWorld(seed: number): { w: World; p: Player } {
  const w = createWorld(seed);
  const p = addPlayer(w, 'a');
  p.xpNext = 1e9;
  w.itemCd = 1e9;
  noSpawn(w);
  return { w, p };
}
function noSpawn(w: World): void {
  w.wave = Math.floor((w.time + DT) / 60);
  w.spawnCd = 1e9;
}
/** 스폰된 적은 치우고 놓아 둔 적만 남긴 채 한 틱 */
function tick(w: World, keep: Enemy[]): void {
  w.enemies = w.enemies.filter((e) => keep.includes(e));
  for (const e of keep) if (!w.enemies.includes(e) && e.hp > 0) w.enemies.push(e);
  noSpawn(w);
  step(w, DT);
  w.enemies = w.enemies.filter((e) => keep.includes(e));
}
/** 발밑에 보물상자를 두고 연다 (odds: [기본 단계, 5개 %, 3개 %, 1개 %]) */
function openChestHere(w: World, p: Player, odds: ChestOdds = [1, 0, 0, 0]): UpgradeId[] {
  w.items.push({ id: w.nextId++, kind: 'chest', x: p.x, y: p.y, ttl: Infinity, chest: odds, born: w.tick });
  const before = w.events.length;
  tick(w, []);
  const ev = w.events.slice(before).find((e) => e.type === 'chest');
  assert.ok(ev && ev.type === 'chest', '상자가 열렸다');
  return ev.items;
}
const maxOf = (id: UpgradeId): number => UPGRADES[id].max;

test('진화 목록: 재료는 진화하지 않은 무기(최대 단계가 있는 것), 짝은 패시브, 재료가 겹치지 않는다', () => {
  assert.equal(EVOLUTIONS.length, 6);
  const used = new Set<UpgradeId>();
  for (const e of EVOLUTIONS) {
    assert.ok(isWeapon(e.id) && evolutionOf(e.id) === e, e.id);
    assert.ok(WEAPON_IDS.indexOf(e.id) >= 23, `${e.id}: 원래 무기 뒤에 붙였다 (통신 순서)`);
    assert.ok(e.from.length === 1 || e.from.length === 2, e.id);
    // 짝 패시브가 없는 것은 합치기 (무기 둘)
    assert.equal(e.with === null, e.from.length === 2, `${e.id}: 합치기는 무기 둘, 짝 패시브 없음`);
    for (const f of e.from) {
      assert.ok(isWeapon(f) && !evolutionOf(f) && maxOf(f) > 1, `${e.id}: 재료 ${f}`);
      assert.ok(!used.has(f), `${f} 는 진화 하나에만 쓰인다`);
      used.add(f);
    }
    if (e.with) assert.ok((PASSIVE_IDS as readonly string[]).includes(e.with), `${e.id}: 짝 ${e.with} 는 패시브`);
  }
  assert.deepEqual(evolutionsUsing('keep_alive').map((e) => e.id), ['websocket']);
  assert.deepEqual(evolutionsUsing('night_owl').map((e) => e.id), ['monitoring']);
  assert.deepEqual(evolutionsUsing('regex'), []);
});

test('진화 조건: 재료 무기가 모두 최대 단계이고 짝 패시브가 있어야 하며, 한 번만 진화한다', () => {
  const ready = (up: Partial<Record<UpgradeId, number>>): string[] => readyEvolutions(up).map((e) => e.id);
  assert.deepEqual(ready({ console_log: 7, test_coverage: 1 }), [], '최대 단계 전');
  assert.deepEqual(ready({ console_log: 8 }), [], '짝 패시브가 없다');
  assert.deepEqual(ready({ console_log: 8, test_coverage: 1 }), ['debugger'], '짝 패시브는 1단계면 된다');
  assert.deepEqual(ready({ debugger: 1, console_log: 8, test_coverage: 5 }), [], '이미 진화했다');
  assert.deepEqual(ready({ canary: 8, night_owl: 7 }), [], '합치기는 둘 다 최대여야');
  assert.deepEqual(ready({ canary: 8, night_owl: 8 }), ['monitoring']);
  // 여럿이면 목록 순서대로
  assert.deepEqual(ready({ broadcast: 8, multicast: 8, ping_pong: 8, keep_alive: 1 }), ['websocket', 'flooding']);
  assert.ok(evolvedAway({ debugger: 1 }, 'console_log'));
  assert.ok(!evolvedAway({ debugger: 1 }, 'test_coverage'), '짝 패시브는 그대로 남는 것');
  assert.ok(!evolvedAway({ console_log: 8 }, 'console_log'));
});

test('보물상자: 진화할 수 있으면 그 몫이 진화가 되고, 재료 무기는 칸에서 빠진다. 짝 패시브는 남는다', () => {
  const { w, p } = quietWorld(301);
  p.up = { console_log: 8, test_coverage: 2, rubber_duck: 3 };
  const items = openChestHere(w, p);
  assert.deepEqual(items, ['debugger']);
  assert.equal(p.up.debugger, 1);
  assert.equal(p.up.console_log, undefined, '재료는 빠진다');
  assert.equal(p.up.test_coverage, 2, '짝 패시브는 그대로');
  assert.equal(p.up.rubber_duck, 3, '1개짜리 상자의 몫은 진화가 차지했다');
  assert.equal(p.tally.chest.debugger, 1, '통계: 진화한 횟수');
  assert.equal(p.tally.chest.console_log, undefined);
  // 다음 상자부터는 평소처럼 (진화한 무기는 더 오르지 않는다)
  const next = openChestHere(w, p);
  assert.deepEqual(next, ['rubber_duck']);
  assert.equal(p.up.debugger, 1);
});

test('보물상자: 5개짜리 상자에서 진화와 강화가 함께, 진화할 것이 둘이면 둘 다', () => {
  const { w, p } = quietWorld(302);
  p.up = { canary: 8, night_owl: 8, hotfix: 8, prod_hotfix: 1, regex: 1 };
  const items = openChestHere(w, p, [3, 100, 0, 0]);
  assert.equal(items.length, 5);
  assert.deepEqual(items.slice(0, 2), ['friday_deploy', 'monitoring'], '진화가 먼저, 목록 순서대로');
  assert.ok(items.slice(2).every((id) => !evolutionOf(id)), '나머지는 평소처럼 오른다');
  for (const gone of ['canary', 'night_owl', 'hotfix'] as const) assert.equal(p.up[gone], undefined, gone);
  assert.deepEqual([p.up.friday_deploy, p.up.monitoring], [1, 1]);
  // 합치기로 무기 칸 하나가 빈다: 무기 4개(카나리아, 부엉이, 핫픽스, 정규표현식) → 3개(금요일 배포, 모니터링, 정규표현식)
  assert.equal(WEAPON_IDS.filter((id) => (p.up[id] ?? 0) > 0).length, 3);
});

test('레벨업 선택지: 진화한 무기와 진화해서 없어진 재료 무기는 나오지 않는다 (빈 칸이 있어도)', () => {
  const { w, p } = quietWorld(303);
  const seen = new Set<UpgradeId>();
  for (let round = 0; round < 300; round++) {
    p.up = { monitoring: 1, debugger: 1 };
    p.offers = null;
    p.xp = p.xpNext = 5;
    w.gems.push({ id: w.nextId++, x: p.x, y: p.y, v: 1 });
    tick(w, []);
    for (const id of p.offers ?? []) seen.add(id);
  }
  for (const id of [...EVOLUTIONS.map((e) => e.id), 'canary', 'night_owl', 'console_log'] as const) assert.ok(!seen.has(id), `${id} 가 선택지에 나왔다`);
  assert.ok(seen.has('broadcast') && seen.has('test_coverage'), '다른 것은 그대로 나온다');
});

test('레벨업 선택지: 진화 뒤에 남는 것을 다 올리면 선택지 대신 회복한다 (진화한 무기를 기다리며 멈추지 않는다)', () => {
  const { w, p } = quietWorld(304);
  p.up = {};
  // 진화한 무기 6개로 무기 칸이 가득, 패시브도 모두 최대
  for (const e of EVOLUTIONS) p.up[e.id] = 1;
  for (const id of PASSIVE_IDS.slice(0, 6)) p.up[id] = maxOf(id);
  assert.equal(WEAPON_IDS.filter((id) => (p.up[id] ?? 0) > 0).length, WEAPON_SLOTS);
  p.hp = 10;
  p.xp = p.xpNext = 5;
  w.gems.push({ id: w.nextId++, x: p.x, y: p.y, v: 1 });
  tick(w, []);
  assert.equal(p.offers, null);
  assert.ok(p.hp > 10);
  // 선택지를 고르는 흐름도 그대로 (가짜 선택은 받지 않는다)
  assert.equal(pickOffer(w, p.id, 0), false);
});

test('디버거: 중단점에 맞은 버그는 잠깐 멈춘다. 보스는 멈추지 않는다', () => {
  const { w, p } = quietWorld(305);
  p.up = { debugger: 1 };
  const bug = enemy(9700, p.x + 40, p.y, 'bug');
  const boss = enemy(9701, p.x - 40, p.y, 'boss_bug');
  let shots = 0;
  for (let i = 0; i < 20 && !(bug.frozen > 0); i++) {
    tick(w, [bug, boss]);
    shots = Math.max(shots, w.shots.filter((s) => s.kind === 'breakpoint').length);
  }
  assert.ok(shots > 0, '중단점을 쏜다');
  assert.ok(bug.frozen > 0 && bug.frozen <= BREAKPOINT_FREEZE, `멈춤 ${bug.frozen}`);
  // 보스는 맞는 틱마다 봐도 한 번도 멈추지 않는다 (멈춤이 풀린 뒤에만 보면 놓친다)
  let bossHits = 0;
  let bossFrozen = 0;
  for (let i = 0; i < 20 * 5; i++) {
    // 보스는 제자리에 둔다 (다가오거나 밀려나 맞는 횟수가 들쭉날쭉하지 않게)
    boss.x = p.x - 40;
    boss.y = p.y;
    const hp = boss.hp;
    tick(w, [bug, boss]);
    if (boss.hp < hp) bossHits++;
    bossFrozen = Math.max(bossFrozen, boss.frozen);
  }
  assert.ok(bossHits >= 4, `보스도 맞는다 (${bossHits}번)`);
  assert.equal(bossFrozen, 0, '보스는 멈추지 않는다');
});

test('웹소켓: keep-alive 가 있으면 공이 끊이지 않는다 (처음 쏜 뒤 20초 동안 한 틱도 비지 않는다)', () => {
  const { w, p } = quietWorld(306);
  p.up = { websocket: 1, keep_alive: 1 };
  tick(w, []);
  let fewest = Infinity;
  for (let i = 0; i < 20 * 20; i++) {
    tick(w, []);
    fewest = Math.min(fewest, w.shots.filter((s) => s.kind === 'socket').length);
  }
  assert.ok(fewest >= 4, `가장 적을 때 ${fewest}개`);
  // 공은 주인 둘레의 상자 안에서 튕긴다 (핑퐁과 같다)
  for (const s of w.shots) assert.ok(Math.abs(s.x - p.x) < 260 && Math.abs(s.y - p.y) < 200, `공 ${s.x},${s.y}`);
});

test('금요일 배포: 첫 불은 내 발밑에, 나머지는 버그들 자리에. 불은 바닥 영역(fire)으로 한 번만 보낸다', () => {
  const { w, p } = quietWorld(307);
  p.up = { friday_deploy: 1 };
  const bugs = [enemy(9710, p.x + 80, p.y), enemy(9711, p.x, p.y - 90)];
  tick(w, bugs);
  const fires = w.zones.filter((z) => z.kind === 'fire');
  assert.equal(fires.length, 5);
  assert.ok(Math.hypot(fires[0]!.x - p.x, fires[0]!.y - p.y) < 3, '첫 불은 발밑');
  for (const z of fires.slice(1)) assert.ok(bugs.some((e) => Math.hypot(z.x - e.x, z.y - e.y) < 1), '나머지는 버그 자리');
  const snap = decodeSnapshot(encodeSnapshot(buildSnapshot(w, p.id, w.tick - 1)!));
  assert.equal(snap.z.filter((z) => ZONE_KINDS[z[1]!] === 'fire').length, 5, '스냅샷에 실린다');
  for (let i = 0; i < 10; i++) tick(w, bugs);
  assert.ok(bugs.every((e) => e.hp < 1e9), '불 위의 버그가 탄다');
});

test('rm -rf node_modules: 화면을 지워도 경험치와 아이템은 언제나 남고, 화면의 경험치를 모두 나에게 끌어당긴다', () => {
  const { w, p } = quietWorld(308);
  p.up = { rm_rf: 1 };
  // git clean 이면 지우는 쪽이 나올 난수 (남길 확률보다 크다)
  w.rng = () => 0.99;
  const bugs = [enemy(9720, p.x + 100, p.y, 'bug', 10), enemy(9721, p.x - 200, p.y, 'null_ptr', 28)];
  const far = enemy(9722, p.x + ENEMY_VIEW_RADIUS + 50, p.y, 'bug', 10);
  w.gems.push({ id: 9723, x: p.x + 150, y: p.y + 60, v: 3 });
  w.gems.push({ id: 9724, x: p.x + ENEMY_VIEW_RADIUS + 80, y: p.y, v: 3 });
  w.heals.push({ id: 9725, x: p.x - 60, y: p.y });
  tick(w, [...bugs, far]);
  assert.ok(bugs.every((e) => e.hp <= 0) && far.hp > 0, '화면 안만 지운다');
  assert.equal(w.heals.length, 1, '회복 아이템은 남는다');
  const near = w.gems.filter((g) => g.id !== 9724);
  assert.ok(near.length >= 3, `처치한 것처럼 경험치가 떨어진다 (${near.length})`);
  assert.ok(near.every((g) => g.to === p.id), '화면의 경험치는 모두 나에게 끌려온다');
  assert.equal(w.gems.find((g) => g.id === 9724)!.to, undefined, '화면 밖의 것은 그대로');
  const wipe = w.zones.find((z) => z.kind === 'wipe');
  assert.equal(wipe?.aux, 1, '초록 고리로 그린다');
  // 끌려와서 먹는다
  p.xpNext = 1e9;
  for (let i = 0; i < 20 * 4; i++) tick(w, []);
  assert.ok(p.xp >= 3 + 1 + 1, `먹은 경험치 ${p.xp}`);
});

/** 함께 하는 방: a 가 rm -rf 를 쓰고, b 는 멀리서 계속 움직인다 (고르지 않으므로 월드는 멈추지 않는다) */
function coopRmRf(seed: number): { w: World; a: Player; b: Player } {
  const w = createWorld(seed);
  w.itemCd = 1e9;
  const a = addPlayer(w, 'a');
  const b = addPlayer(w, 'b');
  b.x = a.x + 3000;
  b.up = {};
  b.xpNext = 1e9;
  a.up = { rm_rf: 1, npm_install: 1 };
  return { w, a, b };
}

test('rm -rf node_modules: 함께 하는 판에서 끌려오던 경험치는 내가 레벨업을 고르는 동안 그 자리에서 기다렸다가 마저 끌려온다', () => {
  const { w, a } = coopRmRf(320);
  a.xpNext = 3;
  const bugs = Array.from({ length: 20 }, (_, k) => enemy(9900 + k, a.x + Math.cos(k) * (60 + k * 10), a.y + Math.sin(k) * (60 + k * 10), 'bug', 1));
  tick(w, bugs);
  assert.ok(bugs.every((e) => e.hp <= 0), '화면의 버그를 지웠다');
  assert.ok(w.gems.length >= 20 && w.gems.every((g) => g.to === a.id && g.hold), '모두 나에게 끌려온다');
  const total = w.gems.reduce((n, g) => n + g.v, 0);
  // 받은 경험치 = 오른 레벨마다 필요했던 양 + 지금 모은 양 (1레벨의 필요량만 3 으로 바꿔 두었다)
  const gained = (): number => {
    let n = a.xp;
    for (let l = 1; l < a.level; l++) n += l === 1 ? 3 : xpForLevel(l);
    return n;
  };
  let choosing = 0;
  let frozen: string | null = null;
  for (let i = 0; i < 20 * 8; i++) {
    tick(w, []);
    assert.ok(!w.paused, '동료가 있으니 월드는 멈추지 않는다');
    if (!a.offers) {
      frozen = null;
      continue;
    }
    // 고르는 동안: 끌려오던 것은 놓이지도, 움직이지도, 먹히지도 않는다
    const now = JSON.stringify([w.gems.map((g) => [g.id, g.x, g.y, g.to, g.hold]), gained()]);
    if (frozen !== null) assert.equal(now, frozen, '고르는 동안 그대로 기다린다');
    frozen = now;
    if (++choosing % 20 === 0) pickOffer(w, a.id, 0);
  }
  assert.ok(choosing >= 20, `중간에 레벨업을 골랐다 (${choosing}틱)`);
  assert.equal(w.gems.length, 0, `모두 먹었다 (남은 것 ${w.gems.length})`);
  assert.ok(Math.abs(gained() - total) < 1e-6, `받은 경험치 ${gained()} = 끌려온 경험치 ${total}`);
});

test('rm -rf node_modules: 기다리던 경험치는 주인이 나가면 놓인다 (다른 사람이 평소처럼 줍고, 기다리게 하지 않는다)', () => {
  const { w, a, b } = coopRmRf(321);
  a.xpNext = 1;
  const bugs = Array.from({ length: 6 }, (_, k) => enemy(9950 + k, a.x + 80 + k * 20, a.y, 'bug', 1));
  tick(w, bugs);
  for (let i = 0; i < 20 && !a.offers; i++) tick(w, []);
  assert.ok(a.offers && w.gems.some((g) => g.hold), '레벨업을 고르는 동안 기다리는 것이 있다');
  // b 가 그 자리로 온다. a 는 나간다. c 는 멀리서 계속 움직인다 (b 가 고를 때 월드가 멈추지 않게)
  const c = addPlayer(w, 'c');
  c.x = a.x - 3000;
  c.up = {};
  c.xpNext = 1e9;
  b.x = a.x + 100;
  b.y = a.y;
  b.xpNext = 1e9;
  removePlayer(w, a.id);
  tick(w, []);
  assert.ok(w.gems.every((g) => !g.hold), '주인이 나가면 hold 도 지운다');
  assert.ok(w.gems.some((g) => g.to === b.id), '가까운 사람이 평소처럼 끈다');
  b.offers = ['coffee'];
  tick(w, []);
  assert.ok(w.gems.every((g) => g.to === undefined), 'b 가 고르는 동안에는 평소처럼 놓는다 (기다리는 것은 rm -rf 가 끈 것만)');
});

test('rm -rf node_modules: 땅이 가득한데 모두 기다리는 중이어도, 동료가 잡은 적은 그 자리에 경험치를 떨어뜨린다', () => {
  const { w, a, b } = coopRmRf(322);
  // 땅을 a 가 끄는(기다리는) 경험치로 가득 채운다
  w.gems = Array.from({ length: MAX_GEMS }, (_, k) => ({ id: 50_000 + k, x: a.x + 100 + (k % 20) * 5, y: a.y + Math.floor(k / 20) * 5, v: 1, to: a.id, sp: 120, hold: true as const }));
  a.offers = ['coffee'];
  const held = (): number => w.gems.filter((g) => g.to === a.id).reduce((n, g) => n + g.v, 0);
  b.up = { console_log: 8 };
  const victims = Array.from({ length: 5 }, (_, k) => enemy(9970 + k, b.x + 40, b.y + k * 3, 'bug', 1));
  for (let i = 0; i < 40 && victims.some((e) => e.hp > 0); i++) {
    for (const e of victims) if (e.hp > 0) [e.x, e.y] = [b.x + 40, b.y + (e.id - 9970) * 3];
    tick(w, victims);
    assert.ok(!w.paused);
  }
  assert.ok(victims.every((e) => e.hp <= 0), 'b 가 잡았다');
  // 잡은 만큼의 경험치가 b 쪽에 생긴다 (가득 찬 땅에서는 새로 떨어지는 것끼리 평소 규칙대로 합쳐진다) — b 가 이미 주운 것도 센다
  const fresh = w.gems.filter((g) => g.to !== a.id);
  assert.ok(fresh.length >= 1, '잡은 자리에 경험치가 떨어진다');
  assert.ok(fresh.every((g) => Math.hypot(g.x - b.x, g.y - b.y) < 80), '잡은 자리에');
  assert.equal(fresh.reduce((n, g) => n + g.v, 0) + b.xp, victims.length, '잡은 만큼');
  assert.equal(held(), MAX_GEMS, 'a 를 기다리던 경험치의 합은 그대로 (동료의 몫이 섞이지 않는다)');
  assert.ok(w.gems.length <= MAX_GEMS, '땅의 개수 상한은 그대로');
});

test('24시간 모니터링: 카나리아와 부엉이가 함께, 쉬지 않고 폭탄을 떨어뜨린다. 두 마리 모두 화면에 보낸다', () => {
  const { w, p } = quietWorld(309);
  p.up = { canary: 8, night_owl: 8 };
  for (let i = 0; i < 5; i++) tick(w, []);
  const pets = { ...p.pets };
  p.up.monitoring = 1;
  delete p.up.canary;
  delete p.up.night_owl;
  let blasts = 0;
  let quiet = 0;
  let longest = 0;
  for (let i = 0; i < 20 * 10; i++) {
    tick(w, []);
    const now = w.zones.filter((z) => z.kind === 'blast' && z.born === w.tick).length;
    blasts += now;
    quiet = now > 0 ? 0 : quiet + 1;
    longest = Math.max(longest, quiet);
  }
  assert.ok(blasts >= 2 * 11 * 19, `10초 동안 폭탄 ${blasts}개`);
  assert.ok(longest <= 10, `쉬는 틈이 없다 (가장 길게 쉰 틱 ${longest})`);
  assert.deepEqual(p.pets, pets, '같은 새를 이어서 돌린다');
  const snap = buildSnapshot(w, p.id)!;
  const kinds = snap.s.filter((s) => s[0] === pets.canary || s[0] === pets.night_owl).map((s) => SHOT_KINDS[s[1]!]);
  assert.deepEqual(kinds.sort(), ['canary', 'owl']);
});

test('패킷 플러딩: 여덟 방향으로 개수만큼 쏜다', () => {
  const { w, p } = quietWorld(310);
  p.up = { flooding: 1 };
  tick(w, []);
  const packets = w.shots.filter((s) => s.kind === 'packet');
  assert.equal(packets.length, 8 * 3);
  const dirs = new Set(packets.map((s) => Math.round((Math.atan2(s.vy, s.vx) / (Math.PI / 4) + 8) % 8)));
  assert.equal(dirs.size, 8);
});

test('통신: 진화한 무기의 단계와 새 투사체(중단점, 웹소켓)가 이진 스냅샷을 오간다', () => {
  const { w, p } = quietWorld(311);
  p.up = { debugger: 1, websocket: 1, flooding: 1, monitoring: 1, rm_rf: 1, friday_deploy: 1, keep_alive: 3 };
  const bug = enemy(9730, p.x + 30, p.y);
  tick(w, [bug]);
  const snap = buildSnapshot(w, p.id)!;
  const back = decodeSnapshot(encodeSnapshot(snap));
  assert.deepEqual(back.me.up, snap.me.up);
  const kinds = new Set(back.s.map((s) => SHOT_KINDS[s[1]!]));
  assert.ok(kinds.has('breakpoint') && kinds.has('socket'), [...kinds].join(','));
});

test('순위표에 남기는 아이템: 진화한 무기도 1단계로 남고 다시 읽힌다', () => {
  const up = { debugger: 1, monitoring: 1, test_coverage: 3 };
  const items = upgradesOf(up);
  assert.deepEqual(items, [
    { id: 'debugger', level: 1 },
    { id: 'monitoring', level: 1 },
    { id: 'test_coverage', level: 3 },
  ]);
  assert.deepEqual(ownedUpgrades(JSON.parse(JSON.stringify(items))), items);
  // 진화한 무기의 단계는 1 뿐이다
  assert.deepEqual(ownedUpgrades([{ id: 'debugger', level: 2 }]), []);
  assert.ok(UPGRADE_IDS.every((id) => UPGRADES[id].max >= 1));
});
