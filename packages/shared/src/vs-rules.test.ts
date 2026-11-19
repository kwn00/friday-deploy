/**
 * 0.1.1: 뱀서와 같은 규칙 (위키에서 옮긴 것). 수치의 출처는 각 테스트의 설명에 적었다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DT,
  ENEMIES,
  INVULN_SECONDS,
  MAX_ENEMIES_ALL,
  MAX_ENEMIES_REGULAR,
  MAX_GEMS,
  STAGE,
  STAGE_TIME,
  UPGRADES,
  addPlayer,
  buildSnapshot,
  createWorld,
  decodeSnapshot,
  encodeSnapshot,
  pickOffer,
  pickupOf,
  setInput,
  step,
  xpForLevel,
  type Enemy,
  type EnemyId,
  type Player,
  type World,
} from './index';

const enemy = (id: number, x: number, y: number, type: EnemyId = 'merge_conflict', hp = 1e9): Enemy => ({
  id,
  type,
  x,
  y,
  hp,
  spd: 1,
  frozen: 0,
  kbTaken: ENEMIES[type].kb,
  resFreeze: ENEMIES[type].resFreeze,
  kbTime: 0,
  kbMult: 0,
  vx: 0,
  vy: 0,
  life: 0,
  hit: false,
});

function quiet(seed: number): { w: World; p: Player } {
  const w = createWorld(seed);
  const p = addPlayer(w, 'a');
  p.xpNext = 1e9;
  p.cd.console_log = 1e9;
  w.itemCd = 1e9;
  return { w, p };
}
/** 웨이브가 적을 내지 않게 한 채로 한 틱 */
function still(w: World): void {
  w.wave = Math.floor((w.time + DT) / 60);
  w.spawnCd = 1e9;
  step(w, DT);
}

test('경험치 (뱀서 Level up): 1→2 는 5, 그 뒤 10씩, 20 레벨과 40 레벨에서 크게 늘어난다', () => {
  assert.deepEqual([1, 2, 3, 19].map(xpForLevel), [5, 15, 25, 185]);
  assert.equal(xpForLevel(20), 795, '19→20 의 185 + 600');
  assert.equal(xpForLevel(21), 266.5, '6.5 × (2·21 - 1)');
  assert.equal(xpForLevel(40), 2913.5);
  assert.equal(xpForLevel(41), 8 * 81);
  // 20 레벨과 40 레벨에 머무는 동안은 경험치 +100%
  const { w, p } = quiet(1);
  p.level = 20;
  p.xp = 0;
  w.gems.push({ id: w.nextId++, x: p.x, y: p.y, v: 10 });
  still(w);
  assert.equal(p.xp, 20);
});

test('경험치가 너무 많으면 (400개) 새 경험치는 빨간 경험치 하나에 모인다 (뱀서 Experience Gem)', () => {
  const { w, p } = quiet(2);
  for (let i = 0; i < MAX_GEMS; i++) w.gems.push({ id: w.nextId++, x: p.x + 5000 + i, y: p.y, v: 1 });
  p.up.console_log = 8;
  p.cd.console_log = 0;
  // 끌어당기는 범위 밖에서 잡는다 (빨간 경험치를 바로 줍지 않게)
  const bugs = [enemy(9001, p.x + 150, p.y, 'off_by_one', 1), enemy(9002, p.x - 150, p.y, 'off_by_one', 1), enemy(9003, p.x, p.y + 150, 'off_by_one', 1)];
  const at: [number, number][] = [[150, 0], [-150, 0], [0, 150]];
  for (let i = 0; i < 400 && bugs.some((b) => b.hp > 0); i++) {
    bugs.forEach((b, k) => {
      b.x = p.x + at[k]![0];
      b.y = p.y + at[k]![1];
    });
    w.enemies = bugs.filter((b) => b.hp > 0);
    still(w);
  }
  assert.equal(w.gems.length, MAX_GEMS + 1, '하나만 더 생긴다');
  const big = w.gems.find((g) => g.big)!;
  assert.equal(big.v, 6, 'Off-by-one 3마리 × 2');
  const snap = buildSnapshot(w, p.id)!;
  assert.ok(snap.g.some((g) => g[0] === big.id && g[3] === 1), '6 은 초록 (9 이하)');
});

test('맞는 방식 (뱀서): 닿아 있는 적 중 가장 센 한 대만 맞고 0.24초 무적. 많이 붙어도 그대로다', () => {
  const run = (n: number): number => {
    const { w, p } = quiet(3);
    const crowd = Array.from({ length: n }, (_, i) => enemy(9100 + i, p.x + Math.cos(i) * 4, p.y + Math.sin(i) * 4, 'off_by_one'));
    for (let t = 0; t < 20; t++) {
      crowd.forEach((e, i) => {
        e.x = p.x + Math.cos(i) * 4;
        e.y = p.y + Math.sin(i) * 4;
      });
      w.enemies = [...crowd];
      still(w);
    }
    return 100 - p.hp;
  };
  assert.equal(run(1), 40, 'Off-by-one(공격력 10) × 1초에 4대');
  assert.equal(run(12), 40, '12마리가 붙어도 같다');
  assert.equal(INVULN_SECONDS, 0.24);
});

test('빠른 적(사신 840px/s)도 가만히 선 플레이어를 지나치지 않고 맞힌다', () => {
  const { w, p } = quiet(4);
  const reaper = enemy(9200, p.x + 63, p.y, 'monday');
  p.revives = 0;
  for (let t = 0; t < 10 && p.alive; t++) {
    w.enemies = [reaper];
    still(w);
  }
  assert.equal(p.alive, false, '사신 한 대에 쓰러진다');
});

test('보스는 나오는 순간 가까운 사람의 레벨만큼 체력이 곱해진다 (HP x Level). 그 뒤 레벨이 올라도 그대로다', () => {
  const w = createWorld(5);
  const p = addPlayer(w, 'a');
  p.level = 12;
  p.xpNext = 1e9;
  // 1분이 되는 순간 왕버그(체력 50 × 레벨)가 나온다
  w.tick = 20 * 60 - 1;
  w.time = w.tick * DT;
  w.wave = 0;
  step(w, DT);
  const boss = w.enemies.find((e) => e.type === 'boss_bug')!;
  assert.ok(boss, '1분 보스');
  assert.equal(boss.hp, 50 * 12);
  assert.deepEqual(boss.chest, STAGE[1]!.boss!.chest, '보스는 상자를 가지고 있다');
  p.level = 30;
  step(w, DT);
  assert.ok(boss.hp <= 50 * 12);
});

test('웨이브 (뱀서): 최소보다 적으면 한꺼번에 채우고, 많으면 간격마다 종류별로 한 마리씩. 300 마리부터는 멈춘다', () => {
  const { w, p } = quiet(6);
  p.hp = 1e9;
  setInput(w, p.id, 0, 0);
  step(w, DT);
  assert.equal(w.enemies.length, STAGE[0]!.min, `0분: 바로 최소(${STAGE[0]!.min})까지`);
  // 간격(1초)마다 최소보다 많으면 종류(버그 1종)마다 1마리
  for (let i = 0; i < 20; i++) step(w, DT);
  assert.equal(w.enemies.length, STAGE[0]!.min + 1);
  // 300 마리면 더 나오지 않는다
  while (w.enemies.length < MAX_ENEMIES_REGULAR) w.enemies.push(enemy(w.nextId++, p.x + 250, p.y + w.enemies.length, 'bug'));
  for (let i = 0; i < 60; i++) step(w, DT);
  assert.ok(w.enemies.length <= MAX_ENEMIES_REGULAR, `${w.enemies.length}`);
  assert.ok(MAX_ENEMIES_ALL === 500);
});

test('함께 하면 최소 수가 늘지만, 적 수의 상한은 같다 (무료 서버)', () => {
  const w = createWorld(7);
  const a = addPlayer(w, 'a');
  const b = addPlayer(w, 'b');
  a.xpNext = b.xpNext = 1e9;
  w.itemCd = 1e9;
  step(w, DT);
  assert.equal(w.enemies.length, Math.round(STAGE[0]!.min * 1.4), '두 명: 최소 × 1.4');
});

test('30분이 되면 화면의 적이 모두 경험치 없이 사라지고, 1분마다 월요일 아침(사신)이 온다', () => {
  const { w, p } = quiet(8);
  p.hp = 1e9;
  w.tick = 20 * STAGE_TIME - 1;
  w.time = w.tick * DT;
  w.wave = STAGE.length - 1;
  for (let i = 0; i < 50; i++) w.enemies.push(enemy(w.nextId++, p.x + 200, p.y, 'bug'));
  const kills = p.kills;
  step(w, DT);
  assert.deepEqual(w.enemies.map((e) => e.type), ['monday']);
  assert.equal(p.kills, kills, '사라진 적은 처치로 세지 않는다');
  assert.equal(w.gems.length, 0);
  const reaper = w.enemies[0]!;
  assert.equal(reaper.hp, ENEMIES.monday.hp * p.level);
  for (let i = 0; i < 20 * 60; i++) {
    p.shield = 1e9; // 쓰러지지 않게
    step(w, DT);
  }
  assert.equal(w.enemies.filter((e) => e.type === 'monday').length, 2, '1분 뒤 하나 더');
});

test('넉백 (뱀서): 맞은 적은 0.12초 동안 거꾸로 움직인다. 사신(-0.5)은 오히려 끌려온다', () => {
  for (const [type, away] of [['off_by_one', true], ['monday', false]] as const) {
    const { w, p } = quiet(9);
    p.up = { console_log: 1 };
    p.cd.console_log = 0;
    p.shield = 1e9;
    const e = enemy(9300, p.x + 120, p.y, type);
    w.enemies = [e];
    let hitAt = -1;
    let before = 0;
    for (let t = 0; t < 40; t++) {
      still(w);
      if (hitAt < 0 && e.kbTime > 0) {
        hitAt = t;
        before = e.x;
      }
      if (hitAt >= 0 && t === hitAt + 1) {
        if (away) assert.ok(e.x > before, `${type}: 밀려난다 (${before} → ${e.x})`);
        else assert.ok(e.x < before, `${type}: 끌려온다`);
        break;
      }
    }
    assert.ok(hitAt >= 0, `${type}: 맞았다`);
  }
});

test('버그 떼는 한 방향으로 가로지르고 6초 뒤 사라진다 (멀어져도 다시 데려오지 않는다)', () => {
  const { w, p } = quiet(10);
  p.shield = 1e9;
  // 2분 웨이브의 버그 떼(반드시)가 나오게 한다
  w.tick = 20 * 120 - 1;
  w.time = w.tick * DT;
  w.wave = 1;
  for (let i = 0; i < 20 * 7; i++) step(w, DT);
  const swarm = w.enemies.filter((e) => e.type === 'bug_swarm');
  // 첫 떼는 2:05 에 나와 2:11 에 사라지고, 두 번째 떼는 2:11 에 나온다
  assert.ok(swarm.length > 0 && swarm.every((e) => e.life > 0 && e.life <= 6), `떼 ${swarm.length}`);
  for (let i = 0; i < 20 * 14; i++) step(w, DT);
  assert.equal(w.enemies.filter((e) => e.type === 'bug_swarm').length, 0, '수명이 다하면 사라진다');
});

test('보물상자 (뱀서 Treasure Chest): 닿아야 열리고, 5개 → 3개 → 1개 순서로 굴려 가진 것을 그만큼 올린다', () => {
  const tierOf = (odds: readonly [1 | 2 | 3, number, number, number], luck: number): number[] => {
    const { w, p } = quiet(11);
    p.up = { console_log: 1, regex: 1, ...(luck ? { deploy_prayer: luck } : {}) };
    const counts: number[] = [];
    for (let i = 0; i < 300; i++) {
      for (const k of Object.keys(p.up)) if (k !== 'deploy_prayer') p.up[k as 'regex'] = 1;
      w.items.push({ id: w.nextId++, kind: 'chest', x: p.x + 3, y: p.y, ttl: Infinity, chest: odds });
      w.events.length = 0;
      still(w);
      const ev = w.events.find((e) => e.type === 'chest');
      if (ev && ev.type === 'chest') counts.push(ev.items.length);
    }
    return counts;
  };
  const none = tierOf([1, 0, 0, 0], 0);
  assert.ok(none.length === 300 && none.every((n) => n === 1), '확률이 0 이면 기본 단계(1개)');
  const big = tierOf([1, 3, 10, 100], 0);
  const five = big.filter((n) => n === 5).length / big.length;
  const three = big.filter((n) => n === 3).length / big.length;
  assert.ok(five > 0.005 && five < 0.07, `5개: 약 3% (${five})`);
  assert.ok(three > 0.05 && three < 0.16, `3개: 약 9.7% (${three})`);
  // 상자는 끌려오지 않는다: 끌어당기는 범위 안이어도 닿기 전에는 그대로
  const { w, p } = quiet(12);
  w.items.push({ id: 9400, kind: 'chest', x: p.x + pickupOf(p) - 2, y: p.y, ttl: Infinity, chest: [1, 0, 0, 0] });
  still(w);
  assert.ok(w.items.some((it) => it.id === 9400));
});

test('상자는 LGTM 처럼 레벨을 올리지 않고, 저절로 놓이는 아이템의 자리(3개)를 차지하지 않는다', () => {
  const { w, p } = quiet(13);
  const level = p.level;
  for (let i = 0; i < 3; i++) w.items.push({ id: w.nextId++, kind: 'chest', x: p.x + 2000 + i, y: p.y, ttl: Infinity, chest: [1, 0, 0, 0] });
  w.itemCd = 0;
  still(w);
  assert.equal(w.items.filter((it) => it.kind !== 'chest').length, 1, '필드 아이템이 하나 놓인다');
  w.items.push({ id: 9500, kind: 'chest', x: p.x, y: p.y, ttl: Infinity, chest: [1, 0, 0, 0] });
  still(w);
  assert.equal(p.level, level);
});

test('레벨업 선택지 (뱀서): rarity 가 무게다. 무게 40 은 무게 100 보다 드물게 나온다', () => {
  const { w, p } = quiet(14);
  const seen: Record<string, number> = {};
  for (let i = 0; i < 400; i++) {
    p.up = { console_log: 1 };
    p.level = 1;
    p.xp = p.xpNext = 5;
    w.gems.push({ id: w.nextId++, x: p.x, y: p.y, v: 1 });
    still(w);
    for (const id of p.offers ?? []) seen[id] = (seen[id] ?? 0) + 1;
    p.offers = null;
  }
  const rate = (id: string): number => (seen[id] ?? 0) / 400;
  assert.ok(rate('stack_overflow') > rate('logic_bomb') * 1.5, `rarity 100 ${rate('stack_overflow')} vs 40 ${rate('logic_bomb')}`);
  assert.ok(rate('console_log') > 0.2, `가진 것이 먼저 나올 기회가 있다 (${rate('console_log')})`);
});

test('무기는 얻거나 오르는 순간 바로 한 번 쓴다 (뱀서)', () => {
  const { w, p } = quiet(15);
  p.up = { console_log: 1 };
  p.cd.ctrl_x = 1e9;
  p.offers = ['ctrl_x'];
  pickOffer(w, p.id, 0);
  assert.equal(p.cd.ctrl_x, 0);
  assert.ok(p.iframe >= INVULN_SECONDS - 1e-9, '고른 뒤 잠깐 무적');
});

test('커밋 히스토리: 멈추면 커밋이 날아가고, 화면에서도 지우라고 스냅샷에 한 번 실린다', () => {
  const { w, p } = quiet(16);
  p.up = { console_log: 1, commit_history: 1 };
  setInput(w, p.id, 1, 0);
  for (let i = 0; i < 20; i++) still(w);
  const trails = w.zones.filter((z) => z.kind === 'trail').map((z) => z.id);
  assert.ok(trails.length >= 2, `${trails.length}`);
  setInput(w, p.id, 0, 0);
  still(w);
  assert.ok(w.shots.some((s) => s.kind === 'drill'), '날아간다');
  const snap = decodeSnapshot(encodeSnapshot(buildSnapshot(w, p.id)!));
  assert.ok(trails.every((id) => snap.zr.includes(id)), '지운 영역이 실린다');
  still(w);
  assert.deepEqual(buildSnapshot(w, p.id)!.zr, [], '한 번만');
});

test('저주 (뱀서 Curse): 체력은 바로, 속도·수·빈도는 다음 분부터', () => {
  const { w, p } = quiet(17);
  p.hp = 1e9;
  step(w, DT);
  const n0 = w.enemies.length;
  p.up.prod_hotfix = 5;
  for (let i = 0; i < 20; i++) step(w, DT);
  const fresh = w.enemies.at(-1)!;
  assert.equal(fresh.hp, ENEMIES.bug.hp * 1.5, '새로 나온 적의 체력은 바로 1.5 배');
  assert.equal(fresh.spd, 1, '속도는 아직');
  assert.ok(w.enemies.length <= n0 + 2);
  assert.equal(UPGRADES.prod_hotfix.kind, 'passive');
});
