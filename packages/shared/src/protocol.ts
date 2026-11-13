import { NAME_MAX_LEN } from './constants';
import type { UpgradeId } from './content';

/* ───────────── Client → Server ─────────────
 * 클라이언트는 "의도(intent)"만 보낸다. 좌표·체력·경험치·점수 같은 상태는 절대 받지 않는다. */

export type GameMode = 'solo' | 'coop';

export type ClientMsg =
  | { t: 'hello'; v: number; token: string; name: string; mode: GameMode }
  | { t: 'input'; seq: number; dx: number; dy: number }
  | { t: 'pick'; choice: number }
  | { t: 'ping'; ts: number };

/* ───────────── Server → Client ───────────── */

export interface Offer {
  id: UpgradeId;
  /** 선택 시 도달하는 레벨 */
  level: number;
}

export interface RunResult {
  sid: string;
  name: string;
  time: number;
  kills: number;
  level: number;
  endedAt: number;
}

export interface Snapshot {
  t: 'snap';
  tick: number;
  time: number;
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
  /** [id, x, y, face, alive(0|1), hp 비율(0..100)] */
  p: [number, number, number, number, number, number][];
  /** [id, enemyTypeIndex, x, y] */
  e: [number, number, number, number][];
  /** [id, shotKindIndex, x, y] */
  s: [number, number, number, number][];
  /** [id, x, y] */
  g: [number, number, number][];
  /** 러버덕 [x, y] */
  d: [number, number][];
}

export type ServerMsg =
  | { t: 'welcome'; id: number; room: string; tickRate: number }
  | { t: 'roster'; players: { id: number; name: string }[] }
  | Snapshot
  | { t: 'levelup'; offers: Offer[]; timeout: number }
  | { t: 'over'; result: RunResult; sig: string }
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
      return { t: 'hello', v: o.v, token: o.token, name: sanitizeName(o.name), mode: o.mode };
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
    case 'ping': {
      if (!isFiniteNum(o.ts)) return null;
      return { t: 'ping', ts: o.ts };
    }
    default:
      return null;
  }
}
