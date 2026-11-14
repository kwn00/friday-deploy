import type { Snapshot } from '@friday-deploy/shared';

/**
 * 스냅샷 재생 버퍼.
 *
 * 서버는 초당 20번 스냅샷을 보내지만 네트워크를 거치면 도착 간격이 들쭉날쭉해진다.
 * "도착한 시각"을 기준으로 보간하면 늦게 온 스냅샷에서 멈췄다가 다음 스냅샷에서 튀어 보인다.
 * 그래서 스냅샷에 찍힌 서버 틱을 시간축으로 삼고, 가장 최근 틱보다 조금 뒤(지연)를 일정한 속도로 재생한다.
 * 지연은 측정한 도착 흔들림에 맞춰 자동으로 늘거나 준다.
 */

const TICK_MS = 50;
/** 재생 위치가 목표에서 이만큼(틱) 벗어나면 따라가지 않고 바로 옮긴다 */
const SNAP_THRESHOLD = 6;
const MIN_MARGIN = 0.2;
const MAX_MARGIN = 2.5;
/** 가끔 크게 늦는 패킷(모바일 망)에 대비해 최근의 가장 큰 지연을 기억했다가 서서히 잊는다 (약 4초에 절반) */
const PEAK_HALF_LIFE_MS = 4000;
/** 오래된 스냅샷을 무한정 쌓지 않는다 (탭이 잠깐 멈췄다 돌아온 경우 등) */
const MAX_BUFFER = 40;

export interface Sample {
  prev: Snapshot;
  curr: Snapshot;
  /** prev → curr 사이의 위치 (0..1) */
  alpha: number;
  /** 지금 화면에 보이는 서버 틱 (소수) */
  tick: number;
}

export class Timeline {
  private buf: Snapshot[] = [];
  private playhead = 0;
  private lastArrival = 0;
  private lastArrivalTick = 0;
  /** 도착 간격이 기대값에서 벗어난 정도의 이동 평균 (ms) */
  private jitter = 0;
  /** 최근에 본 가장 큰 벗어남 (ms). 시간이 지나면 줄어든다 */
  private peak = 0;

  reset(): void {
    this.buf = [];
    this.playhead = 0;
    this.lastArrival = 0;
    this.jitter = 0;
    this.peak = 0;
  }

  get newest(): Snapshot | null {
    return this.buf[this.buf.length - 1] ?? null;
  }

  /** 현재 재생 지연 (틱). 1틱(다음 스냅샷을 기다리는 최소한) + 흔들림 여유 */
  get delayTicks(): number {
    const margin = Math.max(this.jitter * 2.5, this.peak * 0.9) / TICK_MS;
    return 1 + Math.min(MAX_MARGIN, Math.max(MIN_MARGIN, margin));
  }

  push(snap: Snapshot, now: number): void {
    const last = this.newest;
    if (last && snap.tick < last.tick) this.reset(); // 새 판이 시작됐거나 순서가 꼬였다 → 처음부터
    const tail = this.newest;
    if (tail && snap.tick === tail.tick) {
      // 월드가 멈춰 있는 동안에는 같은 틱이 반복된다. 쌓지 않고 최신 내용으로 바꾼다.
      this.buf[this.buf.length - 1] = snap;
    } else {
      if (tail && this.lastArrival > 0 && !tail.paused) {
        const gap = now - this.lastArrival;
        const expected = (snap.tick - this.lastArrivalTick) * TICK_MS;
        const dev = Math.min(250, Math.abs(gap - expected));
        this.jitter += (dev - this.jitter) * 0.1;
        // 늦게 온 것만 여유를 키운다 (밀렸던 패킷이 한꺼번에 일찍 도착하는 것은 재생을 끊지 않는다)
        const late = Math.min(250, Math.max(0, gap - expected));
        this.peak = Math.max(late, this.peak * Math.pow(0.5, gap / PEAK_HALF_LIFE_MS));
      }
      this.buf.push(snap);
      if (this.buf.length === 1) this.playhead = snap.tick;
      if (this.buf.length > MAX_BUFFER) this.buf.splice(0, this.buf.length - MAX_BUFFER);
    }
    this.lastArrival = now;
    this.lastArrivalTick = snap.tick;
  }

  /**
   * 재생 위치를 dtMs 만큼 진행시키고, 그 위치를 사이에 둔 두 스냅샷을 돌려준다.
   * 목표보다 뒤처졌으면 살짝 빠르게, 앞섰으면 살짝 느리게 재생해서 눈에 띄는 끊김 없이 맞춰 간다.
   */
  advance(dtMs: number): Sample | null {
    const newest = this.newest;
    if (!newest) return null;
    const first = this.buf[0]!;
    // 멈춘 상태면 지연 없이 마지막 장면까지 재생한다 (그래야 멈춘 순간의 모습이 정확히 보인다)
    const target = newest.paused ? newest.tick : newest.tick - this.delayTicks;
    const err = target - this.playhead;
    if (Math.abs(err) > SNAP_THRESHOLD) {
      this.playhead = target;
    } else {
      const speed = newest.paused ? 1.5 : Math.min(1.25, Math.max(0.75, 1 + err * 0.08));
      this.playhead += (dtMs / TICK_MS) * speed;
    }
    // 받은 범위를 벗어나 재생하지 않는다 (예측해서 그리지 않는다)
    this.playhead = Math.min(newest.tick, Math.max(first.tick, this.playhead));

    // playhead 를 사이에 둔 두 스냅샷: buf[i].tick <= playhead < buf[i+1].tick
    let i = 0;
    while (i < this.buf.length - 2 && this.buf[i + 1]!.tick <= this.playhead) i++;
    if (i > 0) {
      this.buf.splice(0, i);
    }
    const prev = this.buf[0]!;
    const curr = this.buf[1] ?? prev;
    const span = curr.tick - prev.tick;
    const alpha = span > 0 ? Math.min(1, Math.max(0, (this.playhead - prev.tick) / span)) : 1;
    return { prev, curr, alpha, tick: this.playhead };
  }
}
