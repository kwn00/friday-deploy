import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DT,
  FIELD_ITEMS,
  FIELD_ITEM_KINDS,
  FIELD_ITEM_MAX_DIST,
  FIELD_ITEM_MIN_DIST,
  FIELD_ITEM_TTL,
  GEM_PULL_MAX,
  MAGNET_INTERVAL,
  MAX_FIELD_ITEMS,
  MAX_MAGNETS,
  OFFER_TIMEOUT,
  PLAYER_BASE_PICKUP,
  UPGRADES,
  UPGRADE_IDS,
  addPlayer,
  buildSnapshot,
  createWorld,
  decodeSnapshot,
  encodeSnapshot,
  maxHpOf,
  pickOffer,
  sfc32,
  step,
  type Player,
  type UpgradeId,
  type World,
} from './index';

/** 적이 끼어들지 않게 지우고 한 틱 (스폰 자체는 돌아간다: 보이는 난수의 흐름은 그대로) */
function quietStep(w: World): void {
  w.enemies.length = 0;
  w.shots.length = 0;
  step(w, DT);
  w.enemies.length = 0;
}

/** 저절로 놓이는 것(필드 아이템, 자석)을 끈 판. 레벨업으로 멈추지 않게 경험치 문턱을 아주 높인다 */
function quiet(seed: number, players = 1): { w: World; ps: Player[] } {
  const w = createWorld(seed);
  const ps = Array.from({ length: players }, (_, i) => addPlayer(w, `p${i}`));
  for (const p of ps) {
    p.xpNext = 1e9;
    p.cd.console_log = 1e9;
  }
  w.itemCd = 1e9;
  w.magnetCd = 1e9;
  return { w, ps };
}

const putMagnet = (w: World, x: number, y: number): number => {
  const id = w.nextId++;
  w.items.push({ id, kind: 'magnet', x, y, ttl: FIELD_ITEM_TTL });
  return id;
};

test('자석: 다른 필드 아이템과 따로, 가끔 화면 밖 적당한 거리에 놓이고, 한 번에 하나만 있고, 줍지 않으면 사라진다', () => {
  const w = createWorld(51);
  const p = addPlayer(w, 'a');
  p.xpNext = 1e9;
  const born = new Map<number, number>();
  const gone = new Map<number, number>();
  for (let i = 0; i < 20 * 60 * 60; i++) {
    p.hp = 1e9;
    quietStep(w);
    const magnets = w.items.filter((it) => it.kind === 'magnet');
    assert.ok(magnets.length <= MAX_MAGNETS, '한 번에 하나');
    assert.ok(w.items.filter((it) => it.kind !== 'magnet' && it.kind !== 'chest').length <= MAX_FIELD_ITEMS, '다른 아이템의 수는 그대로 센다');
    for (const it of magnets) {
      if (born.has(it.id)) continue;
      born.set(it.id, w.time);
      const d = Math.hypot(it.x - p.x, it.y - p.y);
      assert.ok(d >= FIELD_ITEM_MIN_DIST - 0.001 && d <= FIELD_ITEM_MAX_DIST + 0.001, `놓인 거리 ${d}`);
    }
    for (const id of born.keys()) if (!gone.has(id) && !w.items.some((it) => it.id === id)) gone.set(id, w.time);
  }
  const times = [...born.values()];
  const expected = 3600 / MAGNET_INTERVAL;
  assert.ok(times.length >= expected * 0.65 && times.length <= expected * 1.35, `한 시간에 ${times.length}개 (평균 ${MAGNET_INTERVAL}초에 하나면 약 ${expected}개)`);
  assert.ok(times[0]! >= MAGNET_INTERVAL * 0.6 - 0.1, `첫 자석은 ${times[0]}초에: 시작하자마자 나오지 않는다`);
  for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= MAGNET_INTERVAL * 0.6 - 0.1, `간격 ${times[i]! - times[i - 1]!}`);
  for (const [id, at] of gone) assert.ok(Math.abs(at - born.get(id)! - FIELD_ITEM_TTL) < 0.11, `수명 ${at - born.get(id)!}`);
  // 피자·LGTM·백업을 뽑는 굴림에는 나오지 않는다 (비중 0: 따로 센 시간이 놓는다)
  assert.equal(FIELD_ITEMS.magnet.weight, 0);
  assert.equal(FIELD_ITEM_KINDS.indexOf('magnet'), FIELD_ITEM_KINDS.length - 1, '통신 번호: 뒤에 붙인다 (예전 번호가 바뀌지 않게)');
});

test('자석: 언제 어디에 놓일지는 비밀 난수만으로 정해진다 (보이는 난수를 쓰지 않는다)', () => {
  const run = (value: number, until: number): { w: World; p: Player; visible: number } => {
    let visible = 0;
    const base = sfc32(9);
    const w = createWorld({ rng: () => (visible++, base()), secret: () => value });
    const p = addPlayer(w, 'a');
    p.xpNext = 1e9;
    const before = visible;
    while (w.time < until - 1e-9) {
      p.hp = 1e9;
      quietStep(w);
    }
    return { w, p, visible: visible - before };
  };
  // 비밀 난수가 늘 0.5 면 첫 자석은 평균 간격에, 늘 0.99 면 그보다 늦게 놓인다
  const at = MAGNET_INTERVAL + 1;
  const mid = run(0.5, at);
  const late = run(0.99, at);
  const magnet = mid.w.items.find((it) => it.kind === 'magnet');
  assert.ok(magnet, '0.5: 평균 간격에 놓였다');
  assert.ok(!late.w.items.some((it) => it.kind === 'magnet'), '0.99: 아직 놓이지 않았다');
  // 방향(0.5 → 반 바퀴)과 거리(가운데)도 비밀 난수로 정했다
  assert.ok(Math.abs(magnet.x - (mid.p.x - (FIELD_ITEM_MIN_DIST + FIELD_ITEM_MAX_DIST) / 2)) < 0.01 && Math.abs(magnet.y - mid.p.y) < 0.01, `${magnet.x}, ${magnet.y}`);
  assert.equal(mid.visible, late.visible, '자석이 놓였든 아니든 보이는 난수는 똑같이 쓰였다');
});

test('자석: 주우면 맵의 경험치가 거리와 상관없이 모두 끌려와 먹힌다 (나중에 떨어진 것은 끌지 않는다)', () => {
  const { w, ps } = quiet(52);
  const p = ps[0]!;
  // 화면 밖 멀리, 사방에 흩어진 경험치
  const spots: [number, number][] = [
    [3000, 0],
    [-2500, 1800],
    [0, -4000],
    [400, 300],
    [-700, -50],
  ];
  spots.forEach(([dx, dy], i) => w.gems.push({ id: 7000 + i, x: p.x + dx, y: p.y + dy, v: i + 1 }));
  const total = w.gems.reduce((n, g) => n + g.v, 0);
  const xp0 = p.xp;
  putMagnet(w, p.x + 5, p.y);
  w.events.length = 0;
  quietStep(w);
  assert.ok(!w.items.some((it) => it.kind === 'magnet'), '주웠다');
  assert.deepEqual(w.events.filter((e) => e.type === 'magnet'), [{ type: 'magnet', pid: p.id, gems: spots.length }], '주운 사람에게 몇 개를 끌었는지 알린다');
  assert.ok(w.gems.every((g) => g.to === p.id && g.hold === true), '모두 나에게 (레벨업을 골라도 놓지 않는다)');
  // 주운 뒤에 떨어진 것은 끌지 않는다
  w.gems.push({ id: 7999, x: p.x + 2000, y: p.y, v: 100 });
  // 가장 먼 것(4000px)도 가장 빠른 속도로 오면 12초 안쪽이다
  for (let i = 0; i < 20 * 15; i++) quietStep(w);
  assert.deepEqual(w.gems.map((g) => g.id), [7999], '땅에 있던 것은 모두 먹었다');
  assert.equal(w.gems[0]!.to, undefined, '나중에 떨어진 것은 그대로 있다');
  assert.ok(Math.abs(p.xp - xp0 - total) < 1e-9, `먹은 경험치 ${p.xp - xp0} = ${total}`);
  assert.ok(GEM_PULL_MAX * 12 > 4000);
});

test('자석: 이미 다른 사람이 끌어당기는 것은 그대로 두고, 쓰러진 사람이 끌던 것은 가져온다', () => {
  const { w, ps } = quiet(53, 3);
  const [a, b, c] = ps as [Player, Player, Player];
  b.x = a.x + 3000;
  c.x = a.x - 3000;
  b.y = c.y = a.y;
  w.gems.push({ id: 8001, x: b.x + 20, y: b.y, v: 1, to: b.id, sp: 200 });
  w.gems.push({ id: 8002, x: c.x + 20, y: c.y, v: 1, to: c.id, sp: 200 });
  w.gems.push({ id: 8003, x: a.x + 900, y: a.y, v: 1 });
  c.alive = false;
  c.hp = 0;
  putMagnet(w, a.x + 5, a.y);
  w.events.length = 0;
  quietStep(w);
  const g = (id: number) => w.gems.find((x) => x.id === id);
  assert.equal(g(8001)?.to, b.id, '살아서 끌고 있는 사람의 것은 그대로');
  assert.equal(g(8002)?.to, a.id, '쓰러진 사람이 끌던 것은 가져온다');
  assert.equal(g(8003)?.to, a.id);
  assert.deepEqual(w.events.find((e) => e.type === 'magnet'), { type: 'magnet', pid: a.id, gems: 2 });
});

test('자석: 함께 하는 판에서 주운 사람이 레벨업을 고르는 동안 끌려오던 경험치는 그 자리에서 기다렸다가 이어서 온다', () => {
  const { w, ps } = quiet(54, 2);
  const [a, b] = ps as [Player, Player];
  b.x = a.x + 2000;
  b.y = a.y;
  // b 근처(획득 범위 바로 밖)의 경험치도 a 에게 끌려간다
  w.gems.push({ id: 8101, x: b.x + PLAYER_BASE_PICKUP + 20, y: b.y, v: 2 });
  w.gems.push({ id: 8102, x: a.x + 1500, y: a.y, v: 2 });
  putMagnet(w, a.x + 5, a.y);
  quietStep(w);
  assert.ok(w.gems.every((g) => g.to === a.id));
  // a 가 고르는 중 (b 는 고르지 않으므로 월드는 돈다)
  a.offers = ['coffee'];
  const at = w.gems.map((g) => [g.x, g.y]);
  // b 가 기다리는 경험치 위로 걸어가도
  const waiting = w.gems.find((g) => g.id === 8101)!;
  b.x = waiting.x - 2;
  b.y = waiting.y;
  for (let i = 0; i < 40; i++) quietStep(w);
  assert.equal(w.paused, false, '함께 하는 판: 한 사람이 골라도 월드는 돈다');
  assert.deepEqual(w.gems.map((g) => [g.x, g.y]), at, '고르는 동안에는 그 자리에서 기다린다');
  assert.ok(w.gems.every((g) => g.to === a.id), 'b 가 바로 옆에 있어도 가져가지 못한다');
  assert.ok(pickOffer(w, a.id, 0));
  for (let i = 0; i < 20 * 10; i++) quietStep(w);
  assert.equal(w.gems.length, 0, '고른 뒤 이어서 끌려와 a 가 먹었다');
  assert.equal(b.xp, 0);
  assert.equal(a.xp, 4);
});

test('자석: 주운 사람이 쓰러지면 끌려오던 경험치는 그 자리에 남는다 (다른 사람이 주울 수 있다)', () => {
  const { w, ps } = quiet(55, 2);
  const [a, b] = ps as [Player, Player];
  b.x = a.x + 2000;
  w.gems.push({ id: 8201, x: a.x + 1500, y: a.y, v: 1 });
  putMagnet(w, a.x + 5, a.y);
  quietStep(w);
  a.alive = false;
  a.hp = 0;
  quietStep(w);
  const g = w.gems[0]!;
  assert.equal(g.to, undefined);
  assert.equal(g.hold, undefined);
  // b 가 다가가면 평소처럼 끌려간다
  b.x = g.x + PLAYER_BASE_PICKUP - 2;
  b.y = g.y;
  for (let i = 0; i < 20; i++) quietStep(w);
  assert.equal(w.gems.length, 0);
  assert.equal(b.xp, 1);
});

test('자석: 스냅샷에는 거리와 상관없이 실리고, 이진 스냅샷으로 오가도 종류가 그대로다', () => {
  const { w, ps } = quiet(56);
  const p = ps[0]!;
  const id = putMagnet(w, p.x + 5000, p.y - 3000);
  const snap = buildSnapshot(w, p.id)!;
  const row = snap.i.find((it) => it[0] === id);
  assert.ok(row, '멀리 있어도 실린다');
  assert.equal(FIELD_ITEM_KINDS[row[1]], 'magnet');
  const back = decodeSnapshot(encodeSnapshot(snap)).i.find((it) => it[0] === id);
  assert.ok(back);
  assert.equal(FIELD_ITEM_KINDS[back[1]], 'magnet');
  // 필드 아이템은 절대 좌표(f32)로 오간다
  assert.ok(Math.abs(back[2] - row[2]) < 0.01 && Math.abs(back[3] - row[3]) < 0.01);
});

test('자석: 동료가 고르는 동안 기다리던 경험치는 내 자석이 가져온다. 지금 끌어당기는 중인 것은 그대로다', () => {
  const { w, ps } = quiet(59, 2);
  const [a, b] = ps as [Player, Player];
  b.x = a.x + 2500;
  b.y = a.y;
  w.gems.push({ id: 8301, x: a.x + 1200, y: a.y, v: 1 }, { id: 8302, x: a.x - 1500, y: a.y, v: 1 });
  putMagnet(w, a.x + 5, a.y);
  quietStep(w);
  // a 가 고르는 중: 기다리던 것은 b 의 자석이 가져간다
  a.offers = ['coffee'];
  putMagnet(w, b.x + 5, b.y);
  w.events.length = 0;
  quietStep(w);
  assert.ok(w.gems.every((g) => g.to === b.id && g.hold), '모두 b 에게');
  assert.deepEqual(w.events.find((e) => e.type === 'magnet'), { type: 'magnet', pid: b.id, gems: 2 });
  // b 가 끌어당기는 중(고르지 않는다)이면 a 의 다음 자석은 손대지 않는다. 이미 내게 오던 것은 다시 세지 않는다
  a.offers = null;
  w.gems.push({ id: 8303, x: a.x + 900, y: a.y, v: 1, to: a.id, sp: 200 });
  putMagnet(w, a.x + 5, a.y);
  w.events.length = 0;
  quietStep(w);
  const g = (id: number) => w.gems.find((x) => x.id === id);
  assert.equal(g(8301)?.to, b.id);
  assert.equal(g(8302)?.to, b.id);
  assert.equal(g(8303)?.to, a.id);
  assert.equal(g(8303)?.hold, true, '이미 내게 오던 것도 기다리게 된다');
  assert.deepEqual(w.events.find((e) => e.type === 'magnet'), { type: 'magnet', pid: a.id, gems: 0 }, '새로 끈 것만 센다');
});

test('자석: 함께 하는 판에서 고르지 않아 시간이 다 되면(자리를 비움) 기다리던 경험치를 놓는다. 혼자 하는 판은 놓지 않는다', () => {
  for (const players of [2, 1]) {
    const { w, ps } = quiet(60, players);
    const a = ps[0]!;
    const b = ps[1];
    if (b) {
      b.x = a.x + 3000;
      b.y = a.y;
    }
    w.gems.push({ id: 8401, x: a.x + 1500, y: a.y, v: 1 }, { id: 8402, x: a.x, y: a.y - 1800, v: 1 });
    putMagnet(w, a.x + 5, a.y);
    quietStep(w);
    a.offers = ['coffee'];
    const at = w.gems.map((g) => [g.x, g.y]);
    for (let i = 0; i < OFFER_TIMEOUT * 20 + 2; i++) quietStep(w);
    assert.equal(a.offers, null, `${players}명: 서버가 대신 골랐다`);
    assert.equal(a.tally.auto.coffee, 1);
    if (b) {
      assert.ok(w.gems.every((g) => g.to === undefined && g.hold === undefined), '함께: 놓였다 (누구나 주울 수 있다)');
      assert.deepEqual(w.gems.map((g) => [g.x, g.y]), at, '놓인 자리는 기다리던 자리');
      // 놓인 것은 b 가 다가가면 평소처럼 끌어당긴다
      const left = w.gems[0]!;
      b.x = left.x + 10;
      b.y = left.y;
      for (let i = 0; i < 20; i++) quietStep(w);
      assert.ok(!w.gems.includes(left));
      assert.equal(b.xp, 1);
    } else {
      assert.ok(w.gems.every((g) => g.to === a.id && g.hold === true), '혼자: 놓지 않고 이어서 끌려온다');
    }
  }
});

test('자석: 맵에 이미 자석이 있으면 그 차례는 건너뛰고, 다른 필드 아이템의 수(MAX_FIELD_ITEMS)에는 세지 않는다', () => {
  const { w, ps } = quiet(61);
  const p = ps[0]!;
  // 이미 있는 자석(멀리, 오래 남는다) + 때가 된 다음 자석
  w.items.push({ id: 8501, kind: 'magnet', x: p.x + 2000, y: p.y, ttl: 1e9 });
  w.magnetCd = 0;
  quietStep(w);
  assert.equal(w.items.filter((it) => it.kind === 'magnet').length, MAX_MAGNETS, '건너뛴다');
  assert.ok(w.magnetCd > MAGNET_INTERVAL * 0.6 - 1, '다음 차례는 다시 센다');
  // 피자·LGTM·백업이 가득(3개)이어도 자석은 놓이고, 자석이 있어도 피자·LGTM·백업은 3개까지 놓인다
  w.items.length = 0;
  for (let k = 0; k < MAX_FIELD_ITEMS; k++) w.items.push({ id: 8510 + k, kind: 'heal', x: p.x + 3000 + k, y: p.y, ttl: 1e9 });
  w.magnetCd = 0;
  quietStep(w);
  assert.equal(w.items.filter((it) => it.kind === 'magnet').length, 1, '다른 아이템이 가득이어도 자석은 놓인다');
  w.items = w.items.filter((it) => it.kind === 'magnet' || it.id !== 8510);
  w.itemCd = 0;
  quietStep(w);
  assert.equal(w.items.filter((it) => it.kind !== 'magnet' && it.kind !== 'chest').length, MAX_FIELD_ITEMS, '자석이 자리를 차지하지 않는다');
});

/** 무기 6칸·패시브 6칸을 모두 최대로 채운다 (더 올릴 것이 없다) */
function maxOut(p: Player): void {
  const weapons: UpgradeId[] = ['console_log', 'rubber_duck', 'hotfix', 'regex', 'ai_agent', 'firewall'];
  const passives = UPGRADE_IDS.filter((u) => UPGRADES[u].kind === 'passive').slice(0, 6);
  p.up = {};
  for (const u of [...weapons, ...passives]) p.up[u] = UPGRADES[u].max;
}

test('강화를 모두 마친 뒤의 레벨업: 선택지 대신 체력이 가득 찬다. 이미 가득이면 알리지 않고, 여러 번 올라도 한 번만 알린다', () => {
  const { w, ps } = quiet(57);
  const p = ps[0]!;
  maxOut(p);
  const max = Math.ceil(maxHpOf(p));
  // LGTM 으로 한 레벨
  p.hp = 12.4;
  p.xpNext = 50;
  p.xp = 0;
  const level = p.level;
  w.items.push({ id: w.nextId++, kind: 'levelup', x: p.x + 5, y: p.y, ttl: 60 });
  w.events.length = 0;
  quietStep(w);
  assert.equal(p.level, level + 1);
  assert.equal(p.offers, null, '선택지는 뜨지 않는다');
  assert.equal(p.hp, maxHpOf(p), '체력이 가득 찬다');
  assert.deepEqual(w.events.filter((e) => e.type === 'refill'), [{ type: 'refill', pid: p.id, hp: max - 13 }], '화면에 보이는 체력(올림) 기준으로 찬 양');
  // 이미 가득이면 알리지 않는다
  w.events.length = 0;
  w.items.push({ id: w.nextId++, kind: 'levelup', x: p.x + 5, y: p.y, ttl: 60 });
  quietStep(w);
  assert.equal(p.level, level + 2);
  assert.ok(!w.events.some((e) => e.type === 'refill'));
  // 한 번에 여러 레벨이 올라도(자석으로 많이 먹었다) 처음 한 번만 채우고 알린다
  p.hp = 1;
  p.xp = 0;
  p.xpNext = 5;
  w.events.length = 0;
  w.gems.push({ id: w.nextId++, x: p.x + 2, y: p.y, v: 1e6 });
  quietStep(w);
  assert.ok(p.level > level + 4, `여러 레벨 (${p.level})`);
  assert.equal(p.hp, maxHpOf(p));
  assert.equal(w.events.filter((e) => e.type === 'refill').length, 1);
});

test('강화가 남아 있으면 레벨업해도 체력은 그대로다 (선택지가 뜬다)', () => {
  const { w, ps } = quiet(58);
  const p = ps[0]!;
  p.hp = 20;
  p.xp = 0;
  p.xpNext = 5;
  w.events.length = 0;
  w.gems.push({ id: w.nextId++, x: p.x + 2, y: p.y, v: 5 });
  quietStep(w);
  assert.ok(p.offers && p.offers.length > 0);
  assert.equal(p.hp, 20);
  assert.ok(!w.events.some((e) => e.type === 'refill'));
});

test('강화를 모두 마친 뒤 연 보물상자: 남는 몫으로 체력을 가득 채운다 (몇 개짜리 상자든 한 번, 비밀 난수는 굴림에만)', () => {
  for (const odds of [[1, 0, 0, 0], [3, 0, 0, 0]] as const) {
    let calls = 0;
    const base = sfc32(62);
    const w = createWorld({ rng: sfc32(63), secret: () => (calls++, base()) });
    const p = addPlayer(w, 'a');
    p.xpNext = 1e9;
    p.cd.console_log = 1e9;
    w.itemCd = 1e9;
    w.magnetCd = 1e9;
    maxOut(p);
    p.hp = 9.2;
    w.items.push({ id: w.nextId++, kind: 'chest', x: p.x + 2, y: p.y, ttl: Infinity, chest: odds });
    w.events.length = 0;
    calls = 0;
    quietStep(w);
    const ev = w.events.find((e) => e.type === 'chest');
    assert.ok(ev && ev.type === 'chest', '열렸다');
    assert.deepEqual(ev.items, [], '오른 것은 없다');
    assert.equal(p.hp, maxHpOf(p), `${odds[0]}: 체력이 가득`);
    assert.equal(ev.heal, Math.ceil(maxHpOf(p)) - 10, '찬 양은 화면에 보이는 체력(올림) 기준, 몇 몫이든 한 번');
    assert.equal(calls, 3, '비밀 난수는 5·3·1개 굴림에만 (예전과 같은 횟수)');
  }
});
