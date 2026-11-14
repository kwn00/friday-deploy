import { NAME_MAX_LEN, ROOM_CODE_ALPHABET, ROOM_CODE_LEN } from './constants';
import type { UpgradeId } from './content';

/* ───────────── Client → Server ─────────────
 * 클라이언트는 "의도(intent)"만 보낸다. 좌표·체력·경험치·점수 같은 상태는 절대 받지 않는다. */

export type GameMode = 'solo' | 'coop';

export type ClientMsg =
  /** mode 가 coop 일 때: room 이 없으면 새 방을 만들고, 있으면 그 코드의 방에 참가한다. */
  | { t: 'hello'; v: number; token: string; name: string; mode: GameMode; room?: string }
  | { t: 'input'; seq: number; dx: number; dy: number }
  | { t: 'pick'; choice: number }
  /** 페어 방의 호스트가 대기실에서 게임을 시작한다. */
  | { t: 'start' }
  /** 일시정지 요청. 서버는 솔로 방에서만 받아들인다 (페어에서는 다른 사람의 게임을 멈출 수 없다). */
  | { t: 'pause'; on: boolean }
  | { t: 'ping'; ts: number };

/* ───────────── Server → Client ───────────── */

export interface Offer {
  id: UpgradeId;
  /** 선택 시 도달하는 레벨 */
  level: number;
}

export interface RunResult {
  sid: string;
  /** 같은 연결에서 몇 번째 판인지 (페어 방은 방을 유지한 채 여러 판을 한다). (sid, run) 이 결과 하나를 가리킨다. */
  run: number;
  name: string;
  time: number;
  kills: number;
  level: number;
  endedAt: number;
}

/** 순위표 종류: 혼자 한 판 / 둘 이상이 함께 한 판 */
export type BoardId = 'solo' | 'coop';

/** 순위표의 한 줄. 서버가 판이 끝날 때 직접 기록한 것만 있다 (클라이언트가 점수를 올리는 통로는 없다). */
export interface LeaderboardEntry {
  rank: number;
  /** 함께 한 사람들의 닉네임 (솔로는 1명) */
  names: string[];
  /** 생존 시간(초) */
  time: number;
  kills: number;
  level: number;
  /** 판이 끝난 시각 (epoch ms) */
  at: number;
}

/** GET /api/leaderboard?board=solo|coop 의 응답 */
export interface LeaderboardResponse {
  board: BoardId;
  season: number;
  /** false 면 기록이 서버 메모리에만 있어서 서버가 다시 시작되면 사라진다 */
  persistent: boolean;
  entries: LeaderboardEntry[];
}

export interface Snapshot {
  t: 'snap';
  /** 시뮬레이션 틱. 월드가 멈춰 있는 동안에는 증가하지 않는다 (클라이언트 보간의 시간축). */
  tick: number;
  time: number;
  /** 월드 정지 여부 (레벨업 선택 대기 또는 솔로 일시정지) */
  paused: boolean;
  me: {
    id: number;
    hp: number;
    maxHp: number;
    xp: number;
    xpNext: number;
    level: number;
    kills: number;
    alive: boolean;
    up: Partial<Record<UpgradeId, number>>;
  };
  /** [id, x, y, face, alive(0|1), hp 비율(0..100), 러버덕 개수]. 같은 방의 플레이어는 거리와 상관없이 전부 포함 (아군 위치는 비밀이 아니다) */
  p: [number, number, number, number, number, number, number][];
  /** [id, enemyTypeIndex, x, y, 이번 틱에 맞았는지(0|1)] */
  e: [number, number, number, number, number][];
  /** [id, shotKindIndex, x, y] */
  s: [number, number, number, number][];
  /** [id, x, y] */
  g: [number, number, number][];
  /** 회복 아이템 [id, x, y] */
  h: [number, number, number][];
}

export type ServerMsg =
  /** code: 페어 방 코드 (솔로는 빈 문자열) */
  | { t: 'welcome'; id: number; mode: GameMode; code: string; tickRate: number }
  /** host: 방장 플레이어 id, started: 게임이 시작됐는지 (false 면 대기실) */
  | { t: 'roster'; players: { id: number; name: string }[]; host: number; started: boolean }
  | Snapshot
  /** 솔로 일시정지 상태가 바뀔 때마다 서버가 알려준다. max: 자동 재개까지 남은 최대 시간(초) */
  | { t: 'pause'; on: boolean; max: number }
  | { t: 'levelup'; offers: Offer[]; timeout: number }
  /** place: 이번 판이 순위표에 올랐을 때의 순위 (오르지 못했으면 없음) */
  | { t: 'over'; result: RunResult; sig: string; place?: { board: BoardId; rank: number } }
  | { t: 'pong'; ts: number }
  | { t: 'error'; code: string };

/* ───────────── 검증 ───────────── */

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** 닉네임 정제: 한글/영문/숫자/일부 기호만 허용. 결과가 비면 기본 이름. */
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return 'anonymous';
  const cleaned = Array.from(raw.normalize('NFKC'))
    .filter((ch) => /[\p{L}\p{N}_\-. ]/u.test(ch))
    .join('')
    .trim()
    .slice(0, NAME_MAX_LEN);
  return cleaned.length > 0 ? cleaned : 'anonymous';
}

const ROOM_CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LEN}}$`);

/** 사람이 입력한 방 코드 정리: 공백·하이픈 제거, 대문자화. 형식이 맞지 않으면 null. */
export function normalizeRoomCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 32) return null;
  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  return ROOM_CODE_RE.test(code) ? code : null;
}

/**
 * 클라이언트 메시지를 엄격하게 파싱한다.
 * 알 수 없는 타입, 누락/초과 필드 타입, 범위를 벗어난 값은 전부 null (= 위반) 처리.
 */
export function parseClientMsg(raw: string): ClientMsg | null {
  if (raw.length > 512) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case 'hello': {
      if (!isInt(o.v, 0, 1_000_000)) return null;
      if (typeof o.token !== 'string' || o.token.length < 16 || o.token.length > 256) return null;
      if (typeof o.name !== 'string' || o.name.length > 64) return null;
      if (o.mode !== 'solo' && o.mode !== 'coop') return null;
      const hello: ClientMsg = { t: 'hello', v: o.v, token: o.token, name: sanitizeName(o.name), mode: o.mode };
      if (o.room !== undefined) {
        // 방 코드는 페어 모드에서만, 정확한 형식일 때만 받는다 (서버는 정규화하지 않는다: 클라이언트가 정리해서 보낸다)
        if (o.mode !== 'coop' || typeof o.room !== 'string' || !ROOM_CODE_RE.test(o.room)) return null;
        hello.room = o.room;
      }
      return hello;
    }
    case 'input': {
      if (!isInt(o.seq, 0, 0x7fffffff)) return null;
      if (!isFiniteNum(o.dx) || !isFiniteNum(o.dy)) return null;
      if (Math.abs(o.dx) > 1.001 || Math.abs(o.dy) > 1.001) return null;
      return { t: 'input', seq: o.seq, dx: o.dx, dy: o.dy };
    }
    case 'pick': {
      if (!isInt(o.choice, 0, 7)) return null;
      return { t: 'pick', choice: o.choice };
    }
    case 'start':
      return { t: 'start' };
    case 'pause': {
      if (typeof o.on !== 'boolean') return null;
      return { t: 'pause', on: o.on };
    }
    case 'ping': {
      if (!isFiniteNum(o.ts)) return null;
      return { t: 'ping', ts: o.ts };
    }
    default:
      return null;
  }
}
