import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DT, PLAYER_BASE_SPEED, addPlayer, buildSnapshot, createWorld, decodeSnapshot, encodeSnapshot, setInput, step } from '@friday-deploy/shared';
import { Predictor } from './predict';

/**
 * 실제 시뮬레이션(서버)과 예측(클라이언트)을 지연이 있는 통신으로 이어서 돌려 본다.
 * 서버는 20Hz 로 돌고, 클라이언트는 60Hz 로 그린다. 입력은 main.ts 와 같은 규칙으로 보낸다 (바뀌면 50ms 간격, 안 바뀌어도 1초마다).
 */
interface Net {
  /** 편도 지연 (ms) */
  up: number;
  down: number;
  /** 스냅샷마다 더 늦는 정도의 최댓값 (ms) */
  jitter?: number;
  /** 입력마다 더 늦는 정도의 최댓값 (ms) */
  upJitter?: number;
}
interface Frame {
  t: number;
  /** 화면에 그린 내 위치 */
  x: number;
  y: number;
  /** 그 순간 클라이언트가 가진 가장 최근의 서버 위치 */
  sx: number;
  sy: number;
}

function play(net: Net, seconds: number, want: (t: number) => [number, number], seed = 1): { frames: Frame[]; end: [number, number] } {
  const world = createWorld(seed);
  const me = addPlayer(world, 'me');
  const pred = new Predictor();
  let rand = seed;
  const noise = (): number => {
    rand = (rand * 1103515245 + 12345) & 0x7fffffff;
    return rand / 0x7fffffff;
  };

  const toServer: { at: number; seq: number; dx: number; dy: number }[] = [];
  const toClient: { at: number; x: number; y: number; ack: number; ackTicks: number; ackPhase: number }[] = [];
  let lastSeq = 0;
  let newest = { x: me.x, y: me.y, ack: 0, ackTicks: 0, ackPhase: 0 };
  let phase = 0;
  let seq = 0;
  let sent = { dx: 0, dy: 0, at: -1e9 };
  let nextTick = 50;
  let lastArrive = 0;
  let lastUp = 0;
  const frames: Frame[] = [];

  const FRAME = 1000 / 60;
  for (let t = 0; t < seconds * 1000; t += FRAME) {
    // 서버: 이 프레임까지 지난 틱을 돌린다
    while (nextTick <= t) {
      while (toServer.length > 0 && toServer[0]!.at <= nextTick) {
        const m = toServer.shift()!;
        lastSeq = m.seq;
        // room.ts 와 같은 계산: 직전 틱에서 얼마나 지나서 도착했는지
        phase = Math.max(0, Math.min(255, Math.floor(((m.at - (nextTick - 50)) * 20 * 256) / 1000)));
        setInput(world, me.id, m.dx, m.dy, phase / 256);
      }
      me.hp = 1e9; // 이동만 본다: 쓰러지지 않게
      me.offers = null;
      step(world, DT);
      // 실제와 같이 이진 인코딩을 거친다 (위치가 0.1px 로 반올림되고 f32 가 된다)
      const snap = buildSnapshot(world, me.id)!;
      snap.ack = lastSeq;
      snap.ackPhase = phase;
      const got = decodeSnapshot(encodeSnapshot(snap));
      // 늦게 오더라도 순서는 바뀌지 않는다 (TCP)
      lastArrive = Math.max(lastArrive, nextTick + net.down + noise() * (net.jitter ?? 0));
      toClient.push({ at: lastArrive, x: got.view[0], y: got.view[1], ack: got.ack, ackTicks: got.ackTicks, ackPhase: got.ackPhase });
      nextTick += 50;
    }
    // 클라이언트: 받은 것 중 가장 최근 것
    while (toClient.length > 0 && toClient[0]!.at <= t) newest = toClient.shift()!;
    if (pred.advance(FRAME / 1000, true)) sent.at = -1e9;
    const [dx, dy] = want(t);
    const changed = dx !== sent.dx || dy !== sent.dy;
    if ((changed && t - sent.at >= 50) || t - sent.at >= 1000) {
      sent = { dx, dy, at: t };
      seq++;
      pred.onSent(seq, dx, dy);
      lastUp = Math.max(lastUp, t + net.up + noise() * (net.upJitter ?? 0));
      toServer.push({ at: lastUp, seq, dx, dy });
    }
    const [x, y] = pred.place({ ...newest, speed: PLAYER_BASE_SPEED }, newest.x, newest.y, FRAME / 1000);
    frames.push({ t, x, y, sx: newest.x, sy: newest.y });
  }
  return { frames, end: [me.x, me.y] };
}

const at = (frames: Frame[], t: number): Frame => frames.find((f) => f.t >= t)!;

test('예측: 누른 다음 프레임부터 움직인다 (서버의 답을 기다리지 않는다)', () => {
  const press = 1000;
  const { frames } = play({ up: 60, down: 60 }, 3, (t) => (t >= press ? [1, 0] : [0, 0]));
  const x0 = at(frames, press - 20).x;
  const pressed = frames.findIndex((f) => f.t >= press);
  assert.ok(frames[pressed + 1]!.x > x0 + 0.5, `누른 다음 프레임에 이미 움직였다: ${frames[pressed + 1]!.x - x0}`);
  // 같은 순간 서버가 보낸 위치는 아직 그대로다 (왕복 120ms + 틱)
  assert.equal(at(frames, press + 100).sx, at(frames, press - 20).sx, '서버 위치는 아직 안 움직였다');
  assert.ok(at(frames, press + 100).x - x0 > 5, '그동안 화면에서는 이미 5px 넘게 움직였다');
});

test('예측: 한 방향으로 갈 때 프레임마다 같은 거리만큼 움직인다 (스냅샷이 들쭉날쭉 와도)', () => {
  const { frames } = play({ up: 60, down: 60, jitter: 80 }, 6, (t) => (t >= 500 ? [1, 0] : [0, 0]));
  const step = PLAYER_BASE_SPEED / 60;
  let worst = 0;
  for (let i = 1; i < frames.length; i++) {
    if (frames[i]!.t < 1000) continue;
    worst = Math.max(worst, Math.abs(frames[i]!.x - frames[i - 1]!.x - step));
  }
  // 서버 위치가 0.1px 로 반올림되어 오는 만큼만 흔들린다
  assert.ok(worst < 0.15, `프레임 사이 이동이 고르다: 가장 큰 차이 ${worst.toFixed(3)}px (한 프레임 ${step.toFixed(2)}px)`);
});

test('예측: 멈추면 서버가 계산한 자리에 선다 (앞서 그린 만큼이 그대로 서버 위치가 된다)', () => {
  for (const net of [{ up: 30, down: 30 }, { up: 60, down: 60, jitter: 80 }, { up: 150, down: 150, jitter: 40 }]) {
    const { frames, end } = play(net, 5, (t) => (t >= 500 && t < 3000 ? [0.6, -0.8] : [0, 0]));
    const stop = at(frames, 3000);
    const final = frames.at(-1)!;
    assert.ok(Math.hypot(final.x - end[0], final.y - end[1]) < 0.1, '끝에는 서버 위치와 같다');
    // 손을 뗀 순간 그리던 자리가 곧 서버가 최종으로 정한 자리다 (서버가 입력을 도착한 때부터 적용하므로 틱 단위로 어긋나지 않는다)
    const off = Math.hypot(stop.x - end[0], stop.y - end[1]);
    assert.ok(off < 0.3, `왕복 ${net.up + net.down}ms: 손을 뗀 자리와 서버 자리의 차이 ${off.toFixed(2)}px`);
    // 손을 뗀 뒤에 뒤로 끌려가거나 튀지 않는다: 그 뒤의 어떤 프레임도 한 번에 1px 넘게 움직이지 않는다
    let jump = 0;
    for (let i = frames.indexOf(stop) + 1; i < frames.length; i++) jump = Math.max(jump, Math.hypot(frames[i]!.x - frames[i - 1]!.x, frames[i]!.y - frames[i - 1]!.y));
    assert.ok(jump < 1, `멈춘 뒤 가장 큰 움직임 ${jump.toFixed(2)}px`);
  }
});

test('예측: 입력이 서버에 가는 시간이 들쭉날쭉하면 그만큼만 어긋나고, 튀지 않고 맞춰진다', () => {
  // 입력마다 0~40ms 더 늦게 도착한다: 서버가 움직인 시간이 누른 시간과 최대 40ms(2.8px) 다를 수 있다
  for (const seed of [1, 2, 3, 4, 5]) {
    const { frames, end } = play({ up: 60, down: 60, jitter: 40, upJitter: 40 }, 5, (t) => (t >= 500 && t < 3000 ? [1, 0] : [0, 0]), seed);
    const stop = at(frames, 3000);
    const off = Math.hypot(stop.x - end[0], stop.y - end[1]);
    assert.ok(off < 3, `손을 뗀 자리와 서버 자리의 차이 ${off.toFixed(2)}px`);
    let jump = 0;
    for (let i = frames.indexOf(stop) + 1; i < frames.length; i++) jump = Math.max(jump, Math.abs(frames[i]!.x - frames[i - 1]!.x));
    assert.ok(jump < 0.6, `멈춘 뒤 한 프레임에 가장 크게 움직인 거리 ${jump.toFixed(2)}px`);
    assert.ok(Math.abs(frames.at(-1)!.x - end[0]) < 0.1, '끝에는 서버 위치와 같다');
  }
});

test('예측: 방향을 자주 바꿔도 서버 위치에서 멀어지지 않는다', () => {
  // 0.3초마다 방향을 바꾼다 (조이스틱을 돌리는 것처럼 대각선도 섞는다)
  const dirs: [number, number][] = [[1, 0], [0.71, 0.71], [0, 1], [-1, 0], [0, -1], [0.71, -0.71]];
  const want = (t: number): [number, number] => (t < 500 || t >= 7000 ? [0, 0] : dirs[Math.floor(t / 300) % dirs.length]!);
  const { frames, end } = play({ up: 60, down: 60, jitter: 60 }, 9, want);
  const final = frames.at(-1)!;
  assert.ok(Math.hypot(final.x - end[0], final.y - end[1]) < 0.1, '끝에는 서버 위치와 같다');
  // 그리는 자리는 서버의 가장 최근 위치보다 "아직 반영되지 않은 시간"만큼만 앞선다: 0.4초 × 70px/s = 28px 를 넘을 수 없다
  let lead = 0;
  let jump = 0;
  for (let i = 1; i < frames.length; i++) {
    lead = Math.max(lead, Math.hypot(frames[i]!.x - frames[i]!.sx, frames[i]!.y - frames[i]!.sy));
    jump = Math.max(jump, Math.hypot(frames[i]!.x - frames[i - 1]!.x, frames[i]!.y - frames[i - 1]!.y));
  }
  assert.ok(lead < 28.5, `서버 위치보다 가장 많이 앞선 거리 ${lead.toFixed(1)}px`);
  // 한 프레임에 가는 거리는 1.17px. 어긋남을 고치는 중에도 그 두 배를 넘게 튀지 않는다
  assert.ok(jump < 2.4, `한 프레임에 가장 크게 움직인 거리 ${jump.toFixed(2)}px`);
});

test('예측: 통신이 막혀도 0.4초 거리보다 더 앞서 나가지 않는다', () => {
  const pred = new Predictor();
  pred.advance(0.016, true);
  pred.onSent(1, 1, 0);
  let x = 0;
  for (let i = 0; i < 300; i++) {
    pred.advance(1 / 60, true);
    [x] = pred.place({ x: 100, y: 0, ack: 0, ackTicks: 0, ackPhase: 0, speed: 70 }, 100, 0, 1 / 60);
  }
  assert.ok(Math.abs(x - (100 + 0.4 * 70)) < 0.5, `서버가 5초 동안 답이 없을 때 ${x.toFixed(1)}`);
});

test('예측: 월드가 멈춰 있는 동안에는 앞서 그리지 않고, 다시 움직이면 입력을 새로 보내 거기서부터 센다', () => {
  const pred = new Predictor();
  assert.equal(pred.advance(1 / 60, true), true, '처음 움직이기 시작한 순간');
  pred.onSent(1, 1, 0);
  for (let i = 0; i < 30; i++) pred.advance(1 / 60, true);
  pred.place({ x: 0, y: 0, ack: 0, ackTicks: 0, ackPhase: 0, speed: 70 }, 0, 0, 1 / 60);
  // 멈춤: 서버 위치(10, 0)에서 멈췄다. 예측하지 않고 서버 위치를 쓴다 (멈춘 동안에는 그리던 자리에서 미끄러지지 않는다)
  assert.equal(pred.advance(1 / 60, false), false);
  const held = pred.place({ x: 10, y: 0, ack: 1, ackTicks: 3, ackPhase: 0, speed: 70 }, 10, 0, 1 / 60, true);
  for (let i = 0; i < 120; i++) {
    pred.advance(1 / 60, false);
    assert.deepEqual(pred.place({ x: 10, y: 0, ack: 1, ackTicks: 3, ackPhase: 0, speed: 70 }, 10, 0, 1 / 60, true), held);
  }
  // 보낸 뒤 30프레임(0.5초)이 흘렀고 서버가 3틱(0.15초)을 반영했다. 멈춘 2초는 세지 않는다
  assert.ok(Math.abs(pred.lead(1, 3)[0] - 0.35) < 1e-9, '시계가 멈춰 있어서 더 늘지 않는다');
  // 다시 움직인다: 그 전의 입력은 버리고 새 입력부터 센다
  assert.equal(pred.advance(1 / 60, true), true);
  assert.deepEqual(pred.lead(1, 3), [0, 0]);
  pred.onSent(2, 0, 1);
  pred.advance(0.1, true);
  const [lx, ly] = pred.lead(1, 3);
  assert.ok(lx === 0 && Math.abs(ly - 0.1) < 1e-9, '서버가 아직 옛 입력을 확인해 주는 동안: 새 입력은 전부 아직 반영되지 않은 것');
  const [ax, ay] = pred.lead(2, 1);
  assert.ok(ax === 0 && Math.abs(ay - (0.1 - DT)) < 1e-9, '새 입력을 한 틱 반영했다: 그만큼을 뺀다');
});

test('예측: 쓰러지면 예측을 끄고 서버가 정한 시점으로 부드럽게 넘어간다. 크게 어긋나면 바로 옮긴다', () => {
  const pred = new Predictor();
  pred.advance(1 / 60, true);
  pred.onSent(1, 1, 0);
  let x = 0;
  for (let i = 0; i < 12; i++) {
    pred.advance(1 / 60, true);
    [x] = pred.place({ x: 0, y: 0, ack: 0, ackTicks: 0, ackPhase: 0, speed: 70 }, 0, 0, 1 / 60);
  }
  assert.ok(x > 10);
  // 쓰러졌다: 서버 시점은 (0, 0). 한 번에 튀지 않고 줄어든다
  pred.advance(1 / 60, false);
  const [a] = pred.place(null, 0, 0, 1 / 60);
  assert.ok(a > x * 0.8 && a < x, `첫 프레임 ${a.toFixed(2)} (직전 ${x.toFixed(2)})`);
  let b = a;
  for (let i = 0; i < 60; i++) [b] = pred.place(null, 0, 0, 1 / 60);
  assert.ok(Math.abs(b) < 0.01, '1초 뒤에는 서버 시점과 같다');
  // 새 판처럼 위치가 멀리 바뀌면 미끄러지지 않고 바로 간다
  const [fx, fy] = pred.place(null, 500, 500, 1 / 60);
  assert.ok(Math.hypot(fx - 500, fy - 500) < 0.01);
});
