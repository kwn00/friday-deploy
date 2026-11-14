import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Snapshot } from '@friday-deploy/shared';
import { Timeline } from './timeline';

/** x 가 틱마다 3.5 씩 일정하게 움직이는 물체 하나만 담은 스냅샷 */
function snap(tick: number, paused = false): Snapshot {
  return {
    t: 'snap', tick, time: tick / 20, paused, view: [tick * 3.5, 0],
    me: { id: 1, hp: 100, maxHp: 100, xp: 0, xpNext: 6, level: 1, kills: 0, alive: true, up: {} },
    p: [[1, tick * 3.5, 0, 1, 1, 100, 0]], e: [], s: [], g: [], h: [],
  };
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 스냅샷이 jitterMs 만큼 들쭉날쭉 도착할 때, 60fps 로 그린 프레임별 이동량을 돌려준다 */
function play(jitterMs: number, seconds: number, render: (now: number, dt: number) => number | null, push: (s: Snapshot, now: number) => void): number[] {
  const rng = mulberry(42);
  const arrivals: { at: number; s: Snapshot }[] = [];
  for (let k = 0; k < seconds * 20; k++) arrivals.push({ at: 100 + k * 50 + rng() * jitterMs, s: snap(k) });
  // WebSocket(TCP)은 순서를 보장한다: 늦은 패킷은 뒤따르는 패킷도 함께 늦춘다
  for (let i = 1; i < arrivals.length; i++) arrivals[i]!.at = Math.max(arrivals[i]!.at, arrivals[i - 1]!.at);
  const xs: number[] = [];
  let next = 0;
  const frame = 1000 / 60;
  for (let now = 0; now < seconds * 1000; now += frame) {
    while (next < arrivals.length && arrivals[next]!.at <= now) push(arrivals[next]!.s, arrivals[next++]!.at);
    const x = render(now, frame);
    if (x !== null) xs.push(x);
  }
  const steps: number[] = [];
  for (let i = 1; i < xs.length; i++) steps.push(xs[i]! - xs[i - 1]!);
  return steps.slice(120); // 처음 2초(버퍼가 차는 동안)는 뺀다
}

const stats = (steps: number[]): { stalls: number; maxJump: number } => {
  const ideal = (3.5 * 20) / 60;
  return { stalls: steps.filter((s) => s < ideal * 0.2).length, maxJump: Math.max(...steps) / ideal };
};

test('timeline: 도착이 들쭉날쭉해도 멈칫하거나 튀지 않고 일정하게 재생한다', () => {
  for (const jitter of [0, 15, 40, 70, 100]) {
    const tl = new Timeline();
    const steps = play(jitter, 20, (_now, dt) => {
      const s = tl.advance(dt);
      if (!s) return null;
      const a = s.prev.p[0]![1];
      return a + (s.curr.p[0]![1] - a) * s.alpha;
    }, (s, now) => tl.push(s, now));
    const r = stats(steps);
    assert.equal(r.stalls, 0, `흔들림 ${jitter}ms: 멈칫 ${r.stalls}회`);
    assert.ok(r.maxJump < 1.35, `흔들림 ${jitter}ms: 가장 큰 프레임 이동이 정상의 ${r.maxJump.toFixed(2)}배`);
  }
});

test('timeline: (회귀) 예전 방식은 같은 조건에서 멈칫하고 튄다', () => {
  // 예전 코드: 가장 최근 두 스냅샷 사이를 "도착 시각" 기준으로 보간
  let prev: Snapshot | null = null;
  let curr: Snapshot | null = null;
  let currAt = 0;
  const steps = play(40, 20, (now) => {
    if (!curr) return null;
    const alpha = prev ? Math.min(1, (now - currAt) / 50) : 1;
    const a = prev ? prev.p[0]![1] : curr.p[0]![1];
    return a + (curr.p[0]![1] - a) * alpha;
  }, (s, now) => {
    prev = curr;
    curr = s;
    currAt = now;
  });
  const r = stats(steps);
  assert.ok(r.stalls > 20 && r.maxJump > 1.8, `예전 방식: 멈칫 ${r.stalls}회, 최대 ${r.maxJump.toFixed(2)}배`);
});

test('timeline: 흔들림이 클수록 지연을 늘리고, 안정되면 최소로 유지한다', () => {
  const calm = new Timeline();
  const rough = new Timeline();
  play(2, 10, (_n, dt) => (calm.advance(dt), null), (s, now) => calm.push(s, now));
  play(60, 10, (_n, dt) => (rough.advance(dt), null), (s, now) => rough.push(s, now));
  assert.ok(calm.delayTicks < 1.5, `안정: ${calm.delayTicks}`);
  assert.ok(rough.delayTicks > calm.delayTicks + 0.3, `안정 ${calm.delayTicks} / 불안정 ${rough.delayTicks}`);
  assert.ok(rough.delayTicks <= 3.5);
});

test('timeline: 멈춘 스냅샷이 오면 그 장면까지 재생한 뒤 멈추고, 재개하면 뒤로 가지 않는다', () => {
  const tl = new Timeline();
  let now = 0;
  for (let k = 0; k <= 40; k++) {
    tl.push(snap(k), now);
    for (let f = 0; f < 3; f++) tl.advance(1000 / 60);
    now += 50;
  }
  // 일시정지: 같은 틱이 paused 로 온다 (쌓이지 않는다)
  tl.push(snap(40, true), now);
  tl.push(snap(40, true), now + 50);
  let s = tl.advance(1000 / 60)!;
  for (let f = 0; f < 30; f++) s = tl.advance(1000 / 60)!;
  assert.equal(s.tick, 40, '멈춘 순간의 장면까지 간다');
  for (let f = 0; f < 120; f++) s = tl.advance(1000 / 60)!;
  assert.equal(s.tick, 40, '멈춰 있는 동안에는 더 나아가지 않는다');
  // 재개
  let lastTick = s.tick;
  for (let k = 41; k <= 80; k++) {
    tl.push(snap(k), now);
    for (let f = 0; f < 3; f++) {
      s = tl.advance(1000 / 60)!;
      assert.ok(s.tick >= lastTick, '시간이 거꾸로 가지 않는다');
      lastTick = s.tick;
    }
    now += 50;
  }
  assert.ok(lastTick > 75);
});

test('timeline: 새 판이 시작되면(틱이 되돌아가면) 버퍼를 비우고 새로 시작한다', () => {
  const tl = new Timeline();
  for (let k = 500; k < 520; k++) tl.push(snap(k), k * 50);
  tl.advance(16);
  tl.push(snap(0), 30_000);
  const s = tl.advance(16)!;
  assert.equal(s.curr.tick, 0);
  assert.equal(s.tick, 0);
});
