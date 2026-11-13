import { randomInt, randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  DT,
  MAX_PLAYERS_PER_ROOM,
  OFFER_TIMEOUT,
  TICK_RATE,
  addPlayer,
  buildSnapshot,
  createWorld,
  offersOf,
  pickOffer,
  removePlayer,
  setInput,
  step,
  type GameMode,
  type RunResult,
  type ServerMsg,
  type World,
} from '@friday-deploy/shared';
import { sign } from './security';

export interface Conn {
  ws: WebSocket;
  sid: string;
  pid: number;
  lastSeq: number;
}

const MAX_ROOMS = 200;
/** 아무 입력 없이 방치된 방을 정리하는 시간 */
const ROOM_IDLE_MS = 3 * 60 * 1000;
/** 느린 클라이언트 보호: 송신 버퍼가 이 이상 쌓이면 스냅샷을 건너뛴다 */
const MAX_BUFFERED = 256 * 1024;

export class Room {
  readonly id = randomUUID().slice(0, 8);
  readonly world: World;
  private conns = new Map<number, Conn>();
  private timer: NodeJS.Timeout;
  private lastActivity = Date.now();
  closed = false;

  constructor(
    readonly mode: GameMode,
    private readonly onClose: (room: Room) => void,
  ) {
    // 시드는 서버의 CSPRNG 에서 뽑고 클라이언트에 공개하지 않는다 (스폰/드롭/선택지 예측 방지)
    this.world = createWorld(randomInt(0, 2 ** 31));
    this.timer = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  get joinable(): boolean {
    return !this.closed && !this.world.over && this.mode === 'coop' && this.conns.size < MAX_PLAYERS_PER_ROOM;
  }

  join(ws: WebSocket, sid: string, name: string): Conn {
    const p = addPlayer(this.world, name);
    const conn: Conn = { ws, sid, pid: p.id, lastSeq: -1 };
    this.conns.set(p.id, conn);
    this.send(conn, { t: 'welcome', id: p.id, room: this.id, tickRate: TICK_RATE });
    this.broadcastRoster();
    return conn;
  }

  leave(conn: Conn): void {
    if (!this.conns.delete(conn.pid)) return;
    removePlayer(this.world, conn.pid);
    if (this.conns.size === 0) this.close();
    else this.broadcastRoster();
  }

  onInput(conn: Conn, seq: number, dx: number, dy: number): boolean {
    // 시퀀스는 단조 증가해야 한다 (리플레이/순서 조작 방지)
    if (seq <= conn.lastSeq) return false;
    conn.lastSeq = seq;
    this.lastActivity = Date.now();
    setInput(this.world, conn.pid, dx, dy);
    return true;
  }

  onPick(conn: Conn, choice: number): boolean {
    this.lastActivity = Date.now();
    return pickOffer(this.world, conn.pid, choice);
  }

  private tick(): void {
    if (this.closed) return;
    if (Date.now() - this.lastActivity > ROOM_IDLE_MS) {
      for (const c of this.conns.values()) c.ws.close(4008, 'idle');
      this.close();
      return;
    }
    step(this.world, DT);

    for (const ev of this.world.events.splice(0)) {
      if (ev.type === 'offers') {
        const conn = this.conns.get(ev.pid);
        const p = this.world.players.get(ev.pid);
        if (conn && p) this.send(conn, { t: 'levelup', offers: offersOf(p), timeout: OFFER_TIMEOUT });
      } else if (ev.type === 'over') {
        this.finish();
        return;
      }
    }

    for (const conn of this.conns.values()) {
      if (conn.ws.bufferedAmount > MAX_BUFFERED) continue;
      const snap = buildSnapshot(this.world, conn.pid);
      if (snap) this.send(conn, snap);
    }
  }

  private finish(): void {
    const endedAt = Date.now();
    for (const conn of this.conns.values()) {
      const p = this.world.players.get(conn.pid);
      if (!p) continue;
      // 결과는 서버가 계산하고 서버가 서명한다. 리더보드는 이 서명이 있는 결과만 받는다.
      const result: RunResult = {
        sid: conn.sid,
        name: p.name,
        time: Math.floor(this.world.time),
        kills: p.kills,
        level: p.level,
        endedAt,
      };
      this.send(conn, { t: 'over', result, sig: sign(JSON.stringify(result)) });
      conn.ws.close(1000, 'over');
    }
    this.close();
  }

  private broadcastRoster(): void {
    const players = [...this.world.players.values()].map((p) => ({ id: p.id, name: p.name }));
    for (const c of this.conns.values()) this.send(c, { t: 'roster', players });
  }

  private send(conn: Conn, msg: ServerMsg): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.onClose(this);
  }
}

export class RoomManager {
  private rooms = new Set<Room>();

  get count(): number {
    return this.rooms.size;
  }

  /** solo: 항상 새 방 / coop: 자리가 있는 방에 합류하거나 새로 생성 */
  find(mode: GameMode): Room | null {
    if (mode === 'coop') for (const r of this.rooms) if (r.joinable) return r;
    if (this.rooms.size >= MAX_ROOMS) return null;
    const room = new Room(mode, (r) => this.rooms.delete(r));
    this.rooms.add(room);
    return room;
  }
}
