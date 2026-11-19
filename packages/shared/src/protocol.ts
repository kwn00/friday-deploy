import { NAME_MAX_LEN, ROOM_CODE_ALPHABET, ROOM_CODE_LEN } from './constants';
import type { UpgradeId } from './content';

/* ───────────── Client → Server ─────────────
 * 클라이언트는 "의도(intent)"만 보낸다. 좌표·체력·경험치·점수 같은 상태는 절대 받지 않는다. */

export type GameMode = 'solo' | 'coop';

export type ClientMsg =
  /** mode 가 coop 일 때: room 이 없으면 새 방을 만들고, 있으면 그 코드의 방에 참가한다. */
  | { t: 'hello'; v: number; token: string; name: string; mode: GameMode; room?: string }
  /**
   * 끊긴 연결을 이어받는다 (hello 대신 보내는 첫 메시지). key 는 서버가 welcome 에 실어 준 값 그대로다.
   * 서버가 그 자리를 아직 지키고 있으면 같은 캐릭터로 돌아간다. 상태를 실어 보내는 것이 아니다: 자리를 가리킬 뿐이다.
   */
  | { t: 'resume'; v: number; token: string; key: string }
  | { t: 'input'; seq: number; dx: number; dy: number }
  | { t: 'pick'; choice: number }
  /** 페어 방의 호스트가 대기실에서 게임을 시작한다. */
  | { t: 'start' }
  /** 일시정지 요청. 서버는 솔로 방에서만 받아들인다 (페어에서는 다른 사람의 게임을 멈출 수 없다). */
  | { t: 'pause'; on: boolean }
  /** 방을 나간다: 자리를 바로 비운다. 이 메시지 없이 연결만 끊기면 서버는 자리를 잠시 지켜 둔다. */
  | { t: 'leave' }
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
  /** 함께 한 사람들의 닉네임 (솔로는 1명). 기여도(개인 처치 수)가 큰 사람부터 */
  names: string[];
  /** names 와 같은 순서의 개인별 처치 수 (기여도). 이 값을 남기기 전의 기록에는 없다 */
  killsBy?: number[];
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
  /** true 면 저장된 기록을 아직 불러오지 못했다 (DB 가 깨어나는 중이거나 잠깐 안 됨). 지금 목록은 일부일 수 있다 */
  loading: boolean;
  entries: LeaderboardEntry[];
}

/**
 * 끝난 판에 순위가 없는 이유.
 * watched: 캐릭터 없이 관전만 한 사람 / short: 너무 짧은 판 / late: 도중에 합류한 사람 / outside: 순위표 밖 /
 * pending: 저장된 기록을 아직 불러오지 못해 순위를 말할 수 없다 (기록 자체는 남는다)
 */
export type UnrankedReason = 'watched' | 'short' | 'late' | 'outside' | 'pending';

export interface Snapshot {
  t: 'snap';
  /** 시뮬레이션 틱. 월드가 멈춰 있는 동안에는 증가하지 않는다 (클라이언트 보간의 시간축). */
  tick: number;
  time: number;
  /** 월드 정지 여부 (레벨업 선택 대기 또는 솔로 일시정지) */
  paused: boolean;
  /**
   * 이 스냅샷이 보여주는 영역의 중심 [x, y]: 살아 있으면 내 캐릭터 위치, 관전 중이면 서버가 계산한 관전 시점.
   * 화면(카메라)과 미니맵은 이 값을 중심으로 그린다.
   */
  view: [number, number];
  /**
   * ack: 서버가 마지막으로 받아들인 내 입력의 번호 (아직 없으면 0).
   * ackTicks: 그 입력으로 내 캐릭터를 움직인 틱 수 (0~255).
   * ackPhase: 그 입력이 틱과 틱 사이의 어디쯤에서 도착했는지 (0~255, 256 이 한 틱).
   * 클라이언트는 이 값으로 "서버가 내 입력을 어디까지 반영했는지"를 알고, 아직 반영되지 않은 만큼만 내 캐릭터를 앞서 그린다.
   * 화면을 위한 값이다: 위치는 여전히 서버만 계산하고, 클라이언트가 그린 위치는 서버로 보내지 않는다.
   */
  ack: number;
  ackTicks: number;
  ackPhase: number;
  me: {
    id: number;
    hp: number;
    maxHp: number;
    xp: number;
    xpNext: number;
    level: number;
    kills: number;
    alive: boolean;
    /** 가지고 있는 부활(백업) 수 */
    revives: number;
    up: Partial<Record<UpgradeId, number>>;
  };
  /**
   * 같은 방의 플레이어. 거리와 상관없이 전부 포함 (아군 위치는 비밀이 아니다).
   * [id, x, y, face, alive(0|1), hp 비율(0..100), 돌고 있는 러버덕 수, 되살아난 직후 무적(0|1),
   *  러버덕 반경(px), 러버덕 각속도(×10 rad/s), 방화벽 반경(px, 없으면 0), 2단계 인증 방패 수(0~3),
   *  맞은 직후 무적(0|1: 깜빡여 그린다)].
   * alive 가 0 이면 그 자리에 묘비가 있다. 관전으로 합류해 몸이 없는 사람은 들어 있지 않다 (나 자신이라도).
   * 러버덕은 서버가 위치를 보내지 않는다: 클라이언트가 같은 반경·각속도·시간으로 같은 자리를 계산해 매끄럽게 그린다.
   */
  p: [number, number, number, number, number, number, number, number, number, number, number, number, number][];
  /** [id, enemyTypeIndex, x, y, 이번 틱에 맞았는지(0|1), 얼어 있는지(0|1)] */
  e: [number, number, number, number, number, number][];
  /** 투사체·소환물 [id, 종류 번호(SHOT_KINDS 의 순서), x, y] */
  s: [number, number, number, number][];
  /**
   * 이번 틱에 새로 생긴 공격 영역 [id, 종류 번호(ZONE_KINDS 의 순서), x, y, 크기(px), 추가 값(0~255), 남는 틱 수].
   * 추가 값: 베기·광선은 방향(256 = 한 바퀴), 세로 띠는 높이/4. 나머지는 0.
   * 영역은 생길 때 한 번만 보낸다 (전송량을 아끼려고). 클라이언트가 남는 틱 수만큼 그린다.
   */
  z: [number, number, number, number, number, number, number][];
  /** 수명보다 일찍 없어진 영역의 id (멈췄을 때 날아간 커밋 히스토리). 클라이언트는 그리던 것을 지운다 */
  zr: number[];
  /** 경험치 [id, x, y, 색 단계(0 파랑: 2 이하, 1 초록: 9 이하, 2 빨강)] */
  g: [number, number, number, number][];
  /** 회복 아이템 [id, x, y] */
  h: [number, number, number][];
  /**
   * 필드 아이템 [id, 종류 번호(FIELD_ITEM_KINDS 의 순서), x, y, 곧 사라지는지(0|1)].
   * 다른 것들과 달리 거리와 상관없이 전부 들어 있다 (미니맵에서 찾아가라고 알려주는 정보다).
   */
  i: [number, number, number, number, number][];
}

export interface RosterPlayer {
  id: number;
  name: string;
  /** 연결이 끊겨 자리만 지키고 있다 (캐릭터는 그 자리에 서 있다). 돌아오면 이어서 한다 */
  away?: boolean;
  /** 연결은 있지만 한동안 입력이 없다 (화면을 떠났거나 통신이 막혔다) */
  idle?: boolean;
}

export type ServerMsg =
  /**
   * code: 페어 방 코드 (솔로는 빈 문자열).
   * key: 이 자리를 이어받는 열쇠. 연결이 끊겼을 때 resume 에 실어 보낸다 (남에게 보이면 안 되는 값이다).
   * resumed: 끊겼던 자리를 이어받은 것이면 true
   */
  | { t: 'welcome'; id: number; mode: GameMode; code: string; tickRate: number; key: string; resumed?: boolean }
  /**
   * host: 지금 시작할 수 있는 사람의 플레이어 id (방장. 방장의 연결이 끊겨 있는 동안에는 접속해 있는 사람 중 가장 먼저 들어온 사람),
   * started: 게임이 시작됐는지 (false 면 대기실)
   */
  | { t: 'roster'; players: RosterPlayer[]; host: number; started: boolean }
  | Snapshot
  /** 솔로 일시정지 상태가 바뀔 때마다 서버가 알려준다. max: 자동 재개까지 남은 최대 시간(초) */
  | { t: 'pause'; on: boolean; max: number }
  | { t: 'levelup'; offers: Offer[]; timeout: number }
  /** 보물상자를 열었다: 한 단계씩 오른 것들 (같은 것이 여러 번 있을 수 있다)과, 올릴 것이 없어 대신 찬 체력 */
  | { t: 'chest'; items: UpgradeId[]; heal: number }
  /** place: 이번 판이 순위표에 올랐을 때의 순위 (오르지 못했으면 없음) */
  | { t: 'over'; result: RunResult; sig: string; place?: { board: BoardId; rank: number }; unranked?: UnrankedReason }
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
/** 이어받기 키: 방 id(16진 8자) . 비밀 값(24바이트의 base64url = 32자) */
const RESUME_KEY_RE = /^[0-9a-f]{8}\.[A-Za-z0-9_-]{32}$/;

const isToken = (v: unknown): v is string => typeof v === 'string' && v.length >= 16 && v.length <= 256;

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
      if (!isToken(o.token)) return null;
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
    case 'resume': {
      if (!isInt(o.v, 0, 1_000_000)) return null;
      if (!isToken(o.token)) return null;
      if (typeof o.key !== 'string' || !RESUME_KEY_RE.test(o.key)) return null;
      return { t: 'resume', v: o.v, token: o.token, key: o.key };
    }
    case 'leave':
      return { t: 'leave' };
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
