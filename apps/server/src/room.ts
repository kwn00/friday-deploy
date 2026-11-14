import { randomInt, randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  DT,
  MAX_PAUSE_SECONDS,
  MAX_PLAYERS_PER_ROOM,
  OFFER_TIMEOUT,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LEN,
  TICK_RATE,
  addPlayer,
  buildSnapshot,
  createWorld,
  encodeSnapshot,
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
  name: string;
  pid: number;
  lastSeq: number;
  /** 이 판에 합류했을 때의 게임 시간(초). 결과에는 "함께 한 시간"만 적는다. */
  joinedAt: number;
}

const MAX_ROOMS = 200;
/** 아무 입력 없이 방치된 방을 정리하는 시간 */
const ROOM_IDLE_MS = 3 * 60 * 1000;
/** 시작하지 않은 대기실을 정리하는 시간 */
const LOBBY_IDLE_MS = 10 * 60 * 1000;
const MAX_PAUSE_MS = MAX_PAUSE_SECONDS * 1000;
/** 한 판에서 일시정지로 쓸 수 있는 시간의 합. 껐다 켜기를 반복해 방을 끝없이 붙잡아 두지 못하게 한다. */
const PAUSE_BUDGET_MS = 30 * 60 * 1000;
/** 느린 클라이언트 보호: 송신 버퍼가 이 이상 쌓이면 스냅샷을 건너뛴다 (스냅샷 약 30개 분량) */
const MAX_BUFFERED = 64 * 1024;

export class Room {
  readonly id = randomUUID().slice(0, 8);
  world: World;
  /** 이 방에서 끝난 판 수. 페어 방은 같은 연결로 여러 판을 하므로 결과를 구분하는 데 쓴다. */
  private runs = 0;
  private conns = new Map<number, Conn>();
  private timer: NodeJS.Timeout;
  private lastActivity = Date.now();
  /** 솔로는 만들자마자 시작, 페어는 방장이 시작할 때까지 대기실 */
  private started: boolean;
  private hostPid = -1;
  /** 솔로 전용 일시정지. 페어 방에서는 절대 true 가 되지 않는다. */
  private userPaused = false;
  private pausedAt = 0;
  /** 지금의 일시정지가 자동으로 풀리기까지의 시간 (ms) */
  private pauseLimit = 0;
  /** 이번 판에서 이미 쓴 일시정지 시간 (ms) */
  private pauseUsed = 0;
  /** 이번 판에서 누군가 쓰러진 적이 있는지. 있으면 이후에 들어오는 사람은 다음 판까지 관전한다. */
  private casualty = false;
  closed = false;

  constructor(
    readonly mode: GameMode,
    /** 페어 방 코드. 솔로는 빈 문자열 */
    readonly code: string,
    private readonly onClose: (room: Room) => void,
  ) {
    // 시드는 서버의 CSPRNG 에서 뽑고 클라이언트에 공개하지 않는다 (스폰/드롭/선택지 예측 방지)
    this.world = createWorld(randomInt(0, 2 ** 31));
    this.started = mode === 'solo';
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        // 한 방의 오류가 프로세스(= 모든 방)를 죽이지 않게, 그 방만 닫는다
        console.error('[error] room tick', err);
        this.kick('server_error');
      }
    }, 1000 / TICK_RATE);
  }

  /** 코드로 참가할 수 있는 상태인지 (진행 중인 판에도 자리가 있으면 합류 가능) */
  get joinable(): boolean {
    return !this.closed && !this.world.over && this.mode === 'coop' && this.conns.size < MAX_PLAYERS_PER_ROOM;
  }

  join(ws: WebSocket, sid: string, name: string): Conn {
    const p = addPlayer(this.world, name);
    // 누군가 쓰러진 뒤에 들어오면 이번 판은 관전만 한다. 그렇지 않으면 쓰러진 사람이 나갔다 다시 들어와
    // 새 캐릭터로 살아나는 것을 반복해 판을 끝없이 이어갈 수 있다.
    if (this.started && this.casualty) {
      p.alive = false;
      p.hp = 0;
    }
    const conn: Conn = { ws, sid, name: p.name, pid: p.id, lastSeq: -1, joinedAt: this.world.time };
    this.conns.set(p.id, conn);
    if (this.hostPid < 0) this.hostPid = p.id;
    this.lastActivity = Date.now();
    this.send(conn, { t: 'welcome', id: p.id, mode: this.mode, code: this.code, tickRate: TICK_RATE });
    this.broadcastRoster();
    return conn;
  }

  leave(conn: Conn): void {
    if (!this.conns.delete(conn.pid)) return;
    removePlayer(this.world, conn.pid);
    if (this.conns.size === 0) return this.close();
    // 방장이 나가면 가장 먼저 들어온 사람이 이어받는다 (대기실이 영영 시작되지 않는 일을 막는다)
    if (conn.pid === this.hostPid) this.hostPid = this.conns.keys().next().value ?? -1;
    this.broadcastRoster();
  }

  onInput(conn: Conn, seq: number, dx: number, dy: number): boolean {
    // 시퀀스는 단조 증가해야 한다 (리플레이/순서 조작 방지)
    if (seq <= conn.lastSeq) return false;
    conn.lastSeq = seq;
    // 대기실에서는 입력이 "활동"이 아니다 (입력만 보내며 대기실을 끝없이 붙잡아 두지 못하게)
    if (this.started) this.lastActivity = Date.now();
    setInput(this.world, conn.pid, dx, dy);
    return true;
  }

  onPick(conn: Conn, choice: number): boolean {
    if (this.started) this.lastActivity = Date.now();
    const ok = pickOffer(this.world, conn.pid, choice);
    // 일시정지 중에는 틱이 돌지 않으므로 연속 레벨업의 다음 선택지를 여기서 바로 보낸다
    if (ok && this.userPaused) this.flushEvents();
    return ok;
  }

  /** 대기실 → 게임 시작. 방장만 가능. 그 외의 요청은 조용히 무시한다. */
  onStart(conn: Conn): void {
    if (this.started || this.closed || conn.pid !== this.hostPid) return;
    this.started = true;
    this.lastActivity = Date.now();
    this.broadcastRoster();
  }

  /**
   * 일시정지. 혼자 하는 방에서만 월드를 멈춘다.
   * 페어 방에서는 한 사람이 다른 사람의 게임을 멈출 수 없어야 하므로 항상 거부하고, 그 사실을 알려준다.
   */
  onPause(conn: Conn, on: boolean): void {
    if (this.closed || !this.started || this.world.over) return;
    // 페어 방이거나, 이번 판의 일시정지 시간을 다 썼으면 거부한다
    if (this.mode !== 'solo' || (on && !this.userPaused && this.pauseLeft() < 1000)) {
      if (on) this.send(conn, { t: 'pause', on: false, max: 0 });
      return;
    }
    this.setPaused(on);
  }

  /** 지금 일시정지하면 멈춰 있을 수 있는 시간 (ms): 한 번의 상한과 남은 예산 중 작은 쪽 */
  private pauseLeft(): number {
    return Math.max(0, Math.min(MAX_PAUSE_MS, PAUSE_BUDGET_MS - this.pauseUsed));
  }

  private setPaused(on: boolean): void {
    if (on === this.userPaused) return;
    const now = Date.now();
    const max = on ? this.pauseLeft() : 0;
    if (!on) this.pauseUsed += now - this.pausedAt;
    this.userPaused = on;
    // pausedAt 에는 "언제까지 멈출 수 있는지"를 계산할 수 있게 시작 시각을 둔다
    if (on) this.pausedAt = now;
    this.pauseLimit = max;
    // 재개 직후 방치 타이머가 바로 터지지 않게 한다
    this.lastActivity = now;
    for (const conn of this.conns.values()) {
      // 멈춘 순간의 마지막 상태를 paused 표시와 함께 한 번 보내 화면이 정확히 그 자리에서 멈추게 한다
      if (on) this.sendSnapshot(conn);
      this.send(conn, { t: 'pause', on, max: Math.floor(max / 1000) });
    }
  }

  private tick(): void {
    if (this.closed) return;
    const now = Date.now();
    if (!this.started) {
      if (now - this.lastActivity > LOBBY_IDLE_MS) this.kick('lobby_idle');
      return;
    }
    if (this.userPaused) {
      // 멈춘 동안에는 시뮬레이션도 스냅샷 전송도 하지 않는다 (서버 CPU·전송량 0). 너무 오래 멈춰 두면 자동 재개.
      if (now - this.pausedAt <= this.pauseLimit) return;
      this.setPaused(false);
    }
    if (now - this.lastActivity > ROOM_IDLE_MS) return this.kick('idle');

    step(this.world, DT);
    if (!this.casualty) for (const p of this.world.players.values()) if (!p.alive) this.casualty = true;
    if (this.flushEvents()) return;
    for (const conn of this.conns.values()) this.sendSnapshot(conn);
  }

  /** 시뮬레이션이 쌓아둔 이벤트를 전달한다. 게임이 끝났으면 true. */
  private flushEvents(): boolean {
    for (const ev of this.world.events.splice(0)) {
      if (ev.type === 'offers') {
        const conn = this.conns.get(ev.pid);
        const p = this.world.players.get(ev.pid);
        if (conn && p) this.send(conn, { t: 'levelup', offers: offersOf(p), timeout: OFFER_TIMEOUT });
      } else if (ev.type === 'over') {
        this.finish();
        return true;
      }
    }
    return false;
  }

  private sendSnapshot(conn: Conn): void {
    if (conn.ws.bufferedAmount > MAX_BUFFERED) return;
    const snap = buildSnapshot(this.world, conn.pid);
    if (!snap) return;
    if (this.userPaused) snap.paused = true;
    // 스냅샷만 이진 프레임으로 보낸다 (JSON 의 약 1/3 크기). 나머지 메시지는 드물어서 JSON 그대로.
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(encodeSnapshot(snap), { binary: true });
  }

  private kick(reason: string): void {
    for (const c of this.conns.values()) c.ws.close(4008, reason);
    this.close();
  }

  private finish(): void {
    const endedAt = Date.now();
    this.runs++;
    for (const conn of this.conns.values()) {
      const p = this.world.players.get(conn.pid);
      if (!p) continue;
      // 결과는 서버가 계산하고 서버가 서명한다. 리더보드는 이 서명이 있는 결과만 받는다.
      const result: RunResult = {
        sid: conn.sid,
        run: this.runs,
        name: p.name,
        // 도중에 들어온 사람에게 판 전체의 시간을 서명해 주지 않는다: 본인이 함께 한 시간만
        time: Math.floor(Math.max(0, this.world.time - conn.joinedAt)),
        kills: p.kills,
        level: p.level,
        endedAt,
      };
      this.send(conn, { t: 'over', result, sig: sign(JSON.stringify(result)) });
      if (this.mode === 'solo') conn.ws.close(1000, 'over');
    }
    if (this.mode === 'solo') return this.close();
    this.resetToLobby();
  }

  /** 페어 방은 판이 끝나도 닫지 않는다. 같은 코드·같은 사람들로 대기실에 돌아가 방장이 다시 시작할 수 있다. */
  private resetToLobby(): void {
    const members = [...this.conns.values()];
    const host = this.conns.get(this.hostPid) ?? members[0];
    this.world = createWorld(randomInt(0, 2 ** 31));
    this.started = false;
    this.casualty = false;
    this.pauseUsed = 0;
    this.lastActivity = Date.now();
    this.conns.clear();
    for (const conn of members) {
      conn.pid = addPlayer(this.world, conn.name).id;
      conn.joinedAt = 0;
      this.conns.set(conn.pid, conn);
    }
    this.hostPid = host?.pid ?? -1;
    // 새 월드에서 플레이어 id 가 바뀌므로 다시 알려준다
    for (const conn of members) this.send(conn, { t: 'welcome', id: conn.pid, mode: this.mode, code: this.code, tickRate: TICK_RATE });
    this.broadcastRoster();
  }

  private broadcastRoster(): void {
    const players = [...this.world.players.values()].map((p) => ({ id: p.id, name: p.name }));
    for (const c of this.conns.values()) this.send(c, { t: 'roster', players, host: this.hostPid, started: this.started });
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

/** 방 코드는 CSPRNG 로 만든다. 추측으로 남의 방에 들어오려면 약 10억 가지 중 하나를 맞혀야 한다. */
function randomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return code;
}

export class RoomManager {
  private rooms = new Set<Room>();
  private byCode = new Map<string, Room>();

  get count(): number {
    return this.rooms.size;
  }

  /** 새 방. 솔로는 코드 없이, 페어는 겹치지 않는 코드를 붙여서 만든다. 서버가 가득 찼으면 null. */
  create(mode: GameMode): Room | null {
    if (this.rooms.size >= MAX_ROOMS) return null;
    let code = '';
    if (mode === 'coop') {
      do code = randomCode();
      while (this.byCode.has(code));
    }
    const room = new Room(mode, code, (r) => {
      this.rooms.delete(r);
      if (r.code) this.byCode.delete(r.code);
    });
    this.rooms.add(room);
    if (code) this.byCode.set(code, room);
    return room;
  }

  /** 코드로 페어 방 찾기. 없으면 undefined. */
  find(code: string): Room | undefined {
    return this.byCode.get(code);
  }
}
