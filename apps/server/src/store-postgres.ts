import pg from 'pg';
import { UPGRADE_IDS, ownedUpgrades, type BoardId, type UpgradeId } from '@friday-deploy/shared';
import { emptyStats, type LeaderboardStore, type RunRecord, type StoredStats, type UpgradeCounts } from './leaderboard';

/** upgrade_stats 의 한 줄 (bigint 는 문자열로 온다) */
interface StatRow {
  upgrade_id: string;
  offered: string;
  picked: string;
  auto_picked: string;
  chest: string;
  final_owned: string;
  final_level_sum: string;
}

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
 *
 * 연결 풀러: 호스팅 DB 가 기본으로 보여주는 "풀링" 주소(Neon 의 -pooler 호스트 등)는 PgBouncer 를 거친다.
 * PgBouncer 는 접속할 때 보내는 매개변수 중 자기가 추적하는 것만 받고, statement_timeout 같은 것이 있으면
 * 접속 자체를 거부한다 ("unsupported startup parameter"). 또 트랜잭션 단위로 연결을 나눠 쓰므로
 * 세션에 걸어 둔 설정은 다음 쿼리에 이어지지 않는다. 그래서 여기서는
 *  - 접속 매개변수로 시간 제한을 보내지 않고,
 *  - 모든 작업을 트랜잭션으로 감싸 그 안에서만 SET LOCAL 로 시간 제한을 건다 (직접 주소·풀링 주소 모두에서 동작),
 *  - 세션 단위 기능(세션 잠금, SET, LISTEN 등)을 쓰지 않는다.
 */

/*
 * 리더보드 기록은 지우지 않는다 (CLAUDE.md). 예전에는 순위표·시즌마다 상위 1000개 밖의 기록을 자동으로 지웠는데,
 * 시즌을 합치면(시즌 0) 그 정리가 기록을 지울 수 있어서 없앴다. 기록 하나는 200바이트 남짓이라 쌓여도 작다.
 */

const POOL_MAX = 2;
const CONNECT_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 10_000;
/** 클라이언트 쪽 상한: DB 가 응답 없이 멈춰도 약속(Promise)이 영원히 pending 으로 남지 않게 한다 */
const QUERY_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 10_000;

/** 순위 정렬은 compareRuns 와 같다. id 는 로케일에 따라 순서가 달라지지 않게 "C" 정렬로 비교한다 */
const ORDER = 'time DESC, kills DESC, level DESC, ended_at ASC, id COLLATE "C" ASC';

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS leaderboard_runs (
    id             text    PRIMARY KEY,
    board          text    NOT NULL,
    season         integer NOT NULL,
    names          text[]  NOT NULL,
    time           integer NOT NULL,
    kills          integer NOT NULL,
    level          integer NOT NULL,
    paused_seconds integer NOT NULL,
    ended_at       bigint  NOT NULL
  )`;
/** 개인별 처치 수(기여도). names 와 같은 순서. 나중에 추가한 열이라 예전 기록에는 NULL 이다 (기존 행은 건드리지 않는다) */
const HAS_MEMBER_KILLS = `SELECT 1 FROM pg_attribute
   WHERE attrelid = 'leaderboard_runs'::regclass AND attname = 'member_kills' AND NOT attisdropped`;
const ADD_MEMBER_KILLS = `ALTER TABLE leaderboard_runs ADD COLUMN IF NOT EXISTS member_kills integer[]`;
/** 개인별 아이템(무기·패시브와 단계). names 와 같은 순서의 배열의 배열을 JSON 으로 둔다. 나중에 추가한 열이라 예전 기록에는 NULL 이다 */
const HAS_MEMBER_ITEMS = `SELECT 1 FROM pg_attribute
   WHERE attrelid = 'leaderboard_runs'::regclass AND attname = 'member_items' AND NOT attisdropped`;
const ADD_MEMBER_ITEMS = `ALTER TABLE leaderboard_runs ADD COLUMN IF NOT EXISTS member_items jsonb`;
/** 상위 N 조회가 그대로 이 인덱스를 따라 읽는다 */
const HAS_INDEX = `SELECT to_regclass('leaderboard_runs_top') IS NOT NULL AS present`;
const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS leaderboard_runs_top
    ON leaderboard_runs (board, season, time DESC, kills DESC, level DESC, ended_at ASC, (id COLLATE "C") ASC)`;
/**
 * 서버가 어느 시즌으로 떠 본 적이 있는지 (뜰 때마다 지금 시즌을 남긴다). 아래 "시즌 0 으로 합치기"가
 * 새 규칙의 시즌(1 이상)이 생긴 뒤에는 절대 돌지 않게 하는 표시다.
 */
const CREATE_SEASON_MARKS = `CREATE TABLE IF NOT EXISTS season_marks (
    season     integer PRIMARY KEY,
    first_seen bigint  NOT NULL
  )`;
const MARK_SEASON = 'INSERT INTO season_marks (season, first_seen) VALUES ($1, $2) ON CONFLICT (season) DO NOTHING';
/**
 * 시즌 0 으로 합치기: 버전의 메이저(x)를 시즌으로 쓰기로 하면서(0.x = 시즌 0), 그 전 규칙으로 쌓인 기록
 * (시즌 1~3)의 시즌 번호를 0 으로 바꾼다. 기록은 지우지 않고 번호만 바꾼다.
 * 새 규칙의 시즌 1 이상으로 떠 본 서버가 아직 하나도 없을 때만 한다 (season_marks): 그때까지 0 이 아닌 시즌의 기록은
 * 모두 예전 규칙의 것이다. 그래서 서버가 뜰 때마다 해도 안전하고, 배포하는 동안 아직 내려가지 않은 예전 서버가
 * 예전 시즌 번호로 남긴 기록도 다음에 뜰 때 합쳐진다. 1.x 가 한 번이라도 뜬 뒤에는 0.x 로 되돌려 띄워도(롤백) 하지 않는다.
 */
const FOLD_INTO_SEASON_ZERO = `UPDATE leaderboard_runs SET season = 0
   WHERE season <> 0 AND NOT EXISTS (SELECT 1 FROM season_marks WHERE season > 0)`;
/** 아이템 통계: 시즌·아이템마다 누적 횟수 */
const CREATE_UPGRADE_STATS = `CREATE TABLE IF NOT EXISTS upgrade_stats (
    season          integer NOT NULL,
    upgrade_id      text    NOT NULL,
    offered         bigint  NOT NULL DEFAULT 0,
    picked          bigint  NOT NULL DEFAULT 0,
    auto_picked     bigint  NOT NULL DEFAULT 0,
    chest           bigint  NOT NULL DEFAULT 0,
    final_owned     bigint  NOT NULL DEFAULT 0,
    final_level_sum bigint  NOT NULL DEFAULT 0,
    PRIMARY KEY (season, upgrade_id)
  )`;
/**
 * 아이템 통계를 더한 묶음의 id. 더하기와 같은 트랜잭션에서 남긴다: 확인 응답만 잃은 묶음을 다시 보내도 두 번 더하지 않는다.
 * 다시 보내는 것은 길어야 몇십 분 안이므로, 오래된 id 는 서버가 뜰 때 지운다 (기록이 아니라 중복 확인용 표시다).
 */
const CREATE_STAT_BATCHES = `CREATE TABLE IF NOT EXISTS stat_batches (
    id     text   PRIMARY KEY,
    season integer NOT NULL,
    at     bigint NOT NULL
  )`;
const STAT_BATCH_KEEP_MS = 7 * 24 * 3600_000;
/** 아이템 통계: 시즌마다 센 판 수와 세기 시작한 때 */
const CREATE_STAT_RUNS = `CREATE TABLE IF NOT EXISTS stat_runs (
    season integer PRIMARY KEY,
    runs   bigint  NOT NULL DEFAULT 0,
    since  bigint  NOT NULL
  )`;
/** 열을 더할 때 테이블 잠금을 기다리는 최대 시간. 못 잡으면 물러났다가 다음 기회에 다시 한다 (그동안 다른 쿼리를 줄 세우지 않게) */
const MIGRATE_LOCK_TIMEOUT_MS = 3_000;

interface Row {
  id: string;
  board: string;
  season: number;
  names: string[];
  member_kills: number[] | null;
  /** jsonb 는 풀어진 값으로 온다. DB 에 무엇이 들었든 모양을 다시 확인해서 쓴다 */
  member_items: unknown;
  time: number;
  kills: number;
  level: number;
  paused_seconds: number;
  /** bigint 는 문자열로 온다 */
  ended_at: string;
}

/** PostgreSQL 의 text 는 NUL 문자를 담지 못한다. 이름은 위에서 정리되지만 저장 실패로 재시도만 반복하지 않게 방어한다 */
const clean = (s: string): string => s.replaceAll('\u0000', '');

/** DB 의 member_items 를 기록 모양으로. 이름 수와 맞는 배열의 배열일 때만 쓰고, 각 목록은 다시 걸러 낸다 */
function itemsOf(raw: unknown, members: number): Pick<RunRecord, 'itemsBy'> {
  if (!Array.isArray(raw) || raw.length !== members) return {};
  return { itemsBy: raw.map((list) => ownedUpgrades(list) ?? []) };
}

export interface PostgresStoreOptions {
  /** DB 쪽 문장 시간 제한(ms). 기본 10초. 테스트에서 짧게 잡을 때만 바꾼다 */
  statementTimeoutMs?: number;
  /**
   * 지금 시즌 (서버는 LEADERBOARD_SEASON 을 넘긴다). 0 이면 서버가 뜰 때 예전 시즌의 기록을 시즌 0 으로 합친다.
   * 넘기지 않으면 아무 시즌도 건드리지 않는다 (테스트는 시즌 번호로 서로의 데이터를 나누므로 넘기지 않는다)
   */
  currentSeason?: number;
}

export async function createPostgresStore(url: string, options: PostgresStoreOptions = {}): Promise<LeaderboardStore> {
  return new PostgresStore(url, options);
}

class PostgresStore implements LeaderboardStore {
  readonly persistent = true;
  private readonly pool: pg.Pool;
  private ready: Promise<void> | null = null;
  private closed = false;
  private inflight = new Set<Promise<unknown>>();
  /** 트랜잭션을 열면서 그 트랜잭션에만 시간 제한을 거는 문장 (숫자는 코드의 상수라 문자열에 넣어도 안전하다) */
  private readonly begin: string;
  private readonly currentSeason: number | undefined;

  constructor(url: string, options: PostgresStoreOptions) {
    this.currentSeason = Number.isInteger(options.currentSeason) && options.currentSeason! >= 0 ? options.currentSeason : undefined;
    const limit = Math.max(1, Math.floor(Number(options.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS)) || STATEMENT_TIMEOUT_MS);
    this.begin = `BEGIN; SET LOCAL statement_timeout = ${limit}; SET LOCAL idle_in_transaction_session_timeout = ${limit}`;
    this.pool = new pg.Pool({
      connectionString: url,
      max: POOL_MAX,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      // statement_timeout 등을 여기(접속 매개변수)에 두면 연결 풀러가 접속을 거부한다. 시간 제한은 tx() 가 건다.
      query_timeout: QUERY_TIMEOUT_MS,
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
      const res = await this.tx((client) =>
        client.query<Row>(
          `SELECT id, board, season, names, member_kills, member_items, time, kills, level, paused_seconds, ended_at
             FROM leaderboard_runs WHERE board = $1 AND season = $2
            ORDER BY ${ORDER} LIMIT $3`,
          [board, season, n],
        ),
      );
      return res.rows.map((r) => ({
        id: r.id,
        board: r.board as BoardId,
        season: r.season,
        names: r.names,
        // 이름과 개수가 맞을 때만 쓴다 (예전 기록은 NULL)
        ...(Array.isArray(r.member_kills) && r.member_kills.length === r.names.length ? { killsBy: r.member_kills } : {}),
        ...itemsOf(r.member_items, r.names.length),
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
      await this.tx((client) =>
        client.query(
          `INSERT INTO leaderboard_runs (id, board, season, names, time, kills, level, paused_seconds, ended_at, member_kills, member_items)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (id) DO NOTHING`,
          [r.id, r.board, r.season, r.names.map(clean), r.time, r.kills, r.level, r.pausedSeconds, r.endedAt, r.killsBy ?? null, r.itemsBy ? JSON.stringify(r.itemsBy) : null],
        ),
      );
    });
  }

  async seasons(): Promise<number[]> {
    return this.track(async () => {
      await this.ensureSchema();
      const res = await this.tx((client) =>
        client.query<{ season: number }>('SELECT DISTINCT season FROM leaderboard_runs UNION SELECT season FROM stat_runs ORDER BY season'),
      );
      return res.rows.map((r) => r.season);
    });
  }

  async loadStats(season: number): Promise<StoredStats> {
    return this.track(async () => {
      await this.ensureSchema();
      return this.tx(async (client) => {
        const head = await client.query<{ runs: string; since: string }>('SELECT runs, since FROM stat_runs WHERE season = $1', [season]);
        const rows = await client.query<StatRow>(
          'SELECT upgrade_id, offered, picked, auto_picked, chest, final_owned, final_level_sum FROM upgrade_stats WHERE season = $1',
          [season],
        );
        const out = emptyStats();
        if (head.rows[0]) {
          out.runs = Number(head.rows[0].runs);
          out.since = Number(head.rows[0].since);
        }
        for (const r of rows.rows) {
          // 지금 게임에 없는 아이템(이름이 바뀌었거나 빠진 것)은 건너뛴다
          if (!(UPGRADE_IDS as readonly string[]).includes(r.upgrade_id)) continue;
          out.upgrades[r.upgrade_id as UpgradeId] = {
            offered: Number(r.offered),
            picked: Number(r.picked),
            autoPicked: Number(r.auto_picked),
            chest: Number(r.chest),
            finalOwned: Number(r.final_owned),
            finalLevelSum: Number(r.final_level_sum),
          };
        }
        return out;
      }, true); // 두 표를 한 시점에서 읽는다 (그 사이에 다른 서버가 더한 것이 반만 섞이지 않게)
    });
  }

  async addStats(season: number, d: StoredStats, batch: string): Promise<void> {
    await this.track(async () => {
      await this.ensureSchema();
      await this.tx(async (client) => {
        // 이미 더한 묶음이면(확인 응답만 잃고 다시 보낸 것) 아무것도 하지 않는다
        const fresh = await client.query('INSERT INTO stat_batches (id, season, at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [batch, season, Date.now()]);
        if (fresh.rowCount === 0) return;
        await client.query(
          `INSERT INTO stat_runs (season, runs, since) VALUES ($1, $2, $3)
           ON CONFLICT (season) DO UPDATE SET runs = stat_runs.runs + EXCLUDED.runs, since = LEAST(stat_runs.since, EXCLUDED.since)`,
          [season, d.runs, d.since ?? Date.now()],
        );
        const ids = Object.keys(d.upgrades) as UpgradeId[];
        if (ids.length === 0) return;
        const col = (f: (c: UpgradeCounts) => number): number[] => ids.map((id) => f(d.upgrades[id]!));
        // 아이템마다 한 줄씩 한 문장으로 더한다 (판 하나에 최대 38줄)
        await client.query(
          `INSERT INTO upgrade_stats (season, upgrade_id, offered, picked, auto_picked, chest, final_owned, final_level_sum)
           SELECT $1, * FROM unnest($2::text[], $3::bigint[], $4::bigint[], $5::bigint[], $6::bigint[], $7::bigint[], $8::bigint[])
           ON CONFLICT (season, upgrade_id) DO UPDATE SET
             offered = upgrade_stats.offered + EXCLUDED.offered,
             picked = upgrade_stats.picked + EXCLUDED.picked,
             auto_picked = upgrade_stats.auto_picked + EXCLUDED.auto_picked,
             chest = upgrade_stats.chest + EXCLUDED.chest,
             final_owned = upgrade_stats.final_owned + EXCLUDED.final_owned,
             final_level_sum = upgrade_stats.final_level_sum + EXCLUDED.final_level_sum`,
          [
            season,
            ids,
            col((c) => c.offered),
            col((c) => c.picked),
            col((c) => c.autoPicked),
            col((c) => c.chest),
            col((c) => c.finalOwned),
            col((c) => c.finalLevelSum),
          ],
        );
      });
    });
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
    await this.tx(async (client) => {
      // 서버 두 개가 동시에 처음 뜰 때 CREATE ... IF NOT EXISTS 끼리 부딪히지 않게 잠시 줄을 세운다.
      // 트랜잭션이 끝나면 풀리는 잠금이라 연결 풀러 뒤에서도 안전하다 (세션 잠금은 풀러에서 쓸 수 없다).
      await client.query('SELECT pg_advisory_xact_lock(7419003)');
      await client.query(CREATE_TABLE);
      // 나중에 더한 열과 인덱스는 "없을 때만" 만든다. ALTER TABLE 은 IF NOT EXISTS 가 붙어 있어도 테이블 전체를 막는
      // 잠금부터 잡고, CREATE INDEX 도 쓰기를 막는 잠금을 잡는다. 서버가 뜰 때마다 그러면, 마침 다른 연결이 테이블을
      // 쓰고 있을 때 서로를 기다리게 만든다. 평소(이미 다 있는 경우)에는 읽기 두 번으로 끝난다.
      const missing: string[] = [];
      if ((await client.query(HAS_MEMBER_KILLS)).rowCount === 0) missing.push(ADD_MEMBER_KILLS);
      if ((await client.query(HAS_MEMBER_ITEMS)).rowCount === 0) missing.push(ADD_MEMBER_ITEMS);
      if (missing.length > 0) {
        await client.query(`SET LOCAL lock_timeout = ${MIGRATE_LOCK_TIMEOUT_MS}`);
        for (const sql of missing) await client.query(sql);
      }
      const index = await client.query<{ present: boolean }>(HAS_INDEX);
      if (!index.rows[0]?.present) await client.query(CREATE_INDEX);
      await client.query(CREATE_UPGRADE_STATS);
      await client.query(CREATE_STAT_RUNS);
      await client.query(CREATE_STAT_BATCHES);
      await client.query(CREATE_SEASON_MARKS);
      await client.query('DELETE FROM stat_batches WHERE at < $1', [Date.now() - STAT_BATCH_KEEP_MS]);
      if (this.currentSeason !== undefined) {
        // 이 시즌으로 떠 본 적이 있다고 남긴다 (기록을 쓰기 전에: 1.x 가 남긴 표시가 있으면 아래 합치기는 돌지 않는다)
        await client.query(MARK_SEASON, [this.currentSeason, Date.now()]);
        // 기록을 불러오기 전에 합친다 (같은 트랜잭션: 합치지 못하면 준비도 실패하고, 다음 호출이 다시 한다)
        if (this.currentSeason === 0) {
          await client.query(`SET LOCAL lock_timeout = ${MIGRATE_LOCK_TIMEOUT_MS}`);
          const moved = await client.query(FOLD_INTO_SEASON_ZERO);
          if ((moved.rowCount ?? 0) > 0) console.log(`[leaderboard] 시즌 0: 예전 시즌의 기록 ${moved.rowCount}개를 시즌 0 으로 합쳤습니다 (지운 기록은 없습니다)`);
        }
      }
    });
  }

  /**
   * 작업 하나를 트랜잭션 하나로 실행한다. 시간 제한은 이 트랜잭션에만 건다 (SET LOCAL):
   * 직접 주소에서도, 트랜잭션 단위로 연결을 나눠 쓰는 풀러 뒤에서도 똑같이 적용된다.
   */
  private async tx<T>(work: (client: pg.PoolClient) => Promise<T>, snapshot = false): Promise<T> {
    const client = await this.pool.connect();
    try {
      // snapshot: 여러 문장이 한 시점의 데이터를 읽어야 할 때 (트랜잭션 단위라 연결 풀러 뒤에서도 된다)
      await client.query(snapshot ? this.begin.replace('BEGIN;', 'BEGIN ISOLATION LEVEL REPEATABLE READ;') : this.begin);
      const out = await work(client);
      await client.query('COMMIT');
      client.release();
      return out;
    } catch (err) {
      // 트랜잭션이 열린 채이거나 연결 자체가 망가졌을 수 있으니 풀에 돌려주지 않고 버린다 (끊기면 DB 가 알아서 되돌린다)
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
