import {
  LEADERBOARD_MIN_SECONDS,
  LEADERBOARD_SEASON,
  LEADERBOARD_SIZE,
  ownedUpgrades,
  sanitizeName,
  type BoardId,
  type LeaderboardEntry,
  type LeaderboardItem,
  type UpgradeId,
  type UpgradeTally,
} from '@friday-deploy/shared';

/**
 * 리더보드.
 *
 * 기록은 판이 끝날 때 서버(Room)가 직접 넣는다. 클라이언트가 점수를 제출하는 요청은 존재하지 않으므로
 * 점수를 위조해 올릴 방법이 없다. 순위 계산과 조회는 메모리의 정렬된 목록으로 하고(게임 루프를 막지 않는다),
 * 저장소(DB)에는 뒤에서 따로 쓴다. 저장소가 느리거나 죽어도 게임과 순위 조회는 계속된다.
 */

export interface RunRecord {
  /** 같은 판을 두 번 저장하지 않기 위한 고유 키 */
  id: string;
  board: BoardId;
  season: number;
  /** 기여도(개인 처치 수)가 큰 사람부터 */
  names: string[];
  /** names 와 같은 순서의 개인별 처치 수. 이 값을 남기기 전의 기록에는 없다 */
  killsBy?: number[];
  /** names 와 같은 순서의 개인별 아이템(무기·패시브와 단계). 판이 끝날 때 가지고 있던 것. 이 값을 남기기 전의 기록에는 없다 */
  itemsBy?: LeaderboardItem[][];
  /** 생존 시간(초) */
  time: number;
  /** 이름이 오른 사람들의 처치 수 합 */
  kills: number;
  level: number;
  /** 일시정지로 멈춰 있던 시간(초). 순위에는 쓰지 않지만 기록으로 남긴다 */
  pausedSeconds: number;
  /** epoch ms */
  endedAt: number;
}

/**
 * Room 이 판이 끝났을 때 넘기는 내용 (시즌은 리더보드가 붙인다).
 * tallies: names 와 같은 순서의 사람별 횟수 (아이템 통계용. 리더보드에는 남기지 않는다)
 */
export type RunReport = Omit<RunRecord, 'season'> & { tallies?: UpgradeTally[] };

/** 아이템 하나의 누적 횟수 (아이템 통계. 시즌마다) */
export interface UpgradeCounts {
  offered: number;
  picked: number;
  autoPicked: number;
  chest: number;
  /** 판이 끝날 때 가지고 있던 판 수 */
  finalOwned: number;
  /** 가지고 있던 판들의 끝날 때 단계의 합 (평균 = finalLevelSum / finalOwned) */
  finalLevelSum: number;
}

/** 한 시즌의 아이템 통계 (저장소에 쌓는 합계, 또는 거기에 더할 몫) */
export interface StoredStats {
  /** 센 판 수 (사람마다) */
  runs: number;
  /** 세기 시작한 때 (epoch ms). 아직 없으면 null */
  since: number | null;
  upgrades: Partial<Record<UpgradeId, UpgradeCounts>>;
}

export const emptyStats = (): StoredStats => ({ runs: 0, since: null, upgrades: {} });
export const emptyCounts = (): UpgradeCounts => ({ offered: 0, picked: 0, autoPicked: 0, chest: 0, finalOwned: 0, finalLevelSum: 0 });

/** a 에 b 를 더한다 (a 를 바꾼다) */
export function addStatsInto(a: StoredStats, b: StoredStats): StoredStats {
  a.runs += b.runs;
  if (b.since !== null) a.since = a.since === null ? b.since : Math.min(a.since, b.since);
  for (const [id, c] of Object.entries(b.upgrades) as [UpgradeId, UpgradeCounts][]) {
    const t = (a.upgrades[id] ??= emptyCounts());
    t.offered += c.offered;
    t.picked += c.picked;
    t.autoPicked += c.autoPicked;
    t.chest += c.chest;
    t.finalOwned += c.finalOwned;
    t.finalLevelSum += c.finalLevelSum;
  }
  return a;
}

/**
 * 기록한 판의 순위.
 * - 숫자: 순위표(상위 LEADERBOARD_SIZE)에 든 순위 (1부터)
 * - null: 순위표 밖이거나 기록 대상이 아님
 * - 'pending': 기록은 받았지만, 저장된 기록을 아직 불러오지 못해서 순위를 말할 수 없음
 *   (이때 메모리의 목록은 일부뿐이라, 거기서 센 순위를 알려주면 나중에 내려가거나 사라진다)
 */
export type RunPlacement = number | 'pending' | null;

export interface LeaderboardStore {
  /** false 면 프로세스가 끝날 때 기록이 사라진다 */
  readonly persistent: boolean;
  /** 해당 순위표·시즌의 상위 기록 (최대 limit 개). 정렬 기준은 compareRuns 와 같아야 한다 */
  load(board: BoardId, season: number, limit: number): Promise<RunRecord[]>;
  /** 저장. 같은 id 가 이미 있으면 아무 일도 하지 않는다 (재시도해도 안전) */
  save(record: RunRecord): Promise<void>;
  /** 기록이나 아이템 통계가 있는 시즌들 */
  seasons(): Promise<number[]>;
  /** 한 시즌의 아이템 통계 합계 */
  loadStats(season: number): Promise<StoredStats>;
  /**
   * 한 시즌의 아이템 통계에 더한다. batch 는 묶음마다 다른 id 로, 같은 id 로 다시 보내면 두 번 더하지 않는다
   * (확인 응답만 잃은 경우: 실패로 보였지만 실제로는 더해졌을 수 있다)
   */
  addStats(season: number, delta: StoredStats, batch: string): Promise<void>;
  close(): Promise<void>;
}

export class MemoryStore implements LeaderboardStore {
  readonly persistent = false;
  private rows = new Map<string, RunRecord>();

  async load(board: BoardId, season: number, limit: number): Promise<RunRecord[]> {
    return [...this.rows.values()].filter((r) => r.board === board && r.season === season).sort(compareRuns).slice(0, limit);
  }
  async save(record: RunRecord): Promise<void> {
    if (!this.rows.has(record.id)) this.rows.set(record.id, record);
  }
  private stats = new Map<number, StoredStats>();
  /** 최근에 더한 묶음 id (메모리 저장소는 더한 뒤에 실패할 일이 없어 오래 기억할 필요가 없다: 최근 것만) */
  private batches = new Set<string>();
  async seasons(): Promise<number[]> {
    return [...new Set([...[...this.rows.values()].map((r) => r.season), ...this.stats.keys()])].sort((a, b) => a - b);
  }
  async loadStats(season: number): Promise<StoredStats> {
    return addStatsInto(emptyStats(), this.stats.get(season) ?? emptyStats());
  }
  async addStats(season: number, delta: StoredStats, batch: string): Promise<void> {
    if (this.batches.has(batch)) return;
    this.batches.add(batch);
    if (this.batches.size > 1000) this.batches.delete(this.batches.values().next().value!);
    if (!this.stats.has(season)) this.stats.set(season, emptyStats());
    addStatsInto(this.stats.get(season)!, delta);
  }
  async close(): Promise<void> {}
}

/** 순위: 오래 버틴 순 → 많이 잡은 순 → 레벨 높은 순 → 먼저 세운 기록 순 */
export function compareRuns(a: RunRecord, b: RunRecord): number {
  return b.time - a.time || b.kills - a.kills || b.level - a.level || a.endedAt - b.endedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const BOARDS: BoardId[] = ['solo', 'coop'];
/** 메모리에 들고 있는 기록 수 (보여주는 것보다 넉넉히: 동점·삭제 여유) */
const KEEP = LEADERBOARD_SIZE * 4;
const MAX_PENDING = 200;
/** 저장 실패 뒤 다시 시도하기까지의 간격. 다 합쳐 약 18분: DB 가 잠깐 안 되는 정도로는 기록을 버리지 않는다 */
const RETRY_MS = [1_000, 5_000, 30_000, 120_000, 300_000, 600_000];
/** 처음 불러오기에 실패했을 때 다시 시도하는 간격 (마지막 값을 반복). DB 가 깨어나는 중이면 금방 된다 */
const LOAD_RETRY_MS = [3_000, 10_000, 30_000];
/** 지난 시즌의 기록·시즌 목록을 메모리에 들고 있는 시간. 지난 시즌은 바뀌지 않으므로 넉넉히 (DB 를 덜 읽게) */
const PAST_CACHE_MS = 10 * 60_000;
/** 시즌 목록을 읽다 실패하면 이 시간 동안은 다시 묻지 않는다 (DB 가 죽어 있을 때 요청마다 두드리지 않게) */
const SEASONS_RETRY_MS = 30_000;
const MAX_PAST_CACHE = 16;

/** 기록 → 순위표 줄 */
function toEntries(rows: readonly RunRecord[]): LeaderboardEntry[] {
  return rows.slice(0, LEADERBOARD_SIZE).map((r, i) => ({
    rank: i + 1,
    names: r.names,
    ...(r.killsBy && r.killsBy.length === r.names.length ? { killsBy: r.killsBy } : {}),
    ...(r.itemsBy && r.itemsBy.length === r.names.length ? { itemsBy: r.itemsBy } : {}),
    time: r.time,
    kills: r.kills,
    level: r.level,
    at: r.endedAt,
  }));
}

const int = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.floor(Number.isFinite(v) ? v : min)));

export class Leaderboard {
  private boards: Record<BoardId, RunRecord[]> = { solo: [], coop: [] };
  private views: Partial<Record<BoardId, LeaderboardEntry[]>> = {};
  private seen = new Set<string>();
  private pending: { record: RunRecord; attempt: number }[] = [];
  /** 지금 돌고 있는 저장 작업. 동시에 둘이 돌지 않게 하고, 종료할 때 이것을 기다린다 */
  private flushing: Promise<void> | null = null;
  /** 저장이 실패해 다음 재시도를 기다리는 중인지. 그동안에는 새 기록이 들어와도 저장소를 건드리지 않는다 */
  private resting = false;
  private closed = false;
  private loaded = false;
  private loadAttempt = 0;
  /** 지난 시즌 기록 (순위표·시즌 → 읽기 시작한 때와 읽는 중이거나 읽은 기록). 같은 것을 동시에 여러 번 읽지 않는다 */
  private past = new Map<string, { at: number; rows: Promise<RunRecord[]> }>();
  /** 마지막으로 읽은 시즌 목록과 그때, 마지막으로 실패한 때, 지금 읽는 중인 것 (한 번에 하나만 읽는다) */
  private seasonList: number[] | null = null;
  private seasonsAt = 0;
  private seasonsFailedAt = -Infinity;
  private seasonsLoading: Promise<number[] | null> | null = null;
  private rev = 0;

  constructor(
    private readonly store: LeaderboardStore,
    readonly season: number = LEADERBOARD_SEASON,
  ) {}

  get persistent(): boolean {
    return this.store.persistent;
  }

  /**
   * 저장소에서 기존 기록을 읽어 온다. 실패해도 예외를 던지지 않고 뒤에서 다시 시도한다
   * (DB 가 잠깐 안 되는 것 때문에 게임 서버가 뜨지 못하면 안 된다).
   */
  async init(): Promise<void> {
    try {
      for (const board of BOARDS) {
        const rows = await this.store.load(board, this.season, KEEP);
        for (const r of rows) this.insert(r);
      }
      this.loaded = true;
      // 시즌 목록도 미리 읽어 둔다 (첫 요청이 기다리지 않게)
      void this.refreshSeasons();
    } catch (err) {
      if (this.closed) return;
      const wait = LOAD_RETRY_MS[Math.min(this.loadAttempt++, LOAD_RETRY_MS.length - 1)]!;
      console.error(`[leaderboard] 기록을 불러오지 못했습니다. ${wait / 1000}초 뒤 다시 시도합니다.`, err);
      setTimeout(() => void this.init(), wait).unref();
    }
  }

  /**
   * 끝난 판을 기록한다. 순위표(상위 LEADERBOARD_SIZE)에 들면 그 순위(1부터)를, 아니면 null 을 돌려준다.
   * 저장된 기록을 아직 불러오지 못했으면 기록만 받아 두고 'pending' 을 돌려준다.
   * 동기 함수다: 순위는 메모리에서 바로 계산하고, 저장은 뒤에서 한다.
   */
  record(report: RunReport): RunPlacement {
    if (!Array.isArray(report.names) || !BOARDS.includes(report.board)) return null;
    // 기여도(개인 처치 수)가 큰 사람부터 적는다. 같으면 넘겨받은 순서(들어온 순서)를 지킨다.
    const hasKills = Array.isArray(report.killsBy) && report.killsBy.length === report.names.length;
    const hasItems = Array.isArray(report.itemsBy) && report.itemsBy.length === report.names.length;
    const members = report.names.slice(0, 8).map((n, i) => ({
      name: sanitizeName(n),
      kills: hasKills ? int(report.killsBy![i]!, 0, 10_000_000) : 0,
      items: hasItems ? (ownedUpgrades(report.itemsBy![i]) ?? []) : [],
    }));
    // 정렬해도 이름·처치 수·아이템이 한 사람 단위로 함께 움직인다
    if (hasKills) members.sort((a, b) => b.kills - a.kills);
    const names = members.map((m) => m.name);
    if (names.length === 0) return null;
    const record: RunRecord = {
      id: String(report.id).slice(0, 80),
      board: report.board,
      season: this.season,
      names,
      ...(hasKills ? { killsBy: members.map((m) => m.kills) } : {}),
      ...(hasItems ? { itemsBy: members.map((m) => m.items) } : {}),
      time: int(report.time, 0, 24 * 3600),
      kills: int(report.kills, 0, 10_000_000),
      level: int(report.level, 1, 10_000),
      pausedSeconds: int(report.pausedSeconds, 0, 24 * 3600),
      endedAt: int(report.endedAt, 0, Number.MAX_SAFE_INTEGER),
    };
    if (record.time < LEADERBOARD_MIN_SECONDS || this.seen.has(record.id)) return null;
    const index = this.insert(record);
    if (index === null) return null;
    this.persist(record);
    if (!this.ready) return 'pending';
    return index < LEADERBOARD_SIZE ? index + 1 : null;
  }

  top(board: BoardId): LeaderboardEntry[] {
    let view = this.views[board];
    if (!view) {
      view = toEntries(this.boards[board]);
      this.views[board] = view;
    }
    return view;
  }

  /**
   * 한 시즌의 기록 (메모리에 들고 있는 만큼: 상위 KEEP 개). 지금 시즌은 메모리에서 바로,
   * 지난 시즌은 저장소에서 읽어 잠시 들고 있는다 (지난 시즌에는 기록이 더 쌓이지 않는다).
   */
  async records(board: BoardId, season: number): Promise<readonly RunRecord[]> {
    if (season === this.season) return this.boards[board];
    const key = `${board}:${season}`;
    const hit = this.past.get(key);
    if (hit && Date.now() - hit.at < PAST_CACHE_MS) return hit.rows;
    const rows = this.store.load(board, season, KEEP);
    if (this.past.size >= MAX_PAST_CACHE) this.past.delete(this.past.keys().next().value!);
    const entry = { at: Date.now(), rows };
    this.past.set(key, entry);
    // 실패한 읽기는 기억하지 않는다 (다음 요청이 다시 읽는다)
    rows.catch(() => {
      if (this.past.get(key) === entry) this.past.delete(key);
    });
    return rows;
  }

  /** 한 시즌의 순위표 */
  async view(board: BoardId, season: number): Promise<LeaderboardEntry[]> {
    return season === this.season ? this.top(board) : toEntries(await this.records(board, season));
  }

  /** 지금 시즌의 기록이 바뀔 때마다 오르는 번호 (기록으로 계산한 값을 들고 있다가 바뀌었는지 볼 때) */
  get revision(): number {
    return this.rev;
  }

  /**
   * 지금 아는 시즌 목록 (기록이나 통계가 있는 시즌들, 지금 시즌은 늘 들어 있다). 저장소를 기다리지 않는다:
   * 지금 시즌의 순위표는 DB 가 느리거나 죽어 있어도 바로 답해야 한다. 아직 모르면 지금 시즌만. 오래됐으면 뒤에서 다시 읽는다.
   */
  knownSeasons(): number[] {
    if (!this.seasonList || Date.now() - this.seasonsAt >= PAST_CACHE_MS) void this.refreshSeasons();
    return this.seasonList ?? [this.season];
  }

  /**
   * 확인된 시즌 목록 (지난 시즌을 물을 때: 없는 시즌인지 가려야 한다). 오래됐으면 다시 읽고 기다린다.
   * 다시 읽지 못하면 마지막으로 읽은 목록을 쓰고, 한 번도 읽지 못했으면 null (저장소를 못 읽음: 없는 시즌이라고 말하지 않는다)
   */
  async seasons(): Promise<number[] | null> {
    if (this.seasonList && Date.now() - this.seasonsAt < PAST_CACHE_MS) return this.seasonList;
    return this.refreshSeasons();
  }

  /** 시즌 목록을 읽는다. 읽는 중이면 그것을 기다리고, 방금 실패했으면 다시 묻지 않는다 */
  private refreshSeasons(): Promise<number[] | null> {
    if (this.seasonsLoading) return this.seasonsLoading;
    if (this.closed || Date.now() - this.seasonsFailedAt < SEASONS_RETRY_MS) return Promise.resolve(this.seasonList);
    const loading = this.store.seasons().then(
      (list) => {
        this.seasonList = [...new Set([...list, this.season])].sort((a, b) => a - b);
        this.seasonsAt = Date.now();
        return this.seasonList;
      },
      (err) => {
        this.seasonsFailedAt = Date.now();
        console.error('[leaderboard] 시즌 목록을 읽지 못했습니다', err instanceof Error ? err.message : err);
        return this.seasonList;
      },
    );
    this.seasonsLoading = loading.finally(() => {
      this.seasonsLoading = null;
    });
    return this.seasonsLoading;
  }

  /** 아직 저장소에 쓰지 못한 기록 수 (종료 처리·테스트용) */
  get unsaved(): number {
    return this.pending.length;
  }

  /**
   * 아직 저장하지 못한 기록을 마저 쓰고 저장소를 닫는다 (배포·재시작 때).
   * 이미 돌고 있는 저장 작업이 있으면 그것이 끝나기를 기다린다. timeoutMs 안에 못 쓴 기록은 포기한다.
   */
  async close(timeoutMs = 2500): Promise<void> {
    await this.flushAll(timeoutMs);
    this.closed = true;
    await this.store.close();
  }

  /** 아직 저장하지 못한 기록을 timeoutMs 안에서 마저 쓴다 (저장소는 닫지 않는다: 같은 저장소를 쓰는 통계도 마저 쓸 수 있게) */
  async flushAll(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    this.resting = false;
    while (this.pending.length > 0 && Date.now() < deadline) {
      await Promise.race([this.flush(), new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
      if (this.pending.length > 0) await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** 정렬된 자리에 넣는다. 들어간 위치(0부터)를 돌려주고, 보관 범위 밖이면 null */
  private insert(record: RunRecord): number | null {
    if (this.seen.has(record.id)) return null;
    const list = this.boards[record.board];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareRuns(list[mid]!, record) <= 0) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= KEEP) return null;
    list.splice(lo, 0, record);
    this.rev++;
    this.seen.add(record.id);
    if (list.length > KEEP) this.seen.delete(list.pop()!.id);
    delete this.views[record.board];
    return lo;
  }

  private persist(record: RunRecord): void {
    if (this.pending.length >= MAX_PENDING) {
      const dropped = this.pending.shift()!;
      console.error('[leaderboard] 저장 대기열이 가득 차 가장 오래된 기록의 저장을 포기합니다.', dropped.record.id);
    }
    this.pending.push({ record, attempt: 0 });
    // 저장이 실패해 쉬는 중이면 예약된 재시도가 이 기록까지 함께 처리한다.
    // (여기서 바로 다시 시도하면 판이 끝날 때마다 맨 앞 기록의 재시도 횟수만 써 버려, 잠깐의 장애에도 기록을 버리게 된다)
    if (!this.resting) void this.flush();
  }

  /** 밀린 기록을 저장한다. 이미 돌고 있으면 그 작업을 돌려준다 (호출한 쪽이 끝을 기다릴 수 있게) */
  private flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.flushing) {
      this.flushing = this.drain().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  /** 순서대로 저장한다. 실패하면 간격을 늘려 가며 다시 시도하고, 끝내 안 되면 그 기록의 저장만 포기한다 */
  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const job = this.pending[0]!;
      try {
        await this.store.save(job.record);
        this.pending.shift();
      } catch (err) {
        const wait = RETRY_MS[job.attempt++];
        if (wait === undefined) {
          console.error('[leaderboard] 기록 저장을 포기합니다 (순위표에는 서버가 다시 시작될 때까지 남습니다).', job.record.id, err);
          this.pending.shift();
          continue;
        }
        console.error(`[leaderboard] 기록 저장 실패, ${wait / 1000}초 뒤 재시도`, job.record.id, err);
        this.resting = true;
        setTimeout(() => {
          this.resting = false;
          void this.flush();
        }, wait).unref();
        return;
      }
    }
  }

  /**
   * 순위를 말할 수 있는 상태인지: 저장된 기록을 다 불러왔거나, 불러올 것이 없는 저장소(메모리)다.
   * false 인 동안에도 판은 기록된다 (메모리에 넣고 저장을 시도한다). 순위만 알려주지 않는다.
   */
  get ready(): boolean {
    return this.loaded || !this.store.persistent;
  }
}
