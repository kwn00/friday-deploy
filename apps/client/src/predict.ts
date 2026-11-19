import { DT } from '@friday-deploy/shared';

/**
 * 내 캐릭터 위치 예측 (화면 전용).
 *
 * 서버가 보낸 위치만 그리면, 누른 입력이 서버를 다녀오고 재생 버퍼를 지난 뒤에야 캐릭터가 움직인다.
 * 그래서 내 캐릭터만은 서버의 가장 최근 위치에 "보냈지만 서버가 아직 반영하지 않은 입력"만큼을 더해서 그린다.
 * 서버는 스냅샷마다 마지막으로 받은 입력 번호(ack), 그 입력으로 움직인 틱 수(ackTicks),
 * 그 입력이 틱 사이의 어디쯤에서 도착했는지(ackPhase)를 알려 준다.
 *
 * 판정은 하나도 바뀌지 않는다: 위치·피격·획득은 여전히 서버가 계산하고, 여기서 계산한 위치는 서버로 보내지 않는다.
 * 이 값을 조작해도 달라지는 것은 자기 화면뿐이다.
 */

/** 서버보다 앞서 그리는 시간의 상한 (초). 통신이 막혀도 캐릭터가 끝없이 앞서 나가지 않는다 */
const MAX_LEAD = 0.4;
/** 예측이 어긋났을 때 서버 위치로 맞춰 가는 시간 (초). 이만큼 지나면 차이의 약 63% 가 사라진다 */
const SETTLE = 0.1;
/** 이보다 크게 어긋나면(px) 미끄러지지 않고 바로 옮긴다 (새 판, 다시 연결 등) */
const SNAP = 40;
/** 기억해 두는 보낸 입력 수. 서버가 확인해 주면 지워지므로 평소에는 몇 개뿐이다 */
const MAX_SENT = 64;

interface Sent {
  seq: number;
  dx: number;
  dy: number;
  /** 보낸 때의 예측 시계 (초) */
  at: number;
}

/** 서버가 알려 준 가장 최근의 내 상태 */
export interface Base {
  x: number;
  y: number;
  ack: number;
  ackTicks: number;
  ackPhase: number;
  /** 이동 속도 (px/s) */
  speed: number;
}

export class Predictor {
  /** 내 캐릭터가 움직일 수 있는 동안에만 흐르는 시계 (초). 월드가 멈춰 있으면 같이 멈춘다 */
  private clock = 0;
  private sent: Sent[] = [];
  private running = false;
  /** 마지막으로 그린 위치와, 그때 예측을 썼는지 */
  private last: [number, number] | null = null;
  private lastPredicted = false;
  /** 그린 위치 - 목표 위치. 어긋남을 한 번에 고치지 않고 서서히 줄인다 */
  private err: [number, number] = [0, 0];
  private face: 1 | -1 | 0 = 0;
  /** 앞서 그리는 시간이 상한에 닿았다 (서버의 답이 오래 없다) */
  private capped = false;
  /** 마지막으로 그린 뒤에 내 입력으로 움직인 양 (방향 × 초) */
  private walked: [number, number] = [0, 0];

  reset(): void {
    this.clock = 0;
    this.sent = [];
    this.running = false;
    this.last = null;
    this.lastPredicted = false;
    this.err = [0, 0];
    this.face = 0;
    this.capped = false;
    this.walked = [0, 0];
  }

  /** 예측해서 그리는 중인지 */
  get active(): boolean {
    return this.running;
  }

  /** 지금 보내 둔 입력으로 움직이는 중인지 (걷는 그림) */
  get moving(): boolean {
    const cur = this.sent[this.sent.length - 1];
    return this.running && !!cur && (cur.dx !== 0 || cur.dy !== 0);
  }

  /** 바라보는 쪽. 아직 좌우로 움직인 적이 없으면 0 (서버가 알려 준 쪽을 쓴다) */
  get facing(): 1 | -1 | 0 {
    return this.face;
  }

  /**
   * 프레임마다 한 번 부른다. running: 지금 내 캐릭터가 움직일 수 있는 상태인지 (살아 있고, 월드가 멈춰 있지 않다).
   * 멈췄다가 다시 움직이기 시작한 순간이면 true 를 돌려준다: 그때는 입력을 새로 보내서 거기서부터 다시 센다.
   */
  advance(dt: number, running: boolean): boolean {
    const resumed = running && !this.running;
    // 멈춰 있던 동안 서버는 내 캐릭터를 움직이지 않았다. 그 전에 보낸 입력으로 더 앞서 그릴 것이 없다
    if (resumed) this.sent = [];
    this.running = running;
    if (running) {
      this.clock += dt;
      // 이 시간 동안에는 방금까지 보내 둔 입력으로 움직였다 (이번 프레임에 새로 보낼 입력은 지금부터다)
      const cur = this.sent[this.sent.length - 1];
      if (cur) this.walked = [this.walked[0] + cur.dx * dt, this.walked[1] + cur.dy * dt];
    }
    return resumed;
  }

  /** 입력을 보냈다. 서버(setInput)와 같은 방식으로 길이를 1 이하로 맞춘다 */
  onSent(seq: number, dx: number, dy: number): void {
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    this.sent.push({ seq, dx, dy, at: this.clock });
    if (this.sent.length > MAX_SENT) this.sent.shift();
    // 서버와 같은 기준: 좌우 성분이 충분할 때만 돌아선다
    if (len > 0 && Math.abs(dx / len) >= 0.3) this.face = dx < 0 ? -1 : 1;
  }

  /**
   * 서버가 아직 반영하지 않은 이동: [x, y] (방향 × 초). 여기에 속도를 곱하면 앞서 그릴 거리다.
   * ack 보다 앞선 입력은 이미 서버 위치에 들어 있다. ack 인 입력은 ackTicks 틱만큼 들어 있고, 그 뒤의 입력은 하나도 들어 있지 않다.
   * 서버는 입력을 틱 중간의 도착한 때(ackPhase)부터 적용한다. 그래서 첫 틱에는 한 틱이 아니라 그 나머지만큼만 반영됐다:
   * 그만큼을 덜 뺀다. 이것이 없으면 같은 방향으로 갈 때도 입력을 다시 보낼 때마다(1초에 한 번) 최대 한 틱 거리만큼 앞뒤로 흔들린다.
   */
  lead(ack: number, ackTicks: number, ackPhase = 0): [number, number] {
    while (this.sent.length > 0 && this.sent[0]!.seq < ack) this.sent.shift();
    let budget = MAX_LEAD;
    let end = this.clock;
    let x = 0;
    let y = 0;
    for (let i = this.sent.length - 1; i >= 0 && budget > 0; i--) {
      const s = this.sent[i]!;
      // 틱 수가 가득 찼으면(255) 얼마나 더 반영됐는지 알 수 없다: 전부 반영된 것으로 본다
      const start = s.seq === ack ? (ackTicks >= 255 ? end : s.at + Math.max(0, ackTicks - ackPhase / 256) * DT) : s.at;
      const dur = Math.min(budget, Math.max(0, end - start));
      x += s.dx * dur;
      y += s.dy * dur;
      budget -= dur;
      end = s.at;
    }
    this.capped = budget <= 0;
    return [x, y];
  }

  /**
   * 이번 프레임에 내 캐릭터(= 카메라)를 그릴 위치.
   * base: 서버의 가장 최근 상태. 예측할 수 없을 때(쓰러짐, 관전)는 null.
   * fx, fy: 예측하지 않을 때 쓰는 위치 (재생 버퍼가 보간한 서버 위치).
   * hold: 월드가 멈춰 있다. 멈춘 동안에는 어긋남을 줄이지 않는다 (멈춘 화면에서 캐릭터만 미끄러지지 않게).
   */
  place(base: Base | null, fx: number, fy: number, dt: number, hold = false): [number, number] {
    const predicted = !!base && this.running;
    let tx = fx;
    let ty = fy;
    let vx = 0;
    let vy = 0;
    if (base && predicted) {
      const [lx, ly] = this.lead(base.ack, base.ackTicks, base.ackPhase);
      tx = base.x + lx * base.speed;
      ty = base.y + ly * base.speed;
      // 상한에 닿아 있으면 목표가 더 나아가지 않는다
      if (!this.capped) {
        vx = this.walked[0] * base.speed;
        vy = this.walked[1] * base.speed;
      }
    }
    this.walked = [0, 0];
    if (!this.last) {
      this.err = [0, 0];
    } else if (predicted) {
      // 예측이 맞으면 목표는 정확히 (지난 위치 + 그동안 내 입력으로 움직인 거리)에 있다. 남는 차이가 서버와 어긋난 만큼이다
      this.err = [this.last[0] + vx - tx, this.last[1] + vy - ty];
    } else if (this.lastPredicted) {
      // 예측을 끄는 순간: 그리던 자리에서 서버 위치로 이어 간다
      this.err = [this.last[0] - tx, this.last[1] - ty];
    }
    if (Math.hypot(this.err[0], this.err[1]) > SNAP) this.err = [0, 0];
    if (predicted || !hold) {
      const keep = Math.exp(-dt / SETTLE);
      this.err = [this.err[0] * keep, this.err[1] * keep];
    }
    this.last = [tx + this.err[0], ty + this.err[1]];
    this.lastPredicted = predicted;
    return this.last;
  }
}
