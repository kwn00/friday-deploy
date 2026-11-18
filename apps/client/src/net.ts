import {
  LEADERBOARD_SIZE,
  PING_INTERVAL_MS,
  PROTOCOL_VERSION,
  decodeSnapshot,
  type BoardId,
  type ClientMsg,
  type GameMode,
  type LeaderboardEntry,
  type LeaderboardResponse,
  type ServerMsg,
} from '@friday-deploy/shared';

/**
 * 네트워크 계층. 클라이언트는 "입력 의도"만 보내고, 서버가 보내준 상태를 그리기만 한다.
 * 여기서 무엇을 조작해도 서버의 검증(스키마/범위/레이트리밋/시퀀스)을 통과해야 하며,
 * 통과하더라도 할 수 있는 일은 '정상 속도로 이동'과 '제시된 선택지 고르기'뿐이다.
 */
/**
 * 게임 서버 주소. 비워두면 같은 출처(same-origin)를 사용한다.
 * 클라이언트를 Vercel 등 정적 호스팅에, 서버를 별도 호스트에 둘 때 빌드 시 VITE_GAME_SERVER_URL 로 지정.
 */
const SERVER = (import.meta.env.VITE_GAME_SERVER_URL ?? '').trim().replace(/\/+$/, '');
const HTTP_BASE = SERVER;
const WS_URL = SERVER
  ? `${SERVER.replace(/^http/, 'ws')}/ws`
  : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;

/** 연결 시도가 실패한 이유. cancelled: 그 사이에 나갔거나 더 새로운 시도가 시작됐다 (오류로 보여주지 않는다) */
export type ConnectErrorKind = 'cancelled' | 'rate' | 'network';

export class ConnectError extends Error {
  constructor(
    readonly kind: ConnectErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** 서버에서 이 시간 동안 아무것도 오지 않으면 죽은 연결로 본다 (조용해지면 그 사이에 ping 을 보내 물어본다) */
const DEAD_MS = 4000;
/** 화면으로 돌아온 직후에는 이만큼만 기다린다 (자리를 비운 사이에 끊겼을 가능성이 높다) */
const POKE_MS = 2500;
/**
 * 서버에서 이만큼 아무것도 오지 않는 동안에는 입력을 보내지 않는다. 통신이 막힌 사이에 입력을 쌓아 두면
 * 뚫리는 순간 한꺼번에 쏟아져 서버의 속도 제한에 걸린다.
 */
const QUIET_MS = 1500;
/** 다시 붙는 시도 하나가 연결이 열리기를 기다리는 시간. 넘으면 그 시도는 접고 다음 시도로 넘어간다 */
const RESUME_TIMEOUT_MS = 8000;
/**
 * 다시 붙을 때 세션 요청을 기다리는 시간. 깨어 있는 서버는 금방 답한다. 통신이 막혔다 풀린 직후에는 브라우저가
 * 이미 죽은 옛 연결로 요청을 보내 한참 멈춰 있을 수 있으므로, 짧게 끊고 새로 시도한다.
 */
const RESUME_SESSION_TIMEOUT_MS = 4000;
/** 연결이 죽었다고 클라이언트가 스스로 판단했을 때 onClose 에 넘기는 코드 (서버가 보내는 코드가 아니다) */
export const CLOSE_TIMEOUT = 4900;

export class Net {
  private ws: WebSocket | null = null;
  private seq = 0;
  /** 연결을 열거나 닫을 때마다 올린다. 진행 중이던 시도는 번호가 달라진 것을 보고 그만둔다 */
  private gen = 0;
  private watchTimer = 0;
  private lastWatch = 0;
  /** 서버에서 마지막으로 무언가를 받은 시각 */
  private lastRecv = 0;
  /**
   * 조용해진 시각. 보통은 lastRecv 와 같다. 페이지가 멈춰 있다 깨어났을 때는 지금으로 당겨서(그동안의 침묵은 세지 않는다),
   * 화면으로 돌아왔을 때는 조금 앞당겨서(금방 판정이 나게) 쓴다.
   */
  private quietSince = 0;

  constructor(
    private readonly onMessage: (msg: ServerMsg) => void,
    /** code: WebSocket 닫힘 코드. 응답이 없어 스스로 끊었으면 CLOSE_TIMEOUT */
    private readonly onClose: (reason: string, code: number) => void,
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** room: 페어 모드에서 참가할 방 코드. 없으면 새 방을 만든다. */
  connect(name: string, mode: GameMode, room?: string): Promise<void> {
    return this.open((token) => (room ? { t: 'hello', v: PROTOCOL_VERSION, token, name, mode, room } : { t: 'hello', v: PROTOCOL_VERSION, token, name, mode }), 0);
  }

  /**
   * 끊긴 자리를 이어받는다. key 는 서버가 welcome 에 실어 준 값이다.
   * 받아들여지면 서버가 welcome(resumed) 과 지금 상태를 보내고, 거절하면 error 를 보내고 닫는다.
   */
  resume(key: string): Promise<void> {
    return this.open((token) => ({ t: 'resume', v: PROTOCOL_VERSION, token, key }), RESUME_TIMEOUT_MS);
  }

  /** timeoutMs: 0 이면 기다릴 만큼 기다린다 (잠든 서버가 깨어나는 데 1분쯤 걸린다) */
  private async open(first: (token: string) => ClientMsg, timeoutMs: number): Promise<void> {
    this.close();
    const gen = this.gen;
    // 기다리는 사이에 나갔거나 다른 시도가 시작됐으면 그만둔다 (뒤늦게 열린 연결이 화면을 다시 끌고 가지 않게)
    const stillWanted = (): void => {
      if (gen !== this.gen) throw new ConnectError('cancelled', 'cancelled');
    };
    // 시간 제한은 응답 본문을 다 받을 때까지 건다 (머리만 오고 본문이 오다 끊기면 한없이 기다리게 된다)
    const abort = new AbortController();
    const timer = timeoutMs ? window.setTimeout(() => abort.abort(), RESUME_SESSION_TIMEOUT_MS) : 0;
    let res: Response;
    let token: string;
    try {
      res = await fetch(`${HTTP_BASE}/api/session`, { method: 'POST', signal: abort.signal });
      stillWanted();
      if (res.status === 429) throw new ConnectError('rate', '요청이 너무 많아요. 잠시 후 다시 시도해주세요.');
      if (!res.ok) throw new ConnectError('network', '서버에 연결할 수 없어요. 잠시 후 다시 시도해주세요.');
      token = ((await res.json()) as { token: string }).token;
    } catch (err) {
      stillWanted();
      if (err instanceof ConnectError) throw err;
      throw new ConnectError('network', '서버에 연결할 수 없어요. 잠시 후 다시 시도해주세요.');
    } finally {
      window.clearTimeout(timer);
    }
    stillWanted();

    const ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.seq = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const t = timeoutMs ? window.setTimeout(() => reject(new Error('timeout')), timeoutMs) : 0;
        ws.onopen = () => {
          window.clearTimeout(t);
          resolve();
        };
        ws.onerror = ws.onclose = () => {
          window.clearTimeout(t);
          reject(new Error('closed'));
        };
      });
    } catch {
      ws.onopen = ws.onerror = ws.onclose = null;
      if (this.ws === ws) this.ws = null;
      try {
        ws.close();
      } catch {
        /* 열리지 않은 소켓 */
      }
      stillWanted();
      throw new ConnectError('network', '서버에 연결할 수 없어요');
    }
    stillWanted();
    ws.onerror = null;
    ws.onmessage = (ev) => {
      // 이미 버린 연결에서 뒤늦게 온 것은 화면에 반영하지 않는다
      if (this.ws !== ws) return;
      this.lastRecv = this.quietSince = performance.now();
      try {
        // 스냅샷은 이진 프레임, 그 밖의 메시지는 JSON 텍스트
        this.onMessage(typeof ev.data === 'string' ? (JSON.parse(ev.data) as ServerMsg) : decodeSnapshot(ev.data as ArrayBuffer));
      } catch {
        /* 형식이 맞지 않는 메시지는 버린다 */
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopWatch();
      this.onClose(ev.reason || `code ${ev.code}`, ev.code);
    };
    this.lastRecv = this.quietSince = performance.now();
    this.startWatch();
    this.send(first(token));
  }

  /**
   * 입력을 보낸다. 보냈으면 true.
   * 서버에서 한동안 아무것도 오지 않는 동안에는 보내지 않는다 (부르는 쪽이 다음에 최신 값을 다시 보낸다).
   */
  sendInput(dx: number, dy: number): boolean {
    if (!this.connected || performance.now() - this.lastRecv > QUIET_MS) return false;
    this.send({ t: 'input', seq: ++this.seq, dx, dy });
    return true;
  }

  sendPick(choice: number): void {
    this.send({ t: 'pick', choice });
  }

  sendStart(): void {
    this.send({ t: 'start' });
  }

  sendPause(on: boolean): void {
    this.send({ t: 'pause', on });
  }

  /** 연결만 닫는다. 서버는 통신이 끊긴 것으로 보고 자리를 잠시 지켜 둔다. */
  close(): void {
    this.gen++;
    this.stopWatch();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* 이미 닫힌 소켓 */
    }
  }

  /** 스스로 나간다: 서버가 자리를 바로 비우게 알리고 닫는다. */
  leave(): void {
    this.send({ t: 'leave' });
    this.close();
  }

  /**
   * 연결이 없는 채로 그만둘 때, 서버가 지켜 두던 자리를 비운다. 따로 연결을 하나 열어 그 자리를 이어받자마자 나간다고 알린다
   * (서버는 받은 순서대로 처리하므로 답을 기다리지 않는다). 실패해도 괜찮다: 자리는 시간이 되면 비워진다.
   */
  abandon(key: string): void {
    void (async () => {
      const abort = new AbortController();
      const timer = window.setTimeout(() => abort.abort(), RESUME_TIMEOUT_MS);
      let token: string;
      try {
        const res = await fetch(`${HTTP_BASE}/api/session`, { method: 'POST', signal: abort.signal });
        if (!res.ok) return;
        token = ((await res.json()) as { token: string }).token;
      } catch {
        return; // 인터넷이 없는 등
      } finally {
        window.clearTimeout(timer);
      }
      try {
        const ws = new WebSocket(WS_URL);
        const kill = window.setTimeout(() => ws.close(), RESUME_TIMEOUT_MS);
        ws.onopen = () => {
          const resume: ClientMsg = { t: 'resume', v: PROTOCOL_VERSION, token, key };
          const leave: ClientMsg = { t: 'leave' };
          ws.send(JSON.stringify(resume));
          ws.send(JSON.stringify(leave));
        };
        ws.onclose = () => window.clearTimeout(kill);
      } catch {
        /* 연결을 만들 수 없다 */
      }
    })();
  }

  /** 화면으로 돌아왔거나 네트워크가 돌아왔다: 연결이 살아 있는지 바로 확인한다 (죽어 있으면 곧 onClose 가 불린다). */
  poke(): void {
    const ws = this.ws;
    // 아직 열리는 중인 연결은 확인할 것이 없다 (여는 쪽이 따로 시간을 잰다)
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    this.lastWatch = now;
    // 지금부터 POKE_MS 안에 아무것도 오지 않으면 죽은 것으로 본다
    this.quietSince = now - (DEAD_MS - POKE_MS);
    this.send({ t: 'ping', ts: Math.round(now) });
    window.setTimeout(() => this.judge(ws), POKE_MS + 50);
  }

  /* 연결 감시: 서버에서 오는 것이 끊기면 ping 을 보내 물어보고, 그래도 조용하면 죽은 연결로 본다.
   * 휴대폰에서는 연결이 죽어도 브라우저가 한참 동안 알려주지 않는다 (닫힘 이벤트가 오지 않는다).
   * 플레이 중에는 스냅샷이 계속 오므로 ping 을 보낼 일이 없다. */

  private startWatch(): void {
    this.stopWatch();
    this.lastWatch = performance.now();
    this.watchTimer = window.setInterval(() => this.watch(), PING_INTERVAL_MS);
  }

  private stopWatch(): void {
    window.clearInterval(this.watchTimer);
    this.watchTimer = 0;
  }

  private watch(): void {
    const ws = this.ws;
    if (!ws) return;
    const now = performance.now();
    // 타이머가 한참 밀렸다면 페이지가 멈춰 있었던 것이다 (다른 앱에 다녀왔다). 그동안의 침묵은 세지 않고 지금부터 다시 센다
    if (now - this.lastWatch > PING_INTERVAL_MS * 1.5) this.quietSince = now;
    this.lastWatch = now;
    if (this.judge(ws)) return;
    // 한 간격 가까이 조용했으면 물어본다 (답이 오면 quietSince 가 새로 잡힌다)
    if (now - this.lastRecv >= PING_INTERVAL_MS - 200) this.send({ t: 'ping', ts: Math.round(now) });
  }

  /** 너무 오래 조용했으면 죽은 연결로 보고 버린다. 버렸으면 true */
  private judge(ws: WebSocket): boolean {
    if (this.ws !== ws || performance.now() - this.quietSince <= DEAD_MS) return false;
    this.fail(ws);
    return true;
  }

  /** 응답이 없는 연결을 버린다. 브라우저의 닫힘 이벤트를 기다리지 않는다 (죽은 연결에서는 한참 뒤에야 온다). */
  private fail(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.stopWatch();
    try {
      ws.close();
    } catch {
      /* 이미 닫힌 소켓 */
    }
    this.onClose('timeout', CLOSE_TIMEOUT);
  }

  private send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

/* ───────────── 순위표 조회 ─────────────
 * 읽기 전용 GET 한 번뿐이다. 점수는 서버가 판이 끝날 때 직접 기록하므로 클라이언트가 보내는 것은 없다. */

export type LeaderboardErrorKind = 'network' | 'rate' | 'http' | 'bad';

export class LeaderboardError extends Error {
  constructor(
    readonly kind: LeaderboardErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** 서버가 잠들어 있다가 깨어나는 시간(최대 1분 안팎)까지 기다려 준다 */
const LEADERBOARD_TIMEOUT_MS = 45_000;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 응답을 그대로 믿지 않고 모양을 확인해 걸러 낸다 (이름 등 문자열은 호출하는 쪽에서 textContent 로만 쓴다) */
function parseEntries(raw: unknown): LeaderboardEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: LeaderboardEntry[] = [];
  for (const e of raw.slice(0, LEADERBOARD_SIZE)) {
    if (typeof e !== 'object' || e === null) return null;
    const o = e as Record<string, unknown>;
    if (!isNum(o.rank) || !isNum(o.time) || !isNum(o.kills) || !isNum(o.level) || !isNum(o.at)) return null;
    if (!Array.isArray(o.names) || !o.names.every((n) => typeof n === 'string')) return null;
    const names = (o.names as string[]).slice(0, 8);
    // 개인별 처치 수: 이름과 개수가 맞고 전부 0 이상의 수일 때만 쓴다 (예전 기록에는 없다)
    const by = o.killsBy;
    const killsBy = Array.isArray(by) && by.length === names.length && by.every((k) => isNum(k) && k >= 0) ? (by as number[]) : undefined;
    out.push({ rank: o.rank, names, ...(killsBy ? { killsBy } : {}), time: o.time, kills: o.kills, level: o.level, at: o.at });
  }
  return out;
}

export async function fetchLeaderboard(board: BoardId, signal?: AbortSignal): Promise<LeaderboardResponse> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), LEADERBOARD_TIMEOUT_MS);
  const onAbort = (): void => timeout.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    let res: Response;
    try {
      res = await fetch(`${HTTP_BASE}/api/leaderboard?board=${board}`, { signal: timeout.signal, headers: { accept: 'application/json' } });
    } catch (err) {
      if (signal?.aborted) throw err; // 호출한 쪽이 취소한 것: 오류로 보여주지 않는다
      throw new LeaderboardError('network', '서버에 연결할 수 없어요. 잠시 후 다시 시도해주세요.');
    }
    if (res.status === 429) throw new LeaderboardError('rate', '요청이 너무 많아요. 잠시 후 다시 시도해주세요.');
    if (!res.ok) throw new LeaderboardError('http', `순위표를 불러오지 못했어요 (오류 ${res.status}).`);
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new LeaderboardError('bad', '순위표 응답을 읽지 못했어요.');
    }
    const o = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
    const entries = parseEntries(o.entries);
    if (!entries || (o.board !== 'solo' && o.board !== 'coop')) throw new LeaderboardError('bad', '순위표 응답을 읽지 못했어요.');
    return { board: o.board, season: isNum(o.season) ? o.season : 0, persistent: o.persistent === true, loading: o.loading === true, entries };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
