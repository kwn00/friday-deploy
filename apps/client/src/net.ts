import {
  LEADERBOARD_SIZE,
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

export class Net {
  private ws: WebSocket | null = null;
  private seq = 0;

  constructor(
    private readonly onMessage: (msg: ServerMsg) => void,
    private readonly onClose: (reason: string) => void,
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** room: 페어 모드에서 참가할 방 코드. 없으면 새 방을 만든다. */
  async connect(name: string, mode: GameMode, room?: string): Promise<void> {
    this.close();
    let res: Response;
    try {
      res = await fetch(`${HTTP_BASE}/api/session`, { method: 'POST' });
    } catch {
      throw new Error('서버에 연결할 수 없어요. 잠시 후 다시 시도해주세요.');
    }
    if (!res.ok) throw new Error(res.status === 429 ? '요청이 너무 많아요. 잠시 후 다시 시도해주세요.' : '세션 발급 실패');
    const { token } = (await res.json()) as { token: string };

    const ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.seq = 0;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('서버에 연결할 수 없어요'));
    });
    ws.onmessage = (ev) => {
      try {
        // 스냅샷은 이진 프레임, 그 밖의 메시지는 JSON 텍스트
        this.onMessage(typeof ev.data === 'string' ? (JSON.parse(ev.data) as ServerMsg) : decodeSnapshot(ev.data as ArrayBuffer));
      } catch {
        /* 형식이 맞지 않는 메시지는 버린다 */
      }
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) {
        this.ws = null;
        this.onClose(ev.reason || `code ${ev.code}`);
      }
    };
    this.send(room ? { t: 'hello', v: PROTOCOL_VERSION, token, name, mode, room } : { t: 'hello', v: PROTOCOL_VERSION, token, name, mode });
  }

  sendInput(dx: number, dy: number): void {
    this.send({ t: 'input', seq: ++this.seq, dx, dy });
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

  close(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
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
    out.push({ rank: o.rank, names: (o.names as string[]).slice(0, 8), time: o.time, kills: o.kills, level: o.level, at: o.at });
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
    return { board: o.board, season: isNum(o.season) ? o.season : 0, persistent: o.persistent === true, entries };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
