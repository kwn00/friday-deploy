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
  maxHpOf,
  decodeSnapshot,
  encodeSnapshot,
  pickOffer,
  pickupOf,
  setInput,
  sfc32,
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

test('경험치가 너무 많으면 (400개) 가장 먼 경험치를 새 경험치에 합친다: 잡으면 언제나 그 자리에 떨어지고 총량은 같다', () => {
  // 뱀서는 넘친 경험치를 빨간 경험치 하나에 모으지만, 그 자리가 화면 밖이면 경험치가 안 떨어지는 것처럼 보여서 바꿨다 (0.2.2)
  const { w, p } = quiet(2);
  for (let i = 0; i < MAX_GEMS; i++) w.gems.push({ id: w.nextId++, x: p.x + 5000 + i, y: p.y, v: 1 });
  const total = (): number => w.gems.reduce((n, g) => n + g.v, 0);
  const before = total();
  p.up.console_log = 8;
  p.cd.console_log = 0;
  // 끌어당기는 범위 밖에서 잡는다 (떨어진 경험치를 바로 줍지 않게)
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
  assert.equal(w.gems.length, MAX_GEMS, '400 개를 넘지 않는다');
  assert.equal(total(), before + 6, '총량은 그대로 (Off-by-one 3마리 × 2)');
  const dropped = w.gems.filter((g) => Math.hypot(g.x - p.x, g.y - p.y) < 200);
  assert.equal(dropped.length, 3, '잡은 자리마다 하나씩 떨어진다');
  for (const g of dropped) assert.equal(g.v, 3, '가장 먼 경험치(1)를 합친 값 2 + 1');
  assert.ok(!w.gems.some((g) => g.x === p.x + 5000 + MAX_GEMS - 1), '가장 먼 것부터 없어진다');
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

test('빠른 적(사신 420px/s)도 가만히 선 플레이어를 지나치지 않고 맞힌다', () => {
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

test('월요일 아침(사신)은 버틸 수 없는 끝이다: 코드 프리즈·keep-alive 최대에 방화벽·디버거·2단계 인증을 가진 60레벨도 30분 뒤 10초 안에 쓰러진다', () => {
  // 예전에는 사신이 코드 프리즈에 얼어서(빙결 저항 1) 이 장비로 30분 뒤 1~6분을 더 버텼다
  for (const seed of [501, 502, 503]) {
    const { w, p } = quiet(seed);
    p.up = { debugger: 1, firewall: 8, code_freeze: 7, two_factor: 7, keep_alive: 5, mech_keyboard: 5, dark_mode: 5, test_coverage: 5 };
    p.level = 60;
    p.hp = maxHpOf(p);
    w.tick = 20 * STAGE_TIME - 1;
    w.time = w.tick * DT;
    w.wave = STAGE.length - 1;
    const start = w.time;
    let frozen = 0;
    let weakened = 0;
    for (let i = 0; i < 20 * 60 && p.alive; i++) {
      step(w, DT);
      for (const e of w.enemies) {
        if (e.type !== 'monday') continue;
        if (e.frozen > 0) frozen++;
        if (e.resFreeze <= 1) weakened++;
      }
    }
    assert.equal(p.alive, false, `시드 ${seed}: 1분 안에 쓰러진다`);
    assert.ok(w.time - start < 10, `시드 ${seed}: 10초 안에 쓰러진다 (${(w.time - start).toFixed(2)}초)`);
    assert.equal(frozen, 0, '사신은 한 번도 얼지 않는다');
    assert.equal(weakened, 0, '방화벽에 맞아도 빙결 저항이 줄지 않는다');
  }
});

test('코드 프리즈: 빙결 저항이 1 이하인 적은 예전처럼 얼고, 1 보다 큰 보스는 얼지 않는다 (방화벽에 맞아 1 까지 내려가면 언다)', () => {
  const { w, p } = quiet(504);
  p.shield = 1e9;
  p.up = { code_freeze: 1 };
  p.cd.code_freeze = 0;
  const types: EnemyId[] = ['bug', 'monolith', 'spaghetti', 'god_class', 'monday'];
  const hitBy = (type: EnemyId, resFreeze?: number): number => {
    // 다음 광선은 12시 방향 (위쪽). 광선 위에 하나만 둔다
    p.freezeDir = 11;
    p.cd.code_freeze = 0;
    const e = enemy(9700 + types.indexOf(type), p.x, p.y - 60, type);
    if (resFreeze !== undefined) e.resFreeze = resFreeze;
    e.spd = 0;
    w.enemies = [e];
    still(w);
    return e.frozen;
  };
  assert.ok(hitBy('bug') > 0, '버그(0)는 언다');
  assert.ok(hitBy('monolith') > 0, '모놀리스(1)는 언다');
  assert.equal(hitBy('spaghetti'), 0, '스파게티 코드(1.1)는 얼지 않는다');
  assert.equal(hitBy('god_class'), 0, 'God Class(1.1)는 얼지 않는다');
  assert.equal(hitBy('monday'), 0, '월요일 아침(1.1)은 얼지 않는다');
  assert.ok(hitBy('spaghetti', 1.0) > 0, '방화벽에 맞아 1 까지 내려간 스파게티 코드는 언다');
  assert.equal(ENEMIES.monday.debuffRes, true, '월요일 아침은 방화벽에 맞아도 저항이 줄지 않는다');
});

test('사신은 넉백이 작은 무기(0.1)에 맞아도 걷는 것보다 느리게 다가오지 않는다 (끌려오기만 한다)', () => {
  const { w, p } = quiet(505);
  p.shield = 1e9;
  p.up = {};
  const walk = ENEMIES.monday.speed * DT;
  for (const kbMult of [0, -0.05, -0.5, -1, -1.5]) {
    const e = enemy(9800, p.x + 300, p.y, 'monday');
    // 넉백 0.1 인 무기(멀티캐스트·고양이·스프린트)에 막 맞은 사신: 배율 0.1 × -0.5 = -0.05
    e.kbTime = kbMult === 0 ? 0 : 0.12;
    e.kbMult = kbMult;
    w.enemies = [e];
    const x = e.x;
    still(w);
    const moved = x - e.x;
    assert.ok(moved >= walk - 1e-9, `배율 ${kbMult}: 한 틱에 ${moved.toFixed(2)}px (걷기 ${walk.toFixed(2)}px)`);
    if (kbMult < -1) assert.ok(moved > walk + 1, `배율 ${kbMult}: 넉백이 크면 걷는 것보다 빨리 끌려온다`);
  }
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

type Odds = readonly [1 | 2 | 3, number, number, number];
const ITEMS = [1, 1, 3, 5] as const;

test('보물상자는 기본 단계보다 적게 나오지 않는다: 굴리는 순서와 비밀 난수를 쓰는 횟수는 그대로, 기본 1 상자는 예전과 같다', () => {
  // 비밀 난수를 정해 둔 값으로 바꿔, 5개·3개·1개 굴림이 어디서 성공하는지 경우마다 본다
  const queue: number[] = [];
  let calls = 0;
  const w = createWorld({ rng: sfc32(31), secret: () => (calls++, queue.length > 0 ? queue.shift()! : 0.5) });
  const p = addPlayer(w, 'a');
  p.xpNext = 1e9;
  p.cd.console_log = 1e9;
  w.itemCd = 1e9;
  // 굴림 값 (× 100 이 확률(%)보다 작으면 성공). 0.0001 은 언제나 성공, 0.9999 는 100% 가 아니면 실패
  const values = [0.0001, 0.02, 0.04, 0.08, 0.3, 0.6, 0.9999];
  const odds: Odds[] = [[2, 3, 10, 50], ...STAGE.flatMap((wv) => (wv.boss ? [wv.boss.chest] : []))];
  for (const o of odds) {
    for (const a of values) {
      for (const b of values) {
        for (const c of values) {
          const draws = [a, b, c];
          // 예전 규칙: 처음 성공한 것, 셋 다 실패하면 기본 단계. 몇 번 굴렸는지도 센다
          let rolledTier = 0;
          let rolls = 0;
          for (const [k, pct] of [o[1], o[2], o[3]].entries()) {
            rolls++;
            if (draws[k]! * 100 < pct) {
              rolledTier = 3 - k;
              break;
            }
          }
          const oldTier = rolledTier || o[0];
          const want = ITEMS[Math.max(o[0], rolledTier)];
          p.up = { console_log: 1, regex: 1, ai_agent: 1 };
          queue.length = 0;
          queue.push(...draws.slice(0, rolls));
          calls = 0;
          w.items.push({ id: w.nextId++, kind: 'chest', x: p.x + 3, y: p.y, ttl: Infinity, chest: o });
          w.events.length = 0;
          still(w);
          const ev = w.events.find((e) => e.type === 'chest');
          assert.ok(ev && ev.type === 'chest', '열렸다');
          const label = `${JSON.stringify(o)} 굴림 ${draws.slice(0, rolls).join(', ')}`;
          assert.equal(ev.items.length, want, `${label}: ${want}개`);
          assert.ok(ev.items.length >= ITEMS[o[0]], `${label}: 기본 단계(${ITEMS[o[0]]}개)보다 적지 않다`);
          if (o[0] === 1) assert.equal(ev.items.length, ITEMS[oldTier], `${label}: 기본 1 상자는 예전과 같다`);
          // 굴림 횟수 + 올린 것마다 한 번 (예전과 같은 흐름)
          assert.equal(calls, rolls + ev.items.length, `${label}: 비밀 난수를 쓰는 횟수`);
        }
      }
    }
  }
});

test('운이 좋을수록 8분 보스 상자(기본 3개)에서 받는 것이 줄지 않는다', () => {
  const open = (seed: number, prayer: number, odds: Odds): number[] => {
    const { w, p } = quiet(seed);
    const counts: number[] = [];
    for (let i = 0; i < 2000; i++) {
      p.up = { console_log: 1, regex: 1, ai_agent: 1, coffee: 1, ...(prayer ? { deploy_prayer: prayer } : {}) };
      w.items.push({ id: w.nextId++, kind: 'chest', x: p.x + 3, y: p.y, ttl: Infinity, chest: odds });
      w.events.length = 0;
      still(w);
      const ev = w.events.find((e) => e.type === 'chest');
      if (ev && ev.type === 'chest') counts.push(ev.items.length);
    }
    assert.equal(counts.length, 2000);
    return counts;
  };
  const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const boss8 = STAGE[8]!.boss!.chest;
  assert.deepEqual(boss8, [2, 3, 10, 50], '8분 왕버그 상자');
  const luck1 = [61, 62, 63].flatMap((s) => open(s, 0, boss8));
  const luck15 = [61, 62, 63].flatMap((s) => open(s, 5, boss8));
  assert.ok(luck1.every((n) => n >= 3) && luck15.every((n) => n >= 3), '언제나 3개 이상');
  // 기대값: 운 1 은 3.06개 (5개 3%), 운 1.5 는 3.09개 (5개 4.5%). 예전에는 2.18 → 1.88 로 줄었다
  assert.ok(avg(luck15) >= avg(luck1), `운 1.5 평균 ${avg(luck15).toFixed(3)} ≥ 운 1 평균 ${avg(luck1).toFixed(3)}`);
  // 기본 1 상자는 운이 좋을수록 많아진다 (예전과 같다)
  const base1 = STAGE[13]!.boss!.chest;
  assert.ok(avg([61, 62].flatMap((s) => open(s, 5, base1))) > avg([61, 62].flatMap((s) => open(s, 0, base1))), '기본 1 상자');
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

test('카나리아 (뱀서 Peachone): 4초 동안 1초마다 한 묶음씩 4번, 그다음 1초 쉰다 (시간 오차로 한 번 더 쏘지 않는다)', () => {
  const { w, p } = quiet(18);
  p.up = { console_log: 1, canary: 1 };
  p.shield = 1e9;
  const volleys: number[] = [];
  for (let t = 0; t < 20 * 12; t++) {
    w.enemies = [];
    const before = w.zones.filter((z) => z.kind === 'blast').length;
    still(w);
    const born = w.zones.filter((z) => z.kind === 'blast' && z.born === w.tick).length;
    if (born > 0 && before >= 0) volleys.push(Math.round(w.time * 100) / 100);
  }
  // 첫 주기: 4번, 그다음 간격은 1초 이상
  const gaps = volleys.slice(1).map((t, i) => Math.round((t - volleys[i]!) * 100) / 100);
  assert.deepEqual(gaps.slice(0, 3), [1, 1, 1], `묶음 사이 1초 (${volleys.join(', ')})`);
  assert.ok(gaps[3]! >= 1.99, `4번 뒤에는 1초 쉰다 (간격 ${gaps[3]})`);
  const perMinute = volleys.filter((t) => t < 10).length;
  assert.equal(perMinute, 8, '10초에 8번 (4번 + 쉼, 두 주기)');
});
