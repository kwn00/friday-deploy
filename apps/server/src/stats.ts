import {
  LEADERBOARD_MIN_SECONDS,
  LEADERBOARD_SEASON,
  UPGRADES,
  UPGRADE_IDS,
  ownedUpgrades,
  type BoardId,
  type TopRunUpgrade,
  type UpgradeId,
  type UpgradeStat,
  type UpgradeStatsResponse,
} from '@friday-deploy/shared';
import { addStatsInto, emptyCounts, emptyStats, type Leaderboard, type LeaderboardStore, type RunReport, type StoredStats } from './leaderboard';

/**
 * 아이템 통계: 시즌마다 무기·패시브가 선택지에 몇 번 나왔고, 몇 번 골라졌고, 판이 끝날 때 얼마나 가지고 있었는지.
 *
 * - 서버가 직접 센다: 선택지를 만들고, 고르고, 시간이 지나 대신 고르고, 보물상자를 여는 것은 모두 서버의 시뮬레이션이 한다
 *   (sim.ts 의 tally). 클라이언트가 보내는 것은 "몇 번째를 골랐다"뿐이라 숫자를 위조할 수 없다.
 * - 리더보드와 같은 판만 센다: 30초 이상 버틴 판에서 처음부터 함께 한 사람 (Room 이 리더보드에 넘기는 사람들).
 * - 이름·IP 같은 개인 정보는 남기지 않고 합계만 쌓는다. 리더보드 기록은 건드리지 않는다 (다른 표에 쌓는다).
 * - 지금 시즌의 합계는 메모리에 들고 있고(응답할 때 DB 를 읽지 않는다), 판이 끝날 때마다 늘어난 몫을 뒤에서 저장소에 더한다.
 *   저장이 실패하면 몫을 모아 두었다가 간격을 늘려 가며 다시 더한다. 지난 시즌은 읽기만 한다.
 */

/** 저장 실패 뒤 다시 시도하기까지의 간격 (마지막 값을 반복한다: 몫은 계속 모아 두므로 버리지 않는다) */
const RETRY_MS = [1_000, 5_000, 30_000, 120_000, 300_000];
/** 처음 불러오기에 실패했을 때 다시 시도하는 간격 (마지막 값을 반복) */
const LOAD_RETRY_MS = [3_000, 10_000, 30_000];
/** 지난 시즌 통계를 메모리에 들고 있는 시간 */
const PAST_CACHE_MS = 10 * 60_000;
const MAX_PAST_CACHE = 8;
/** 같은 판을 두 번 세지 않기 위해 기억하는 판 수 */
const SEEN_MAX = 1000;

const round = (v: number, digits: number): number => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};
/** 셀 수 있는 횟수로만 (서버 안의 값이지만, 이상한 값이 합계를 망가뜨리지 않게) */
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 1_000_000) : 0);

/** 끝난 판 하나를 통계의 몫으로. 셀 대상이 아니면 null */
export function statsOfRun(report: RunReport, at: number): StoredStats | null {
  if (!(report.time >= LEADERBOARD_MIN_SECONDS)) return null;
  const tallies = Array.isArray(report.tallies) ? report.tallies : [];
  const items = Array.isArray(report.itemsBy) ? report.itemsBy : [];
  const members = Array.isArray(report.names) ? report.names.length : 0;
  // 사람마다 횟수와 끝날 때 아이템이 함께 있어야 한다 (Room 이 같은 순서로 넘긴다)
  if (members === 0 || tallies.length !== members || items.length !== members) return null;
  const out = emptyStats();
  out.runs = members;
  out.since = at;
  const add = (id: UpgradeId, field: 'offered' | 'picked' | 'autoPicked' | 'chest', n: number): void => {
    if (n <= 0) return;
    (out.upgrades[id] ??= emptyCounts())[field] += n;
  };
  for (let i = 0; i < members; i++) {
    const t = tallies[i];
    for (const id of UPGRADE_IDS) {
      add(id, 'offered', count(t?.offered?.[id]));
      add(id, 'picked', count(t?.picked?.[id]));
      add(id, 'autoPicked', count(t?.auto?.[id]));
      add(id, 'chest', count(t?.chest?.[id]));
    }
    // 끝날 때 가진 것: 아는 아이템·범위 안의 단계만 (리더보드와 같은 규칙)
    for (const it of ownedUpgrades(items[i]) ?? []) {
      const c = (out.upgrades[it.id] ??= emptyCounts());
      c.finalOwned += 1;
      c.finalLevelSum += it.level;
    }
  }
  return out;
}

/** YYYY-MM-DD (UTC) */
const day = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString().slice(0, 10));

export type StatsKind = 'weapon' | 'passive' | null;

/** 합계 → 응답의 아이템 목록 (모든 아이템, 선택률 높은 순 → 많이 나온 순 → 원래 순서) */
export function upgradeList(stats: StoredStats, kind: StatsKind): UpgradeStat[] {
  return UPGRADE_IDS.filter((id) => kind === null || UPGRADES[id].kind === kind)
    .map((id, order) => {
      const c = stats.upgrades[id] ?? emptyCounts();
      const def = UPGRADES[id];
      return {
        order,
        stat: {
          id,
          name: def.name,
          icon: def.icon,
          kind: def.kind,
          offered: c.offered,
          picked: c.picked,
          autoPicked: c.autoPicked,
          pickRate: c.offered > 0 ? round(Math.min(1, (c.picked + c.autoPicked) / c.offered), 3) : 0,
          chest: c.chest,
          finalOwnedRate: stats.runs > 0 ? round(Math.min(1, c.finalOwned / stats.runs), 3) : 0,
          avgFinalLevel: c.finalOwned > 0 ? round(c.finalLevelSum / c.finalOwned, 2) : 0,
        } satisfies UpgradeStat,
      };
    })
    .sort((a, b) => b.stat.pickRate - a.stat.pickRate || b.stat.offered - a.stat.offered || a.order - b.order)
    .map((x) => x.stat);
}

/** 순위 기록(끝날 때 가진 아이템)에서: 사람마다 하나로 센다. 아이템을 남기기 전의 기록은 빠진다 */
export function topRunsOf(records: readonly { names: string[]; itemsBy?: unknown[] }[], kind: StatsKind): UpgradeStatsResponse['topRuns'] {
  let runs = 0;
  const owned = new Map<UpgradeId, { n: number; levels: number }>();
  for (const r of records) {
    if (!Array.isArray(r.itemsBy) || r.itemsBy.length !== r.names.length) continue;
    for (const list of r.itemsBy) {
      runs++;
      for (const it of ownedUpgrades(list) ?? []) {
        const o = owned.get(it.id) ?? { n: 0, levels: 0 };
        o.n++;
        o.levels += it.level;
        owned.set(it.id, o);
      }
    }
  }
  const list: TopRunUpgrade[] = [...owned]
    .filter(([id]) => kind === null || UPGRADES[id].kind === kind)
    .map(([id, o]) => ({ id, rate: round(o.n / runs, 3), avgLevel: round(o.levels / o.n, 2) }))
    .sort((a, b) => b.rate - a.rate || b.avgLevel - a.avgLevel || UPGRADE_IDS.indexOf(a.id) - UPGRADE_IDS.indexOf(b.id));
  return { runs, owned: list };
}

export class UpgradeStats {
  /** 지금 시즌의 합계: 저장소에서 불러온 것 + 이 서버가 뜬 뒤에 센 것 */
  private totals = emptyStats();
  /** 아직 저장소에 더하지 못한 몫 */
  private pending = emptyStats();
  private flushing: Promise<void> | null = null;
  private resting = false;
  private attempt = 0;
  private loaded = false;
  private loadAttempt = 0;
  private closed = false;
  private seen = new Set<string>();
  private past = new Map<number, { at: number; stats: Promise<StoredStats> }>();

  constructor(
    private readonly store: LeaderboardStore,
    readonly season: number = LEADERBOARD_SEASON,
    private readonly now: () => number = Date.now,
  ) {}

  get persistent(): boolean {
    return this.store.persistent;
  }

  /** 저장된 합계를 다 불러왔는지 (false 면 지금 시즌의 숫자는 이 서버가 뜬 뒤의 것뿐이다) */
  get ready(): boolean {
    return this.loaded;
  }

  /** 아직 저장소에 더하지 못한 판 수 (종료 처리·테스트용) */
  get unsaved(): number {
    return this.pending.runs;
  }

  /** 저장된 합계를 불러온다. 실패해도 예외를 던지지 않고 뒤에서 다시 시도한다 (그동안 센 것은 모아 둔다) */
  async init(): Promise<void> {
    try {
      const base = await this.store.loadStats(this.season);
      addStatsInto(this.totals, base);
      this.loaded = true;
      // 불러오기 전에 센 몫은 아직 저장소에 없다: 이제 더한다 (불러오기 전에는 더하지 않는다. 두 번 세지 않게)
      if (this.pending.runs > 0) void this.flush();
    } catch (err) {
      if (this.closed) return;
      const wait = LOAD_RETRY_MS[Math.min(this.loadAttempt++, LOAD_RETRY_MS.length - 1)]!;
      console.error(`[stats] 아이템 통계를 불러오지 못했습니다. ${wait / 1000}초 뒤 다시 시도합니다.`, err instanceof Error ? err.message : err);
      setTimeout(() => void this.init(), wait).unref();
    }
  }

  /** 끝난 판을 센다. 예외를 던지지 않는다 (리더보드 기록을 방해하지 않게) */
  record(report: RunReport): void {
    try {
      const id = String(report.id);
      if (this.closed || this.seen.has(id)) return;
      const delta = statsOfRun(report, this.now());
      if (!delta) return;
      this.seen.add(id);
      if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value!);
      addStatsInto(this.totals, delta);
      addStatsInto(this.pending, delta);
      if (!this.resting) void this.flush();
    } catch (err) {
      console.error('[stats] 판을 세지 못했습니다', err);
    }
  }

  /** 모아 둔 몫을 저장소에 더한다. 이미 돌고 있으면 그 작업을 돌려준다 */
  private flush(): Promise<void> {
    if (this.closed || !this.loaded) return Promise.resolve();
    if (!this.flushing) {
      this.flushing = this.drain().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.pending.runs > 0) {
      const delta = this.pending;
      this.pending = emptyStats();
      try {
        await this.store.addStats(this.season, delta);
        this.attempt = 0;
      } catch (err) {
        // 더하기는 한 트랜잭션이라 실패하면 아무것도 더해지지 않았다: 몫을 되돌려 놓고 나중에 다시
        addStatsInto(this.pending, delta);
        if (this.closed) return;
        const wait = RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)]!;
        console.error(`[stats] 아이템 통계 저장 실패, ${wait / 1000}초 뒤 재시도 (모아 둔 판 ${this.pending.runs}개)`, err instanceof Error ? err.message : err);
        this.resting = true;
        setTimeout(() => {
          this.resting = false;
          void this.flush();
        }, wait).unref();
        return;
      }
    }
  }

  /** 한 시즌의 합계. 지금 시즌은 메모리에서, 지난 시즌은 저장소에서 읽어 잠시 들고 있는다 */
  async statsOf(season: number): Promise<StoredStats> {
    if (season === this.season) return this.totals;
    const hit = this.past.get(season);
    if (hit && this.now() - hit.at < PAST_CACHE_MS) return hit.stats;
    const stats = this.store.loadStats(season);
    if (this.past.size >= MAX_PAST_CACHE) this.past.delete(this.past.keys().next().value!);
    const entry = { at: this.now(), stats };
    this.past.set(season, entry);
    stats.catch(() => {
      if (this.past.get(season) === entry) this.past.delete(season);
    });
    return stats;
  }

  /**
   * GET /api/stats/upgrades 의 응답. seasons 는 기록이나 통계가 있는 시즌들이고, season 은 그 안의 것이어야 한다
   * (호출하는 쪽이 확인한다: 없는 시즌으로 저장소를 두드리지 않게).
   */
  async response(season: number, kind: StatsKind, seasons: number[], leaderboard: Pick<Leaderboard, 'records'>): Promise<UpgradeStatsResponse> {
    const stats = await this.statsOf(season);
    const boards: BoardId[] = ['solo', 'coop'];
    const records = (await Promise.all(boards.map((b) => leaderboard.records(b, season)))).flat();
    return {
      season,
      current: this.season,
      seasons,
      since: day(stats.since),
      runs: stats.runs,
      persistent: this.persistent,
      loading: season === this.season && !this.loaded,
      upgrades: upgradeList(stats, kind),
      topRuns: topRunsOf(records, kind),
    };
  }

  /** 모아 둔 몫을 마저 더한다 (배포·재시작 때). timeoutMs 안에 못 더한 몫은 포기한다 */
  async close(timeoutMs = 2000): Promise<void> {
    const deadline = this.now() + timeoutMs;
    if (this.loaded && this.pending.runs > 0) {
      this.resting = false;
      await Promise.race([this.flush(), new Promise((r) => setTimeout(r, Math.max(0, deadline - this.now())))]);
    }
    if (this.pending.runs > 0) console.error(`[stats] 종료: 판 ${this.pending.runs}개의 통계를 저장하지 못했습니다`);
    this.closed = true;
  }
}
