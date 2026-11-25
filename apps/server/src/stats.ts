import { randomUUID } from 'node:crypto';
import {
  APP_VERSION,
  LEADERBOARD_MIN_SECONDS,
  compareVersions,
  evolutionOf,
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
import {
  addStatsInto,
  copyStatsByVersion,
  emptyCounts,
  emptyStats,
  sumStats,
  type Leaderboard,
  type LeaderboardStore,
  type RunReport,
  type StatsByVersion,
  type StoredStats,
} from './leaderboard';

/**
 * 아이템 통계: 시즌마다 무기·패시브가 선택지에 몇 번 나왔고, 몇 번 골라졌고, 판이 끝날 때 얼마나 가지고 있었는지.
 *
 * - 서버가 직접 센다: 선택지를 만들고, 고르고, 시간이 지나 대신 고르고, 보물상자를 여는 것은 모두 서버의 시뮬레이션이 한다
 *   (sim.ts 의 tally). 클라이언트가 보내는 것은 "몇 번째를 골랐다"뿐이라 숫자를 위조할 수 없다.
 *   시작 무기(started)도 서버가 판을 시작할 때 센다. 클라이언트는 허용 목록의 번호만 보낸다.
 * - 리더보드와 같은 판만 센다: 30초 이상 버틴 판에서 처음부터 함께 한 사람 (Room 이 리더보드에 넘기는 사람들).
 * - 이름·IP 같은 개인 정보는 남기지 않고 합계만 쌓는다. 리더보드 기록은 건드리지 않는다 (다른 표에 쌓는다).
 * - 시즌·게임 버전(x.y.z)별로 쌓는다: 같은 시즌 안에서도 밸런스 패치 전후를 나눠 볼 수 있다. 버전을 고르지 않으면 시즌 전체.
 * - 지금 시즌의 합계는 메모리에 들고 있고(응답할 때 DB 를 읽지 않는다), 판이 끝날 때마다 늘어난 몫을 뒤에서 저장소에 더한다.
 *   더하는 몫(묶음)마다 id 를 붙인다: 저장이 실패하면 같은 묶음을 같은 id 로 다시 보내므로, 실제로는 더해졌는데 확인 응답만
 *   잃은 경우에도 두 번 더해지지 않는다. 그동안 끝난 판은 다음 묶음에 모은다. 지난 시즌은 읽기만 한다.
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
  const add = (id: UpgradeId, field: 'offered' | 'picked' | 'autoPicked' | 'chest' | 'started', n: number): void => {
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
      // 시작 무기는 선택지에서 고른 것이 아니다: 따로 센다 (선택률이 부풀지 않게)
      add(id, 'started', count(t?.start?.[id]));
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

/** 순위 기록에서 topRuns 계산에 쓰는 부분 */
type RunRecordLike = { names: string[]; itemsBy?: unknown[]; version?: string };

/** YYYY-MM-DD (UTC) */
const day = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString().slice(0, 10));

export type StatsKind = 'weapon' | 'passive' | null;

/** 진화한 무기의 재료 (응답에 그대로 싣는다. 진화한 무기가 아니면 빈 객체) */
function evolveOf(id: UpgradeId): Pick<UpgradeStat, 'evolve'> {
  const e = evolutionOf(id);
  return e ? { evolve: { from: [...e.from], with: e.with } } : {};
}

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
          started: c.started,
          finalOwnedRate: stats.runs > 0 ? round(Math.min(1, c.finalOwned / stats.runs), 3) : 0,
          avgFinalLevel: c.finalOwned > 0 ? round(c.finalLevelSum / c.finalOwned, 2) : 0,
          ...evolveOf(id),
        } satisfies UpgradeStat,
      };
    })
    .sort((a, b) => b.stat.pickRate - a.stat.pickRate || b.stat.offered - a.stat.offered || a.order - b.order)
    .map((x) => x.stat);
}

/**
 * 순위 기록(끝날 때 가진 아이템)에서: 사람마다 하나로 센다. 아이템을 남기기 전의 기록은 빠진다.
 * version 을 주면 그 버전에서 세운 기록만 (버전을 남기기 전의 기록은 빠진다)
 */
export function topRunsOf(records: readonly RunRecordLike[], kind: StatsKind, version: string | null = null): UpgradeStatsResponse['topRuns'] {
  let runs = 0;
  const owned = new Map<UpgradeId, { n: number; levels: number }>();
  for (const r of records) {
    if (version !== null && r.version !== version) continue;
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

/** 순위 기록에서 계산한 값을 들고 있는다: 기록이 바뀔 때만 다시 계산한다 (요청마다 하면 무료 서버의 CPU 를 쓴다) */
interface TopRunsMemo {
  key: string;
  /** 지금 시즌: 리더보드의 기록 번호. 지난 시즌: 읽어 둔 기록 배열 자체 */
  rev: number;
  rows: readonly unknown[][];
  value: UpgradeStatsResponse['topRuns'];
}

/** 버전별 통계 → 응답의 버전 목록 (최신 버전부터). always 는 판이 없어도 넣는다 (지금 버전) */
export function versionList(byVersion: StatsByVersion, always: string | null): UpgradeStatsResponse['versions'] {
  const names = new Set(Object.keys(byVersion));
  if (always) names.add(always);
  return [...names]
    .sort((a, b) => compareVersions(b, a))
    .map((v) => ({ version: v, runs: byVersion[v]?.runs ?? 0, since: day(byVersion[v]?.since ?? null) }));
}

export class UpgradeStats {
  /** 지금 시즌의 버전별 합계: 저장소에서 불러온 것 + 이 서버가 뜬 뒤에 센 것 (이 서버가 세는 것은 this.version 뿐이다) */
  private totals: StatsByVersion = {};
  /** 아직 묶음에 넣지 않은 몫 */
  private pending = emptyStats();
  /** 보내는 중이거나, 보냈다가 실패해 같은 id 로 다시 보낼 묶음 */
  private batch: { id: string; delta: StoredStats } | null = null;
  private topMemo = new Map<string, TopRunsMemo>();
  private flushing: Promise<void> | null = null;
  private resting = false;
  private attempt = 0;
  private loaded = false;
  private loadAttempt = 0;
  private closed = false;
  private seen = new Set<string>();
  private past = new Map<number, { at: number; stats: Promise<StatsByVersion> }>();

  constructor(
    private readonly store: LeaderboardStore,
    readonly season: number = LEADERBOARD_SEASON,
    private readonly now: () => number = Date.now,
    /** 이 서버가 세는 판에 붙일 게임 버전 */
    readonly version: string = APP_VERSION,
  ) {}

  get persistent(): boolean {
    return this.store.persistent;
  }

  /** 저장된 합계를 다 불러왔는지 (false 면 지금 시즌의 숫자는 이 서버가 뜬 뒤의 것뿐이다) */
  get ready(): boolean {
    return this.loaded;
  }

  /** 아직 저장소에 더하지 못한 판 수: 보내는 중인 묶음 포함 (종료 처리·테스트용) */
  get unsaved(): number {
    return this.pending.runs + (this.batch?.delta.runs ?? 0);
  }

  /** 저장된 합계를 불러온다. 실패해도 예외를 던지지 않고 뒤에서 다시 시도한다 (그동안 센 것은 모아 둔다) */
  async init(): Promise<void> {
    try {
      const base = await this.store.loadStats(this.season);
      for (const [v, s] of Object.entries(base)) addStatsInto((this.totals[v] ??= emptyStats()), s);
      this.loaded = true;
      // 불러오기 전에 센 몫은 아직 저장소에 없다: 이제 더한다 (불러오기 전에는 더하지 않는다. 두 번 세지 않게)
      if (this.unsaved > 0) void this.flush();
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
      addStatsInto((this.totals[this.version] ??= emptyStats()), delta);
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
    while (this.batch || this.pending.runs > 0) {
      // 실패한 묶음이 있으면 그것을 그대로(같은 id 로) 먼저 다시 보낸다. 새로 끝난 판은 다음 묶음에 모인다
      if (!this.batch) {
        this.batch = { id: randomUUID(), delta: this.pending };
        this.pending = emptyStats();
      }
      const batch = this.batch;
      try {
        await this.store.addStats(this.season, this.version, batch.delta, batch.id);
        this.batch = null;
        this.attempt = 0;
      } catch (err) {
        if (this.closed) return;
        const wait = RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)]!;
        console.error(`[stats] 아이템 통계 저장 실패, ${wait / 1000}초 뒤 재시도 (판 ${this.unsaved}개)`, err instanceof Error ? err.message : err);
        this.resting = true;
        setTimeout(() => {
          this.resting = false;
          void this.flush();
        }, wait).unref();
        return;
      }
    }
  }

  /** 한 시즌의 버전별 합계. 지금 시즌은 메모리에서, 지난 시즌은 저장소에서 읽어 잠시 들고 있는다 */
  async statsOf(season: number): Promise<StatsByVersion> {
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
   * version 을 주면 그 버전만, null 이면 시즌 전체.
   * - 그 시즌에 없는 버전이면 { unknownVersion: 버전 목록 } (호출한 쪽이 404 로 답한다)
   * - 지금 시즌인데 저장된 합계를 아직 못 불러와서 그 버전이 있는지 알 수 없으면 { notReady: true } (호출한 쪽이 503 으로 답한다:
   *   없는 버전이라고 말하지 않는다. 서버가 막 깨어났거나 DB 가 안 될 때. 시즌 목록과 같은 방식)
   */
  async response(
    season: number,
    version: string | null,
    kind: StatsKind,
    seasons: number[],
    leaderboard: Pick<Leaderboard, 'records' | 'ready' | 'revision'>,
  ): Promise<UpgradeStatsResponse | { unknownVersion: UpgradeStatsResponse['versions'] } | { notReady: true }> {
    const byVersion = await this.statsOf(season);
    const current = season === this.season;
    // 지금 시즌에서는 지금 버전을 판이 없어도 목록에 넣는다 (그 버전을 물어도 404 가 아니라 0 으로 답한다)
    const versions = versionList(byVersion, current ? this.version : null);
    if (version !== null && !versions.some((v) => v.version === version)) {
      if (current && !this.loaded) return { notReady: true };
      return { unknownVersion: versions };
    }
    const stats = version === null ? sumStats(byVersion) : copyStatsByVersion({ [version]: byVersion[version] ?? emptyStats() })[version]!;
    const boards: BoardId[] = ['solo', 'coop'];
    const rows = await Promise.all(boards.map((b) => leaderboard.records(b, season)));
    return {
      season,
      current: this.season,
      seasons,
      version,
      currentVersion: this.version,
      versions,
      since: day(stats.since),
      runs: stats.runs,
      persistent: this.persistent,
      // 지금 시즌: 통계 합계나 순위 기록(topRuns 의 바탕) 중 하나라도 아직 다 불러오지 못했으면 일부일 수 있다
      loading: current && (!this.loaded || !leaderboard.ready),
      upgrades: upgradeList(stats, kind),
      topRuns: this.topRunsCached(season, version, kind, current ? leaderboard.revision : -1, rows),
    };
  }

  /** topRunsOf 를 기록이 바뀔 때만 다시 계산한다 (지금 시즌은 리더보드의 기록 번호, 지난 시즌은 읽어 둔 기록 배열로 본다) */
  private topRunsCached(
    season: number,
    version: string | null,
    kind: StatsKind,
    rev: number,
    rows: readonly (readonly RunRecordLike[])[],
  ): UpgradeStatsResponse['topRuns'] {
    const key = `${season}:${version ?? 'all'}:${kind ?? 'all'}`;
    const hit = this.topMemo.get(key);
    if (hit && hit.rev === rev && hit.rows.length === rows.length && hit.rows.every((r, i) => r === rows[i])) return hit.value;
    const value = topRunsOf(rows.flat(), kind, version);
    if (this.topMemo.size >= 32) this.topMemo.clear();
    this.topMemo.set(key, { key, rev, rows: rows as readonly unknown[][], value });
    return value;
  }

  /**
   * 모아 둔 몫을 마저 더한다 (배포·재시작 때). timeoutMs 안에 못 더한 몫은 포기한다 (못 더한 판 수를 남긴다).
   * 저장된 합계를 아직 불러오지 못했어도 더한다: 이 서버에서는 더 불러올 일이 없으니 두 번 셀 일도 없다.
   * 저장소는 닫지 않는다 (리더보드가 닫는다).
   */
  async close(timeoutMs = 2000): Promise<void> {
    const deadline = this.now() + timeoutMs;
    this.loaded = true;
    this.resting = false;
    while (this.unsaved > 0 && this.now() < deadline) {
      await Promise.race([this.flush(), new Promise((r) => setTimeout(r, Math.max(0, deadline - this.now())))]);
      if (this.unsaved > 0) await new Promise((r) => setTimeout(r, 100));
    }
    this.closed = true;
    if (this.unsaved > 0) console.error(`[stats] 종료: 판 ${this.unsaved}개의 통계를 저장하지 못했습니다`);
  }
}
