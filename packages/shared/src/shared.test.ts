import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addPlayer, buildSnapshot, createWorld, parseClientMsg, pickOffer, sanitizeName, setInput, step, DT, PLAYER_BASE_SPEED } from './index';

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
