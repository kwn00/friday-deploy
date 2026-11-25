/**
 * 시작 무기 고르기: 허용 목록의 성질, 통신(번호만 받는다), 시뮬레이션(1단계로 시작, 대기실에서만 바꾸기).
 * 서버 권위: 클라이언트는 목록의 번호만 보내고, 무엇으로 몇 단계로 시작하는지는 서버가 정한다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_STARTER,
  DT,
  STARTER_WEAPONS,
  UPGRADES,
  WEAPON_IDS,
  WEAPON_SLOTS,
  addPlayer,
  createWorld,
  evolutionOf,
  isBaseWeapon,
  isStarter,
  isWeapon,
  newTally,
  parseClientMsg,
  setStarter,
  starterAt,
  starterIndex,
  step,
  upgradesOf,
  weaponStats,
  type Enemy,
  type WeaponDef,
} from './index';

test('시작 무기: 진화하지 않은 무기만, 겹치지 않게, 0번은 console.log() (기본값). 모두 1단계에 피해가 있다', () => {
  assert.equal(DEFAULT_STARTER, 'console_log');
  assert.equal(STARTER_WEAPONS[0], 'console_log');
  assert.equal(new Set(STARTER_WEAPONS).size, STARTER_WEAPONS.length);
  for (const id of STARTER_WEAPONS) {
    assert.ok(isWeapon(id), `${id} 는 무기`);
    assert.equal(evolutionOf(id), undefined, `${id} 는 진화한 무기가 아니다`);
    assert.ok((UPGRADES[id] as WeaponDef).rarity > 0, `${id} 는 선택지에도 나오는 무기`);
    // "안 잡고 버티기"가 되지 않게: 피해 없는 무기는 넣지 않는다
    assert.ok(weaponStats(id, 1).dmg > 0, `${id} 1단계 피해`);
  }
  assert.deepEqual([...STARTER_WEAPONS], ['console_log', 'rollback', 'ai_agent', 'firewall'], '후보 4개 (통신 번호 순서)');
  assert.ok(!(STARTER_WEAPONS as readonly string[]).includes('hotfix'), '가장 센 핫픽스는 후보가 아니다 (쏠림)');
});

test('시작 무기: 번호 ↔ 무기, 허용 목록 확인', () => {
  STARTER_WEAPONS.forEach((id, i) => {
    assert.equal(starterAt(i), id);
    assert.equal(starterIndex(id), i);
    assert.ok(isStarter(id));
  });
  for (const bad of [-1, STARTER_WEAPONS.length, 1.5, Number.NaN, '0', null, undefined]) assert.equal(starterAt(bad), undefined, String(bad));
  for (const bad of ['hotfix', 'debugger', 'coffee', 'nope', '', 0, null]) assert.equal(isStarter(bad), false, String(bad));
});

test('시작 무기: 저장된 기록을 읽을 때는 "진화하지 않은 무기" 면 받는다 (나중에 후보에서 빠진 무기도 그대로 보이게)', () => {
  for (const id of WEAPON_IDS) assert.equal(isBaseWeapon(id), evolutionOf(id) === undefined, id);
  assert.equal(isBaseWeapon('hotfix'), true, '지금 후보는 아니지만 읽을 때는 받는다');
  for (const bad of ['debugger', 'monitoring', 'coffee', 'prod_hotfix', 'nope', '', 3, null, undefined]) assert.equal(isBaseWeapon(bad), false, String(bad));
});

test('parseClientMsg: hello 의 시작 무기는 목록의 번호만 받는다 (없으면 그대로 비워 둔다: 서버가 0번으로)', () => {
  const tok = 'a'.repeat(24);
  const hello = (extra: string): string => `{"t":"hello","v":14,"token":"${tok}","name":"a","mode":"solo"${extra}}`;
  assert.deepEqual(parseClientMsg(hello('')), { t: 'hello', v: 14, token: tok, name: 'a', mode: 'solo' });
  for (let i = 0; i < STARTER_WEAPONS.length; i++) {
    assert.deepEqual(parseClientMsg(hello(`,"starter":${i}`)), { t: 'hello', v: 14, token: tok, name: 'a', mode: 'solo', starter: i });
  }
  const coop = parseClientMsg(`{"t":"hello","v":14,"token":"${tok}","name":"a","mode":"coop","room":"ABC234","starter":3}`);
  assert.deepEqual(coop, { t: 'hello', v: 14, token: tok, name: 'a', mode: 'coop', room: 'ABC234', starter: 3 });
  // 범위 밖·정수 아님·무기 이름·단계를 실은 것은 모두 위반 (null)
  for (const bad of [
    hello(`,"starter":${STARTER_WEAPONS.length}`),
    hello(',"starter":-1'),
    hello(',"starter":1.5'),
    hello(',"starter":"1"'),
    hello(',"starter":"hotfix"'),
    hello(',"starter":null'),
    hello(',"starter":{"id":"debugger","level":1}'),
  ]) {
    assert.equal(parseClientMsg(bad), null, bad);
  }
  // 단계나 무기 이름을 따로 실어도 받는 자리가 없다 (버려진다)
  assert.deepEqual(parseClientMsg(hello(',"starter":1,"level":8,"weapon":"friday_deploy"')), { t: 'hello', v: 14, token: tok, name: 'a', mode: 'solo', starter: 1 });
});

test('parseClientMsg: 대기실의 시작 무기 바꾸기(starter)는 목록의 번호만. 게임 시작(start)과 다른 메시지다', () => {
  for (let i = 0; i < STARTER_WEAPONS.length; i++) assert.deepEqual(parseClientMsg(`{"t":"starter","choice":${i}}`), { t: 'starter', choice: i });
  for (const bad of ['{"t":"starter"}', `{"t":"starter","choice":${STARTER_WEAPONS.length}}`, '{"t":"starter","choice":-1}', '{"t":"starter","choice":0.5}', '{"t":"starter","choice":"0"}', '{"t":"starter","choice":"rollback"}']) {
    assert.equal(parseClientMsg(bad), null, bad);
  }
  assert.deepEqual(parseClientMsg('{"t":"starter","choice":2,"level":8}'), { t: 'starter', choice: 2 });
  assert.deepEqual(parseClientMsg('{"t":"start"}'), { t: 'start' });
});

test('시뮬레이션: 고른 무기 1단계로 시작하고 그것 하나만 가진다. 통계는 선택지·고른 것이 아니라 started 로 센다', () => {
  for (const id of STARTER_WEAPONS) {
    const w = createWorld(1);
    const p = addPlayer(w, 'a', false, id);
    assert.equal(p.start, id);
    assert.deepEqual(p.up, { [id]: 1 }, `${id} 1단계만`);
    assert.deepEqual(upgradesOf(p.up), [{ id, level: 1 }]);
    assert.deepEqual(p.tally, { ...newTally(), start: { [id]: 1 } });
  }
  // 기본값: console.log()
  const d = addPlayer(createWorld(1), 'a');
  assert.deepEqual([d.start, d.up], ['console_log', { console_log: 1 }]);
  // 허용 목록 밖의 값이 들어와도(서버 코드의 실수) 기본 무기로 시작한다: 진화한 무기나 패시브로 시작할 수 없다
  for (const bad of ['debugger', 'hotfix', 'coffee', 'nope']) {
    const q = addPlayer(createWorld(1), 'a', false, bad as typeof DEFAULT_STARTER);
    assert.deepEqual([q.start, q.up], ['console_log', { console_log: 1 }], bad);
  }
});

test('시뮬레이션: 어느 시작 무기든 첫 몇 초 안에 가까운 버그를 다치게 한다', () => {
  const enemy = (id: number, x: number, y: number): Enemy => ({ id, type: 'merge_conflict', x, y, hp: 1e12, spd: 0, frozen: 0, kbTaken: 0, resFreeze: 0, kbTime: 0, kbMult: 0, vx: 0, vy: 0, life: 0, hit: false });
  for (const id of STARTER_WEAPONS) {
    const w = createWorld(7);
    const p = addPlayer(w, 'a', false, id);
    p.shield = 1e9;
    p.xpNext = 1e12;
    w.itemCd = 1e9;
    w.magnetCd = 1e9;
    const e = enemy(w.nextId++, p.x + 20, p.y);
    for (let i = 0; i < 4 / DT; i++) {
      w.enemies = [e];
      e.x = p.x + 20;
      e.y = p.y;
      w.wave = Math.floor((w.time + DT) / 60);
      w.spawnCd = 1e9;
      step(w, DT);
    }
    assert.ok(e.hp < 1e12, `${id}: 4초 동안 한 번도 맞히지 못했다`);
  }
});

test('시뮬레이션: 시작 무기는 무기 칸 하나를 쓰고, 다른 무기처럼 단계가 오른다', () => {
  const w = createWorld(3);
  const p = addPlayer(w, 'a', false, 'rollback');
  // 칸이 가득 찬 상태: 시작 무기 + 다른 무기 5개
  const others = WEAPON_IDS.filter((id) => id !== 'rollback' && !evolutionOf(id) && (UPGRADES[id] as WeaponDef).rarity > 0).slice(0, WEAPON_SLOTS - 1);
  for (const id of others) p.up[id] = 1;
  assert.equal(upgradesOf(p.up).filter((u) => isWeapon(u.id)).length, WEAPON_SLOTS);
  // 레벨업을 일으켜 선택지를 본다: 가진 무기(시작 무기 포함)만 무기로 나온다
  w.gems.push({ id: w.nextId++, x: p.x, y: p.y, v: p.xpNext });
  w.itemCd = 1e9;
  w.magnetCd = 1e9;
  w.spawnCd = 1e9;
  step(w, DT);
  assert.ok(p.offers, '선택지가 떴다');
  for (const u of p.offers!) if (isWeapon(u)) assert.ok(p.up[u], `가진 무기만: ${u}`);
});

test('시뮬레이션: 시작 무기는 판이 시작되기 전(월드가 돌기 전)에만 바꿀 수 있다', () => {
  const w = createWorld(5);
  const p = addPlayer(w, 'a', false, 'rollback');
  assert.equal(setStarter(w, p.id, 'rollback'), false, '같은 무기는 바뀐 것이 아니다');
  assert.equal(setStarter(w, p.id, 'firewall'), true);
  assert.deepEqual([p.start, p.up, p.tally.start], ['firewall', { firewall: 1 }, { firewall: 1 }]);
  assert.equal(setStarter(w, p.id, 'debugger' as typeof DEFAULT_STARTER), false, '허용 목록 밖');
  assert.equal(setStarter(w, 999, 'ai_agent'), false, '없는 사람');
  const watcher = addPlayer(w, 'b', true);
  assert.equal(setStarter(w, watcher.id, 'ai_agent'), false, '몸이 없는 관전자');
  step(w, DT);
  assert.equal(setStarter(w, p.id, 'ai_agent'), false, '한 틱이라도 돌았으면 바꾸지 않는다');
  assert.equal(p.start, 'firewall');
  assert.equal(p.up.ai_agent, undefined);
});
