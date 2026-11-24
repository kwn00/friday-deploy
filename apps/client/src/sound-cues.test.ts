import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENEMY_IDS, FIELD_ITEM_KINDS, STAGE_TIME, ZONE_KINDS, type Snapshot } from '@friday-deploy/shared';
import { SoundCues, erasedIn, insideAny, wipesBetween, type Cue } from './sound-cues';

const BUG = ENEMY_IDS.indexOf('bug');
const BOSS = ENEMY_IDS.indexOf('boss_bug');

/** 나(id 1)는 (0, 0) 에 서 있다 */
function snap(tick: number, over: Partial<Snapshot> = {}, me: Partial<Snapshot['me']> = {}): Snapshot {
  return {
    t: 'snap', tick, time: tick / 20, paused: false, view: [0, 0], ack: 0, ackTicks: 0, ackPhase: 0,
    me: { id: 1, hp: 100, maxHp: 100, xp: 0, xpNext: 6, level: 1, kills: 0, alive: true, revives: 0, up: {}, ...me },
    p: [[1, 0, 0, 1, 1, 100, 0, 0, 0, 0, 0, 0, 0]], e: [], s: [], z: [], zr: [], b: [], g: [], h: [], i: [],
    ...over,
  };
}
const ids = (cues: Cue[]): string[] => cues.map((c) => `${c.id}${c.n > 1 ? `×${c.n}` : ''}`);

test('sound: 가까이에서 사라진 적은 쓰러진 것, 멀리서 사라진 것은 시야 밖으로 나간 것', () => {
  const c = new SoundCues();
  const a = snap(1, { e: [[10, BUG, 20, 0, 0, 0], [11, BUG, 30, 0, 0, 0], [12, BUG, 500, 0, 0, 0]] });
  assert.deepEqual(ids(c.diff(a, snap(2))), ['kill×2']);
});

test('sound: 맞은 적이 있으면 한 번 (같은 틱이 다시 오면 내지 않는다)', () => {
  const c = new SoundCues();
  const e: Snapshot['e'] = [[10, BUG, 20, 0, 1, 0], [11, BUG, 30, 0, 1, 0]];
  assert.deepEqual(ids(c.diff(snap(1, { e }), snap(2, { e }))), ['hit×2']);
  assert.deepEqual(ids(c.diff(snap(2, { e }), snap(2, { e }))), []);
});

test('sound: 보스 경보는 보스마다 한 번 (시야를 들락날락해도)', () => {
  const c = new SoundCues();
  const boss: Snapshot['e'] = [[20, BOSS, 200, 0, 0, 0]];
  assert.deepEqual(ids(c.diff(snap(1), snap(2, { e: boss }))), ['bossAppear']);
  assert.deepEqual(ids(c.diff(snap(2, { e: boss }), snap(3))), ['bossKill']);
  assert.deepEqual(ids(c.diff(snap(3), snap(4, { e: boss }))), []);
  c.reset();
  assert.deepEqual(ids(c.diff(snap(4), snap(5, { e: boss }))), ['bossAppear']);
});

test('sound: 내 근처에서 사라진 경험치·아이템만 내가 먹은 것', () => {
  const c = new SoundCues();
  const chest = FIELD_ITEM_KINDS.indexOf('chest');
  const a = snap(1, { g: [[1, 10, 0, 0], [2, 300, 0, 0]], i: [[5, chest, 50, 0, 0]], h: [[7, 20, 0]] });
  assert.deepEqual(ids(c.diff(a, snap(2))), ['gem', 'chest', 'heal']);
});

test('sound: 자석을 주우면 자석 소리 (멀리서 사라진 자석은 조용하다)', () => {
  const c = new SoundCues();
  const magnet = FIELD_ITEM_KINDS.indexOf('magnet');
  assert.deepEqual(ids(c.diff(snap(1, { i: [[5, magnet, 20, 0, 0], [6, magnet, 900, 0, 0]] }), snap(2))), ['magnet']);
});

test('sound: git clean 에 지워진 경험치·아이템은 내 근처에서 사라져도 먹은 소리를 내지 않는다', () => {
  const c = new SoundCues();
  const wipe = ZONE_KINDS.indexOf('wipe');
  const lgtm = FIELD_ITEM_KINDS.indexOf('levelup');
  const a = snap(1, { g: [[1, 10, 0, 0]], i: [[5, lgtm, 50, 0, 0]], h: [[7, 20, 0]] });
  // 지우는 쪽이 나온 git clean (aux 0): 그 자리(반경 304)에서 사라진 것은 지워진 것
  assert.deepEqual(ids(c.diff(a, snap(2, { z: [[90, wipe, 0, 0, 304, 0, 20]] }))), []);
  // rm -rf node_modules (aux 1) 는 지우지 않으므로 사라진 것은 먹은 것
  assert.deepEqual(ids(c.diff(a, snap(2, { z: [[91, wipe, 0, 0, 304, 1, 20]] }))), ['gem', 'pickup', 'heal']);
  // 다른 사람이 멀리서 쓴 git clean 은 내 근처와 상관없다
  assert.deepEqual(ids(c.diff(a, snap(2, { z: [[92, wipe, 1000, 0, 304, 0, 20]] }))), ['gem', 'pickup', 'heal']);
  const erased = erasedIn(snap(2, { z: [[93, wipe, 0, 0, 304, 0, 20]] }));
  assert.ok(erased(0, 304) && !erased(0, 310), '지우는 범위 안쪽만');
  assert.equal(erasedIn(snap(2))(0, 0), false, '지우기 영역이 없으면 아무것도 지워지지 않았다');
  // 보물상자는 git clean 에 지워지지 않는다: 지우기 영역 안에서 사라졌어도 연 것이다
  const chest = FIELD_ITEM_KINDS.indexOf('chest');
  assert.deepEqual(ids(c.diff(snap(1, { i: [[8, chest, 5, 0, 0]] }), snap(2, { z: [[94, wipe, 0, 0, 304, 0, 20]] }))), ['chest']);
});

test('sound: 지우기 영역을 실은 스냅샷이 화면에 나오지 않고 지나가도, 화면이 기억한 영역으로 지워진 것을 알아본다', () => {
  const c = new SoundCues();
  const zones = [
    { kind: 'wipe' as const, aux: 0, from: 4, x: 0, y: 0, size: 304 }, // 틱 5 스냅샷에 실려 왔다 (화면에는 4 → 6 으로 건너뜀)
    { kind: 'wipe' as const, aux: 1, from: 4, x: 1000, y: 0, size: 304 }, // rm -rf node_modules: 지우지 않는다
    { kind: 'wipe' as const, aux: 0, from: 7, x: 2000, y: 0, size: 304 }, // 아직 보이지 않은 스냅샷의 것
    { kind: 'fire' as const, aux: 0, from: 5, x: 3000, y: 0, size: 304 },
  ];
  assert.deepEqual(wipesBetween(zones, 4, 6), [{ x: 0, y: 0, r: 304 }]);
  assert.deepEqual(wipesBetween(zones, 3, 4), [], '그 전 구간에는 없다');
  // 틱 5 를 건너뛰고 4 → 6: 6 에는 영역이 없지만 넘겨받은 지운 자리로 판단한다
  const a = snap(4, { g: [[1, 10, 0, 0]], h: [[7, 20, 0]] });
  assert.deepEqual(ids(c.diff(a, snap(6))), ['gem', 'heal'], '넘겨받지 않으면 next 만 본다');
  assert.deepEqual(ids(c.diff(a, snap(6), insideAny(wipesBetween(zones, 4, 6)))), []);
});

test('sound: 쓰러져 있으면 근처의 경험치가 사라져도 내 소리를 내지 않는다', () => {
  const c = new SoundCues();
  const dead: Snapshot['p'] = [[1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]];
  assert.deepEqual(ids(c.diff(snap(1, { p: dead, g: [[1, 5, 0, 0]] }, { alive: false }), snap(2, { p: dead }, { alive: false }))), []);
});

test('sound: 맞음, 쓰러짐, 되살아남, 동료가 쓰러짐', () => {
  const c = new SoundCues();
  assert.deepEqual(ids(c.diff(snap(1), snap(2, {}, { hp: 90 }))), ['hurt']);
  assert.deepEqual(ids(c.diff(snap(2, {}, { hp: 10 }), snap(3, {}, { hp: 0, alive: false }))), ['down']);
  const revived: Snapshot['p'] = [[1, 0, 0, 1, 1, 50, 0, 1, 0, 0, 0, 0, 0]];
  assert.deepEqual(ids(c.diff(snap(3), snap(4, { p: revived }))), ['revive']);
  const mate = (alive: number): Snapshot['p'] => [[1, 0, 0, 1, 1, 100, 0, 0, 0, 0, 0, 0, 0], [2, 50, 0, 1, alive, 0, 0, 0, 0, 0, 0, 0, 0]];
  assert.deepEqual(ids(c.diff(snap(4, { p: mate(1) }), snap(5, { p: mate(0) }))), ['mateDown']);
});

test('sound: 30분이 되는 순간 한 번', () => {
  const c = new SoundCues();
  assert.deepEqual(ids(c.diff(snap(1, { time: STAGE_TIME - 0.1 }), snap(2, { time: STAGE_TIME }))), ['monday']);
  assert.deepEqual(ids(c.diff(snap(2, { time: STAGE_TIME }), snap(3, { time: STAGE_TIME + 0.1 }))), []);
});
