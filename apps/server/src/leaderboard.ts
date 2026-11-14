import { LEADERBOARD_MIN_SECONDS, LEADERBOARD_SEASON, LEADERBOARD_SIZE, sanitizeName, type BoardId, type LeaderboardEntry } from '@friday-deploy/shared';

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
  names: string[];
  /** 생존 시간(초) */
  time: number;
  kills: number;
  level: number;
  /** 일시정지로 멈춰 있던 시간(초). 순위에는 쓰지 않지만 기록으로 남긴다 */
  pausedSeconds: number;
  /** epoch ms */
  endedAt: number;
}

/** Room 이 판이 끝났을 때 넘기는 내용 (시즌은 리더보드가 붙인다) */
export type RunReport = Omit<RunRecord, 'season'>;

export interface LeaderboardStore {
  /** false 면 프로세스가 끝날 때 기록이 사라진다 */
  readonly persistent: boolean;
  /** 해당 순위표·시즌의 상위 기록 (최대 limit 개). 정렬 기준은 compareRuns 와 같아야 한다 */
  load(board: BoardId, season: number, limit: number): Promise<RunRecord[]>;
  /** 저장. 같은 id 가 이미 있으면 아무 일도 하지 않는다 (재시도해도 안전) */
  save(record: RunRecord): Promise<void>;
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
const RETRY_MS = [1_000, 5_000, 30_000, 120_000];

const int = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.floor(Number.isFinite(v) ? v : min)));

export class Leaderboard {
  private boards: Record<BoardId, RunRecord[]> = { solo: [], coop: [] };
  private views: Partial<Record<BoardId, LeaderboardEntry[]>> = {};
  private seen = new Set<string>();
  private pending: { record: RunRecord; attempt: number }[] = [];
  /** 지금 돌고 있는 저장 작업. 동시에 둘이 돌지 않게 하고, 종료할 때 이것을 기다린다 */
  private flushing: Promise<void> | null = null;
  private closed = false;
  private loaded = false;

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
    } catch (err) {
      console.error('[leaderboard] 기록을 불러오지 못했습니다. 30초 뒤 다시 시도합니다.', err);
      setTimeout(() => void this.init(), 30_000).unref();
    }
  }

  /**
   * 끝난 판을 기록한다. 순위표(상위 LEADERBOARD_SIZE)에 들면 그 순위(1부터)를, 아니면 null 을 돌려준다.
   * 동기 함수다: 순위는 메모리에서 바로 계산하고, 저장은 뒤에서 한다.
   */
  record(report: RunReport): number | null {
    const names = report.names.map((n) => sanitizeName(n)).slice(0, 8);
    if (names.length === 0 || !BOARDS.includes(report.board)) return null;
    const record: RunRecord = {
      id: String(report.id).slice(0, 80),
      board: report.board,
      season: this.season,
      names,
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
    return index < LEADERBOARD_SIZE ? index + 1 : null;
  }

  top(board: BoardId): LeaderboardEntry[] {
    let view = this.views[board];
    if (!view) {
      view = this.boards[board].slice(0, LEADERBOARD_SIZE).map((r, i) => ({ rank: i + 1, names: r.names, time: r.time, kills: r.kills, level: r.level, at: r.endedAt }));
      this.views[board] = view;
    }
    return view;
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
    const deadline = Date.now() + timeoutMs;
    while (this.pending.length > 0 && Date.now() < deadline) {
      await Promise.race([this.flush(), new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
      if (this.pending.length > 0) await new Promise((r) => setTimeout(r, 100));
    }
    this.closed = true;
    await this.store.close();
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
    this.seen.add(record.id);
    if (list.length > KEEP) this.seen.delete(list.pop()!.id);
    delete this.views[record.board];
    return lo;
  }

  private persist(record: RunRecord): void {
    if (this.pending.length >= MAX_PENDING) this.pending.shift();
    this.pending.push({ record, attempt: 0 });
    void this.flush();
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
        setTimeout(() => void this.flush(), wait).unref();
        return;
      }
    }
  }

  /** 저장소를 아직 읽지 못했는지 (읽기 전에 기록된 판도 메모리에는 들어간다) */
  get ready(): boolean {
    return this.loaded;
  }
}
