import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DT,
  ownedUpgrades,
  upgradesOf,
  ENEMY_IDS,
  OFFER_COUNT,
  PASSIVE_IDS,
  PASSIVE_SLOTS,
  SHOT_KINDS,
  UPGRADES,
  UPGRADE_IDS,
  VIEW_RADIUS,
  WEAPON_IDS,
  WEAPON_SLOTS,
  ZONE_KINDS,
  addPlayer,
  buildSnapshot,
  createWorld,
  decodeSnapshot,
  effectiveStats,
  encodeSnapshot,
  evolutionOf,
  maxHpOf,
  pickOffer,
  setInput,
  step,
  upgradeText,
  weaponStats,
  type Enemy,
  type Player,
  type UpgradeId,
  type WeaponId,
  type World,
} from './index';

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
/** 다음 틱에 웨이브가 적을 내지 않게 한다 (분이 바뀌어도) */
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

test('강화 정의: 개수, 최대 단계, 단계별 증가분이 맞고, 통신 번호가 1바이트 안에 든다', () => {
  // 무기 23종 + 진화한 무기 6종 (진화한 무기는 뒤에 붙였다)
  assert.equal(WEAPON_IDS.length, 29);
  assert.equal(WEAPON_IDS.filter((id) => !evolutionOf(id)).length, 23);
  assert.equal(PASSIVE_IDS.length, 15);
  assert.equal(new Set(UPGRADE_IDS).size, UPGRADE_IDS.length, 'id 가 겹치지 않는다');
  // 통신 순서: 예전 것들이 같은 자리에 있다 (뒤에만 붙였다)
  assert.deepEqual(WEAPON_IDS.slice(0, 4), ['console_log', 'rubber_duck', 'regex', 'ai_agent']);
  assert.equal(WEAPON_IDS.indexOf('debugger'), 23, '진화한 무기는 원래 무기 23종 뒤에');
  assert.deepEqual(PASSIVE_IDS.slice(0, 6), ['coffee', 'mech_keyboard', 'stack_overflow', 'npm_install', 'dark_mode', 'dual_monitor']);
  assert.ok(ENEMY_IDS.length < 64 && SHOT_KINDS.length < 256 && ZONE_KINDS.length < 256);
  for (const id of UPGRADE_IDS) {
    const def = UPGRADES[id];
    assert.ok(def.name && def.icon && def.desc, id);
    if (def.kind === 'weapon') {
      assert.equal(def.levels.length, def.max - 1, `${id}: 단계 수`);
      const max: Partial<Record<UpgradeId, number>> = { code_freeze: 7, two_factor: 7, logic_bomb: 6 };
      // 진화한 무기는 단계가 하나뿐이고 레벨업 선택지에 나오지 않는다
      if (evolutionOf(id)) assert.deepEqual([def.max, def.rarity], [1, 0], `${id}: 진화한 무기`);
      else assert.equal(def.max, max[id] ?? 8, `${id}: 최대 단계 (뱀서: Clock Lancet·Laurel 7, Bracelet 6, 나머지 8)`);
      for (let l = 1; l <= def.max; l++) {
        const s = weaponStats(id as WeaponId, l);
        for (const [k, v] of Object.entries(s)) assert.ok(Number.isFinite(v) && v >= 0, `${id} ${l}단계 ${k}=${v}`);
        assert.ok(s.cd > 0, `${id} 쿨다운`);
      }
    } else {
      assert.ok([2, 5].includes(def.max), `${id}: 패시브는 5단계 (git fork, 스냅샷은 2)`);
    }
    // 선택지 문구: 모든 단계에 있고, 휴대폰 선택지 카드에 들어갈 만큼 짧다
    for (let l = 1; l <= def.max; l++) {
      const text = upgradeText(id, l);
      assert.ok(text.length > 0 && text.length <= 60, `${id} ${l}단계 "${text}" (${text.length}자)`);
    }
  }
  assert.equal(upgradeText('regex', 3), '피해 +5, 개수 +1');
  assert.equal(upgradeText('coffee', 1), '이동 속도가 빨라진다. (이동 속도 +10%)');
  assert.equal(upgradeText('npm_install', 2), '끌어당기는 범위 +33%');
  assert.equal(upgradeText('infinite_scroll', 3), '쿨다운 +0.75초, 지속 +0.5초', '쿨다운이 느는 단계는 + 로 보인다');
  assert.equal(upgradeText('two_factor', 4), '방패 +1');
});

test('뱀서 수치: 최대 단계의 피해·쿨다운·개수·관통·지속이 위키의 같은 무기 값과 같다', () => {
  // [우리 무기, 최대 단계의 dmg, cd, amount, (뱀서 pierce - 1), dur] (위키 Infobox 의 max-* 값)
  const table: [WeaponId, number, number, number, number | null, number | null][] = [
    ['console_log', 30, 1.0, 4, 1, null], // Magic Wand: 30 / 1.0s / 4 / pierce 2
    ['regex', 16.5, 1.0, 6, 2, null], // Knife: 16.5 / 6 / pierce 3
    ['ai_agent', 90, 3.0, 3, 0, null], // Fire Wand: 90
    ['ctrl_x', 40, 1.35, 2, null, null], // Whip: 40 / 2
    ['brick_book', 80, 4.0, 3, 6, null], // Axe: 80 / 3 / pierce 7
    ['rollback', 35, 2.0, 3, null, null], // Cross: 35 / 3
    ['firewall', 15, 1.0, 1, null, null], // Garlic: 15 / 1.0s
    ['hotfix', 40, 4.5, 4, null, 3.0], // Santa Water: 40 / 4 / 3.0s
    ['ping_pong', 30, 3.0, 3, null, 3.25], // Runetracer: 30 / 3 / 3.25s
    ['hot_reload', 65, 4.5, 6, null, null], // Lightning Ring: 65 / 6
    ['git_clean', 0, 60, 1, null, null], // Pentagram: 60s
    ['canary', 30, 0.5, 11, null, 4.0], // Peachone: 30 / 0.5s / 11
    ['broadcast', 15, 1.4, 3, 6, null], // Phiera: 15 / 3 / pierce 7
    ['keyboard_cat', 10, 5.0, 3, null, 8.0], // Gatti Amari: 3 / 8s
    ['infinite_scroll', 40, 4.25, 1, null, 2.0], // Song of Mana: 40 / 4.25s / 2s
    ['commit_history', 25, 6.0, 2, null, 1.75], // Shadow Pinion: 25 / 2 / 1.75s
    ['code_freeze', 0, 1.0, 1, null, 6.0], // Clock Lancet: 1.0s / 6s
    ['two_factor', 0, 8.0, 3, null, null], // Laurel: 8s / 충전 3
    ['sprint', 6, 2.0, 7, null, 0.4], // Vento Sacro: 6 / 7
    ['logic_bomb', 30, 1.4, 4, 2, 0.4], // Bracelet: 30 / 4 / pierce 3
  ];
  for (const [id, dmg, cd, amount, pierce, dur] of table) {
    const s = weaponStats(id, UPGRADES[id].max);
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
    assert.ok(near(s.dmg, dmg) && near(s.cd, cd) && near(s.amount, amount), `${id}: ${s.dmg}/${s.cd}/${s.amount}`);
    if (pierce !== null) assert.equal(s.pierce, pierce, `${id} 관통`);
    if (dur !== null) assert.ok(near(s.dur, dur), `${id} 지속 ${s.dur}`);
  }
  // 1단계 = 뱀서의 기본값
  assert.deepEqual([weaponStats('console_log', 1).dmg, weaponStats('console_log', 1).cd], [10, 1.2], 'Magic Wand 10 / 1.2s');
  assert.equal(weaponStats('regex', 1).dmg, 6.5, 'Knife 6.5');
  assert.equal(weaponStats('hotfix', 2).area, weaponStats('hotfix', 1).area * 1.2, 'Santa Water 2단계 범위 +20%');
  // 레벨업 무게(rarity)
  assert.deepEqual([UPGRADES.console_log.rarity, UPGRADES.logic_bomb.rarity, UPGRADES.snapshot.rarity], [100, 40, 40]);
});

test('칸 제한: 무기 6칸·패시브 6칸이 차면 새 것은 선택지에 나오지 않고, 최대 단계인 것도 나오지 않는다', () => {
  const { w, p } = quietWorld(61);
  const weapons = WEAPON_IDS.slice(0, WEAPON_SLOTS);
  const passives = PASSIVE_IDS.slice(0, PASSIVE_SLOTS);
  p.up = {};
  for (const id of weapons) p.up[id] = 1;
  for (const id of passives) p.up[id] = 1;
  p.up.mech_keyboard = UPGRADES.mech_keyboard.max;
  const owned = new Set<UpgradeId>([...weapons, ...passives]);
  for (let round = 0; round < 60; round++) {
    p.xp = p.xpNext = 5;
    w.gems.push({ id: w.nextId++, x: p.x, y: p.y, v: 1 });
    tick(w, []);
    assert.ok(p.offers, `${round}: 선택지가 뜬다`);
    for (const id of p.offers) {
      assert.ok(owned.has(id), `${round}: 칸이 찼는데 새 것(${id})이 나왔다`);
      assert.notEqual(id, 'mech_keyboard', '최대 단계인 것은 나오지 않는다');
    }
    // 남은 강화가 적으면 선택지도 그만큼 적다 (거의 다 최대가 됐을 때)
    assert.ok(p.offers.length >= 1 && p.offers.length <= OFFER_COUNT + 1);
    pickOffer(w, p.id, round % p.offers.length);
    for (const id of owned) assert.ok((p.up[id] ?? 0) <= UPGRADES[id].max, `${id} 단계 상한`);
  }
  // 모두 최대가 되면 선택지 대신 회복 아이템 하나만큼 (30) 채운다 (뱀서: 금화 또는 Floor Chicken. 우리는 금화가 없다)
  for (const id of owned) p.up[id] = UPGRADES[id].max;
  p.hp = 10;
  p.xp = p.xpNext = 5;
  w.gems.push({ id: w.nextId++, x: p.x, y: p.y, v: 1 });
  tick(w, []);
  assert.equal(p.offers, null);
  assert.equal(p.hp, 40);
});

test('칸 제한: 칸이 남아 있으면 처음 보는 것도 나온다 (무기 1개로 시작)', () => {
  const { w, p } = quietWorld(62);
  const seen = new Set<UpgradeId>();
  for (let round = 0; round < 40; round++) {
    p.up = { console_log: 1 };
    p.xp = p.xpNext = 5;
    w.gems.push({ id: w.nextId++, x: p.x, y: p.y, v: 1 });
    tick(w, []);
    for (const id of p.offers ?? []) seen.add(id);
    p.offers = null;
  }
  assert.ok([...seen].some((id) => UPGRADES[id].kind === 'weapon' && id !== 'console_log'));
  assert.ok([...seen].some((id) => UPGRADES[id].kind === 'passive'));
});

test('무기: 피해를 주는 무기 21종과 진화한 무기 6종은 저마다 혼자서 가까이 온 적을 다치게 한다', () => {
  const quiet = new Set<UpgradeId>(['code_freeze', 'two_factor']);
  for (const id of WEAPON_IDS) {
    if (quiet.has(id)) continue;
    const { w, p } = quietWorld(70 + WEAPON_IDS.indexOf(id));
    p.up = { [id]: 1 };
    // 사방에 두 겹으로 적을 둔다: 바로 옆(30)과, 카나리아·부엉이가 도는 거리(64).
    // 방향을 가리는 무기도 하나는 맞히게. 움직이며 쓰는 무기를 위해 천천히 걷는다
    const at = (k: number): [number, number] => {
      const d = k < 8 ? 30 : 64;
      return [p.x + Math.cos((k * Math.PI) / 4) * d, p.y + Math.sin((k * Math.PI) / 4) * d];
    };
    const ring = Array.from({ length: 16 }, (_, k) => enemy(9000 + k, ...at(k)));
    // 천천히 걷기 (0.3 이상이어야 걷는 것으로 친다)
    setInput(w, p.id, 0.35, 0);
    let hurt = false;
    for (let i = 0; i < 20 * 70 && !hurt; i++) {
      p.hp = 1e9;
      for (const [k, e] of ring.entries()) [e.x, e.y] = at(k);
      tick(w, ring);
      hurt = ring.some((e) => e.hp < 1e9);
    }
    assert.ok(hurt, `${id}: 70초 안에 한 번도 맞히지 못했다`);
  }
});

test('코드 프리즈: 맞은 적은 얼어서 움직이지도 때리지도 못하고, 시간이 지나면 풀린다', () => {
  const { w, p } = quietWorld(81);
  p.up = { code_freeze: 1 };
  const e = enemy(9100, p.x, p.y - 40, 'bug');
  // 처음 광선은 위쪽(12시 다음 칸)부터 시계 방향으로 돈다: 여러 방향에 적을 둬서 언젠가 맞게 한다
  const all = [e, enemy(9101, p.x + 40, p.y, 'bug'), enemy(9102, p.x, p.y + 40, 'bug'), enemy(9103, p.x - 40, p.y, 'bug')];
  let frozen: Enemy | undefined;
  for (let i = 0; i < 20 * 12 && !frozen; i++) {
    p.hp = 100;
    tick(w, all);
    frozen = all.find((x) => x.frozen > 0);
  }
  assert.ok(frozen, '얼었다');
  const snap = decodeSnapshot(encodeSnapshot(buildSnapshot(w, p.id)!));
  assert.equal(snap.e.find((r) => r[0] === frozen.id)![5], 1, '스냅샷에 얼음 표시');
  // 옆에 붙여 둬도 움직이지도 때리지도 못한다
  p.up = {};
  frozen.x = p.x + 3;
  frozen.y = p.y;
  const hp = p.hp;
  const x = frozen.x;
  for (let i = 0; i < 10; i++) tick(w, [frozen]);
  assert.equal(frozen.x, x);
  assert.equal(p.hp, hp);
  for (let i = 0; i < 20 * 2; i++) tick(w, [frozen]);
  assert.equal(frozen.frozen, 0);
  assert.ok(p.hp < hp, '풀리면 다시 때린다');
});

test('2단계 인증: 방패가 한 대를 대신 막고 잠깐 무적이 된다. 방패를 다 쓰면 쿨다운 뒤에 다시 찬다', () => {
  const { w, p } = quietWorld(82);
  p.up = { two_factor: 1 };
  const e = enemy(9200, p.x + 3, p.y, 'merge_conflict');
  tick(w, []);
  assert.equal(p.charges, 1, '처음 얻으면 바로 방패가 찬다');
  assert.equal(buildSnapshot(w, p.id)!.p[0]![11], 1, '스냅샷에 방패 수');
  const hp = p.hp;
  tick(w, [e]);
  assert.equal(p.hp, hp, '첫 대는 방패가 막는다');
  assert.equal(p.charges, 0);
  assert.ok(p.iframe > 0.2, `방패가 막으면 무적 ${p.iframe}`);
  for (let i = 0; i < 20; i++) {
    e.x = p.x + 3;
    e.y = p.y;
    tick(w, [e]);
  }
  assert.ok(p.hp < hp, '방패를 다 쓰면 다시 맞는다');
  // 쿨다운(10초) 뒤에 다시 찬다
  for (let i = 0; i < 20 * 11; i++) tick(w, []);
  assert.equal(p.charges, 1);
});

test('git clean (뱀서 Pentagram): 화면 안의 적을 사신만 빼고 지운다. 한 번 굴려 아이템까지 지우거나, 경험치를 주고 아이템은 남긴다. 보물상자는 언제나 남는다', () => {
  for (const keep of [false, true]) {
    const { w, p } = quietWorld(83);
    p.up = { git_clean: 1 };
    // 남길 확률은 10% (1단계). 보이는 난수를 고정해 두 경우를 본다
    w.rng = () => (keep ? 0 : 0.99);
    const bugs = [enemy(9300, p.x + 100, p.y, 'bug', 10), enemy(9301, p.x - 300, p.y, 'null_ptr', 28)];
    const far = enemy(9302, p.x + VIEW_RADIUS + 30, p.y, 'bug', 10);
    const boss = { ...enemy(9303, p.x, p.y + 150, 'legacy_code', 5000), chest: [1, 0, 0, 100] as const };
    const reaper = enemy(9305, p.x - 40, p.y - 40, 'monday', 1e9);
    w.gems.push({ id: 9304, x: p.x + 50, y: p.y + 50, v: 3 });
    w.heals.push({ id: 9306, x: p.x - 60, y: p.y });
    // 필드 아이템: 화면 안(주울 수 있는 거리 밖)의 셋과 화면 밖의 하나. 보물상자: 전에 잡은 보스가 화면 안과 밖에 남긴 것
    const inView = [9310, 9311, 9312];
    w.items.push(
      { id: 9310, kind: 'heal', x: p.x + 120, y: p.y, ttl: 60 },
      { id: 9311, kind: 'levelup', x: p.x, y: p.y - 200, ttl: 60 },
      { id: 9312, kind: 'revive', x: p.x - 150, y: p.y + 150, ttl: 60 },
      { id: 9313, kind: 'levelup', x: p.x + VIEW_RADIUS + 30, y: p.y, ttl: 60 },
      { id: 9314, kind: 'chest', x: p.x - 100, y: p.y - 100, ttl: Infinity, chest: [1, 0, 0, 0] },
      { id: 9315, kind: 'chest', x: p.x, y: p.y + VIEW_RADIUS + 30, ttl: Infinity, chest: [1, 0, 0, 0] },
    );
    tick(w, [...bugs, far, boss, reaper]);
    assert.ok(bugs.every((e) => e.hp <= 0) && boss.hp <= 0, `${keep}: 화면 안의 적(보스 포함)은 지워진다`);
    assert.ok(far.hp > 0, '화면 밖은 그대로');
    assert.ok(reaper.hp > 0, '사신은 버틴다');
    assert.equal(p.kills, 3);
    const ids = new Set(w.items.map((it) => it.id));
    assert.equal(w.items.filter((it) => it.kind === 'chest' && it.id !== 9314 && it.id !== 9315).length, 1, `${keep}: 지워진 보스의 상자는 떨어진다`);
    assert.ok(ids.has(9314) && ids.has(9315), `${keep}: 땅에 있던 보물상자는 화면 안이어도 남는다`);
    assert.ok(ids.has(9313), `${keep}: 화면 밖의 필드 아이템은 그대로`);
    if (keep) {
      assert.ok(w.gems.length >= 4, `남기는 쪽: 처치한 것처럼 경험치가 떨어지고 있던 것도 남는다 (${w.gems.length})`);
      assert.equal(w.heals.length, 1);
      assert.ok(inView.every((id) => ids.has(id)), '남기는 쪽: 화면 안의 필드 아이템도 남는다');
    } else {
      assert.equal(w.gems.length, 0, '지우는 쪽: 경험치를 남기지 않고, 있던 것도 지운다');
      assert.equal(w.heals.length, 0);
      assert.ok(inView.every((id) => !ids.has(id)), '지우는 쪽: 화면 안의 필드 아이템(피자·LGTM·백업)도 지운다');
    }
  }
});

test('rm -rf node_modules: 화면 안의 필드 아이템과 보물상자를 지우지 않는다', () => {
  const { w, p } = quietWorld(85);
  p.up = { rm_rf: 1 };
  w.rng = () => 0.99; // git clean 이었다면 지우는 쪽이 나올 난수
  w.items.push(
    { id: 9320, kind: 'levelup', x: p.x + 150, y: p.y, ttl: 60 },
    { id: 9321, kind: 'chest', x: p.x - 150, y: p.y, ttl: Infinity, chest: [1, 0, 0, 0] },
  );
  tick(w, [enemy(9322, p.x + 100, p.y, 'bug', 10)]);
  assert.ok(w.zones.some((z) => z.kind === 'wipe'), '썼다');
  assert.deepEqual(w.items.map((it) => it.id).sort(), [9320, 9321]);
});

test('영역은 생긴 틱의 스냅샷에만 남는 시간과 함께 실린다 (전송량)', () => {
  const { w, p } = quietWorld(84);
  p.up = { hotfix: 1 };
  const e = enemy(9400, p.x + 60, p.y, 'merge_conflict');
  let first: number[] | undefined;
  let at = 0;
  for (let i = 0; i < 20 * 6 && !first; i++) {
    tick(w, [e]);
    first = buildSnapshot(w, p.id)!.z[0];
    at = w.tick;
  }
  assert.ok(first, '웅덩이가 생겼다');
  assert.equal(ZONE_KINDS[first[1]!], 'pool');
  // 생긴 틱에 이미 한 틱이 지났으므로, 이 스냅샷 다음으로 39틱 더 보인다 (모두 2초 = 40틱)
  assert.equal(first[6], 39, '이 스냅샷 뒤로 39틱 더 남는다');
  tick(w, [e]);
  assert.ok(w.tick > at);
  assert.equal(buildSnapshot(w, p.id)!.z.length, 0, '다음 틱에는 다시 싣지 않는다');
  assert.ok(w.zones.length > 0, '서버에는 남아서 계속 다치게 한다');
  const before = e.hp;
  for (let i = 0; i < 20; i++) tick(w, [e]);
  assert.ok(e.hp < before);
});

test('패시브: 테스트 커버리지는 받는 피해를 줄이고, 워라밸은 체력을 채운다', () => {
  const taken = (armor: number): number => {
    const { w, p } = quietWorld(85);
    p.up = { test_coverage: armor };
    p.cd.console_log = 1e9;
    const e = enemy(9500, p.x + 3, p.y, 'bug');
    for (let i = 0; i < 20; i++) {
      e.x = p.x + 3;
      tick(w, [e]);
    }
    return 100 - p.hp;
  };
  // 한 대씩, 맞으면 0.24초 무적 → 1초(20틱)에 4대. 버그 공격력 5, 방어(테스트 커버리지)는 한 대에 1씩, 최소 1
  assert.equal(taken(0), 20, `기본: 5 × 4대 (${taken(0)})`);
  assert.equal(taken(3), 8, `3단계: 2 × 4대 (${taken(3)})`);
  assert.equal(taken(5), 4, `5단계: 최소 1 × 4대 (${taken(5)})`);
  const { w, p } = quietWorld(86);
  p.up = { work_life: 5 };
  p.hp = 50;
  for (let i = 0; i < 20 * 10; i++) tick(w, []);
  assert.ok(Math.abs(p.hp - 60) < 0.01, `10초에 +10 (${p.hp})`);
});

test('패시브: 다크 모드는 최대 체력을 1.2배씩 곱하고(회복은 없다), 스냅샷은 부활을 주고, 사이드 프로젝트는 경험치를 늘린다', () => {
  const { w, p } = quietWorld(87);
  p.hp = 60;
  p.offers = ['dark_mode'];
  pickOffer(w, p.id, 0);
  assert.equal(maxHpOf(p), 120);
  assert.equal(p.hp, 60, '고른다고 회복하지는 않는다 (뱀서 Hollow Heart)');
  assert.ok(Math.abs(maxHpOf({ up: { dark_mode: 5 } }) - 248.832) < 1e-9, '5단계: 100 × 1.2⁵');
  p.offers = ['snapshot'];
  pickOffer(w, p.id, 0);
  assert.equal(p.revives, 1);
  p.offers = ['snapshot'];
  pickOffer(w, p.id, 0);
  assert.equal(p.revives, 2);
  p.up.side_project = 5;
  p.xp = 0;
  w.gems.push({ id: 9600, x: p.x, y: p.y, v: 10 });
  tick(w, []);
  assert.equal(p.xp, 14, '경험치 10 × 1.4');
});

test('패시브: 배포 기도가 있으면 가끔 선택지가 4개, 없으면 늘 3개', () => {
  const count = (luck: number): number[] => {
    const { w, p } = quietWorld(88);
    const n: number[] = [];
    for (let i = 0; i < 200; i++) {
      p.up = { console_log: 1, ...(luck ? { deploy_prayer: luck } : {}) };
      p.xp = p.xpNext = 5;
      w.gems.push({ id: w.nextId++, x: p.x, y: p.y, v: 1 });
      tick(w, []);
      n.push(p.offers!.length);
      p.offers = null;
    }
    return n;
  };
  assert.ok(count(0).every((n) => n === 3));
  const lucky = count(5).filter((n) => n === 4).length / 200;
  assert.ok(lucky > 0.22 && lucky < 0.45, `5단계: 운 1.5 → 1 - 1/1.5 = 약 33% (${lucky})`);
});

test('패시브: 운영 서버 직접 수정은 내 주변에 나오는 적을 더 세고 빠르게, 더 자주 나오게 한다', () => {
  const spawned = (curse: number): { n: number; hp: number; spd: number } => {
    const w = createWorld(89);
    const p = addPlayer(w, 'a');
    p.xpNext = 1e9;
    p.up = curse ? { prod_hotfix: curse } : {};
    p.cd.console_log = 1e9;
    let n = 0;
    const seen = new Set<number>();
    // 적 수 상한(140)에 닿기 전까지만 센다
    for (let i = 0; i < 20 * 25; i++) {
      p.hp = 1e9;
      step(w, DT);
      for (const e of w.enemies) if (!seen.has(e.id)) seen.add(e.id), n++;
    }
    const bug = w.enemies.find((e) => e.type === 'bug')!;
    return { n, hp: bug.hp, spd: bug.spd };
  };
  const base = spawned(0);
  const cursed = spawned(5);
  assert.ok(cursed.n > base.n * 1.3, `등장 수 ${base.n} → ${cursed.n}`);
  assert.equal(cursed.spd, 1.5);
  assert.ok(cursed.hp > base.hp * 1.4, `체력 ${base.hp} → ${cursed.hp}`);
});

test('패시브: git fork 는 개수를, keep-alive 는 지속을, CDN 은 속도를, 기계식 키보드는 쿨다운을 바꾼다', () => {
  const p = { up: { hotfix: 1 } as Partial<Record<UpgradeId, number>> };
  const base = effectiveStats(p, 'hotfix');
  p.up = { hotfix: 1, git_fork: 2, keep_alive: 5, cdn: 5, mech_keyboard: 5, stack_overflow: 5, dual_monitor: 5 };
  const all = effectiveStats(p, 'hotfix');
  assert.equal(all.amount, base.amount + 2);
  assert.ok(Math.abs(all.dur - base.dur * 1.5) < 1e-9);
  assert.ok(Math.abs(all.cd - base.cd * 0.6) < 1e-9);
  assert.ok(Math.abs(all.dmg - base.dmg * 1.5) < 1e-9);
  assert.ok(Math.abs(all.area - base.area * 1.5) < 1e-9);
  const ping = effectiveStats({ up: { ping_pong: 1, cdn: 5 } }, 'ping_pong');
  assert.ok(Math.abs(ping.speed - 300) < 1e-9);
  // 단계가 정의보다 높게 들어와도 최대 단계로 친다
  assert.deepEqual(effectiveStats({ up: { regex: 99 } }, 'regex'), effectiveStats({ up: { regex: 8 } }, 'regex'));
});

test('소환물: 카나리아와 부엉이는 주인 주위를 서로 반대로 돌고, 스냅샷에 같은 id 로 실린다', () => {
  const { w, p } = quietWorld(90);
  p.up = { canary: 1, night_owl: 1 };
  tick(w, []);
  const ids = (): number[] => buildSnapshot(w, p.id)!.s.map((r) => r[0]!).sort();
  const a = ids();
  assert.equal(a.length, 2);
  for (let i = 0; i < 10; i++) tick(w, []);
  assert.deepEqual(ids(), a, '같은 새는 같은 id');
  const snap = buildSnapshot(w, p.id)!;
  for (const r of snap.s) {
    assert.ok(['canary', 'owl'].includes(SHOT_KINDS[r[1]!]!));
    assert.ok(Math.abs(Math.hypot(r[2]! - p.x, r[3]! - p.y) - 64) < 0.2, '반경 64');
  }
});

test('검토 반영: 작은 경험치에 붙는 배율도 쌓여서 반영된다 (사이드 프로젝트, 운영 서버 직접 수정)', () => {
  const { w, p } = quietWorld(91);
  p.up = { console_log: 1, side_project: 1 };
  for (let i = 0; i < 100; i++) {
    w.gems.push({ id: w.nextId++, x: p.x, y: p.y, v: 1 });
    tick(w, []);
  }
  assert.ok(Math.abs(p.xp - 108) < 1e-6, `버그 경험치(1) 100개 × 1.08 (${p.xp})`);
  // 저주는 경험치를 늘리지 않는다 (뱀서 Curse): 버그의 경험치는 1 그대로
  p.up = { console_log: 8, prod_hotfix: 5 };
  const cursed = enemy(9700, p.x + 20, p.y, 'bug', 1);
  for (let i = 0; i < 40 && cursed.hp > 0; i++) tick(w, [cursed]);
  assert.ok(w.gems.some((g) => g.v === 1), `경험치 ${w.gems.map((g) => g.v).join(',')}`);
});

test('검토 반영: 거의 0 인 이동 입력으로는 달리는 것으로 치지 않는다 (스프린트·커밋 히스토리)', () => {
  const { w, p } = quietWorld(92);
  p.up = { sprint: 8, commit_history: 1 };
  setInput(w, p.id, 1e-300, 0);
  for (let i = 0; i < 20 * 5; i++) tick(w, []);
  assert.equal(p.moveTime, 0, '제자리: 달린 시간이 쌓이지 않는다');
  assert.equal(w.zones.filter((z) => z.kind === 'trail').length, 0, '제자리에는 발자국을 남기지 않는다');
  // 진짜로 걸으면 발자국이 반경만큼 떨어져서 남는다
  setInput(w, p.id, 1, 0);
  for (let i = 0; i < 20 * 2; i++) tick(w, []);
  const trails = w.zones.filter((z) => z.kind === 'trail').sort((a, b) => a.x - b.x);
  assert.ok(trails.length >= 3, `발자국 ${trails.length}개`);
  // 0.3초마다 하나 (기본 속도 70px/s 로 21px 간격): 반경(10)보다 멀리 떨어진다
  for (let i = 1; i < trails.length; i++) assert.ok(trails[i]!.x - trails[i - 1]!.x >= trails[i]!.r - 0.01, '겹쳐 쌓이지 않는다');
  assert.ok(p.moveTime > 1.9);
});

test('검토 반영: 스냅샷 부활을 다 써도 백업은 하나까지만 주울 수 있다', () => {
  const { w, p } = quietWorld(93);
  p.offers = ['snapshot'];
  pickOffer(w, p.id, 0);
  p.offers = ['snapshot'];
  pickOffer(w, p.id, 0);
  assert.equal(p.revives, 2);
  // 두 번 쓰러졌다 되살아난다
  for (let k = 0; k < 2; k++) {
    const e = enemy(9800 + k, p.x + 3, p.y, 'legacy_code');
    p.hp = 0.01;
    p.shield = 0;
    p.iframe = 0;
    tick(w, [e]);
    assert.ok(p.alive, `${k + 1}번째`);
  }
  assert.equal(p.revives, 0);
  assert.equal(p.up.snapshot, undefined, '스냅샷으로 받은 부활을 다 쓰면 칸에서 빠진다 (뱀서 Tiragisu)');
  for (let k = 0; k < 3; k++) w.items.push({ id: w.nextId++, kind: 'revive', x: p.x + 5, y: p.y, ttl: 90 });
  for (let i = 0; i < 5; i++) tick(w, []);
  assert.equal(p.revives, 1, '하나만 주웠다');
  assert.equal(w.items.length, 2, '나머지는 남는다');
});

test('검토 반영: 월드가 멈춰 있는 동안(레벨업 선택 중)에는 같은 영역을 다시 싣지 않는다', () => {
  const { w, p } = quietWorld(94);
  p.up = { hotfix: 1 };
  const e = enemy(9900, p.x + 60, p.y, 'merge_conflict');
  let born = -1;
  for (let i = 0; i < 20 * 6 && born < 0; i++) {
    tick(w, [e]);
    if (buildSnapshot(w, p.id)!.z.length > 0) born = w.tick;
  }
  assert.ok(born > 0);
  // 다음 틱에 레벨업 선택으로 멈춘다
  p.offers = ['coffee', 'cdn', 'work_life'];
  for (let i = 0; i < 20; i++) {
    tick(w, [e]);
    assert.equal(w.tick, born, '멈춰 있다');
    assert.equal(buildSnapshot(w, p.id)!.z.length, 0, '멈춘 동안에는 영역을 다시 싣지 않는다');
  }
  // 새 연결(이어받기)에게는 남아 있는 영역을 남은 시간으로 한 번 보낸다
  const all = buildSnapshot(w, p.id, -1)!.z;
  assert.equal(all.length, 1);
  assert.ok(all[0]![6]! > 0 && all[0]![6]! < 40);
});

test('순위표에 남기는 아이템: 게임 화면 칸과 같은 순서(무기 먼저)로 두고, 모르는 것·범위 밖 단계·중복·칸을 넘는 것은 버린다', () => {
  assert.deepEqual(upgradesOf({ coffee: 2, console_log: 3, rubber_duck: 0 }), [
    { id: 'console_log', level: 3 },
    { id: 'coffee', level: 2 },
  ], '단계 0 은 가진 것이 아니다');
  const max = UPGRADES.console_log.max;
  assert.deepEqual(
    ownedUpgrades([
      { id: 'console_log', level: max + 1 },
      { id: 'console_log', level: 2 },
      { id: 'console_log', level: 3 },
      { id: 'nope', level: 1 },
      { id: 'coffee', level: 1.5 },
      { id: 'coffee', level: '1' },
      null,
      'coffee',
    ]),
    [{ id: 'console_log', level: 2 }],
  );
  const tooMany = [...WEAPON_IDS, ...PASSIVE_IDS].map((id) => ({ id, level: 1 }));
  const kept = ownedUpgrades(tooMany)!;
  assert.equal(kept.filter((u) => UPGRADES[u.id].kind === 'weapon').length, Math.min(WEAPON_IDS.length, 6));
  assert.equal(kept.filter((u) => UPGRADES[u.id].kind === 'passive').length, Math.min(PASSIVE_IDS.length, PASSIVE_SLOTS));
  assert.equal(ownedUpgrades('x'), null);
  assert.deepEqual(ownedUpgrades([]), []);
});
