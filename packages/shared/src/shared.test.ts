import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DT,
  FIELD_ITEM_FADE,
  FIELD_ITEM_INTERVAL,
  FIELD_ITEM_KINDS,
  FIELD_ITEM_MAX_DIST,
  FIELD_ITEM_MIN_DIST,
  FIELD_ITEM_TTL,
  FIELD_ITEMS,
  MAX_FIELD_ITEMS,
  REVIVE_BLAST_RADIUS,
  REVIVE_SHIELD_SECONDS,
  UPGRADES,
  UPGRADE_IDS,
  GEM_PULL_MAX,
  PLAYER_BASE_PICKUP,
  SPECTATOR_LEASH,
  SPECTATOR_SPEED,
  HEAL_DROP_COOLDOWN,
  HEAL_AMOUNT,
  PLAYER_BASE_SPEED,
  VIEW_RADIUS,
  ENEMY_VIEW_RADIUS,
  addPlayer,
  buildSnapshot,
  createWorld,
  decodeSnapshot,
  duckOffset,
  encodeSnapshot,
  maxHpOf,
  normalizeRoomCode,
  parseClientMsg,
  pickOffer,
  sanitizeName,
  setInput,
  sfc32,
  step,
  areaMultOf,
  effectiveStats,
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

test('parseClientMsg: 이어받기(resume) · 나가기(leave)', () => {
  const tok = 'a'.repeat(24);
  const key = `0a1b2c3d.${'Ab-_'.repeat(8)}`;
  const resume = (k: unknown, extra = ''): string => `{"t":"resume","v":6,"token":"${tok}","key":${JSON.stringify(k)}${extra}}`;
  assert.deepEqual(parseClientMsg(resume(key)), { t: 'resume', v: 6, token: tok, key });
  // 상태를 실어 보낼 자리는 없다: 모르는 필드는 버려진다
  assert.deepEqual(parseClientMsg(resume(key, ',"hp":9999,"id":1,"name":"x","room":"ABC234"')), { t: 'resume', v: 6, token: tok, key });
  const bad = [
    resume(''),
    resume('0a1b2c3d'),
    resume(`0a1b2c3d.${'A'.repeat(31)}`), // 비밀 값이 짧다
    resume(`0a1b2c3d.${'A'.repeat(33)}`),
    resume(`0A1B2C3D.${'A'.repeat(32)}`), // 방 id 는 소문자 16진수
    resume(`0a1b2c3.${'A'.repeat(32)}`),
    resume(`0a1b2c3d.${'A'.repeat(31)}=`),
    resume(`0a1b2c3d.${'A'.repeat(31)}/`),
    resume(`__proto__.${'A'.repeat(32)}`),
    resume(`0a1b2c3d.1.${'A'.repeat(32)}`),
    resume(null),
    resume(12345678),
    resume({ $ne: '' }),
    resume([key]),
    `{"t":"resume","v":6,"key":"${key}"}`, // 세션 토큰 없이
    `{"t":"resume","v":6,"token":"short","key":"${key}"}`,
    `{"t":"resume","v":"6","token":"${tok}","key":"${key}"}`,
    `{"t":"resume","token":"${tok}","key":"${key}"}`,
  ];
  for (const raw of bad) assert.equal(parseClientMsg(raw), null, raw);
  assert.deepEqual(parseClientMsg('{"t":"leave"}'), { t: 'leave' });
  assert.deepEqual(parseClientMsg('{"t":"leave","kick":2}'), { t: 'leave' }, '남을 내보내는 메시지가 아니다: 보낸 연결의 자리만 비운다');
});

test('normalizeRoomCode: 사람이 친 코드를 정리하고, 형식이 다르면 거부', () => {
  assert.equal(normalizeRoomCode(' abc-234 '), 'ABC234');
  assert.equal(normalizeRoomCode('ABC234'), 'ABC234');
  for (const bad of ['', 'ABC23', 'ABC2345', 'ABC10O', 'ABC23<', null, undefined, 123456, 'A'.repeat(100)]) {
    assert.equal(normalizeRoomCode(bad), null, String(bad));
  }
});

test('sim: 보스는 보물상자를 떨어뜨리고, 회복 아이템은 체력이 가득이면 줍지 않는다', () => {
  const w = createWorld(7);
  const p = addPlayer(w, 'a');
  w.enemies.push({ id: 9001, type: 'legacy_code', x: p.x + 200, y: p.y, hp: 1, spd: 1, frozen: 0, kbTaken: 0, resFreeze: 0, kbTime: 0, kbMult: 0, vx: 0, vy: 0, life: 0, hit: false, chest: [1, 0, 0, 100] });
  w.shots.push({ id: 9002, kind: 'log', owner: p.id, x: p.x + 200, y: p.y, vx: 0, vy: 0, ttl: 1, dmg: 99, pierce: 0, r: 4, hit: new Set(), life: 1, rehit: 0, turn: 0, w: 'console_log' });
  step(w, DT);
  assert.equal(w.items.filter((it) => it.kind === 'chest').length, 1, '보스 처치 → 보물상자');
  assert.equal(w.heals.length, 0, '보스는 회복 아이템을 떨어뜨리지 않는다 (뱀서)');
  w.heals.push({ id: 9010, x: p.x + 200, y: p.y });
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
  assert.equal(p.hp, 40 + HEAL_AMOUNT, '회복 아이템 하나에 30 (뱀서 Floor Chicken)');
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

test('sim: 러버덕은 정해진 시간 돌고 쉬기를 되풀이하고, 화면은 스냅샷의 반경·각속도·틱만으로 서버와 같은 자리에 그린다', () => {
  const w = createWorld(9);
  const p = addPlayer(w, 'a');
  p.xpNext = 1e9;
  w.itemCd = 1e9;
  p.up.rubber_duck = 4; // 2마리 (2단계에 +1), 3단계에 반경·속도 +, 4단계에 지속 +0.5초
  const st = effectiveStats(p, 'rubber_duck');
  assert.equal(st.amount, 2);
  const counts: number[] = [];
  for (let i = 0; i < 20 * 12; i++) {
    p.hp = 1e9;
    step(w, DT);
    counts.push(buildSnapshot(w, p.id)!.p[0]![6]);
  }
  const on = counts.filter((n) => n === 2).length / counts.length;
  // 3.5초 돌고 3초 쉰다 → 약 54%
  assert.ok(on > 0.45 && on < 0.62, `도는 시간의 비율 ${on.toFixed(2)}`);
  assert.ok(counts.includes(0), '쉬는 동안은 0');
  // 도는 중인 순간을 골라 서버 판정 위치와 화면 위치를 비교한다
  while (buildSnapshot(w, p.id)!.p[0]![6] === 0) step(w, DT);
  const snap = decodeSnapshot(encodeSnapshot(buildSnapshot(w, p.id)!));
  const row = snap.p.find((r) => r[0] === p.id)!;
  assert.equal(row[8], Math.round(36 * 1.25), '반경 (3단계에 +25%)');
  assert.equal(row[9], Math.round(2.6 * 1.3 * 10), '각속도 ×10 (3단계에 +30%)');
  for (let i = 0; i < 2; i++) {
    const [cx, cy] = duckOffset(snap.tick * DT, i, row[6], row[8], row[9] / 10);
    const [sx, sy] = duckOffset(w.time, i, 2, Math.round(st.area), Math.round(st.speed * 10) / 10);
    assert.ok(Math.abs(cx - sx) < 1e-6 && Math.abs(cy - sy) < 1e-6, `오리 ${i}`);
  }
});

test('sim: 같은 방 동료는 멀리 있어도 스냅샷에 있고, 멀리 있는 적은 없다', () => {
  const w = createWorld(4);
  const a = addPlayer(w, 'a');
  const b = addPlayer(w, 'b');
  b.x = a.x + VIEW_RADIUS * 3;
  w.enemies.push({ id: 7001, type: 'bug', x: b.x + 10, y: b.y, hp: 1e9, spd: 1, frozen: 0, kbTaken: 0, resFreeze: 0, kbTime: 0, kbMult: 0, vx: 0, vy: 0, life: 0, hit: false });
  w.heals.push({ id: 7002, x: b.x + 10, y: b.y });
  const snap = buildSnapshot(w, a.id)!;
  assert.deepEqual(snap.p.map((r) => r[0]).sort(), [a.id, b.id].sort());
  assert.equal(snap.e.find((e) => e[0] === 7001), undefined, '시야 밖 적은 보내지 않는다');
  assert.equal(snap.h.length, 0, '시야 밖 아이템도 보내지 않는다');
  assert.equal(buildSnapshot(w, b.id)!.h.length, 1);
});

test('codec: 스냅샷을 이진으로 보냈다가 풀면 같은 내용이다 (좌표는 1/4 픽셀 이내)', () => {
  const w = createWorld(21);
  const a = addPlayer(w, 'a');
  const b = addPlayer(w, 'b');
  // 영역(웅덩이·발자국·폭발)과 여러 투사체가 다 실리도록 무기를 골고루 준다
  a.up = { console_log: 8, rubber_duck: 2, hotfix: 3, commit_history: 2, logic_bomb: 2, firewall: 3 };
  b.up = { console_log: 1, keyboard_cat: 2, code_freeze: 2, canary: 2 };
  let checked = 0;
  let zones = 0;
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
      // 입력 번호와 도착한 때는 방이 채운다: 큰 번호도 그대로 오가야 한다
      snap.ack = i * 1_000_003;
      snap.ackPhase = i % 256;
      const bin = encodeSnapshot(snap);
      const back = decodeSnapshot(bin);
      jsonBytes += JSON.stringify(snap).length;
      binBytes += bin.length;
      assert.equal(back.tick, snap.tick);
      assert.equal(back.paused, snap.paused);
      assert.deepEqual([back.ack, back.ackTicks, back.ackPhase], [snap.ack, snap.ackTicks, snap.ackPhase]);
      assert.deepEqual(back.me, snap.me);
      assert.equal(back.p.length, snap.p.length);
      for (const [k, list] of [['e', snap.e], ['s', snap.s], ['z', snap.z], ['g', snap.g], ['h', snap.h], ['p', snap.p]] as const) {
        const got = back[k] as number[][];
        assert.equal(got.length, list.length, k);
        list.forEach((row: number[], n: number) => {
          row.forEach((v, c) => {
            const isCoord = k === 'e' || k === 's' || k === 'z' ? c === 2 || c === 3 : c === 1 || c === 2;
            // 적·투사체·경험치·회복 아이템은 1/4 픽셀, 영역은 1/16 픽셀, 플레이어는 f32
            const tol = k === 'z' ? 1 / 16 : k === 'p' ? 0.001 : 1 / 8;
            if (isCoord) assert.ok(Math.abs(got[n]![c]! - v) <= tol + 0.02, `${k}[${n}][${c}] ${got[n]![c]} vs ${v}`);
            else assert.equal(got[n]![c], v, `${k}[${n}][${c}]`);
          });
        });
      }
      checked++;
      zones += snap.z.length;
    }
  }
  assert.ok(checked > 500);
  assert.ok(zones > 20, `영역 ${zones}개를 확인했다`);
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
  w.enemies.push({ id: 5001, type: 'merge_conflict', x: p.x + 150, y: p.y, hp: 80, spd: 1, frozen: 0, kbTaken: 0, resFreeze: 0, kbTime: 0, kbMult: 0, vx: 0, vy: 0, life: 0, hit: false });
  w.enemies.push({ id: 5002, type: 'bug', x: p.x - 150, y: p.y, hp: 10, spd: 1, frozen: 0, kbTaken: 0, resFreeze: 0, kbTime: 0, kbMult: 0, vx: 0, vy: 0, life: 0, hit: false });
  const row = (id: number): number[] | undefined => buildSnapshot(w, p.id)!.e.find((e) => e[0] === id);
  step(w, DT);
  assert.equal(row(5001)![4], 0);
  assert.equal(row(5001)!.length, 6, '[id, 종류, x, y, 피격, 얼음] 뿐: 체력은 없다');

  const tank = w.enemies.find((e) => e.id === 5001)!;
  w.shots.push({ id: 5003, kind: 'log', owner: p.id, x: tank.x, y: tank.y, vx: 0, vy: 0, ttl: 1, dmg: 12, pierce: 0, r: 4, hit: new Set(), life: 1, rehit: 0, turn: 0, w: 'console_log' });
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
  p.up.npm_install = 1; // 범위 +40% → 50.4
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

/** 플레이어를 쓰러뜨린다 (접촉 피해로 쓰러질 때와 같은 상태) */
function fell(p: ReturnType<typeof addPlayer>): void {
  p.alive = false;
  p.hp = 0;
  p.dx = 0;
  p.dy = 0;
}

test('관전: 쓰러진 사람은 입력으로 시점만 움직인다. 묘비는 제자리에 남고, 보이는 범위는 시점을 따라간다', () => {
  const w = createWorld(31);
  const a = addPlayer(w, 'a');
  const b = addPlayer(w, 'b');
  a.xpNext = b.xpNext = 1e9;
  a.x = a.y = 0;
  b.x = 30;
  b.y = 0;
  quietStep(w);
  fell(b);
  setInput(w, b.id, 1, 0);
  for (let i = 0; i < 20; i++) quietStep(w); // 1초
  assert.deepEqual([b.x, b.y], [30, 0], '묘비는 움직이지 않는다');
  assert.ok(Math.abs(b.camX - (30 + SPECTATOR_SPEED)) < 0.001, `1초에 ${SPECTATOR_SPEED}px (${b.camX})`);
  assert.equal(b.camY, 0);

  // 시점 근처의 적은 보이고, 묘비 근처지만 시점에서 먼 적은 보이지 않는다
  w.enemies.push({ id: 7001, type: 'bug', x: b.camX + ENEMY_VIEW_RADIUS - 20, y: 0, hp: 1e9, spd: 1, frozen: 0, kbTaken: 0, resFreeze: 0, kbTime: 0, kbMult: 0, vx: 0, vy: 0, life: 0, hit: false });
  w.enemies.push({ id: 7002, type: 'bug', x: b.x - ENEMY_VIEW_RADIUS + 20, y: 0, hp: 1e9, spd: 1, frozen: 0, kbTaken: 0, resFreeze: 0, kbTime: 0, kbMult: 0, vx: 0, vy: 0, life: 0, hit: false });
  const snap = decodeSnapshot(encodeSnapshot(buildSnapshot(w, b.id)!));
  assert.ok(Math.abs(snap.view[0] - b.camX) < 0.11 && snap.view[1] === 0, `시점이 스냅샷에 실린다 (${snap.view})`);
  assert.equal(snap.me.alive, false);
  assert.deepEqual(snap.e.map((e) => e[0]), [7001]);
  const grave = snap.p.find((row) => row[0] === b.id)!;
  assert.deepEqual([grave[1], grave[2], grave[4]], [30, 0, 0], '내 묘비는 쓰러진 자리에 그대로 실린다');
  // 살아 있는 사람의 스냅샷은 전과 같다: 중심은 자기 캐릭터
  const mine = buildSnapshot(w, a.id)!;
  assert.deepEqual(mine.view, [a.x, a.y]);
  assert.deepEqual(mine.e.map((e) => e[0]).sort(), [7002]);
});

test('관전: 시점은 살아 있는 동료에게서 정해진 거리보다 멀어질 수 없고, 동료가 움직이면 따라 끌려간다', () => {
  const w = createWorld(32);
  const a = addPlayer(w, 'a');
  const b = addPlayer(w, 'b');
  a.xpNext = b.xpNext = 1e9;
  a.x = a.y = b.y = 0;
  b.x = 10;
  fell(b);
  setInput(w, b.id, 1, 0);
  let far = 0;
  for (let i = 0; i < 20 * 8; i++) {
    quietStep(w);
    far = Math.max(far, Math.hypot(b.camX - a.x, b.camY - a.y));
  }
  assert.ok(far <= SPECTATOR_LEASH + 0.001, `${far}`);
  assert.ok(far > SPECTATOR_LEASH - 1, '끝까지는 갈 수 있다');
  // 동료가 반대쪽으로 달아나도 (관전자는 계속 반대로 가려고 해도) 거리는 유지된다
  setInput(w, a.id, -1, 0);
  for (let i = 0; i < 20 * 5; i++) {
    quietStep(w);
    assert.ok(Math.hypot(b.camX - a.x, b.camY - a.y) <= SPECTATOR_LEASH + 0.001);
  }
  // 동료가 둘이면 더 가까운 쪽 기준
  const c = addPlayer(w, 'c');
  c.xpNext = 1e9;
  c.x = b.camX + 50;
  c.y = 0;
  setInput(w, a.id, -1, 0);
  setInput(w, b.id, 0, 0);
  const at = b.camX;
  for (let i = 0; i < 20 * 3; i++) quietStep(w);
  assert.equal(b.camX, at, '가까운 동료(c)가 곁에 있으면 멀어지는 동료(a)에게 끌려가지 않는다');
});

test('관전: 동료와 멀리 떨어져 쓰러지면 시점이 한 번에 튀지 않고 빠르게 미끄러져 동료 쪽으로 온다', () => {
  const w = createWorld(33);
  const a = addPlayer(w, 'a');
  const b = addPlayer(w, 'b');
  a.xpNext = b.xpNext = 1e9;
  a.x = a.y = b.y = 0;
  b.x = 1500;
  quietStep(w);
  fell(b);
  let prev = b.camX;
  let ticks = 0;
  while (Math.hypot(b.camX - a.x, b.camY - a.y) > SPECTATOR_LEASH + 0.001 && ticks < 200) {
    quietStep(w);
    assert.ok(Math.abs(b.camX - prev) <= 45.001, `한 틱에 ${Math.abs(b.camX - prev)}px`);
    prev = b.camX;
    ticks++;
  }
  assert.ok(ticks > 5 && ticks <= 30, `${ticks}틱`);
  assert.equal(b.x, 1500, '묘비는 쓰러진 자리에');
  // 그동안의 스냅샷도 문제없이 만들어진다 (묘비가 시점에서 1000px 넘게 떨어져 있어도)
  const snap = decodeSnapshot(encodeSnapshot(buildSnapshot(w, b.id)!));
  assert.ok(Math.abs(snap.p.find((row) => row[0] === b.id)![1] - 1500) < 0.01);
});

test('관전으로 합류한 사람은 몸이 없다: 화면에 그려지지 않고, 적의 표적도 아니고, 아무것도 줍지 못한다', () => {
  const w = createWorld(34);
  const a = addPlayer(w, 'a');
  a.xpNext = 1e9;
  a.x = a.y = 0;
  const s = addPlayer(w, 'watcher', true);
  assert.deepEqual([s.alive, s.body, s.hp], [false, false, 0]);
  assert.ok(Math.hypot(s.camX - a.x, s.camY - a.y) < 30, '살아 있는 사람 곁에서 보기 시작한다');

  // 관전자 바로 옆에 경험치·회복 아이템·적을 둔다 (살아 있는 a 에게서는 멀리)
  setInput(w, s.id, 1, 0);
  for (let i = 0; i < 20 * 2; i++) quietStep(w);
  const gem: Gem = { id: 8001, x: s.camX + 3, y: s.camY, v: 5 };
  w.gems.push(gem);
  w.heals.push({ id: 8002, x: s.camX, y: s.camY + 3 });
  // 적은 관전자와 a 사이에 둔다: a 에게 가면 관전자에게서는 멀어진다
  w.enemies.push({ id: 8003, type: 'bug', x: s.camX - 60, y: s.camY, hp: 1e9, spd: 1, frozen: 0, kbTaken: 0, resFreeze: 0, kbTime: 0, kbMult: 0, vx: 0, vy: 0, life: 0, hit: false });
  const gemAt = gem.x;
  const toWatcher = 60;
  const toPlayer = Math.hypot(s.camX - 60 - a.x, s.camY - a.y);
  setInput(w, s.id, 0, 0);
  for (let i = 0; i < 10; i++) {
    w.shots.length = 0;
    step(w, DT);
  }
  assert.deepEqual([gem.x, gem.to, s.xp], [gemAt, undefined, 0], '관전자 곁의 경험치는 끌려가지 않는다');
  assert.equal(w.gems.length, 1);
  assert.equal(w.heals.length, 1, '회복 아이템도 줍지 못한다');
  const bug = w.enemies.find((e) => e.id === 8003)!;
  assert.ok(Math.hypot(bug.x - a.x, bug.y - a.y) < toPlayer - 3, '적은 살아 있는 사람에게 간다');
  assert.ok(Math.hypot(bug.x - s.camX, bug.y - s.camY) > toWatcher, '관전자를 쫓지 않는다');

  // 누구의 스냅샷에도 관전자의 줄이 없다 (본인 것에도). 관전자의 스냅샷은 시점 주변을 보여준다.
  for (const viewer of [a, s]) assert.deepEqual(buildSnapshot(w, viewer.id)!.p.map((row) => row[0]), [a.id]);
  const snap = decodeSnapshot(encodeSnapshot(buildSnapshot(w, s.id)!));
  assert.equal(snap.me.alive, false);
  assert.ok(snap.e.some((e) => e[0] === 8003));

  // 살아 있는 사람이 모두 쓰러지면 관전자가 남아 있어도 판이 끝난다
  fell(a);
  step(w, DT);
  assert.equal(w.over, true);
});

/* ───────────── 필드 아이템과 부활 ───────────── */

test('필드 아이템: 아주 가끔, 화면 밖 적당한 거리에 놓이고, 동시에 몇 개를 넘지 않으며, 줍지 않으면 사라진다', () => {
  const w = createWorld(41);
  const p = addPlayer(w, 'a');
  p.xpNext = 1e9;
  const born = new Map<number, number>();
  const gone = new Map<number, number>();
  const kinds: string[] = [];
  for (let i = 0; i < 20 * 60 * 60; i++) {
    p.hp = 1e9;
    quietStep(w);
    assert.ok(w.items.length <= MAX_FIELD_ITEMS);
    for (const it of w.items) {
      if (born.has(it.id)) continue;
      born.set(it.id, w.time);
      kinds.push(it.kind);
      const d = Math.hypot(it.x - p.x, it.y - p.y);
      assert.ok(d >= FIELD_ITEM_MIN_DIST - 0.001 && d <= FIELD_ITEM_MAX_DIST + 0.001, `놓인 거리 ${d}`);
    }
    for (const id of born.keys()) if (!gone.has(id) && !w.items.some((it) => it.id === id)) gone.set(id, w.time);
  }
  const times = [...born.values()];
  const expected = 3600 / FIELD_ITEM_INTERVAL;
  assert.ok(times.length >= expected * 0.65 && times.length <= expected * 1.35, `한 시간에 ${times.length}개 (평균 ${FIELD_ITEM_INTERVAL}초에 하나면 약 ${Math.round(expected)}개)`);
  assert.ok(times[0]! >= FIELD_ITEM_INTERVAL * 0.6 - 0.1, `첫 아이템은 ${times[0]}초에: 시작하자마자 나오지 않는다`);
  for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= FIELD_ITEM_INTERVAL * 0.6 - 0.1, `간격 ${times[i]! - times[i - 1]!}`);
  // 아무도 줍지 않았으므로 전부 수명(90초)을 채우고 사라졌다
  for (const [id, at] of gone) assert.ok(Math.abs(at - born.get(id)! - FIELD_ITEM_TTL) < 0.11, `수명 ${at - born.get(id)!}`);
  assert.ok(kinds.every((k) => (FIELD_ITEM_KINDS as readonly string[]).includes(k)));
  assert.ok(kinds.filter((k) => k === 'heal').length > kinds.filter((k) => k === 'levelup').length, '피자가 가장 흔하다');
});

test('필드 아이템: 무엇이 언제 어디에 놓일지는 비밀 난수만으로 정해진다 (보이는 난수를 쓰지 않는다)', () => {
  // 비밀 난수가 항상 같은 값을 내면: 간격, 방향, 거리, 종류가 그 값으로 정해진다
  const run = (value: number): { kind: string; at: number; visibleDraws: number } => {
    let visible = 0;
    const base = sfc32(7);
    const w = createWorld({ rng: () => (visible++, base()), secret: () => value });
    const p = addPlayer(w, 'a');
    p.xpNext = 1e9;
    const before = visible;
    while (w.items.length === 0 && w.time < 200) {
      p.hp = 1e9;
      quietStep(w);
    }
    // quietStep 은 적을 지우지만 스폰 자체(보이는 난수)는 매 틱 돌아간다. 아이템이 놓이는 틱에도 그 횟수는 달라지지 않아야 한다.
    return { kind: w.items[0]!.kind, at: w.time, visibleDraws: visible - before };
  };
  const heal = run(0.5);
  const levelup = run(0.7);
  const revive = run(0.995);
  assert.deepEqual([heal.kind, levelup.kind, revive.kind], ['heal', 'levelup', 'revive'], '비중 65 / 34 / 1');
  assert.ok(Math.abs(heal.at - FIELD_ITEM_INTERVAL) < 0.11 && levelup.at > heal.at && revive.at > levelup.at, `${heal.at} ${levelup.at} ${revive.at}`);
  // 같은 시각까지의 보이는 난수 소비량은 아이템과 무관하다: 0.5 로 75초까지 돌린 것과, 아이템이 아직 없는 0.7 의 75초 시점이 같아야 한다
  let visible = 0;
  const base = sfc32(7);
  const w = createWorld({ rng: () => (visible++, base()), secret: () => 0.7 });
  const p = addPlayer(w, 'a');
  p.xpNext = 1e9;
  const before = visible;
  while (w.time < heal.at - 0.001) {
    p.hp = 1e9;
    quietStep(w);
  }
  assert.equal(w.items.length, 0);
  assert.equal(visible - before, heal.visibleDraws, '아이템이 놓였든 아니든 보이는 난수는 똑같이 쓰였다');
  assert.equal(FIELD_ITEMS.revive.weight, 1);
});

test('필드 아이템: 피자는 체력이 닳았을 때만, LGTM 은 정확히 한 레벨, 백업은 하나만 가질 수 있다', () => {
  const w = createWorld(42);
  const p = addPlayer(w, 'a');
  p.xpNext = 1e9;
  w.itemCd = 1e9; // 저절로 놓이는 것은 끄고 직접 놓는다
  const put = (kind: 'heal' | 'levelup' | 'revive', dx = 5): number => {
    const id = w.nextId++;
    w.items.push({ id, kind, x: p.x + dx, y: p.y, ttl: FIELD_ITEM_TTL });
    return id;
  };
  const has = (id: number): boolean => w.items.some((it) => it.id === id);

  // 피자: 체력이 가득이면 남겨 두고, 닳았으면 30 회복 (뱀서 Floor Chicken)
  const pizza = put('heal');
  quietStep(w);
  assert.ok(has(pizza), '체력이 가득이면 줍지 않는다');
  p.hp = 50;
  quietStep(w);
  assert.ok(!has(pizza));
  assert.equal(p.hp, 80);
  // 범위 밖의 것은 줍지 않는다
  const far = put('heal', PLAYER_BASE_PICKUP + 10);
  quietStep(w);
  assert.ok(has(far));
  w.items.length = 0;

  // 백업: 하나만
  const first = put('revive');
  quietStep(w);
  assert.ok(!has(first));
  assert.equal(p.revives, 1);
  const second = put('revive');
  quietStep(w);
  assert.ok(has(second), '이미 가지고 있으면 줍지 않고 남는다');
  assert.equal(p.revives, 1);
  w.items.length = 0;

  // LGTM: 모으던 경험치는 그대로 두고 정확히 한 레벨, 바로 강화 선택지가 뜬다
  p.xpNext = 20;
  p.xp = 7;
  const level = p.level;
  const lgtm = put('levelup');
  quietStep(w);
  assert.ok(!has(lgtm));
  assert.equal(p.level, level + 1);
  assert.equal(p.xp, 7, '모으던 경험치는 남는다');
  assert.ok(p.offers && p.offers.length > 0, '강화 선택지가 뜬다');
  assert.ok(w.events.some((e) => e.type === 'offers' && e.pid === p.id));
  // 선택 중에는 다른 아이템을 줍지 못한다 (혼자면 월드가 멈춘다)
  const waiting = put('revive');
  quietStep(w);
  assert.ok(has(waiting));
});

test('필드 아이템: 함께 할 때는 가장 가까운 사람이 갖고, 쓰러진 사람과 관전자는 줍지 못한다', () => {
  const w = createWorld(43);
  const a = addPlayer(w, 'a');
  const b = addPlayer(w, 'b');
  const watcher = addPlayer(w, 'w', true);
  a.xpNext = b.xpNext = 1e9;
  w.itemCd = 1e9;
  a.x = a.y = b.y = 0;
  b.x = 40;
  w.items.push({ id: 9101, kind: 'revive', x: 25, y: 0, ttl: 90 });
  quietStep(w);
  assert.deepEqual([a.revives, b.revives], [0, 1], 'a 에게서 25, b 에게서 15: 더 가까운 b');
  // b 는 이미 하나 가졌으므로 다음 것은 조금 더 먼 a 가 갖는다
  w.items.push({ id: 9102, kind: 'revive', x: 25, y: 0, ttl: 90 });
  quietStep(w);
  assert.deepEqual([a.revives, b.revives, w.items.length], [1, 1, 0]);
  // 쓰러진 사람의 묘비나 관전 시점이 아이템 위에 있어도 줍지 못한다
  fell(a);
  a.revives = 0;
  watcher.camX = 0;
  watcher.camY = 0;
  w.items.push({ id: 9103, kind: 'revive', x: 2, y: 0, ttl: 90 });
  for (let i = 0; i < 5; i++) quietStep(w);
  assert.deepEqual([a.revives, watcher.revives, w.items.length], [0, 0, 1]);
});

test('부활: 백업이 있으면 쓰러질 순간에 그 자리에서 되살아나고, 잠깐 무적이며, 두 번째에는 쓰러진다', () => {
  const w = createWorld(44);
  const p = addPlayer(w, 'a');
  p.xpNext = 1e9;
  w.itemCd = 1e9;
  p.revives = 1;
  p.hp = 0.5;
  const swarm = (): void => {
    w.enemies.length = 0;
    for (let i = 0; i < 12; i++) w.enemies.push({ id: 9200 + i, type: 'bug', x: p.x + Math.cos(i) * 3, y: p.y + Math.sin(i) * 3, hp: 1e9, spd: 1, frozen: 0, kbTaken: 0, resFreeze: 0, kbTime: 0, kbMult: 0, vx: 0, vy: 0, life: 0, hit: false });
    w.enemies.push({ id: 9290, type: 'bug', x: p.x, y: p.y, hp: 1e9, spd: 1, frozen: 0, kbTaken: 0, resFreeze: 0, kbTime: 0, kbMult: 0, vx: 0, vy: 0, life: 0, hit: false }); // 정확히 겹친 적
  };
  swarm();
  w.shots.length = 0;
  step(w, DT);
  assert.equal(p.alive, true, '쓰러지지 않고 되살아났다');
  assert.equal(w.over, false);
  assert.equal(p.revives, 0);
  assert.equal(p.hp, 50, '최대 체력의 절반');
  assert.ok(p.shield > REVIVE_SHIELD_SECONDS - 0.11);
  for (const e of w.enemies) {
    const d = Math.hypot(e.x - p.x, e.y - p.y);
    assert.ok(Number.isFinite(d) && d >= REVIVE_BLAST_RADIUS - 6, `주변의 적은 밀려난다 (${d})`);
  }
  // 무적인 동안에는 적이 붙어 있어도 체력이 줄지 않는다
  const snap = decodeSnapshot(encodeSnapshot(buildSnapshot(w, p.id)!));
  assert.equal(snap.me.revives, 0);
  assert.equal(snap.p[0]![7], 1, '무적 중이라는 표시가 실린다');
  for (let i = 0; i < REVIVE_SHIELD_SECONDS * 20 - 2; i++) {
    swarm();
    w.shots.length = 0;
    step(w, DT);
    assert.equal(p.hp, 50, `무적 중 (${i}틱)`);
  }
  // 무적이 끝나면 다시 피해를 받고, 백업이 없으므로 이번에는 쓰러진다
  for (let i = 0; i < 20 * 30 && p.alive; i++) {
    swarm();
    w.shots.length = 0;
    step(w, DT);
  }
  assert.equal(p.alive, false);
  assert.equal(buildSnapshot(w, p.id)!.p[0]![7], 0);
  step(w, DT);
  assert.equal(w.over, true, '혼자 하는 판은 여기서 끝난다');
});

test('필드 아이템: 멀리 있어도 스냅샷에 실린다 (미니맵용). 곧 사라질 때는 표시가 붙고, 이진 변환을 거쳐도 그대로다', () => {
  const w = createWorld(45);
  const a = addPlayer(w, 'a');
  const b = addPlayer(w, 'b');
  a.xpNext = b.xpNext = 1e9;
  w.itemCd = 1e9;
  a.x = a.y = 0;
  b.x = 9000;
  b.y = -4000;
  w.items.push({ id: 9301, kind: 'levelup', x: 5000.3, y: -1234.5, ttl: FIELD_ITEM_TTL });
  w.items.push({ id: 9302, kind: 'revive', x: -700, y: 650, ttl: FIELD_ITEM_FADE + 0.2 });
  w.enemies.push({ id: 9303, type: 'bug', x: 5000, y: -1234, hp: 1e9, spd: 1, frozen: 0, kbTaken: 0, resFreeze: 0, kbTime: 0, kbMult: 0, vx: 0, vy: 0, life: 0, hit: false });
  for (const viewer of [a, b]) {
    const raw = buildSnapshot(w, viewer.id)!;
    const snap = decodeSnapshot(encodeSnapshot(raw));
    assert.deepEqual(snap.i.map((row) => [row[0], FIELD_ITEM_KINDS[row[1]], row[4]]), [[9301, 'levelup', 0], [9302, 'revive', 0]], '누구에게나, 거리와 상관없이');
    assert.ok(Math.abs(snap.i[0]![2] - 5000.3) < 0.01 && Math.abs(snap.i[0]![3] + 1234.5) < 0.01, `${snap.i[0]}`);
    assert.ok(!snap.e.some((e) => e[0] === 9303), '멀리 있는 적은 여전히 보내지 않는다');
  }
  // 수명이 10초 아래로 내려가면 "곧 사라짐" 표시
  w.enemies.length = 0;
  for (let i = 0; i < 10; i++) {
    a.hp = b.hp = 1e9;
    quietStep(w);
  }
  const later = decodeSnapshot(encodeSnapshot(buildSnapshot(w, a.id)!));
  assert.deepEqual(later.i.map((row) => [row[0], row[4]]), [[9301, 0], [9302, 1]]);
  // 가지고 있는 백업 수도 실린다
  a.revives = 1;
  assert.equal(decodeSnapshot(encodeSnapshot(buildSnapshot(w, a.id)!)).me.revives, 1);
  assert.equal(decodeSnapshot(encodeSnapshot(buildSnapshot(w, b.id)!)).me.revives, 0, '남의 것은 보내지 않는다');
  // 알 수 없는 종류 번호가 들어 있으면 그 스냅샷은 버린다
  const bytes = encodeSnapshot(buildSnapshot(w, a.id)!);
  const broken = Uint8Array.from(bytes);
  broken[broken.length - 9] = 0x7f; // 마지막 아이템의 종류 바이트
  assert.throws(() => decodeSnapshot(broken), RangeError);
});

/* ───────────── 공격 범위 강화 (듀얼 모니터) ───────────── */

test('듀얼 모니터: 공격 범위(크기)가 한 단계에 10% 씩 커진다. 겨누는 거리와 탄이 날아가는 거리는 그대로다 (뱀서 Area)', () => {
  assert.equal(areaMultOf({ up: {} }), 1);
  assert.ok(Math.abs(areaMultOf({ up: { dual_monitor: 5 } }) - 1.5) < 1e-9);
  assert.ok(Math.abs(areaMultOf({ up: { dual_monitor: 99 } }) - 1.5) < 1e-9, '최대 단계를 넘는 값이 와도 최대로 친다');
  // 가만히 서서 console.log 만으로, 정해진 거리에 놓은 적을 맞히는지 본다
  const hits = (level: number, dist: number): boolean => {
    const w = createWorld(51);
    const p = addPlayer(w, 'a');
    p.xpNext = 1e9;
    w.itemCd = 1e9;
    if (level > 0) p.up.dual_monitor = level;
    const target = { id: 9500, type: 'merge_conflict' as const, x: p.x + dist, y: p.y, hp: 1e9, spd: 1, frozen: 0, kbTaken: 0, resFreeze: 0, kbTime: 0, kbMult: 0, vx: 0, vy: 0, life: 0, hit: false };
    for (let i = 0; i < 20 * 4; i++) {
      p.hp = 1e9;
      // 스폰된 다른 적은 치우고 표적만 제자리에 둔다
      target.x = p.x + dist;
      target.y = p.y;
      w.enemies.length = 0;
      w.enemies.push(target);
      step(w, DT);
      if (target.hit) return true;
    }
    return false;
  };
  assert.equal(hits(0, 190), true, '기본 조준 거리(200) 안');
  assert.equal(hits(0, 225), false, '기본 조준 거리 밖은 겨누지 않는다');
  assert.equal(hits(5, 225), false, '듀얼 모니터로 겨누는 거리가 늘지 않는다');
  assert.ok(Math.abs(effectiveStats({ up: { console_log: 1, dual_monitor: 5 } }, 'console_log').area - 4 * 1.5) < 1e-9, '탄의 크기는 커진다');
});

test('입력 반영 틱 수: 같은 입력으로 움직인 틱을 세고, 입력이 오면 다시 센다. 움직이지 못하는 동안에는 세지 않는다', () => {
  const w = createWorld(21);
  const p = addPlayer(w, 'a');
  const tick = (): void => {
    p.hp = 1e9;
    step(w, DT);
  };
  setInput(w, p.id, 1, 0);
  for (let i = 0; i < 3; i++) tick();
  assert.equal(buildSnapshot(w, p.id)!.ackTicks, 3);
  // 같은 방향을 다시 보내도 새 입력이다: 클라이언트는 입력 번호마다 따로 센다
  setInput(w, p.id, 1, 0);
  assert.equal(buildSnapshot(w, p.id)!.ackTicks, 0);
  tick();
  assert.equal(buildSnapshot(w, p.id)!.ackTicks, 1);
  // 선택지를 고르는 동안에는 서버가 캐릭터를 세워 둔다: 그동안은 세지 않고, 위치도 그대로다
  const x = p.x;
  p.offers = ['coffee'];
  for (let i = 0; i < 5; i++) tick();
  assert.equal(buildSnapshot(w, p.id)!.ackTicks, 1);
  assert.equal(p.x, x);
  p.offers = null;
  for (let i = 0; i < 400; i++) tick();
  assert.equal(buildSnapshot(w, p.id)!.ackTicks, 255, '255 에서 멈춘다 (한 바이트)');
  // 화면을 위한 값일 뿐이다: 위치는 입력과 틱으로만 정해진다
  assert.ok(Math.abs(p.x - (x + 400 * PLAYER_BASE_SPEED * DT)) < 1e-6);
});

test('틱 도중에 도착한 입력: 도착한 때부터 적용한다. 누른 시간만큼만 움직이고, 한 틱에 가는 거리는 늘지 않는다', () => {
  const w = createWorld(22);
  const p = addPlayer(w, 'a');
  p.xpNext = 1e9; // 레벨업 선택으로 월드가 멈추지 않게 (이동만 본다)
  const tick = (): void => {
    p.hp = 1e9;
    step(w, DT);
  };
  const per = PLAYER_BASE_SPEED * DT;
  // 틱의 40% 지점에서 누르면 그 틱에는 나머지 60% 만큼만 간다
  let x = p.x;
  setInput(w, p.id, 1, 0, 0.4);
  tick();
  assert.ok(Math.abs(p.x - x - per * 0.6) < 1e-9);
  // 다음 틱부터는 한 틱을 다 간다
  tick();
  assert.ok(Math.abs(p.x - x - per * 1.6) < 1e-9);
  // 틱의 25% 지점에서 떼면 그 틱에는 25% 만큼만 더 간다: 누르고 있던 시간은 0.6 + 1 + 0.25 틱
  setInput(w, p.id, 0, 0, 0.25);
  tick();
  tick();
  assert.ok(Math.abs(p.x - x - per * 1.85) < 1e-9);
  // 한 틱 안에서 방향을 여러 번 바꿔도 각 구간의 길이만큼씩만 간다. 순서가 뒤집힌 시각은 앞으로 당겨지지 않는다
  x = p.x;
  const y = p.y;
  setInput(w, p.id, 1, 0, 0);
  setInput(w, p.id, 0, 1, 0.5);
  setInput(w, p.id, -1, 0, 0.2); // 0.5 보다 앞이라고 주장해도 0.5 부터다
  tick();
  assert.ok(Math.abs(p.x - x - per * (0.5 - 0.5)) < 1e-9 && Math.abs(p.y - y) < 1e-9);
  // 어떤 조합이어도 한 틱에 기본 속도보다 멀리 가지 못한다
  for (let i = 0; i < 200; i++) {
    const bx = p.x;
    const by = p.y;
    for (let k = 0; k < 5; k++) setInput(w, p.id, Math.cos(i * k), Math.sin(i + k), ((i * 7 + k * 13) % 10) / 9);
    tick();
    assert.ok(Math.hypot(p.x - bx, p.y - by) <= per * 1.0001);
  }
  // 엉뚱한 값은 0 으로 본다 (틱의 처음부터)
  setInput(w, p.id, 0, 0);
  tick();
  x = p.x;
  setInput(w, p.id, 1, 0, Number.NaN);
  tick();
  assert.ok(Math.abs(p.x - x - per) < 1e-9);
  // 월드가 멈춰 있는 동안 온 입력의 몫은 다음 틱으로 넘어가지 않는다
  setInput(w, p.id, 0, 0);
  p.offers = ['coffee'];
  setInput(w, p.id, 1, 0, 0.9);
  step(w, DT);
  assert.deepEqual([p.part, p.preX, p.preY], [0, 0, 0]);
});
