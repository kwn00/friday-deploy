import pg from 'pg';
import type { BoardId } from '@friday-deploy/shared';
import type { LeaderboardStore, RunRecord } from './leaderboard';

/**
 * PostgreSQL 저장소 (DATABASE_URL 이 설정됐을 때만 쓴다).
 *
 * - 만들 때 DB 에 접속하지 않는다. 테이블도 첫 사용 때 만들고, 실패하면 다음 사용 때 다시 시도한다
 *   (무료 호스팅 DB 는 한동안 쓰지 않으면 잠들었다가 느리게 깨어난다. 그동안에도 게임 서버는 떠 있어야 한다).
 * - load/save 는 실패하면 reject 한다. Leaderboard 가 그걸 보고 재시도한다.
 * - 쿼리는 전부 매개변수로 보낸다. 이름은 데이터로만 저장하고 SQL 문자열에 섞지 않는다.
 *
 * TLS: 연결 문자열에 sslmode=require 등이 있으면 pg 8.x 는 ssl 옵션을 켜고 인증서 검증도 그대로 켜 둔다
 * (rejectUnauthorized 기본값 true, 호스트 이름 검사 포함 — pg-connection-string 의 기본 분기).
 * 검증을 끄는 건 sslmode=no-verify 나 uselibpqcompat=true 를 직접 쓸 때뿐이라 여기서는 건드리지 않는다.
 * sslmode 가 없는 주소(로컬 테스트 DB, 호스팅의 내부 주소)는 TLS 없이 접속한다.
 */

/** 순위표·시즌마다 이 개수까지만 남긴다. Leaderboard 가 메모리에 들고 있는 수(보여주는 수의 4배)보다 훨씬 넉넉하게 */
const KEEP_PER_BOARD = 1000;
/** 저장 이 횟수마다 한 번 정리한다 (매번 지우면 쓸데없이 DB 를 두드린다) */
const PRUNE_EVERY = 50;

const POOL_MAX = 2;
const CONNECT_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 10_000;
/** 클라이언트 쪽 상한: DB 가 응답 없이 멈춰도 약속(Promise)이 영원히 pending 으로 남지 않게 한다 */
const QUERY_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 10_000;

/** 순위 정렬은 compareRuns 와 같다. id 는 로케일에 따라 순서가 달라지지 않게 "C" 정렬로 비교한다 */
const ORDER = 'time DESC, kills DESC, level DESC, ended_at ASC, id COLLATE "C" ASC';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS leaderboard_runs (
    id             text    PRIMARY KEY,
    board          text    NOT NULL,
    season         integer NOT NULL,
    names          text[]  NOT NULL,
    time           integer NOT NULL,
    kills          integer NOT NULL,
    level          integer NOT NULL,
    paused_seconds integer NOT NULL,
    ended_at       bigint  NOT NULL
  )`,
  // 상위 N 조회와 정리 쿼리가 그대로 이 인덱스를 따라 읽는다
  `CREATE INDEX IF NOT EXISTS leaderboard_runs_top
    ON leaderboard_runs (board, season, time DESC, kills DESC, level DESC, ended_at ASC, (id COLLATE "C") ASC)`,
];

interface Row {
  id: string;
  board: string;
  season: number;
  names: string[];
  time: number;
  kills: number;
  level: number;
  paused_seconds: number;
  /** bigint 는 문자열로 온다 */
  ended_at: string;
}

/** PostgreSQL 의 text 는 NUL 문자를 담지 못한다. 이름은 위에서 정리되지만 저장 실패로 재시도만 반복하지 않게 방어한다 */
const clean = (s: string): string => s.replaceAll('\u0000', '');

export async function createPostgresStore(url: string): Promise<LeaderboardStore> {
  return new PostgresStore(url);
}

class PostgresStore implements LeaderboardStore {
  readonly persistent = true;
  private readonly pool: pg.Pool;
  private ready: Promise<void> | null = null;
  private saves = 0;
  private closed = false;
  private inflight = new Set<Promise<unknown>>();

  constructor(url: string) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: POOL_MAX,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
      idle_in_transaction_session_timeout: STATEMENT_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      keepAlive: true,
    });
    // 쉬고 있는 연결을 호스팅 DB 가 끊으면 'error' 가 올라온다. 리스너가 없으면 프로세스가 죽으므로 반드시 둔다.
    // 끊긴 연결은 풀이 알아서 버리고 다음 쿼리 때 새로 연결한다.
    this.pool.on('error', (err) => console.error('[leaderboard] DB 연결 오류 (다음 요청 때 다시 연결합니다)', err.message));
  }

  async load(board: BoardId, season: number, limit: number): Promise<RunRecord[]> {
    return this.track(async () => {
      await this.ensureSchema();
      const n = Math.max(0, Math.floor(limit));
      const res = await this.pool.query<Row>(
        `SELECT id, board, season, names, time, kills, level, paused_seconds, ended_at
           FROM leaderboard_runs WHERE board = $1 AND season = $2
          ORDER BY ${ORDER} LIMIT $3`,
        [board, season, n],
      );
      return res.rows.map((r) => ({
        id: r.id,
        board: r.board as BoardId,
        season: r.season,
        names: r.names,
        time: r.time,
        kills: r.kills,
        level: r.level,
        pausedSeconds: r.paused_seconds,
        endedAt: Number(r.ended_at),
      }));
    });
  }

  async save(r: RunRecord): Promise<void> {
    await this.track(async () => {
      await this.ensureSchema();
      await this.pool.query(
        `INSERT INTO leaderboard_runs (id, board, season, names, time, kills, level, paused_seconds, ended_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [r.id, r.board, r.season, r.names.map(clean), r.time, r.kills, r.level, r.pausedSeconds, r.endedAt],
      );
    });
    if (++this.saves % PRUNE_EVERY === 0) void this.prune(r.board, r.season);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.inflight]);
    try {
      await this.pool.end();
    } catch {
      /* 이미 끊긴 연결 때문에 종료가 실패해도 무시한다 */
    }
  }

  /** 상위 KEEP_PER_BOARD 밖의 기록만 지운다. 순위표에 보이는 기록과 겹칠 수 없다. 실패해도 다음 기회에 한다 */
  private async prune(board: BoardId, season: number): Promise<void> {
    try {
      await this.track(async () => {
        await this.ensureSchema();
        await this.pool.query(
          `DELETE FROM leaderboard_runs WHERE id IN (
             SELECT id FROM leaderboard_runs WHERE board = $1 AND season = $2
              ORDER BY ${ORDER} OFFSET $3)`,
          [board, season, KEEP_PER_BOARD],
        );
      });
    } catch (err) {
      console.error('[leaderboard] 오래된 기록 정리 실패 (다음에 다시 시도합니다)', err instanceof Error ? err.message : err);
    }
  }

  /** 테이블 준비. 한 번 성공하면 끝이고, 실패하면 기억하지 않아 다음 호출이 다시 시도한다 */
  private ensureSchema(): Promise<void> {
    if (!this.ready) {
      const attempt = this.createSchema();
      this.ready = attempt;
      attempt.catch(() => {
        if (this.ready === attempt) this.ready = null;
      });
    }
    return this.ready;
  }

  private async createSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // 서버 두 개가 동시에 처음 뜰 때 CREATE ... IF NOT EXISTS 끼리 부딪히지 않게 잠시 줄을 세운다
      await client.query('SELECT pg_advisory_xact_lock(7419003)');
      for (const sql of SCHEMA) await client.query(sql);
      await client.query('COMMIT');
      client.release();
    } catch (err) {
      // 연결 자체가 망가졌을 수 있으니 풀에 돌려주지 않고 버린다
      client.release(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /** 동기 예외가 새거나 close 가 진행 중인 작업을 놓치지 않도록 모든 작업을 같은 틀로 실행한다 */
  private track<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('저장소가 이미 닫혔습니다'));
    const p = Promise.resolve().then(fn);
    this.inflight.add(p);
    const done = () => void this.inflight.delete(p);
    p.then(done, done);
    return p;
  }
}
