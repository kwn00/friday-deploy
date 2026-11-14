import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DT,
  DUCK_ORBIT_RADIUS,
  GEM_PULL_MAX,
  PLAYER_BASE_PICKUP,
  HEAL_DROP_COOLDOWN,
  HEAL_FRACTION,
  PLAYER_BASE_SPEED,
  VIEW_RADIUS,
  addPlayer,
  buildSnapshot,
  createWorld,
  decodeSnapshot,
  duckOffset,
  encodeSnapshot,
  duckPositions,
  maxHpOf,
  normalizeRoomCode,
  parseClientMsg,
  pickOffer,
  sanitizeName,
  setInput,
  step,
  type Gem,
} from './index';

test('parseClientMsg: 조작된 메시지는 전부 거부', () => {
  const bad = [
    'not json',
    '[]',
    'null',
    '{"t":"input","seq":1,"dx":5,"dy":0}', // 범위 초과 (스피드핵)
    '{"t":"input","seq":1,"dx":"1","dy":0}',
    '{"t":"input","seq":1,"dx":null,"dy":0}',
    '{"t":"input","seq":-1,"dx":0,"dy":0}',
    '{"t":"input","seq":1.5,"dx":0,"dy":0}',
    '{"t":"pick","choice":99}',
    '{"t":"pick","choice":"0"}',
    '{"t":"setHp","hp":9999}', // 존재하지 않는 타입
    '{"t":"hello","v":1,"token":"short","name":"a","mode":"solo"}',
    '{"t":"hello","v":1,"token":"aaaaaaaaaaaaaaaaaaaaaaaa","name":"a","mode":"god"}',
    '{"t":"input","seq":1,"dx":1e999,"dy":0}',
    'x'.repeat(600),
  ];
  for (const raw of bad) assert.equal(parseClientMsg(raw), null, raw);
  assert.deepEqual(parseClientMsg('{"t":"input","seq":3,"dx":1,"dy":-1,"hp":9999}'), { t: 'input', seq: 3, dx: 1, dy: -1 });
});

test('sanitizeName: 태그/제어문자 제거 및 길이 제한', () => {
  assert.equal(sanitizeName('<img src=x onerror=alert(1)>'), 'img srcx one');
  assert.doesNotMatch(sanitizeName('<script>"\'&</script>'), /[<>"'&\/]/);
  assert.equal(sanitizeName('   '), 'anonymous');
  assert.equal(sanitizeName('김개발_dev'), '김개발_dev');
  assert.ok(sanitizeName('a'.repeat(100)).length <= 12);
});

test('sim: 입력 벡터는 서버에서 정규화되어 속도 상한을 넘을 수 없다', () => {
  const w = createWorld(1);
  const p = addPlayer(w, 'a');
  const x0 = p.x;
  const y0 = p.y;
  setInput(w, p.id, 1, 1);
  for (let i = 0; i < 20; i++) step(w, DT);
  const moved = Math.hypot(p.x - x0, p.y - y0);
  assert.ok(moved <= PLAYER_BASE_SPEED * 1.0001, `moved ${moved}`);
});

test('sim: 제시되지 않은 업그레이드는 선택할 수 없다', () => {
  const w = createWorld(2);
  const p = addPlayer(w, 'a');
  assert.equal(pickOffer(w, p.id, 0), false); // 레벨업 중이 아님
  p.xp = p.xpNext;
  w.gems.push({ id: 999, x: p.x, y: p.y, v: 1 });
  step(w, DT);
  assert.ok(p.offers && p.offers.length > 0);
  assert.equal(pickOffer(w, p.id, 7), false);
  assert.equal(pickOffer(w, p.id, 0), true);
  assert.equal(p.offers, null);
});

test('sim: 5분간 돌려도 터지지 않고 스냅샷이 만들어진다', () => {
  const w = createWorld(3);
  const p = addPlayer(w, 'a');
  for (let i = 0; i < 20 * 300 && !w.over; i++) {
    if (p.offers) pickOffer(w, p.id, 0);
    setInput(w, p.id, Math.cos(i / 40), Math.sin(i / 40));
    step(w, DT);
  }
  assert.ok(w.time > 5);
  const snap = buildSnapshot(w, p.id);
  assert.ok(snap);
  assert.ok(JSON.stringify(snap).length < 64_000);
});

test('parseClientMsg: 방 코드 · 시작 · 일시정지', () => {
  const tok = 'a'.repeat(24);
  const hello = (extra: string): string => `{"t":"hello","v":2,"token":"${tok}","name":"a",${extra}}`;
  assert.deepEqual(parseClientMsg(hello('"mode":"coop","room":"ABC234"')), { t: 'hello', v: 2, token: tok, name: 'a', mode: 'coop', room: 'ABC234' });
  assert.deepEqual(parseClientMsg(hello('"mode":"coop"')), { t: 'hello', v: 2, token: tok, name: 'a', mode: 'coop' });
  const bad = [
    hello('"mode":"solo","room":"ABC234"'), // 솔로에는 방 코드가 없다
    hello('"mode":"coop","room":"abc234"'), // 정규화는 클라이언트 몫, 서버는 정확한 형식만
    hello('"mode":"coop","room":"ABC23"'),
    hello('"mode":"coop","room":"ABC2345"'),
    hello('"mode":"coop","room":"ABCO10"'), // 헷갈리는 글자(O, 1, 0)는 코드에 없다
    hello('"mode":"coop","room":123456'),
    hello('"mode":"coop","room":null'),
    hello('"mode":"coop","room":"../../x"'),
    '{"t":"pause"}',
    '{"t":"pause","on":1}',
    '{"t":"pause","on":"true"}',
  ];
  for (const raw of bad) assert.equal(parseClientMsg(raw), null, raw);
  assert.deepEqual(parseClientMsg('{"t":"pause","on":true,"forever":true}'), { t: 'pause', on: true });
  assert.deepEqual(parseClientMsg('{"t":"start","seed":1}'), { t: 'start' });
});

test('normalizeRoomCode: 사람이 친 코드를 정리하고, 형식이 다르면 거부', () => {
  assert.equal(normalizeRoomCode(' abc-234 '), 'ABC234');
  assert.equal(normalizeRoomCode('ABC234'), 'ABC234');
  for (const bad of ['', 'ABC23', 'ABC2345', 'ABC10O', 'ABC23<', null, undefined, 123456, 'A'.repeat(100)]) {
    assert.equal(normalizeRoomCode(bad), null, String(bad));
  }
});

test('sim: 회복 아이템은 보스에게서 반드시 나오고, 체력이 가득이면 줍지 않는다', () => {
  const w = createWorld(7);
  const p = addPlayer(w, 'a');
  w.enemies.push({ id: 9001, type: 'legacy_code', x: p.x + 200, y: p.y, hp: 1, duckCd: 0, hit: false });
  w.shots.push({ id: 9002, kind: 'log', owner: p.id, x: p.x + 200, y: p.y, vx: 0, vy: 0, ttl: 1, dmg: 99, pierce: 0, r: 4, hit: new Set() });
  step(w, DT);
  assert.equal(w.heals.length, 1, '보스 처치 → 회복 아이템');
  w.gems.length = 0; // 보스가 남긴 경험치를 주우면 레벨업 선택으로 월드가 멈추므로 치워 둔다

  // 체력이 가득한 채로 그 위에 서 있어도 사라지지 않는다
  const heal = w.heals[0]!;
  p.x = heal.x;
  p.y = heal.y;
  step(w, DT);
  assert.equal(w.heals.length, 1);
  assert.equal(p.hp, maxHpOf(p));

  // 화면에는 가득(올림 100)으로 보이는 99.6 같은 체력에서도 줍지 않는다
  p.hp = maxHpOf(p) - 0.4;
  step(w, DT);
  assert.equal(w.heals.length, 1, '화면상 가득이면 아이템을 쓰지 않는다');

  // 다치면 줍고, 최대 체력의 일정 비율만큼 회복하되 최대치를 넘지 않는다
  p.hp = 40;
  step(w, DT);
  assert.equal(w.heals.length, 0);
  assert.equal(p.hp, 40 + Math.ceil(maxHpOf(p) * HEAL_FRACTION));
  p.hp = 95;
  w.heals.push({ id: 9003, x: p.x, y: p.y });
  step(w, DT);
  assert.ok(p.hp <= maxHpOf(p));
});

test('sim: 일반 적의 회복 아이템은 쿨다운 동안 다시 떨어지지 않는다', () => {
  const w = createWorld(11);
  const p = addPlayer(w, 'a');
  p.hp = 1e9; // 죽지 않게
  let drops = 0;
  let lastDropAt = -Infinity;
  let minGap = Infinity;
  let seen = new Set<number>();
  for (let i = 0; i < 20 * 600; i++) {
    if (p.offers) pickOffer(w, p.id, 0);
    setInput(w, p.id, Math.cos(i / 40), Math.sin(i / 40));
    p.hp = 1e9;
    step(w, DT);
    for (const h of w.heals) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      // 보스 드롭(쿨다운과 무관)은 간격 계산에서 뺀다: 보스는 150초마다만 나온다
      drops++;
      minGap = Math.min(minGap, w.time - lastDropAt);
      lastDropAt = w.time;
    }
  }
  // 너무 드물지도(10분에 2개 미만), 쿨다운이 허용하는 것보다 많지도(+ 보스 드롭 최대 4개) 않다
  assert.ok(drops >= 2, `10분 동안 ${drops}개`);
  assert.ok(drops <= Math.ceil(600 / HEAL_DROP_COOLDOWN) + 4, `10분 동안 ${drops}개`);
  seen = new Set();
});

test('sim: 위아래로 움직일 때 미세한 좌우 흔들림으로 캐릭터가 뒤집히지 않는다', () => {
  const w = createWorld(5);
  const p = addPlayer(w, 'a');
  setInput(w, p.id, 1, 0);
  step(w, DT);
  assert.equal(p.face, 1);
  // 터치 조이스틱으로 "거의 위쪽": 좌우 성분이 프레임마다 부호를 바꾼다
  for (let i = 0; i < 40; i++) {
    setInput(w, p.id, i % 2 ? 0.08 : -0.08, -1);
    step(w, DT);
    assert.equal(p.face, 1, `tick ${i}`);
    assert.equal(buildSnapshot(w, p.id)!.p[0]![3], 1);
  }
  setInput(w, p.id, -0.6, -0.8);
  step(w, DT);
  assert.equal(p.face, -1);
});

test('sim: 러버덕 위치는 틱만으로 계산할 수 있고(클라이언트 그리기용) 서버 판정 위치와 같다', () => {
  const w = createWorld(9);
  const p = addPlayer(w, 'a');
  p.up.rubber_duck = 3;
  for (let i = 0; i < 137; i++) step(w, DT);
  const snap = buildSnapshot(w, p.id)!;
  assert.equal(snap.p[0]![6], 3, '스냅샷에는 러버덕 개수만 들어간다');
  const server = duckPositions(w, p);
  for (let i = 0; i < 3; i++) {
    const [ox, oy] = duckOffset(snap.tick * DT, i, 3);
    assert.ok(Math.abs(p.x + ox - server[i]![0]) < 1e-6 && Math.abs(p.y + oy - server[i]![1]) < 1e-6);
    assert.ok(Math.abs(Math.hypot(ox, oy) - DUCK_ORBIT_RADIUS) < 1e-9);
  }
});

test('sim: 같은 방 동료는 멀리 있어도 스냅샷에 있고, 멀리 있는 적은 없다', () => {
  const w = createWorld(4);
  const a = addPlayer(w, 'a');
  const b = addPlayer(w, 'b');
  b.x = a.x + VIEW_RADIUS * 3;
  w.enemies.push({ id: 7001, type: 'bug', x: b.x + 10, y: b.y, hp: 1e9, duckCd: 0, hit: false });
  w.heals.push({ id: 7002, x: b.x + 10, y: b.y });
  const snap = buildSnapshot(w, a.id)!;
  assert.deepEqual(snap.p.map((r) => r[0]).sort(), [a.id, b.id].sort());
  assert.equal(snap.e.find((e) => e[0] === 7001), undefined, '시야 밖 적은 보내지 않는다');
  assert.equal(snap.h.length, 0, '시야 밖 아이템도 보내지 않는다');
  assert.equal(buildSnapshot(w, b.id)!.h.length, 1);
});

test('codec: 스냅샷을 이진으로 보냈다가 풀면 같은 내용이다 (좌표는 1/16 픽셀 이내)', () => {
  const w = createWorld(21);
  const a = addPlayer(w, 'a');
  const b = addPlayer(w, 'b');
  a.up.rubber_duck = 2;
  let checked = 0;
  let jsonBytes = 0;
  let binBytes = 0;
  for (let i = 0; i < 20 * 240 && !w.over; i++) {
    for (const p of [a, b]) if (p.offers) pickOffer(w, p.id, i % 3);
    setInput(w, a.id, Math.cos(i / 40), Math.sin(i / 40));
    setInput(w, b.id, -0.7, 0.2); // b 는 멀리 떠난다: 동료의 절대 좌표가 멀어져도 정확해야 한다
    a.hp = b.hp = 100;
    if (i === 1200) w.heals.push({ id: w.nextId++, x: a.x + 30, y: a.y - 12 });
    step(w, DT);
    if (i % 7 !== 0) continue;
    for (const pid of [a.id, b.id]) {
      const snap = buildSnapshot(w, pid)!;
      const bin = encodeSnapshot(snap);
      const back = decodeSnapshot(bin);
      jsonBytes += JSON.stringify(snap).length;
      binBytes += bin.length;
      assert.equal(back.tick, snap.tick);
      assert.equal(back.paused, snap.paused);
      assert.deepEqual(back.me, snap.me);
      assert.equal(back.p.length, snap.p.length);
      for (const [k, list] of [['e', snap.e], ['s', snap.s], ['g', snap.g], ['h', snap.h], ['p', snap.p]] as const) {
        const got = back[k] as number[][];
        assert.equal(got.length, list.length, k);
        list.forEach((row: number[], n: number) => {
          row.forEach((v, c) => {
            const isCoord = k === 'e' || k === 's' ? c === 2 || c === 3 : c === 1 || c === 2;
            if (isCoord) assert.ok(Math.abs(got[n]![c]! - v) <= 1 / 16 + 0.02, `${k}[${n}][${c}] ${got[n]![c]} vs ${v}`);
            else assert.equal(got[n]![c], v, `${k}[${n}][${c}]`);
          });
        });
      }
      checked++;
    }
  }
  assert.ok(checked > 500);
  assert.ok(binBytes < jsonBytes * 0.45, `이진 ${binBytes} / JSON ${jsonBytes} = ${((binBytes / jsonBytes) * 100).toFixed(0)}%`);
});

test('codec: 손상된 데이터는 예외로 끝난다 (멈추거나 거대한 배열을 만들지 않는다)', () => {
  const w = createWorld(3);
  const p = addPlayer(w, 'a');
  for (let i = 0; i < 400; i++) step(w, DT);
  const good = encodeSnapshot(buildSnapshot(w, p.id)!);
  assert.doesNotThrow(() => decodeSnapshot(good));
  assert.throws(() => decodeSnapshot(good.slice(0, good.length - 3)), RangeError);
  assert.throws(() => decodeSnapshot(new Uint8Array([...good, 0])), RangeError);
  assert.throws(() => decodeSnapshot(new Uint8Array([9, 0, 0])), RangeError);
  assert.throws(() => decodeSnapshot(new Uint8Array(0)), RangeError);
  // 무작위로 바이트를 바꿔도 RangeError 외의 일은 일어나지 않는다
  let seed = 12345;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < 3000; i++) {
    const bad = good.slice();
    for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) bad[Math.floor(rnd() * bad.length)] = Math.floor(rnd() * 256);
    try {
      const s = decodeSnapshot(bad);
      assert.ok(s.e.length <= 4096 && s.g.length <= 4096);
    } catch (err) {
      assert.ok(err instanceof RangeError, String(err));
    }
  }
});

test('sim: 맞고 살아남은 적은 그 틱의 스냅샷에만 피격 표시가 붙는다 (체력은 여전히 보내지 않는다)', () => {
  const w = createWorld(31);
  const p = addPlayer(w, 'a');
  p.cd.console_log = 1e9; // 자동 공격이 끼어들지 않게
  w.enemies.push({ id: 5001, type: 'merge_conflict', x: p.x + 150, y: p.y, hp: 80, duckCd: 0, hit: false });
  w.enemies.push({ id: 5002, type: 'bug', x: p.x - 150, y: p.y, hp: 10, duckCd: 0, hit: false });
  const row = (id: number): number[] | undefined => buildSnapshot(w, p.id)!.e.find((e) => e[0] === id);
  step(w, DT);
  assert.equal(row(5001)![4], 0);
  assert.equal(row(5001)!.length, 5, '[id, 종류, x, y, 피격] 뿐: 체력은 없다');

  const tank = w.enemies.find((e) => e.id === 5001)!;
  w.shots.push({ id: 5003, kind: 'log', owner: p.id, x: tank.x, y: tank.y, vx: 0, vy: 0, ttl: 1, dmg: 12, pierce: 0, r: 4, hit: new Set() });
  step(w, DT);
  assert.equal(row(5001)![4], 1, '맞은 틱');
  assert.equal(row(5002)![4], 0, '안 맞은 적');
  // 이진 인코딩을 거쳐도 표시와 종류가 그대로다
  const back = decodeSnapshot(encodeSnapshot(buildSnapshot(w, p.id)!));
  assert.deepEqual(back.e.find((e) => e[0] === 5001)!.slice(0, 2).concat(back.e.find((e) => e[0] === 5001)![4]), [5001, 2, 1]);
  assert.deepEqual(back.e.find((e) => e[0] === 5002)!.slice(0, 2).concat(back.e.find((e) => e[0] === 5002)![4]), [5002, 0, 0]);
  step(w, DT);
  assert.equal(row(5001)![4], 0, '다음 틱에는 사라진다');
});

/** 적이 끼어들지 않게 치우면서 한 틱 진행한다 (경험치 움직임만 보려는 테스트용) */
function quietStep(w: ReturnType<typeof createWorld>): void {
  w.enemies.length = 0;
  w.shots.length = 0;
  step(w, DT);
  w.enemies.length = 0;
}

test('sim: 경험치는 획득 범위에 들어오면 그 자리에서 사라지지 않고 플레이어에게 끌려와서 닿을 때 획득된다', () => {
  const w = createWorld(21);
  const p = addPlayer(w, 'a');
  p.xpNext = 1e9; // 레벨업으로 월드가 멈추지 않게
  const far: Gem = { id: 9001, x: p.x + PLAYER_BASE_PICKUP + 4, y: p.y, v: 3 };
  const near: Gem = { id: 9002, x: p.x + PLAYER_BASE_PICKUP - 2, y: p.y, v: 5 };
  w.gems.push(far, near);
  const dist = (): number => Math.hypot(near.x - p.x, near.y - p.y);

  quietStep(w);
  assert.equal(p.xp, 0, '첫 틱에는 아직 닿지 않았다 (예전에는 여기서 바로 획득됐다)');
  assert.ok(w.gems.includes(near));
  const d1 = dist();
  assert.ok(d1 < PLAYER_BASE_PICKUP - 2, `끌려오기 시작했다 (${d1})`);
  quietStep(w);
  const d2 = dist();
  assert.ok(d1 - d2 > PLAYER_BASE_PICKUP - 2 - d1, '가까워질수록 빨라진다');
  let ticks = 2;
  while (w.gems.includes(near) && ticks < 40) {
    quietStep(w);
    ticks++;
  }
  assert.equal(p.xp, 5, '닿으면 그 경험치만큼만 오른다');
  assert.ok(ticks <= 6, `0.3초 안에 도착한다 (${ticks}틱)`);
  // 범위 밖의 경험치는 그대로 제자리에 있다
  assert.ok(w.gems.includes(far));
  assert.deepEqual([far.x, far.y, far.to], [p.x + PLAYER_BASE_PICKUP + 4, p.y, undefined]);
});

test('sim: npm install 은 경험치를 끌어당기는 범위를 넓힌다', () => {
  const w = createWorld(22);
  const p = addPlayer(w, 'a');
  p.xpNext = 1e9;
  const gem: Gem = { id: 9001, x: p.x + PLAYER_BASE_PICKUP * 1.2, y: p.y, v: 1 };
  w.gems.push(gem);
  for (let i = 0; i < 10; i++) quietStep(w);
  assert.equal(gem.x, p.x + PLAYER_BASE_PICKUP * 1.2, '기본 범위(36)에서는 닿지 않는다');
  p.up.npm_install = 1; // 범위 +30% → 46.8
  for (let i = 0; i < 10; i++) quietStep(w);
  assert.equal(p.xp, 1);
  assert.equal(w.gems.length, 0);
});

test('sim: 한번 끌리기 시작한 경험치는 가장 빠른 플레이어가 달아나도 따라잡는다 (끌어놓고 버릴 수 없다)', () => {
  const w = createWorld(23);
  const p = addPlayer(w, 'a');
  p.xpNext = 1e9;
  p.up.coffee = 5; // 최고 이동 속도
  p.up.npm_install = 5; // 가장 넓은 범위의 끝에서 끌리기 시작
  const reach = PLAYER_BASE_PICKUP * 2.5;
  // 범위 끝에서 살짝 안쪽 (플레이어가 먼저 한 걸음 달아난 뒤에도 범위 안이도록)
  const gem: Gem = { id: 9001, x: p.x - (reach - 6), y: p.y, v: 7 };
  w.gems.push(gem);
  setInput(w, p.id, 1, 0); // 경험치 반대쪽으로 계속 달린다
  let ticks = 0;
  let top = 0;
  while (w.gems.length > 0 && ticks < 200) {
    quietStep(w);
    top = Math.max(top, gem.sp ?? 0);
    ticks++;
  }
  assert.equal(p.xp, 7);
  assert.ok(ticks <= 20, `1초 안에 따라잡는다 (${ticks}틱)`);
  assert.ok(top <= GEM_PULL_MAX, `속도 상한 (${top})`);
});

test('sim: 경험치는 더 가까운 사람에게 가고, 레벨업 선택 중이거나 쓰러진 사람은 끌어당기지 못한다', () => {
  const w = createWorld(24);
  const a = addPlayer(w, 'a');
  const b = addPlayer(w, 'b');
  a.xpNext = b.xpNext = 1e9;
  a.x = 0;
  a.y = 0;
  b.x = 40;
  b.y = 0;
  // a 에게서 25, b 에게서 15 떨어진 곳: 둘 다 범위 안이지만 b 가 더 가깝다
  const gem: Gem = { id: 9001, x: 25, y: 0, v: 4 };
  w.gems.push(gem);
  quietStep(w);
  assert.equal(gem.to, b.id);
  for (let i = 0; i < 10; i++) quietStep(w);
  assert.deepEqual([a.xp, b.xp], [0, 4]);

  // 끌려오는 도중에 그 사람이 레벨업 선택에 들어가면 놓는다. 다른 사람의 범위 안이면 그 사람에게 간다.
  const second: Gem = { id: 9002, x: 22, y: 0, v: 6 };
  w.gems.push(second);
  quietStep(w);
  assert.equal(second.to, b.id);
  b.offers = ['coffee'];
  quietStep(w);
  assert.equal(second.to, a.id, '선택 중인 사람 대신 범위 안의 다른 사람에게');
  for (let i = 0; i < 10; i++) quietStep(w);
  assert.deepEqual([a.xp, b.xp], [6, 4]);

  // 범위 안에 선택 중인 사람과 쓰러진 사람뿐이면 제자리에 남는다
  a.alive = false;
  const third: Gem = { id: 9003, x: 38, y: 0, v: 9 };
  w.gems.push(third);
  for (let i = 0; i < 5; i++) quietStep(w);
  assert.deepEqual([third.x, third.y, third.to], [38, 0, undefined]);
  assert.deepEqual([a.xp, b.xp], [6, 4]);
});

test('sim: 끌려오는 경험치의 위치가 스냅샷에 실린다 (화면에서 움직이는 것이 보인다)', () => {
  const w = createWorld(25);
  const p = addPlayer(w, 'a');
  p.xpNext = 1e9;
  p.up.npm_install = 5;
  w.gems.push({ id: 9001, x: p.x + 80, y: p.y, v: 1 });
  const xs: number[] = [];
  for (let i = 0; i < 4; i++) {
    quietStep(w);
    const g = decodeSnapshot(encodeSnapshot(buildSnapshot(w, p.id)!)).g.find((row) => row[0] === 9001);
    if (g) xs.push(g[1] - p.x);
  }
  assert.ok(xs.length >= 3, `${xs.length}`);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i]! < xs[i - 1]! - 5, `매 틱 눈에 띄게 다가온다: ${xs.join(', ')}`);
});
