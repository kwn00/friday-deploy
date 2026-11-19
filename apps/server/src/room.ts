import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { RunPlacement, RunReport } from './leaderboard';
import { newWorld } from './world';
import type { WebSocket } from 'ws';
import {
  DT,
  LEADERBOARD_MIN_SECONDS,
  MAX_PAUSE_SECONDS,
  MAX_PLAYERS_PER_ROOM,
  OFFER_TIMEOUT,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LEN,
  SEAT_HOLD_SECONDS,
  TICK_RATE,
  addPlayer,
  buildSnapshot,
  encodeSnapshot,
  offersOf,
  pickOffer,
  removePlayer,
  setInput,
  step,
  upgradesOf,
  type BoardId,
  type GameMode,
  type RosterPlayer,
  type RunResult,
  type ServerMsg,
  type World,
} from '@friday-deploy/shared';
import { safeEqual, sign } from './security';

type OverMsg = Extract<ServerMsg, { t: 'over' }>;

export interface Conn {
  ws: WebSocket;
  sid: string;
  name: string;
  pid: number;
  lastSeq: number;
  /** 마지막 입력이 틱과 틱 사이의 어디쯤에서 도착했는지 (0~255, 256 이 한 틱) */
  seqPhase: number;
  /** 이 판에 합류했을 때의 게임 시간(초). 결과에는 "함께 한 시간"만 적는다. */
  joinedAt: number;
  /**
   * 이 자리를 이어받는 열쇠 (방 id . 비밀 값). 자리 주인의 브라우저만 안다.
   * 연결이 끊겼을 때 이것을 내면 같은 캐릭터로 돌아온다. 자리가 비워지면 쓸모가 없어진다.
   */
  key: string;
  /** 연결이 끊겨 자리만 지키고 있는 중 (캐릭터는 월드에 그대로 서 있다) */
  away: boolean;
  /** 돌아오지 않으면 자리를 비울 시각 (ms). away 일 때만 의미가 있다 */
  awayUntil: number;
  /** 연결은 있는데 한동안 입력이 오지 않는다 (화면을 떠났거나, 화면이 멈췄거나, 통신이 막힌 상태) */
  stalled: boolean;
  /** 마지막으로 입력(이동·선택)을 받은 시각 (ms) */
  lastInput: number;
  /**
   * 이 방에서 마지막으로 끝난 판의 결과. 결과를 보낸 순간에 통신이 막혀 있었을 수 있으므로(서버는 아직 모른다)
   * 끊긴 사람이 돌아오면 한 번 더 전해 준다. 다음 판이 시작되면 지운다.
   */
  lastOver?: OverMsg;
  /**
   * 이 연결에 바닥 영역을 어느 틱까지 보냈는지. 영역은 생길 때 한 번만 보내므로, 이 틱 뒤에 생긴 것만 싣는다
   * (월드가 멈춰 같은 틱의 스냅샷을 여러 번 보낼 때 같은 영역을 거듭 보내지 않게, 건너뛴 스냅샷의 영역은 다음에 보내게).
   */
  zoneTick: number;
  /** 지키던 자리가 풀릴 때(이어받음·시간 초과·방 닫힘) 한 번 부른다 */
  onFree?: () => void;
}

const MAX_ROOMS = 200;
/** 아무 입력 없이 방치된 방을 정리하는 시간 */
const ROOM_IDLE_MS = 3 * 60 * 1000;
/** 시작하지 않은 대기실을 정리하는 시간 */
const LOBBY_IDLE_MS = 10 * 60 * 1000;
const MAX_PAUSE_MS = MAX_PAUSE_SECONDS * 1000;
/** 한 판에서 일시정지로 쓸 수 있는 시간의 합. 껐다 켜기를 반복해 방을 끝없이 붙잡아 두지 못하게 한다. */
const PAUSE_BUDGET_MS = 30 * 60 * 1000;
/** 판이 시작되고 이 시간(게임 시간, 초) 안에 들어온 사람까지를 "처음부터 함께 한 사람"으로 본다 */
const CREW_GRACE_SECONDS = 5;
/** 느린 클라이언트 보호: 송신 버퍼가 이 이상 쌓이면 스냅샷을 건너뛴다 (스냅샷 약 30개 분량) */
const MAX_BUFFERED = 64 * 1024;
/** 연결이 끊긴 사람의 자리를 지켜 두는 시간 */
const SEAT_HOLD_MS = SEAT_HOLD_SECONDS * 1000;
/**
 * 판이 진행되는 동안 이 시간 넘게 입력이 없는 연결은 멈춘 것으로 본다. 화면을 보고 있는 클라이언트는 가만히 있어도
 * 1초에 한 번은 입력을 보내므로, 이만큼 조용하면 화면을 떠났거나 통신이 막힌 것이다.
 * 죽은 연결을 하트비트가 알아채는 데는 15~30초가 걸린다. 그동안 캐릭터가 마지막 입력대로 달리게 두지 않는다.
 */
const STALL_MS = 4000;
/** 틱이 이만큼 늦게 돌았으면 서버가 밀린 것이다. 그 틱에서는 "입력이 없었다"고 판단하지 않는다 */
const LATE_TICK_MS = 1000;

export class Room {
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
  private lastTick = Date.now();
  private pausedAt = 0;
  /** 지금의 일시정지가 자동으로 풀리기까지의 시간 (ms) */
  private pauseLimit = 0;
  /** 이번 판에서 이미 쓴 일시정지 시간 (ms) */
  private pauseUsed = 0;
  /**
   * 이번 판에서 누군가 쓰러졌거나 나간 적이 있는지. 있으면 이후에 들어오는 사람은 다음 판까지 관전한다.
   * 계정이 없어서 "아까 그 사람"인지 서버가 확인할 방법이 없다. 그래서 사람을 가리지 않고 막는다:
   * 쓰러진 사람이 나갔다 들어와 새 캐릭터로 살아나거나, 체력이 줄었을 때 나갔다 들어와 가득 채우는 것을 할 수 없다.
   */
  private sealed = false;
  /**
   * 이번 판이 진행되는 동안 동시에 있었던 최대 인원. 2 이상이면 함께 한 판(coop 순위표)으로 기록한다.
   * 대기실에만 있다가 나간 사람은 세지 않는다 (판이 시작될 때부터 센다).
   */
  private peak = 0;
  closed = false;

  constructor(
    readonly mode: GameMode,
    /** 페어 방 코드. 솔로는 빈 문자열 */
    readonly code: string,
    private readonly onClose: (room: Room) => void,
    /** 끝난 판을 리더보드에 기록한다. 순위표에 들면 순위를 돌려준다. 없으면 기록하지 않는다 */
    private readonly onRun?: (report: RunReport) => RunPlacement,
    /** 방 id (16진 8자). 이어받기 키의 앞부분이라 방마다 달라야 한다 */
    readonly id: string = randomBytes(4).toString('hex'),
    /** 혼자 하는 판이 끝나 방이 닫힐 때의 결과. 끊겨 있던 사람이 돌아오면 전해 줄 수 있게 밖에서 잠시 보관한다 */
    private readonly onResult?: (key: string, over: OverMsg) => void,
  ) {
    this.world = newWorld();
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
    // 누군가 쓰러졌거나 나간 뒤에 들어오면 이번 판은 관전만 한다 (캐릭터 없이 시점만 움직인다).
    const p = addPlayer(this.world, name, this.started && this.sealed);
    const now = Date.now();
    const conn: Conn = {
      ws,
      sid,
      name: p.name,
      pid: p.id,
      lastSeq: -1,
      seqPhase: 0,
      joinedAt: this.world.time,
      // 비밀 값은 운영체제 CSPRNG 에서 192비트. 추측으로 남의 자리를 이어받을 수 없다
      key: `${this.id}.${randomBytes(24).toString('base64url')}`,
      away: false,
      awayUntil: 0,
      stalled: false,
      lastInput: now,
      // 들어오는 순간 남아 있는 영역도 한 번 받는다
      zoneTick: -1,
    };
    this.conns.set(p.id, conn);
    if (this.started) this.peak = Math.max(this.peak, this.conns.size);
    if (this.hostPid < 0) this.hostPid = p.id;
    this.lastActivity = now;
    this.send(conn, this.welcome(conn));
    this.broadcastRoster();
    return conn;
  }

  private welcome(conn: Conn): Extract<ServerMsg, { t: 'welcome' }> {
    return { t: 'welcome', id: conn.pid, mode: this.mode, code: this.code, tickRate: TICK_RATE, key: conn.key };
  }

  /** 자리를 바로 비운다: 스스로 나갔을 때, 쫓겨났을 때, 지켜 두던 자리의 시간이 다 됐을 때. */
  leave(conn: Conn): void {
    if (this.conns.get(conn.pid) !== conn) return;
    this.conns.delete(conn.pid);
    conn.away = false;
    this.release(conn);
    // 진행 중인 판에서 나가면, 그 뒤로 들어오는 사람은(나갔던 본인 포함) 이번 판을 관전한다
    if (this.started) this.sealed = true;
    removePlayer(this.world, conn.pid);
    if (this.conns.size === 0) return this.close();
    // 방장이 나가면 다음 사람이 이어받는다 (대기실이 영영 시작되지 않는 일을 막는다)
    if (conn.pid === this.hostPid) this.pickHost();
    this.broadcastRoster();
  }

  /** 새 방장: 접속해 있는 사람 중 가장 먼저 들어온 사람. 모두 자리를 비웠으면 가장 먼저 들어온 자리 */
  private pickHost(): void {
    const members = [...this.conns.values()];
    this.hostPid = (members.find((c) => !c.away) ?? members[0])?.pid ?? -1;
  }

  /**
   * 연결이 닫혔다. hold 가 true 면(스스로 나간 것이 아니라 끊긴 것) 자리를 잠시 지켜 둔다.
   * 지켜 두었으면 true 를 돌려주고, 그 자리가 풀릴 때 onFree 를 한 번 부른다.
   *
   * 자리를 지키는 동안 캐릭터는 월드에 그대로 서 있다: 페어 판에서는 계속 맞는다 (끊는 것으로 피해를 피할 수 없다).
   * 혼자 하는 판은 일시정지와 같은 방식, 같은 예산으로 월드를 멈춘다 (일시정지로 할 수 없는 일은 끊어서도 할 수 없다).
   */
  disconnect(conn: Conn, ws: WebSocket, hold: boolean, onFree?: () => void): boolean {
    // 다른 연결이 이미 이 자리를 이어받았다: 옛 연결이 닫히는 것은 자리와 상관없다
    if (conn.ws !== ws) return false;
    if (!hold || this.closed || this.conns.get(conn.pid) !== conn) {
      this.leave(conn);
      return false;
    }
    const now = Date.now();
    conn.away = true;
    // 대기실에서는 잃을 것이 없으므로 대기실이 닫힐 때까지 넉넉히 기다린다 (초대 링크를 보내러 다른 앱에 다녀오는 동안)
    conn.awayUntil = now + (this.started ? SEAT_HOLD_MS : LOBBY_IDLE_MS);
    conn.stalled = false;
    conn.onFree = onFree;
    setInput(this.world, conn.pid, 0, 0);
    if (this.started) {
      // 나간 것과 똑같이 이번 판을 막는다: 끊긴 사람이 새 접속으로 들어와 새 캐릭터를 받을 수 없다
      this.sealed = true;
      if (this.mode === 'solo') {
        this.autoPause();
        // 멈춰 있는 동안에는 자리를 지켜도 드는 것이 없다: 일시정지가 끝날 때까지 기다려 준다
        if (this.userPaused) conn.awayUntil = Math.max(conn.awayUntil, this.pausedAt + this.pauseLimit);
      }
    }
    this.broadcastRoster();
    return true;
  }

  /**
   * 끊긴 자리를 새 연결이 이어받는다. 열쇠가 맞는 자리가 없으면 null (자리가 없는 것과 열쇠가 틀린 것을 구분해 주지 않는다).
   * 서버가 끊긴 줄 아직 모르는 옛 연결이 남아 있으면 그것을 닫는다: 한 자리는 한 연결만 쓴다.
   * 돌려받는 것은 서버에 있던 상태 그대로다. 클라이언트가 실어 보내는 상태는 없다.
   */
  resume(key: string, ws: WebSocket): Conn | null {
    if (this.closed) return null;
    let conn: Conn | null = null;
    for (const c of this.conns.values()) if (safeEqual(c.key, key)) conn = c;
    if (!conn) return null;
    const now = Date.now();
    const old = conn.ws;
    // 먼저 바꿔 둔다: 옛 연결의 close 가 뒤늦게 와도 disconnect 가 이 자리를 건드리지 않는다
    conn.ws = ws;
    if (old !== ws && old.readyState === old.OPEN) {
      old.close(4009, 'replaced');
      setTimeout(() => old.terminate(), 1000).unref?.();
    }
    conn.away = false;
    conn.stalled = false;
    conn.lastSeq = -1; // 새 연결의 입력 번호는 처음부터 다시 센다
    conn.seqPhase = 0;
    conn.lastInput = now;
    // 새 연결은 아무것도 받지 못했다: 아직 남아 있는 영역을 (남은 시간으로) 한 번 다시 보낸다
    conn.zoneTick = -1;
    this.release(conn);
    this.lastActivity = now;
    this.send(conn, { ...this.welcome(conn), resumed: true });
    // 끝난 판의 결과를 못 받았을 수 있다. 이미 본 결과면 클라이언트가 (판 번호로) 걸러 낸다
    if (!this.started && conn.lastOver) this.send(conn, conn.lastOver);
    this.broadcastRoster();
    if (this.started) {
      const p = this.world.players.get(conn.pid);
      if (p?.offers) this.send(conn, { t: 'levelup', offers: offersOf(p), timeout: Math.max(1, Math.ceil(OFFER_TIMEOUT - p.offerTimer)) });
      // 멈춰 있는 동안에는 틱이 스냅샷을 보내지 않으므로 지금 상태를 한 장 보낸다
      this.sendSnapshot(conn);
      if (this.mode === 'solo') {
        const left = this.userPaused ? Math.max(0, this.pausedAt + this.pauseLimit - now) : 0;
        this.send(conn, { t: 'pause', on: this.userPaused, max: Math.floor(left / 1000) });
      }
    }
    return conn;
  }

  /** 입력(이동·선택)을 받았다. 멈춘 것으로 봤던 연결이면 다시 돌아온 것이다. */
  private active(conn: Conn, now: number): void {
    conn.lastInput = now;
    if (!conn.stalled) return;
    conn.stalled = false;
    this.broadcastRoster();
  }

  private release(conn: Conn): void {
    const free = conn.onFree;
    conn.onFree = undefined;
    free?.();
  }

  /** 혼자 하는 판에서 플레이어가 자리에 없을 때(끊김·멈춤) 서버가 스스로 멈춘다. 쓰는 것은 같은 일시정지 예산이다. */
  private autoPause(): void {
    if (this.mode !== 'solo' || !this.started || this.world.over || this.userPaused || this.pauseLeft() < 1000) return;
    this.setPaused(true);
  }

  /** 틱마다: 지켜 두던 자리의 시간이 다 됐는지, 입력이 멈춘 연결이 있는지 살핀다. */
  private sweep(now: number): void {
    // 서버가 밀려서 틱이 늦게 돌았다면, 그동안 온 입력이 아직 읽히지 않았을 뿐이다. 모두 방금 입력한 것으로 친다
    const late = now - this.lastTick > LATE_TICK_MS;
    this.lastTick = now;
    let changed = false;
    for (const conn of [...this.conns.values()]) {
      if (conn.away) {
        if (now >= conn.awayUntil) {
          this.leave(conn);
          if (this.closed) return;
        }
      } else if (late) {
        conn.lastInput = now;
      } else if (this.started && !this.userPaused && !conn.stalled && now - conn.lastInput > STALL_MS) {
        conn.stalled = true;
        // 캐릭터가 마지막 입력대로 계속 달리지 않게 세운다
        setInput(this.world, conn.pid, 0, 0);
        changed = true;
        this.autoPause();
      }
    }
    if (changed) this.broadcastRoster();
  }

  onInput(conn: Conn, seq: number, dx: number, dy: number): boolean {
    // 시퀀스는 단조 증가해야 한다 (리플레이/순서 조작 방지)
    if (seq <= conn.lastSeq) return false;
    conn.lastSeq = seq;
    const now = Date.now();
    // 직전 틱에서 얼마나 지나서 도착했는지 (서버 시계). 입력은 도착한 때부터 적용하고, 같은 값을 스냅샷에 실어
    // 화면이 내 캐릭터를 앞서 그릴 거리를 한 틱보다 곱게 맞추게 한다
    conn.seqPhase = Math.max(0, Math.min(255, Math.floor(((now - this.lastTick) * TICK_RATE * 256) / 1000)));
    // 대기실에서는 입력이 "활동"이 아니다 (입력만 보내며 대기실을 끝없이 붙잡아 두지 못하게)
    if (this.started) this.lastActivity = now;
    this.active(conn, now);
    setInput(this.world, conn.pid, dx, dy, conn.seqPhase / 256);
    return true;
  }

  onPick(conn: Conn, choice: number): boolean {
    // 선택 시간이 끝나 서버가 대신 고른 직후에 도착한 클릭: 아무것도 바꾸지 않고 조용히 넘긴다 (위반이 아니다).
    // 선택 대기 중에 범위를 벗어난 번호를 보내는 것은 여전히 위반이다.
    if (!this.world.players.get(conn.pid)?.offers) return true;
    const now = Date.now();
    if (this.started) this.lastActivity = now;
    this.active(conn, now);
    const ok = pickOffer(this.world, conn.pid, choice);
    // 일시정지 중에는 틱이 돌지 않으므로 연속 레벨업의 다음 선택지를 여기서 바로 보낸다
    if (ok && this.userPaused) this.flushEvents();
    return ok;
  }

  /**
   * 지금 시작할 수 있는 사람. 보통은 방장이고, 방장의 연결이 끊겨 있는 동안에는 접속해 있는 사람 중 가장 먼저 들어온 사람이다
   * (방장이 돌아오지 않아도 대기실이 멈춰 있지 않게). 방장이 돌아오면 다시 방장이 시작한다.
   */
  private get starter(): number {
    const host = this.conns.get(this.hostPid);
    if (host && !host.away) return this.hostPid;
    for (const c of this.conns.values()) if (!c.away) return c.pid;
    return this.hostPid;
  }

  /** 대기실 → 게임 시작. 방장만 가능. 그 외의 요청은 조용히 무시한다. */
  onStart(conn: Conn): void {
    if (this.started || this.closed || conn.pid !== this.starter) return;
    // 연결이 끊겨 자리만 지키던 사람은 빼고 시작한다: 서 있기만 하는 캐릭터를 판에 넣지 않는다.
    // (아직 시작 전이라 판이 막히지 않는다. 돌아오면 방 코드로 다시 들어와 함께 할 수 있다)
    for (const c of [...this.conns.values()]) if (c.away) this.leave(c);
    this.started = true;
    this.peak = this.conns.size;
    const now = Date.now();
    this.lastActivity = now;
    for (const c of this.conns.values()) {
      // 이제부터 입력이 오기 시작한다. 대기실에서 조용했던 시간을 "멈춤"으로 세지 않는다
      c.lastInput = now;
      c.lastOver = undefined;
    }
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
      // 멈춰 있던 동안 조용했던 것을 "입력이 멈춘 연결"로 세지 않는다
      if (!on) conn.lastInput = now;
      // 멈춘 순간의 마지막 상태를 paused 표시와 함께 한 번 보내 화면이 정확히 그 자리에서 멈추게 한다
      if (on) this.sendSnapshot(conn);
      this.send(conn, { t: 'pause', on, max: Math.floor(max / 1000) });
    }
  }

  private tick(): void {
    if (this.closed) return;
    const now = Date.now();
    this.sweep(now);
    // 마지막 자리가 비워져 방이 닫혔을 수 있다
    if (this.closed) return;
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
    if (!this.sealed) for (const p of this.world.players.values()) if (!p.alive) this.sealed = true;
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
      } else if (ev.type === 'chest') {
        // 보물상자: 연 사람에게만 무엇이 올랐는지 알려 준다 (끊겨 있으면 다음 스냅샷의 강화 단계로 알 수 있다)
        const conn = this.conns.get(ev.pid);
        if (conn) this.send(conn, { t: 'chest', items: ev.items, heal: ev.heal });
      } else if (ev.type === 'over') {
        this.finish();
        return true;
      }
    }
    return false;
  }

  private sendSnapshot(conn: Conn): void {
    if (conn.ws.bufferedAmount > MAX_BUFFERED) return;
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    const snap = buildSnapshot(this.world, conn.pid, conn.zoneTick);
    if (!snap) return;
    if (this.userPaused) snap.paused = true;
    snap.ack = Math.max(0, conn.lastSeq);
    snap.ackPhase = conn.seqPhase;
    // 스냅샷만 이진 프레임으로 보낸다 (JSON 의 약 1/3 크기). 나머지 메시지는 드물어서 JSON 그대로.
    conn.ws.send(encodeSnapshot(snap), { binary: true });
    conn.zoneTick = this.world.tick;
  }

  private kick(reason: string): void {
    for (const c of this.conns.values()) c.ws.close(4008, reason);
    this.close();
  }

  /**
   * 끝난 판을 리더보드에 올린다. 기록은 서버가 직접 만든다 (클라이언트가 내는 값은 없다).
   * 이름이 오르는 것은 처음부터 함께 해서 끝까지 남은 사람뿐이다: 도중에 들어온 사람이나 관전자는 빠진다.
   * 관전으로 들어온 사람(몸이 없다)은 판이 시작된 직후에 들어왔더라도 빠진다: 한 번도 플레이하지 않았다.
   * 쓰러진 뒤 관전한 사람은 몸(묘비)이 있으므로 그대로 오른다.
   */
  private report(endedAt: number): { board: BoardId; rank: RunPlacement; crew: Set<Conn> } | null {
    if (!this.onRun) return null;
    const crew = [...this.conns.values()].filter((c) => c.joinedAt <= CREW_GRACE_SECONDS && this.world.players.get(c.pid)?.body === true);
    const board: BoardId = this.peak >= 2 ? 'coop' : 'solo';
    // 처음부터 있던 사람이 아무도 남지 않았으면 기록하지 않는다 (남은 사람은 모두 도중 합류)
    if (crew.length === 0) return { board, rank: null, crew: new Set() };
    const players = crew.map((c) => this.world.players.get(c.pid)!);
    try {
      const rank = this.onRun({
        id: randomUUID(),
        board,
        names: players.map((p) => p.name),
        // 개인별 처치 수 = 기여도. 리더보드가 이 값이 큰 순서로 이름을 적는다
        killsBy: players.map((p) => p.kills),
        // 판이 끝날 때 가진 무기·패시브. 쓰러진 뒤에는 경험치를 얻지 못하므로 쓰러질 때의 것이다
        // (쓰러지기 전에 뜬 선택지를 쓰러진 뒤에 고르면 그 하나는 들어간다)
        itemsBy: players.map((p) => upgradesOf(p.up)),
        time: Math.floor(this.world.time),
        kills: players.reduce((sum, p) => sum + p.kills, 0),
        level: Math.max(...players.map((p) => p.level)),
        pausedSeconds: Math.round(this.pauseUsed / 1000),
        endedAt,
      });
      return { board, rank, crew: new Set(crew) };
    } catch (err) {
      console.error('[error] leaderboard record', err);
      return null;
    }
  }

  private finish(): void {
    const endedAt = Date.now();
    this.runs++;
    const ranked = this.report(endedAt);
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
      const over: OverMsg = { t: 'over', result, sig: sign(JSON.stringify(result)) };
      if (ranked) {
        const named = ranked.crew.has(conn);
        // 순위가 없으면 이유를 알려준다 (화면이 "순위표 밖"이라고 잘못 말하지 않게)
        if (named && typeof ranked.rank === 'number') over.place = { board: ranked.board, rank: ranked.rank };
        else if (!p.body) over.unranked = 'watched';
        else if (this.world.time < LEADERBOARD_MIN_SECONDS) over.unranked = 'short';
        else if (!named) over.unranked = 'late';
        else over.unranked = ranked.rank === 'pending' ? 'pending' : 'outside';
      }
      // 지금 통신이 막혀 있는 사람도 있을 수 있다(서버는 아직 모른다). 돌아오면 다시 전해 줄 수 있게 남겨 둔다
      conn.lastOver = over;
      this.send(conn, over);
      if (this.mode === 'solo') {
        this.onResult?.(conn.key, over);
        conn.ws.close(1000, 'over');
      }
    }
    if (this.mode === 'solo') return this.close();
    this.resetToLobby();
  }

  /** 페어 방은 판이 끝나도 닫지 않는다. 같은 코드·같은 사람들로 대기실에 돌아가 방장이 다시 시작할 수 있다. */
  private resetToLobby(): void {
    const members = [...this.conns.values()];
    const host = this.conns.get(this.hostPid) ?? members[0];
    this.world = newWorld();
    this.started = false;
    this.sealed = false;
    this.pauseUsed = 0;
    this.peak = 0;
    const now = Date.now();
    this.lastActivity = now;
    this.conns.clear();
    for (const conn of members) {
      conn.pid = addPlayer(this.world, conn.name).id;
      conn.joinedAt = 0;
      conn.stalled = false;
      conn.lastInput = now;
      conn.zoneTick = -1; // 새 월드는 틱이 0 부터 다시 센다
      // 판 도중에 끊긴 사람은 2분만 기다리기로 했었다. 이제 대기실이니 대기실 기준(닫힐 때까지)으로 기다린다
      if (conn.away) conn.awayUntil = Math.max(conn.awayUntil, now + LOBBY_IDLE_MS);
      this.conns.set(conn.pid, conn);
    }
    this.hostPid = host?.pid ?? -1;
    // 새 월드에서 플레이어 id 가 바뀌므로 다시 알려준다 (자리를 비운 사람은 돌아올 때 받는다)
    for (const conn of members) this.send(conn, this.welcome(conn));
    this.broadcastRoster();
  }

  private broadcastRoster(): void {
    const players: RosterPlayer[] = [...this.world.players.values()].map((p) => {
      const c = this.conns.get(p.id);
      return { id: p.id, name: p.name, ...(c?.away ? { away: true } : c?.stalled ? { idle: true } : {}) };
    });
    const host = this.starter;
    for (const c of this.conns.values()) this.send(c, { t: 'roster', players, host, started: this.started });
  }

  private send(conn: Conn, msg: ServerMsg): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    // 지켜 두던 자리들도 함께 풀린다
    for (const conn of this.conns.values()) this.release(conn);
    this.onClose(this);
  }
}

const roomIdOf = (key: string): string => key.slice(0, Math.max(0, key.indexOf('.')));

/** 방 코드는 CSPRNG 로 만든다. 추측으로 남의 방에 들어오려면 약 10억 가지 중 하나를 맞혀야 한다. */
function randomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return code;
}

/** 혼자 하는 판이 끝난 뒤에도 그 결과를 이만큼 보관한다 (끊겨 있던 사람이 돌아와 결과를 볼 수 있게) */
const RESULT_KEEP_MS = SEAT_HOLD_SECONDS * 1000;
const MAX_KEPT_RESULTS = 256;

export class RoomManager {
  private rooms = new Set<Room>();
  private byCode = new Map<string, Room>();
  private byId = new Map<string, Room>();
  /** 방 id → 방금 닫힌 혼자 하는 판의 결과 (이어받기 키가 맞는 사람에게만 준다) */
  private results = new Map<string, { key: string; over: OverMsg; until: number }>();

  /** onRun: 끝난 판을 리더보드에 기록하는 함수 (없으면 기록하지 않는다) */
  constructor(private readonly onRun?: (report: RunReport) => RunPlacement) {}

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
    let id: string;
    do id = randomBytes(4).toString('hex');
    while (this.byId.has(id));
    const room = new Room(
      mode,
      code,
      (r) => {
        this.rooms.delete(r);
        this.byId.delete(r.id);
        if (r.code) this.byCode.delete(r.code);
      },
      this.onRun,
      id,
      (key, over) => this.keepResult(id, key, over),
    );
    this.rooms.add(room);
    this.byId.set(id, room);
    if (code) this.byCode.set(code, room);
    return room;
  }

  /** 이어받기 키로 자리를 찾아 새 연결에 넘겨준다. 실패하면 null (이유는 구분해 주지 않는다). */
  resume(key: string, ws: WebSocket): { room: Room; conn: Conn } | null {
    const room = this.byId.get(roomIdOf(key));
    const conn = room?.resume(key, ws);
    return room && conn ? { room, conn } : null;
  }

  private keepResult(id: string, key: string, over: OverMsg): void {
    const now = Date.now();
    for (const [k, v] of this.results) if (v.until <= now || this.results.size >= MAX_KEPT_RESULTS) this.results.delete(k);
    this.results.set(id, { key, over, until: now + RESULT_KEEP_MS });
  }

  /**
   * 이어받으려던 판이 그 사이에 끝났다면 그 결과. 키가 맞는 사람에게만, 보관 시간 안에서만 준다.
   * (결과는 이미 서버가 기록했다. 이것은 본인에게 다시 보여주는 것뿐이다)
   */
  resultFor(key: string): OverMsg | null {
    const kept = this.results.get(roomIdOf(key));
    if (!kept || kept.until <= Date.now() || !safeEqual(kept.key, key)) return null;
    return kept.over;
  }

  /** 코드로 페어 방 찾기. 없으면 undefined. */
  find(code: string): Room | undefined {
    return this.byCode.get(code);
  }
}
