import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DT,
  ENEMIES,
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
  maxHpOf,
  ownedUpgrades,
  pickOffer,
  readyEvolutions,
  removePlayer,
  step,
  xpForLevel,
  upgradesOf,
  effectiveStats,
  weaponStats,
  type ChestOdds,
  type Enemy,
  type Player,
  type UpgradeId,
  type World,
} from './index';
import { BREAKPOINT_FREEZE, WATCH_ORBIT, hit } from './combat';

const enemy = (id: number, x: number, y: number, type: Enemy['type'] = 'merge_conflict', hp = 1e9): Enemy => ({ id, type, x, y, hp, spd: 1, frozen: 0, kbTaken: 0, resFreeze: 0, kbTime: 0, kbMult: 0, vx: 0, vy: 0, life: 0, hit: false });

/** 아무것도 저절로 생기지 않는 월드 (스폰·아이템·레벨업이 끼어들지 않게) */
function quietWorld(seed: number): { w: World; p: Player } {
  const w = createWorld(seed);
  const p = addPlayer(w, 'a');
  p.xpNext = 1e9;
  w.itemCd = 1e9;
  w.magnetCd = 1e9;
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
  w.items.push({ id: w.nextId++, kind: 'chest', x: p.x, y: p.y, ttl: Infinity, chest: odds });
  const before = w.events.length;
  tick(w, []);
  const ev = w.events.slice(before).find((e) => e.type === 'chest');
  assert.ok(ev && ev.type === 'chest', '상자가 열렸다');
  return ev.items;
}
const maxOf = (id: UpgradeId): number => UPGRADES[id].max;

test('진화 목록: 재료는 진화하지 않은 무기(최대 단계가 있는 것), 짝은 패시브, 재료가 겹치지 않는다', () => {
  assert.equal(EVOLUTIONS.length, 9);
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
  // 0.4.0 에 더한 진화: 짝은 다른 진화에 쓰이지 않던 패시브다 (짝을 함께 쓰지 않는다)
  assert.deepEqual(evolutionsUsing('rollback').map((e) => e.id), ['git_reset']);
  assert.deepEqual(evolutionsUsing('deploy_prayer').map((e) => e.id), ['git_reset']);
  assert.deepEqual(evolutionsUsing('regex').map((e) => e.id), ['grep_r']);
  assert.deepEqual(evolutionsUsing('cdn').map((e) => e.id), ['grep_r']);
  assert.deepEqual(evolutionsUsing('ai_agent').map((e) => e.id), ['agi']);
  assert.deepEqual(evolutionsUsing('side_project').map((e) => e.id), ['agi']);
  const pairs = EVOLUTIONS.flatMap((e) => (e.with ? [e.with] : []));
  assert.equal(new Set(pairs).size, pairs.length, '짝 패시브는 진화 하나에만 쓰인다');
  assert.deepEqual(evolutionsUsing('ctrl_x'), [], '아직 진화가 없는 무기');
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
  // 0.4.0 에 더한 진화: 재료 무기 최대 단계(8) + 짝 패시브 (단계는 상관없다)
  assert.deepEqual(ready({ rollback: 8, deploy_prayer: 1 }), ['git_reset']);
  assert.deepEqual(ready({ regex: 8, cdn: 3 }), ['grep_r']);
  assert.deepEqual(ready({ ai_agent: 8, side_project: 5 }), ['agi']);
  assert.deepEqual(ready({ rollback: 7, deploy_prayer: 5, regex: 7, cdn: 5, ai_agent: 7, side_project: 5 }), [], '최대 단계 전');
  assert.deepEqual(ready({ rollback: 8, regex: 8, ai_agent: 8, stack_overflow: 5, keep_alive: 5 }), [], '짝이 아닌 패시브');
  assert.deepEqual(ready({ git_reset: 1, rollback: 8, deploy_prayer: 1 }), [], '이미 진화했다');
  assert.ok(evolvedAway({ grep_r: 1 }, 'regex') && evolvedAway({ agi: 1 }, 'ai_agent') && evolvedAway({ git_reset: 1 }, 'rollback'));
  assert.ok(!evolvedAway({ grep_r: 1 }, 'cdn'), '짝 패시브는 남는다');
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
  // (무엇이 오를지는 비밀 난수다: 가진 것 중 최대가 아닌 러버덕이나 짝 패시브)
  const next = openChestHere(w, p);
  assert.equal(next.length, 1);
  assert.ok(next[0] === 'rubber_duck' || next[0] === 'test_coverage', `${next[0]}`);
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

test('보물상자: 0.4.0 의 진화 셋 (git reset --hard, grep -r, AGI) 도 재료가 빠지고 짝 패시브는 남으며, 목록 순서대로 바뀐다', () => {
  const { w, p } = quietWorld(317);
  p.up = { rollback: 8, deploy_prayer: 1, regex: 8, cdn: 2, ai_agent: 8, side_project: 3, console_log: 2 };
  const items = openChestHere(w, p, [3, 100, 0, 0]);
  assert.equal(items.length, 5);
  assert.deepEqual(items.slice(0, 3), ['git_reset', 'grep_r', 'agi'], '진화가 먼저, EVOLUTIONS 순서대로');
  assert.ok(items.slice(3).every((id) => !evolutionOf(id)), '나머지는 평소처럼 오른다');
  for (const gone of ['rollback', 'regex', 'ai_agent'] as const) assert.equal(p.up[gone], undefined, `재료 ${gone} 는 빠진다`);
  assert.deepEqual([p.up.git_reset, p.up.grep_r, p.up.agi], [1, 1, 1]);
  for (const kept of ['deploy_prayer', 'cdn', 'side_project'] as const) assert.ok((p.up[kept] ?? 0) >= 1, `짝 ${kept} 는 남는다`);
  // 진화는 칸을 그대로 쓴다: 무기 4개(롤백·정규표현식·AI 에이전트·console.log) → 4개
  assert.equal(WEAPON_IDS.filter((id) => (p.up[id] ?? 0) > 0).length, 4);
  assert.deepEqual([p.tally.chest.git_reset, p.tally.chest.grep_r, p.tally.chest.agi], [1, 1, 1], '통계: 진화한 횟수 (선택지에는 나오지 않는다)');
  assert.deepEqual([p.tally.offered.git_reset, p.tally.offered.grep_r, p.tally.offered.agi], [undefined, undefined, undefined]);
});

test('레벨업 선택지: 진화한 무기와 진화해서 없어진 재료 무기는 나오지 않는다 (빈 칸이 있어도)', () => {
  const { w, p } = quietWorld(303);
  const seen = new Set<UpgradeId>();
  for (let round = 0; round < 300; round++) {
    p.up = { monitoring: 1, debugger: 1, git_reset: 1 };
    p.offers = null;
    p.xp = p.xpNext = 5;
    w.gems.push({ id: w.nextId++, x: p.x, y: p.y, v: 1 });
    tick(w, []);
    for (const id of p.offers ?? []) seen.add(id);
  }
  for (const id of [...EVOLUTIONS.map((e) => e.id), 'canary', 'night_owl', 'console_log', 'rollback'] as const) assert.ok(!seen.has(id), `${id} 가 선택지에 나왔다`);
  assert.ok(seen.has('broadcast') && seen.has('test_coverage') && seen.has('deploy_prayer'), '다른 것(짝 패시브도)은 그대로 나온다');
});

test('레벨업 선택지: 진화 뒤에 남는 것을 다 올리면 선택지 대신 체력을 가득 채운다 (진화한 무기를 기다리며 멈추지 않는다)', () => {
  const { w, p } = quietWorld(304);
  p.up = {};
  // 진화한 무기 6개로 무기 칸이 가득, 패시브도 모두 최대 (진화는 9개라 칸 수만큼만)
  for (const e of EVOLUTIONS.slice(0, WEAPON_SLOTS)) p.up[e.id] = 1;
  for (const id of PASSIVE_IDS.slice(0, 6)) p.up[id] = maxOf(id);
  assert.equal(WEAPON_IDS.filter((id) => (p.up[id] ?? 0) > 0).length, WEAPON_SLOTS);
  p.hp = 10;
  p.xp = p.xpNext = 5;
  w.gems.push({ id: w.nextId++, x: p.x, y: p.y, v: 1 });
  const before = w.events.length;
  tick(w, []);
  assert.equal(p.offers, null);
  assert.equal(p.hp, maxHpOf(p), '체력이 가득 찬다');
  assert.equal(w.events.slice(before).filter((e) => e.type === 'refill').length, 1);
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
  w.magnetCd = 1e9;
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

test('24시간 모니터링: 감시 새 한 마리가 쉬지 않고 돌며 0.25초마다 큰 폭탄 하나를 떨군다. 화면에는 그 한 마리만 보낸다', () => {
  const { w, p } = quietWorld(309);
  p.up = { canary: 8, night_owl: 8 };
  for (let i = 0; i < 5; i++) tick(w, []);
  const pets = { ...p.pets };
  // 보물상자에서 진화한 것처럼 재료를 빼고 진화한 무기를 넣는다
  p.up.monitoring = 1;
  delete p.up.canary;
  delete p.up.night_owl;
  const st = UPGRADES.monitoring.kind === 'weapon' ? UPGRADES.monitoring.base : null;
  assert.ok(st);
  let blasts = 0;
  let quiet = 0;
  let longest = 0;
  for (let i = 0; i < 20 * 10; i++) {
    tick(w, []);
    const now = w.zones.filter((z) => z.kind === 'blast' && z.born === w.tick);
    blasts += now.length;
    quiet = now.length > 0 ? 0 : quiet + 1;
    longest = Math.max(longest, quiet);
    for (const z of now) {
      assert.equal(z.r, st.area, '큰 폭탄 (반경 72)');
      assert.equal(z.aux, 1, '청록 폭발로 그린다');
      assert.ok(Math.abs(Math.hypot(z.x - p.x, z.y - p.y) - WATCH_ORBIT) < 1e-6, '새의 자리 (궤도 56) 에 떨군다');
    }
  }
  assert.equal(blasts, 40, `10초 동안 폭탄 ${blasts}개 (0.25초마다 하나)`);
  assert.ok(longest <= 5, `쉬는 틈이 없다 (가장 길게 쉰 틱 ${longest})`);
  assert.equal(p.pets.monitoring, pets.canary, '재료였던 카나리아의 id 를 이어 쓴다 (화면에서 끊기지 않게)');
  const snap = decodeSnapshot(encodeSnapshot(buildSnapshot(w, p.id)!));
  const birds = snap.s.filter((s) => ['canary', 'owl', 'watch'].includes(SHOT_KINDS[s[1]!]!));
  assert.equal(birds.length, 1, '새는 한 마리만 보낸다 (부엉이는 보내지 않는다)');
  assert.equal(SHOT_KINDS[birds[0]![1]!], 'watch');
  assert.equal(birds[0]![0], pets.canary);
  assert.ok(Math.abs(Math.hypot(birds[0]![2]! - p.x, birds[0]![3]! - p.y) - WATCH_ORBIT) < 0.5, '궤도 56');
  // 시계 방향으로 돈다 (화면 좌표는 y 가 아래로: 각도가 는다). 스냅샷 좌표는 0.1 단위라 각도에 0.002rad 쯤 오차가 있다
  const angle = (): number => {
    const row = buildSnapshot(w, p.id)!.s.find((s) => s[0] === pets.canary)!;
    return Math.atan2(row[3]! - p.y, row[2]! - p.x);
  };
  const a0 = angle();
  tick(w, []);
  const turn = (((angle() - a0) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  assert.ok(Math.abs(turn - st.speed * DT) < 5e-3, `한 틱에 ${turn}rad (2.0rad/s, 시계 방향)`);
});

test('24시간 모니터링: 궤도(56)가 폭발 반경(72)보다 작아 몸에 붙은 버그는 폭탄마다 맞고, 닿는 거리(128) 밖은 맞지 않는다', () => {
  const { w, p } = quietWorld(312);
  p.up = { monitoring: 1 };
  const st = weaponOf('monitoring');
  const close = enemy(9740, p.x + 4, p.y);
  const edge = enemy(9741, p.x, p.y + WATCH_ORBIT + st.area - 8);
  const far = enemy(9742, p.x - (WATCH_ORBIT + st.area + ENEMIES.merge_conflict.r + 2), p.y);
  const all = [close, edge, far];
  const at: [number, number][] = all.map((e) => [e.x, e.y]);
  let volleys = 0;
  for (let i = 0; i < 20 * 10; i++) {
    // 밀려나도 그 자리에 다시 둔다. 붙어 있는 버그에 맞아 쓰러지지 않게 체력을 채운다
    for (const [k, e] of all.entries()) [e.x, e.y] = at[k]!;
    p.hp = 1e9;
    tick(w, all);
    volleys += w.zones.filter((z) => z.kind === 'blast' && z.born === w.tick).length;
  }
  assert.equal(volleys, 40);
  assert.equal(1e9 - close.hp, volleys * st.dmg, '몸에 붙은 버그는 폭탄마다 맞는다 (사각지대가 없다)');
  assert.ok(1e9 - edge.hp > 0 && 1e9 - edge.hp < volleys * st.dmg, '궤도 바깥 끝 쪽은 새가 가까이 올 때만 맞는다');
  assert.equal(far.hp, 1e9, '닿는 거리 밖');
});

test('24시간 모니터링: git fork 로 개수가 늘면 지나온 자리(0.5rad 뒤마다)에 폭탄을 더 떨군다', () => {
  const { w, p } = quietWorld(313);
  p.up = { monitoring: 1, git_fork: 2 };
  tick(w, []);
  const now = w.zones.filter((z) => z.kind === 'blast' && z.born === w.tick);
  assert.equal(now.length, 3, '1 + git fork 2');
  const ang = now.map((z) => Math.atan2(z.y - p.y, z.x - p.x));
  for (let i = 1; i < ang.length; i++) {
    const gap = (((ang[i - 1]! - ang[i]!) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    assert.ok(Math.abs(gap - 0.5) < 1e-9, `${i}번째는 0.5rad 뒤 (${gap})`);
  }
  assert.deepEqual(Object.keys(p.pets), ['monitoring'], '처음부터 가졌으면 새 id 를 만든다');
});

/** 진화한 무기의 능력치 (패시브 없음) */
const weaponOf = (id: 'monitoring' | 'flooding' | 'git_reset' | 'grep_r' | 'agi') => {
  const def = UPGRADES[id];
  assert.ok(def.kind === 'weapon');
  return def.base;
};

/** 패킷 플러딩 둘레에 놓는 적: 여덟 방향 × 여러 거리. 반경(234) + 고리 두께의 반(6) + 몸 바깥은 맞지 않는다 */
function floodRing(p: Player): { all: Enemy[]; inside: Enemy[]; outside: Enemy[]; place: () => void } {
  const st = weaponOf('flooding');
  const reach = st.speed * st.dur;
  const r = ENEMIES.merge_conflict.r;
  const dists = [0, 20, 60, 130, 200, reach + st.area + r - 1];
  const spots: [number, number][] = [];
  for (let k = 0; k < 8; k++) for (const d of dists) spots.push([Math.cos((k * Math.PI) / 4 + 0.2) * d, Math.sin((k * Math.PI) / 4 + 0.2) * d]);
  const out: [number, number][] = [0, 2, 4, 6].map((k) => [Math.cos((k * Math.PI) / 4) * (reach + st.area + r + 2), Math.sin((k * Math.PI) / 4) * (reach + st.area + r + 2)]);
  const x0 = p.x;
  const y0 = p.y;
  const inside = spots.map(([dx, dy], i) => enemy(9800 + i, x0 + dx, y0 + dy));
  const outside = out.map(([dx, dy], i) => enemy(9900 + i, x0 + dx, y0 + dy));
  const all = [...inside, ...outside];
  const pos = all.map((e): [number, number] => [e.x, e.y]);
  // 밀려나거나 다가와도 그 자리에 다시 둔다 (같은 자리에서 여러 틱 동안 띠 안에 있어도 한 번만 맞는지 보려고)
  const place = (): void => {
    for (const [k, e] of all.entries()) [e.x, e.y] = pos[k]!;
  };
  return { all, inside, outside, place };
}

test('패킷 플러딩: 내 자리에서 물결 하나가 퍼져, 모든 방향의 버그를 관통 제한 없이 물결마다 한 번씩 맞힌다', () => {
  const { w, p } = quietWorld(310);
  p.up = { flooding: 1 };
  const st = weaponOf('flooding');
  const { all, inside, outside, place } = floodRing(p);
  const lost = (e: Enemy): number => 1e9 - e.hp;
  // 물결이 지나간 뒤에 안쪽으로 들어온 버그 (그 물결에는 맞지 않는다)
  const late = enemy(9990, p.x - 20, p.y + 20);
  const lateAt: [number, number] = [late.x, late.y];
  const keep = (i: number): Enemy[] => (i >= 8 ? [...all, late] : all);
  // 한 물결 (쿨다운 1.2초보다 짧게): 생긴 틱부터 끝까지 퍼지는 데 0.9초
  for (let i = 0; i < 22; i++) {
    place();
    [late.x, late.y] = lateAt;
    p.hp = 1e9;
    tick(w, keep(i));
    assert.equal(w.shots.length, 0, '투사체를 만들지 않는다');
    if (i === 0) {
      const waves = w.zones.filter((z) => z.kind === 'wave');
      assert.equal(waves.length, 1, '물결 겹 수(3)만큼 따로 만들지 않고 하나로 판정한다');
      assert.deepEqual([waves[0]!.r, waves[0]!.aux, waves[0]!.dmg], [st.speed * st.dur, st.amount, st.dmg * st.amount], '반경 234, 겹 3, 피해 10 × 3');
    }
  }
  for (const e of inside) assert.equal(lost(e), st.dmg * st.amount, `거리 ${Math.round(Math.hypot(e.x - p.x, e.y - p.y))}: 한 번만 맞는다`);
  for (const e of outside) assert.equal(lost(e), 0, '반경 밖은 맞지 않는다');
  assert.equal(lost(late), 0, '물결이 지나간 뒤 안쪽으로 들어온 버그는 그 물결에 맞지 않는다');
  assert.equal(w.zones.filter((z) => z.kind === 'wave').length, 0, '다 퍼지면 사라진다');
  // 쿨다운(1.2초)마다 새 물결: 다시 한 번씩
  for (let i = 22; i < 24 + 20; i++) {
    place();
    [late.x, late.y] = lateAt;
    p.hp = 1e9;
    tick(w, keep(i));
  }
  for (const e of inside) assert.equal(lost(e), 2 * st.dmg * st.amount, '두 번째 물결');
  for (const e of outside) assert.equal(lost(e), 0);
  assert.equal(lost(late), st.dmg * st.amount, '다음 물결에는 맞는다');
});

test('패킷 플러딩: git fork 는 겹 수(피해 배수), 듀얼 모니터는 고리 두께. CDN·keep-alive 로 반경이 늘지 않는다', () => {
  const { w, p } = quietWorld(314);
  p.up = { flooding: 1, git_fork: 2, dual_monitor: 5, cdn: 5, keep_alive: 5 };
  const st = weaponOf('flooding');
  tick(w, []);
  const z = w.zones.find((z) => z.kind === 'wave')!;
  assert.deepEqual([z.r, z.aux, z.dmg, z.band], [st.speed * st.dur, 5, st.dmg * 5, st.area * 1.5]);
  assert.ok(Math.abs(z.ttl - st.dur) < 1e-9, '퍼지는 시간도 그대로');
});

test('패킷 플러딩: 고리 쪽으로 가장 빠른 적(월요일 아침, 틱마다 21px)만큼 빠르게 다가와도 건너뛰지 않고 한 번 맞는다', () => {
  const { w, p } = quietWorld(315);
  p.up = { flooding: 1 };
  const st = weaponOf('flooding');
  // 가장 빠른 적의 한 틱 이동 거리. 고리 앞도 틱마다 13px 나아가서, 마주 오면 한 틱에 34px 가까워진다
  const step = Math.max(...Object.values(ENEMIES).map((d) => d.speed)) * DT;
  assert.ok(step >= 20, `${step}px/틱`);
  // 몸이 가장 작은 버그 떼로, 출발 거리를 1px 씩 바꿔 고리 앞과 만나는 자리가 저마다 다르게 (어느 하나도 건너뛰면 안 된다)
  const runners = Array.from({ length: 40 }, (_, k) => enemy(9950 + k, p.x, p.y, 'bug_swarm'));
  const x0 = p.x;
  const y0 = p.y;
  for (let i = 0; i < 12; i++) {
    for (const [k, e] of runners.entries()) {
      const a = (k * Math.PI * 2) / runners.length;
      const d = 200 + k - step * i;
      [e.x, e.y] = [x0 + Math.cos(a) * d, y0 + Math.sin(a) * d];
    }
    p.hp = 1e9;
    tick(w, runners);
  }
  for (const e of runners) assert.equal(1e9 - e.hp, st.dmg * st.amount, `${e.id}: 한 번 맞는다`);
});

test('브로드캐스트·멀티캐스트: 재료 무기는 그대로 저마다 네 방향으로 패킷을 쏜다', () => {
  for (const [id, turn] of [['broadcast', 0], ['multicast', 1]] as const) {
    const { w, p } = quietWorld(316);
    p.up = { [id]: 1 };
    tick(w, []);
    const packets = w.shots.filter((s) => s.kind === 'packet');
    assert.equal(packets.length, 4, id);
    const dirs = new Set(packets.map((s) => Math.round((Math.atan2(s.vy, s.vx) / (Math.PI / 4) + 8) % 8)));
    assert.deepEqual([...dirs].sort(), [0, 2, 4, 6].map((d) => d + turn), id);
  }
});

/** 놓아 둔 자리에 다시 둔 채(밀려나도, 다가와도) 한 틱 */
function tickAt(w: World, p: Player, all: Enemy[], at: [number, number][]): void {
  for (const [k, e] of all.entries()) [e.x, e.y] = at[k]!;
  p.hp = 1e9;
  tick(w, all);
}

test('git reset --hard: 롤백 갈래·그림 그대로 부메랑 넷을 가장 가까운 버그 쪽으로 부채꼴로 던지고, 관통 제한 없이 벤다', () => {
  const { w, p } = quietWorld(330);
  p.up = { git_reset: 1 };
  const st = weaponOf('git_reset');
  const rollback8 = weaponStats('rollback', UPGRADES.rollback.max);
  // 오른쪽에 버그 하나: 가장 가까운 버그 쪽으로 던진다
  const bug = enemy(9600, p.x + 60, p.y);
  const at: [number, number][] = [[bug.x, bug.y]];
  tickAt(w, p, [bug], at);
  const shots = w.shots.filter((s) => s.w === 'git_reset');
  assert.equal(shots.length, st.amount, '부메랑 넷');
  for (const s of shots) {
    assert.equal(s.kind, 'rollback', '롤백의 그림을 그대로 쓴다 (새 투사체 종류가 없다)');
    // 움직임은 롤백과 같다: life 를 기준으로 오가고 그 1.5배 동안 남는다. 같은 적을 다시 맞히는 간격은 롤백과 같은 0.5초
    assert.deepEqual([s.r, s.rehit, s.life], [st.area, 0.5, st.dur]);
    assert.ok(Math.abs(s.ttl - (st.dur * 1.5 - DT)) < 1e-9);
    assert.ok(s.pierce >= 998, `관통 제한 없음 (${s.pierce})`);
  }
  const angles = shots.map((s) => Math.atan2(s.vy, s.vx)).sort((a, b) => a - b);
  assert.ok(Math.abs(angles.reduce((a, b) => a + b, 0) / angles.length) < 1e-9, '버그 쪽(오른쪽)을 가운데로 부채꼴');
  for (let i = 1; i < angles.length; i++) assert.ok(Math.abs(angles[i]! - angles[i - 1]! - 0.35) < 1e-9, '롤백과 같은 간격(0.35rad)');
  // 가운데 두 개가 같은 버그를 지나간다: 맞혀도 사라지지 않고 계속 날아간다
  for (let i = 0; i < 10; i++) tickAt(w, p, [bug], at);
  assert.ok(1e9 - bug.hp >= 2 * st.dmg, `두 개 이상에 맞았다 (${1e9 - bug.hp})`);
  assert.equal(w.shots.filter((s) => s.w === 'git_reset').length, st.amount, '맞힌 뒤에도 넷 다 남는다');
  // 롤백 최대 단계보다 많이, 세게, 크게, 빠르게
  assert.ok(st.amount > rollback8.amount && st.dmg > rollback8.dmg && st.area > rollback8.area && st.speed >= rollback8.speed);
});

test('git reset --hard: 치명타는 25% × 2배이고, 확률에 운(배포 기도)이 곱해진다 (서버의 보이는 난수로 판정)', () => {
  const { w, p } = quietWorld(331);
  const st = weaponOf('git_reset');
  const dmgWith = (prayer: number, roll: number): number => {
    p.up = { git_reset: 1, ...(prayer > 0 ? { deploy_prayer: prayer } : {}) };
    w.rng = () => roll;
    const e = enemy(9610, p.x + 50, p.y);
    hit(w, e, st.dmg, p, 'git_reset');
    return 1e9 - e.hp;
  };
  assert.equal(dmgWith(0, 0.24), st.dmg * 2, '25% 안: 두 배');
  assert.equal(dmgWith(0, 0.3), st.dmg, '25% 밖: 그대로');
  // 배포 기도 5단계: 운 ×1.5 → 37.5%
  assert.equal(dmgWith(5, 0.3), st.dmg * 2, '배포 기도로 치명타가 잦아진다');
  assert.equal(dmgWith(5, 0.38), st.dmg);
  // 재료인 롤백에는 치명타가 없다
  const e = enemy(9611, p.x + 50, p.y);
  w.rng = () => 0;
  hit(w, e, 5, p, 'rollback');
  assert.equal(1e9 - e.hp, 5);
});

test('grep -r: 정규표현식 갈래·그림 그대로 가장 가까운 버그 쪽으로 넷을 나란히, 0.4초마다 쏜다. 하나가 넷까지 꿰뚫는다 (관통 3)', () => {
  const { w, p } = quietWorld(332);
  p.up = { grep_r: 1, cdn: 1 };
  const st = weaponOf('grep_r');
  // 바라보는 쪽(오른쪽)과 반대인 왼쪽에 버그 다섯을 한 줄로: 그래도 가장 가까운 버그 쪽으로 쏜다
  // 몸이 큰 기술 부채로 30px 간격: 바깥 줄(9px 비켜남)도 한 틱(21px)에 건너뛰지 않고, 한 틱에 둘을 함께 맞히지 않는다
  const row = Array.from({ length: 5 }, (_, k) => enemy(9620 + k, p.x - 30 - k * 30, p.y, 'tech_debt'));
  const at = row.map((e): [number, number] => [e.x, e.y]);
  tickAt(w, p, row, at);
  const shots = w.shots.filter((s) => s.w === 'grep_r');
  assert.equal(shots.length, st.amount, '넷을 한꺼번에');
  for (const s of shots) {
    assert.equal(s.kind, 'regex', '정규표현식의 그림을 그대로 쓴다');
    assert.ok(s.vx < 0 && Math.abs(s.vy) < 1e-9, '왼쪽(가장 가까운 버그 쪽)으로');
    assert.ok(Math.abs(Math.hypot(s.vx, s.vy) - st.speed * 1.1) < 1e-6, '짝인 CDN 으로 빨라진다');
    assert.equal(s.r, st.area);
  }
  // 나란히: 쏘는 쪽에 수직으로 6px 간격
  const ys = shots.map((s) => s.y - p.y).sort((a, b) => a - b);
  assert.deepEqual(ys.map((y) => Math.round(y)), [-9, -3, 3, 9]);
  // 4초 동안 0.4초마다 (첫 틱 포함 10번), 다섯째 버그는 앞의 넷에 막혀 맞지 않는다 (관통 3 = 넷까지)
  let volleys = 1;
  for (let i = 1; i < 20 * 4; i++) {
    const before = new Set(w.shots.map((s) => s.id));
    tickAt(w, p, row, at);
    if (w.shots.some((s) => s.w === 'grep_r' && !before.has(s.id))) volleys++;
  }
  assert.equal(volleys, 10, `${volleys}번 쐈다`);
  for (const e of row.slice(0, 4)) assert.ok(e.hp < 1e9, `${e.id} 는 맞는다`);
  assert.equal(row[4]!.hp, 1e9, '다섯째는 맞지 않는다');
  // 버그가 없으면 바라보는 쪽으로 (정규표현식과 같다)
  const q = quietWorld(333);
  q.p.up = { grep_r: 1 };
  tick(q.w, []);
  assert.ok(q.w.shots.length === st.amount && q.w.shots.every((s) => s.vx > 0), '바라보는 쪽(오른쪽)으로');
});

test('AGI: AI 에이전트 갈래·그림 그대로 크고 느린 답 셋을 부채꼴로 쏜다. 하나가 다섯까지 꿰뚫는다 (관통 4)', () => {
  const { w, p } = quietWorld(334);
  p.up = { agi: 1, side_project: 1 };
  const st = weaponOf('agi');
  const row = Array.from({ length: 7 }, (_, k) => enemy(9640 + k, p.x + 30 + k * 20, p.y));
  const at = row.map((e): [number, number] => [e.x, e.y]);
  tickAt(w, p, row, at);
  const shots = w.shots.filter((s) => s.w === 'agi');
  assert.equal(shots.length, st.amount, '셋');
  for (const s of shots) {
    assert.equal(s.kind, 'ai', 'AI 에이전트의 그림을 그대로 쓴다 (새 투사체 종류가 없다)');
    assert.deepEqual([s.r, s.pierce], [8, 4], '판정 반경 8, 관통 4');
    assert.ok(Math.abs(Math.hypot(s.vx, s.vy) - st.speed) < 1e-6, '느리다 (160px/s)');
  }
  const snap = decodeSnapshot(encodeSnapshot(buildSnapshot(w, p.id)!));
  assert.equal(snap.s.filter((r) => SHOT_KINDS[r[1]!] === 'ai').length, st.amount, '화면에는 AI 에이전트의 그림으로');
  // 쿨다운(2초)보다 짧게: 첫 셋만 날아간다. 피해는 짝인 사이드 프로젝트의 피해량(+5%)까지
  for (let i = 0; i < 20 * 1.9; i++) tickAt(w, p, row, at);
  const dmg = effectiveStats(p, 'agi').dmg;
  assert.ok(Math.abs(dmg - st.dmg * 1.05) < 1e-9);
  for (const e of row.slice(0, 5)) assert.ok(Math.abs(1e9 - e.hp - dmg * st.amount) < 1e-6, `${e.id}: 셋에 모두 맞는다 (${1e9 - e.hp})`);
  for (const e of row.slice(5)) assert.equal(e.hp, 1e9, `${e.id}: 앞의 다섯에 막힌다`);
  // AI 에이전트 최대 단계보다 한 발이 세고(150 > 90), 느리다
  const ai8 = weaponStats('ai_agent', UPGRADES.ai_agent.max);
  assert.ok(st.dmg > ai8.dmg && st.speed < ai8.speed && st.pierce > ai8.pierce);
});

test('통신: 진화한 무기의 단계와 새 투사체(중단점, 웹소켓, 감시 새)·영역(물결)이 이진 스냅샷을 오간다', () => {
  const { w, p } = quietWorld(311);
  p.up = { debugger: 1, websocket: 1, flooding: 1, monitoring: 1, rm_rf: 1, friday_deploy: 1, git_reset: 1, grep_r: 1, agi: 1, keep_alive: 3, snapshot: 2 };
  const bug = enemy(9730, p.x + 30, p.y);
  tick(w, [bug]);
  const snap = buildSnapshot(w, p.id)!;
  const back = decodeSnapshot(encodeSnapshot(snap));
  assert.deepEqual(back.me.up, snap.me.up);
  // 0.4.0 의 진화 셋을 무기 뒤에 붙여 패시브의 자리가 밀렸다 (스냅샷 형식 9): 맨 뒤 패시브까지 그대로 읽힌다
  assert.deepEqual([back.me.up.git_reset, back.me.up.grep_r, back.me.up.agi, back.me.up.keep_alive, back.me.up.snapshot], [1, 1, 1, 3, 2]);
  const kinds = new Set(back.s.map((s) => SHOT_KINDS[s[1]!]));
  assert.ok(kinds.has('breakpoint') && kinds.has('socket') && kinds.has('watch'), [...kinds].join(','));
  // (AGI 는 겨눌 버그가 있어야 쏘는데 rm -rf 가 먼저 지웠다: AGI 의 그림은 AGI 테스트에서 본다)
  assert.ok(kinds.has('rollback') && kinds.has('regex'), `git reset --hard·grep -r 는 재료의 그림으로 (${[...kinds].join(',')})`);
  assert.ok(!kinds.has('canary') && !kinds.has('owl') && !kinds.has('packet'), '재료의 새와 패킷은 없다');
  // 물결: 생긴 틱에 한 번, 다른 영역과 같은 일곱 칸만 (맞은 적의 기억·고리 두께는 서버에만 있다)
  const wave = snap.z.filter((z) => ZONE_KINDS[z[1]!] === 'wave');
  assert.equal(wave.length, 1);
  assert.equal(wave[0]!.length, 7);
  const got = back.z.find((z) => ZONE_KINDS[z[1]!] === 'wave')!;
  assert.deepEqual([got[0], got[1], ...got.slice(4)], [wave[0]![0], wave[0]![1], ...wave[0]!.slice(4)]);
  assert.ok(Math.abs(got[2]! - wave[0]![2]!) < 0.1 && Math.abs(got[3]! - wave[0]![3]!) < 0.1, '자리');
  assert.deepEqual(wave[0]!.slice(4), [234, 3, 18], '반경, 겹 수, 남는 틱 (퍼지는 0.9초)');
  tick(w, [bug]);
  assert.ok(!buildSnapshot(w, p.id)!.z.some((z) => ZONE_KINDS[z[1]!] === 'wave'), '다음 스냅샷에는 다시 싣지 않는다');
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
