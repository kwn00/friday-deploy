import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DT,
  OFFER_REROLLS,
  OFFER_TIMEOUT,
  PASSIVE_IDS,
  PASSIVE_SLOTS,
  UPGRADES,
  WEAPON_IDS,
  WEAPON_SLOTS,
  addPlayer,
  canReroll,
  createWorld,
  evolutionOf,
  parseClientMsg,
  pickOffer,
  rerollOffers,
  step,
  type Player,
  type UpgradeId,
  type World,
} from './index';

/** 아무것도 저절로 생기지 않는 월드 (스폰·아이템이 끼어들지 않게) */
function quietWorld(seed: number): { w: World; p: Player } {
  const w = createWorld(seed);
  const p = addPlayer(w, 'a');
  p.xpNext = 1e9;
  w.itemCd = 1e9;
  return { w, p };
}

/** 경험치를 하나 주워 레벨업 선택지를 띄운다 */
function levelUp(w: World, p: Player): UpgradeId[] {
  p.xp = p.xpNext = 5;
  w.gems.push({ id: w.nextId++, x: p.x, y: p.y, v: 1 });
  w.wave = Math.floor((w.time + DT) / 60);
  w.spawnCd = 1e9;
  step(w, DT);
  w.enemies = [];
  assert.ok(p.offers, '선택지가 뜬다');
  return [...p.offers];
}

/** 무기 6칸·패시브 6칸을 채우고, keep 에 든 것만 최대 단계 아래로 둔다 (선택지에 나올 수 있는 것 = keep) */
function onlyLeft(p: Player, keep: UpgradeId[]): void {
  p.up = {};
  const weapons = WEAPON_IDS.filter((u) => !evolutionOf(u)).slice(0, WEAPON_SLOTS);
  const passives = PASSIVE_IDS.slice(0, PASSIVE_SLOTS);
  for (const id of [...weapons, ...passives]) p.up[id] = keep.includes(id) ? 1 : UPGRADES[id].max;
}

test('새로고침: 한 판에 두 번. 지금 카드를 빼고 다시 뽑고, 카드 수와 제한 시간은 처음처럼', () => {
  assert.equal(OFFER_REROLLS, 2);
  const { w, p } = quietWorld(7);
  assert.equal(p.rerolls, OFFER_REROLLS, '판을 시작할 때 두 번');
  const first = levelUp(w, p);
  assert.ok(canReroll(p));
  p.offerTimer = 12;
  assert.equal(rerollOffers(w, p.id), true);
  const second = [...p.offers!];
  assert.equal(second.length, first.length, '카드 수는 그대로');
  assert.ok(
    second.every((u) => !first.includes(u)),
    `처음 카드(${first})는 다시 나오지 않는다: ${second}`,
  );
  assert.equal(new Set(second).size, second.length, '겹치는 카드가 없다');
  assert.equal(p.offerTimer, 0, '제한 시간은 처음부터');
  assert.equal(p.rerolls, 1);
  assert.deepEqual(w.events.at(-1), { type: 'offers', pid: p.id }, '새 선택지를 알리는 이벤트');

  assert.equal(rerollOffers(w, p.id), true);
  assert.ok(p.offers!.every((u) => !second.includes(u)));
  assert.equal(p.rerolls, 0);
  const third = [...p.offers!];
  assert.equal(canReroll(p), false, '다 썼다');
  assert.equal(rerollOffers(w, p.id), false);
  assert.deepEqual(p.offers, third, '받지 않으면 선택지도 그대로');
  assert.equal(p.rerolls, 0);

  // 레벨업마다가 아니라 한 판 전체에서 두 번이다
  assert.equal(pickOffer(w, p.id, 0), true);
  levelUp(w, p);
  assert.equal(p.rerolls, 0);
  assert.equal(canReroll(p), false);
  assert.equal(rerollOffers(w, p.id), false);
});

test('새로고침: 선택 중이 아니면 받지 않는다 (횟수도 줄지 않는다)', () => {
  const { w, p } = quietWorld(8);
  assert.equal(p.offers, null);
  assert.equal(canReroll(p), false);
  assert.equal(rerollOffers(w, p.id), false);
  assert.equal(rerollOffers(w, 9999), false, '없는 플레이어');
  assert.equal(p.rerolls, OFFER_REROLLS);
});

test('새로고침: 배포 기도로 4개였으면 새 카드도 4개', () => {
  const { w, p } = quietWorld(9);
  let tries = 0;
  for (;;) {
    p.up = { console_log: 1, deploy_prayer: 5 };
    levelUp(w, p);
    if (p.offers!.length === 4) break;
    p.offers = null;
    assert.ok(++tries < 200, '4개짜리 선택지가 나온다');
  }
  const old = [...p.offers!];
  assert.equal(rerollOffers(w, p.id), true);
  assert.equal(p.offers!.length, 4);
  assert.ok(p.offers!.every((u) => !old.includes(u)));
});

test('새로고침: 새로 나올 것이 모자라면 지금 카드 중에서 채우고, 하나도 없으면 받지 않는다', () => {
  const { w, p } = quietWorld(10);
  const left: UpgradeId[] = ['console_log', 'rubber_duck', 'coffee', 'mech_keyboard'];
  onlyLeft(p, left);
  const shown = levelUp(w, p);
  assert.equal(shown.length, 3);
  assert.ok(shown.every((u) => left.includes(u)));
  const fresh = left.find((u) => !shown.includes(u))!;
  assert.equal(rerollOffers(w, p.id), true);
  assert.equal(p.offers!.length, 3, '카드 수는 그대로');
  assert.ok(p.offers!.includes(fresh), `새로 나올 수 있는 것(${fresh})은 반드시 나온다`);
  assert.equal(p.offers!.filter((u) => shown.includes(u)).length, 2, '나머지는 지금 카드에서');
  assert.equal(new Set(p.offers).size, 3);

  // 올릴 수 있는 것이 모두 보이고 있다: 새로고침해도 같은 카드뿐이라 받지 않는다
  p.offers = null;
  onlyLeft(p, left.slice(0, 3));
  levelUp(w, p);
  assert.equal(p.offers!.length, 3);
  const before = p.rerolls;
  assert.equal(canReroll(p), false);
  assert.equal(rerollOffers(w, p.id), false);
  assert.equal(p.rerolls, before, '횟수가 줄지 않는다');
});

test('새로고침: 칸이 찼으면 새 것은 나오지 않고, 진화한 무기와 최대 단계인 것도 나오지 않는다', () => {
  const { w, p } = quietWorld(11);
  const weapons = WEAPON_IDS.filter((u) => !evolutionOf(u)).slice(0, WEAPON_SLOTS);
  const passives = PASSIVE_IDS.slice(0, PASSIVE_SLOTS);
  for (let round = 0; round < 80; round++) {
    p.up = {};
    for (const id of [...weapons, ...passives]) p.up[id] = 1;
    p.up.mech_keyboard = UPGRADES.mech_keyboard.max;
    p.rerolls = OFFER_REROLLS;
    levelUp(w, p);
    while (canReroll(p)) {
      assert.equal(rerollOffers(w, p.id), true);
      for (const id of p.offers!) {
        assert.ok(id in p.up, `${round}: 칸이 찼는데 새 것(${id})이 나왔다`);
        assert.notEqual(id, 'mech_keyboard', '최대 단계인 것은 나오지 않는다');
        assert.equal(evolutionOf(id), undefined, '진화한 무기는 보물상자로만');
      }
    }
    p.offers = null;
  }
});

test('새로고침: 통계의 offered 에는 새로 나온 카드만 더한다', () => {
  const { w, p } = quietWorld(12);
  const left: UpgradeId[] = ['console_log', 'rubber_duck', 'coffee', 'mech_keyboard'];
  onlyLeft(p, left);
  const shown = levelUp(w, p);
  const before = { ...p.tally.offered };
  assert.ok(shown.every((u) => before[u] === 1));
  assert.equal(rerollOffers(w, p.id), true);
  for (const u of left) {
    const added = (p.tally.offered[u] ?? 0) - (before[u] ?? 0);
    assert.equal(added, shown.includes(u) ? 0 : 1, `${u}: 그대로 남은 카드는 한 번만 센다`);
  }
  assert.deepEqual(p.tally.picked, {}, '고른 것은 아직 없다');
});

test('새로고침: 비밀 난수만 쓴다 (보이는 난수를 건드리면 화면의 스폰으로 새 선택지가 새어 나갈 수 있다)', () => {
  const { w, p } = quietWorld(13);
  levelUp(w, p);
  let visible = 0;
  const rng = w.rng;
  w.rng = () => {
    visible++;
    return rng();
  };
  let secret = 0;
  const sec = w.secret;
  w.secret = () => {
    secret++;
    return sec();
  };
  assert.equal(rerollOffers(w, p.id), true);
  assert.equal(visible, 0);
  assert.ok(secret > 0);
});

test('새로고침: 혼자 하는 판은 고르는 동안 시간이 멈추고, 새로고침해도 제한 시간이 지나면 첫 카드가 골라진다', () => {
  const { w, p } = quietWorld(14);
  levelUp(w, p);
  const t0 = w.time;
  for (let i = 0; i < 10 / DT; i++) step(w, DT);
  assert.equal(w.time, t0, '월드는 멈춰 있다');
  assert.equal(rerollOffers(w, p.id), true);
  const first = p.offers![0]!;
  const lvBefore = p.up[first] ?? 0;
  // 새로고침 뒤 처음부터 다시 20초 (그 전의 10초는 세지 않는다)
  for (let i = 0; i < (OFFER_TIMEOUT - 1) / DT; i++) step(w, DT);
  assert.ok(p.offers, '아직 고르는 중');
  for (let i = 0; i < 2 / DT; i++) step(w, DT);
  assert.equal(p.offers, null, '시간이 지나 서버가 골랐다');
  assert.equal(p.up[first], lvBefore + 1);
  assert.equal(p.tally.auto[first], 1);
});

test('통신: reroll 은 어느 선택지(레벨)를 새로고침하는지만 싣는다 (다른 값을 실어 보내도 받지 않는다)', () => {
  assert.deepEqual(parseClientMsg('{"t":"reroll","level":3}'), { t: 'reroll', level: 3 });
  assert.deepEqual(parseClientMsg('{"t":"reroll","level":3,"offers":["coffee"],"rerolls":99}'), { t: 'reroll', level: 3 });
  for (const bad of ['{"t":"reroll"}', '{"t":"reroll","level":-1}', '{"t":"reroll","level":1.5}', '{"t":"reroll","level":"3"}', '{"t":"reroll","level":1e9}'])
    assert.equal(parseClientMsg(bad), null, bad);
});
