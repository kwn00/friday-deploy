import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_VERSION, LEADERBOARD_MIN_SECONDS, UPGRADES, UPGRADE_IDS, newTally, type UpgradeStatsResponse, type UpgradeTally } from '@friday-deploy/shared';
import { Leaderboard, MemoryStore, addStatsInto, emptyStats, sumStats, type LeaderboardStore, type RunRecord, type RunReport, type StoredStats } from './leaderboard';
import { UpgradeStats, statsOfRun, topRunsOf, upgradeList, versionList } from './stats';

const V = APP_VERSION;
/** 응답이 '없는 버전'이 아니라 통계일 때 (테스트에서) */
function must(r: UpgradeStatsResponse | { unknownVersion: unknown } | { notReady: true }): UpgradeStatsResponse {
  assert.ok(!('unknownVersion' in r) && !('notReady' in r), '통계 응답이다');
  return r as UpgradeStatsResponse;
}

let seq = 0;
const tally = (over: Partial<UpgradeTally> = {}): UpgradeTally => ({ ...newTally(), ...over });
const report = (over: Partial<RunReport> = {}): RunReport => ({
  id: `r${seq++}`,
  board: 'solo',
  names: ['a'],
  killsBy: [1],
  itemsBy: [[{ id: 'console_log', level: 3 }]],
  tallies: [tally({ offered: { console_log: 2, regex: 1 }, picked: { console_log: 1 }, auto: { regex: 1 }, chest: { console_log: 1 } })],
  time: 100,
  kills: 1,
  level: 4,
  pausedSeconds: 0,
  endedAt: 1_700_000_000_000,
  ...over,
});

test('통계: 판 하나를 몫으로 바꾼다 (사람마다 한 판, 끝날 때 가진 것과 단계)', () => {
  const d = statsOfRun(report(), 1234)!;
  assert.equal(d.runs, 1);
  assert.equal(d.since, 1234);
  assert.deepEqual(d.upgrades.console_log, { offered: 2, picked: 1, autoPicked: 0, chest: 1, finalOwned: 1, finalLevelSum: 3, started: 0 });
  assert.deepEqual(d.upgrades.regex, { offered: 1, picked: 0, autoPicked: 1, chest: 0, finalOwned: 0, finalLevelSum: 0, started: 0 });
  assert.equal(Object.keys(d.upgrades).length, 2, '센 것이 없는 아이템은 싣지 않는다');
});

test('통계: 시작 무기는 선택지·고른 것과 따로 started 로 센다 (선택률이 부풀지 않는다). 응답에도 싣는다', () => {
  const d = statsOfRun(
    report({
      names: ['a', 'b'],
      killsBy: [1, 1],
      itemsBy: [[{ id: 'rollback', level: 2 }], [{ id: 'console_log', level: 1 }]],
      tallies: [tally({ start: { rollback: 1 }, offered: { rollback: 1 }, picked: { rollback: 1 } }), tally({ start: { console_log: 1 } })],
    }),
    1,
  )!;
  assert.deepEqual(d.upgrades.rollback, { offered: 1, picked: 1, autoPicked: 0, chest: 0, finalOwned: 1, finalLevelSum: 2, started: 1 }, '2단계는 선택지에서 고른 것');
  assert.deepEqual(d.upgrades.console_log, { offered: 0, picked: 0, autoPicked: 0, chest: 0, finalOwned: 1, finalLevelSum: 1, started: 1 });
  // 이상한 값은 걸러 낸다 (다른 횟수와 같은 규칙)
  const odd = statsOfRun(report({ tallies: [tally({ start: { firewall: -1, ai_agent: 1.7, nope: 5 } as never })] }), 1)!;
  assert.equal(odd.upgrades.firewall?.started ?? 0, 0);
  assert.equal(odd.upgrades.ai_agent!.started, 1);
  // 이 값을 세기 전의 횟수(예전 서버가 넘긴 모양)에는 start 가 없다: 0 으로
  const { start: _drop, ...noStart } = newTally();
  assert.notEqual(statsOfRun(report({ tallies: [noStart as UpgradeTally] }), 1), null);
  const s = emptyStats();
  s.runs = 2;
  addStatsInto(s, d);
  assert.deepEqual(upgradeList(s, 'weapon').filter((u) => u.started > 0).map((u) => [u.id, u.started]).sort(), [['console_log', 1], ['rollback', 1]]);
  // 0.3.x 의 몫처럼 started 가 없는 합계를 더해도 0 으로 본다
  addStatsInto(s, { runs: 1, since: null, upgrades: { firewall: { offered: 1, picked: 1, autoPicked: 0, chest: 0, finalOwned: 0, finalLevelSum: 0 } as never } });
  assert.equal(upgradeList(s, 'weapon').find((u) => u.id === 'firewall')!.started, 0);
});

test('통계: 리더보드처럼 30초가 안 되는 판은 세지 않고, 사람 수와 횟수·아이템 수가 맞지 않으면 세지 않는다', () => {
  assert.equal(statsOfRun(report({ time: LEADERBOARD_MIN_SECONDS - 1 }), 0), null);
  assert.notEqual(statsOfRun(report({ time: LEADERBOARD_MIN_SECONDS }), 0), null);
  assert.equal(statsOfRun(report({ tallies: undefined }), 0), null);
  assert.equal(statsOfRun(report({ names: ['a', 'b'] }), 0), null);
  assert.equal(statsOfRun(report({ itemsBy: [] }), 0), null);
});

test('통계: 함께 한 판은 사람마다 따로 센다. 이상한 값(음수·소수·모르는 아이템·범위 밖 단계)은 걸러 낸다', () => {
  const d = statsOfRun(
    report({
      names: ['a', 'b'],
      killsBy: [1, 2],
      itemsBy: [
        [{ id: 'console_log', level: 2 }, { id: 'nope' as 'regex', level: 1 }],
        [{ id: 'console_log', level: 99 }, { id: 'coffee', level: 5 }],
      ],
      tallies: [tally({ offered: { console_log: 1.9, regex: -3 } }), tally({ picked: { coffee: Number.NaN }, offered: { coffee: 2 } })],
    }),
    0,
  )!;
  assert.equal(d.runs, 2);
  assert.equal(d.upgrades.console_log!.offered, 1, '소수는 버림');
  assert.equal(d.upgrades.regex, undefined, '음수는 세지 않는다');
  assert.equal(d.upgrades.coffee!.picked, 0);
  assert.equal(d.upgrades.coffee!.offered, 2);
  // 범위 밖 단계나 모르는 아이템은 리더보드와 같은 규칙(ownedUpgrades)으로 걸러진다
  assert.equal(d.upgrades.coffee!.finalOwned, 1);
  assert.deepEqual([d.upgrades.console_log!.finalOwned, d.upgrades.console_log!.finalLevelSum], [1, 2], 'b 의 단계 99 는 범위 밖이라 빠진다');
});

test('통계: 응답 목록은 모든 아이템이고, 선택률 높은 순이며, 비율을 계산한다', () => {
  const s = emptyStats();
  s.runs = 4;
  s.upgrades.regex = { offered: 10, picked: 6, autoPicked: 2, chest: 0, finalOwned: 3, finalLevelSum: 12, started: 0 };
  s.upgrades.coffee = { offered: 10, picked: 9, autoPicked: 0, chest: 1, finalOwned: 4, finalLevelSum: 10, started: 0 };
  s.upgrades.console_log = { offered: 3, picked: 0, autoPicked: 0, chest: 5, finalOwned: 4, finalLevelSum: 20, started: 0 };
  const all = upgradeList(s, null);
  assert.equal(all.length, UPGRADE_IDS.length, '나온 적 없는 것도 0 으로 싣는다');
  assert.deepEqual(all.slice(0, 2).map((u) => u.id), ['coffee', 'regex']);
  const regex = all.find((u) => u.id === 'regex')!;
  assert.deepEqual(
    { pickRate: regex.pickRate, finalOwnedRate: regex.finalOwnedRate, avgFinalLevel: regex.avgFinalLevel, name: regex.name, kind: regex.kind },
    { pickRate: 0.8, finalOwnedRate: 0.75, avgFinalLevel: 4, name: UPGRADES.regex.name, kind: 'weapon' },
  );
  const never = all.find((u) => u.offered === 0 && u.id !== 'console_log')!;
  assert.deepEqual([never.pickRate, never.finalOwnedRate, never.avgFinalLevel], [0, 0, 0]);
  assert.ok(upgradeList(s, 'weapon').every((u) => u.kind === 'weapon'));
  assert.ok(upgradeList(s, 'passive').every((u) => u.kind === 'passive'));
  assert.equal(upgradeList(s, 'weapon').length + upgradeList(s, 'passive').length, UPGRADE_IDS.length);
});

test('통계: 진화한 무기는 재료를 함께 싣고, 보물상자 횟수가 진화한 횟수다', () => {
  const s = emptyStats();
  s.runs = 2;
  s.upgrades.debugger = { offered: 0, picked: 0, autoPicked: 0, chest: 1, finalOwned: 1, finalLevelSum: 1, started: 0 };
  const all = upgradeList(s, 'weapon');
  const dbg = all.find((u) => u.id === 'debugger')!;
  assert.deepEqual(dbg.evolve, { from: ['console_log'], with: 'test_coverage' });
  assert.deepEqual([dbg.chest, dbg.pickRate, dbg.finalOwnedRate, dbg.avgFinalLevel], [1, 0, 0.5, 1]);
  assert.deepEqual(all.find((u) => u.id === 'monitoring')!.evolve, { from: ['canary', 'night_owl'], with: null }, '합치기는 짝 패시브 없음');
  assert.equal(all.find((u) => u.id === 'console_log')!.evolve, undefined, '진화하지 않은 것에는 없다');
  assert.ok(!('evolve' in all.find((u) => u.id === 'regex')!), 'JSON 에도 키가 없다');
  // 판의 몫: 진화한 횟수(상자)와 끝날 때 가진 것
  const t = newTally();
  t.chest.debugger = 1;
  const d = statsOfRun(report({ tallies: [t], itemsBy: [[{ id: 'debugger', level: 1 }, { id: 'test_coverage', level: 2 }]] }), 1)!;
  assert.deepEqual(d.upgrades.debugger, { offered: 0, picked: 0, autoPicked: 0, chest: 1, finalOwned: 1, finalLevelSum: 1, started: 0 });
});

test('통계: 순위 기록에서는 사람마다 끝날 때 가진 것을 센다 (아이템을 남기기 전의 기록은 빠진다)', () => {
  const top = topRunsOf(
    [
      { names: ['a', 'b'], itemsBy: [[{ id: 'regex', level: 4 }], [{ id: 'regex', level: 2 }, { id: 'coffee', level: 1 }]] },
      { names: ['c'] },
      { names: ['d'], itemsBy: [[{ id: 'coffee', level: 5 }]] },
    ],
    null,
  );
  assert.equal(top.runs, 3);
  assert.deepEqual(top.owned, [
    { id: 'regex', rate: 0.667, avgLevel: 3 },
    { id: 'coffee', rate: 0.667, avgLevel: 3 },
  ]);
  assert.deepEqual(topRunsOf([], null), { runs: 0, owned: [] });
  assert.deepEqual(topRunsOf([{ names: ['d'], itemsBy: [[{ id: 'coffee', level: 5 }]] }], 'weapon').owned, []);
});

test('통계: 센 판은 지금 시즌 합계에 바로 들어가고, 저장소에도 더해진다. 같은 판은 두 번 세지 않는다', async () => {
  const store = new MemoryStore();
  const stats = new UpgradeStats(store, 0);
  await stats.init();
  const r = report();
  stats.record(r);
  stats.record(r);
  stats.record(report({ time: 5 }));
  assert.equal(sumStats(await stats.statsOf(0)).runs, 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sumStats(await store.loadStats(0)).runs, 1);
  assert.equal(sumStats(await store.loadStats(0)).upgrades.console_log!.picked, 1);
});

test('통계: 저장된 합계를 불러오기 전에 센 판은 불러온 뒤에 더한다 (두 번 세지 않는다)', async () => {
  const store = new MemoryStore();
  await store.addStats(0, V, statsOfRun(report(), 1)!, 'seed');
  const stats = new UpgradeStats(store, 0);
  stats.record(report());
  assert.equal(stats.ready, false);
  assert.equal(sumStats(await stats.statsOf(0)).runs, 1, '불러오기 전: 이 서버가 센 것만');
  assert.equal(sumStats(await store.loadStats(0)).runs, 1, '불러오기 전에는 저장소에 더하지 않는다');
  await stats.init();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sumStats(await stats.statsOf(0)).runs, 2);
  assert.equal(sumStats(await store.loadStats(0)).runs, 2);
});

test('통계: 저장이 실패하면 몫을 모아 두었다가 다시 더한다 (버리지 않는다)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'error', () => {});
  const inner = new MemoryStore();
  let down = true;
  const flaky: LeaderboardStore = {
    persistent: true,
    load: (...a) => inner.load(...a),
    save: (r) => inner.save(r),
    seasons: () => inner.seasons(),
    loadStats: (s) => inner.loadStats(s),
    addStats: async (s, v, d, b) => {
      if (down) throw new Error('db down');
      await inner.addStats(s, v, d, b);
    },
    close: async () => {},
  };
  const stats = new UpgradeStats(flaky, 0);
  await stats.init();
  stats.record(report());
  await Promise.resolve();
  stats.record(report());
  stats.record(report());
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(stats.unsaved, 3, '모아 두었다');
  assert.equal(sumStats(await stats.statsOf(0)).runs, 3, '응답에는 바로 보인다');
  down = false;
  t.mock.timers.tick(1_000);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(stats.unsaved, 0);
  assert.equal(sumStats(await inner.loadStats(0)).runs, 3, '세 판이 모두 한 번씩 더해졌다');
});

test('통계: 지난 시즌은 저장소에서 읽고, 응답은 약속한 모양이다', async () => {
  const store = new MemoryStore();
  await store.addStats(7, '0.1.0', { runs: 2, since: Date.UTC(2026, 0, 2, 3), upgrades: { coffee: { offered: 4, picked: 2, autoPicked: 0, chest: 0, finalOwned: 1, finalLevelSum: 3, started: 0 } } }, 's7');
  const old: RunRecord = { id: 'old', board: 'coop', season: 7, names: ['x', 'y'], itemsBy: [[{ id: 'coffee', level: 2 }], []], time: 300, kills: 1, level: 1, pausedSeconds: 0, endedAt: 1 };
  await store.save(old);
  const lb = new Leaderboard(store, 0);
  const stats = new UpgradeStats(store, 0);
  await Promise.all([lb.init(), stats.init()]);
  const res = must(await stats.response(7, null, 'passive', (await lb.seasons())!, lb));
  assert.deepEqual(Object.keys(res).sort(), ['current', 'currentVersion', 'loading', 'persistent', 'runs', 'season', 'seasons', 'since', 'topRuns', 'upgrades', 'version', 'versions']);
  assert.deepEqual([res.version, res.currentVersion, res.versions], [null, V, [{ version: '0.1.0', runs: 2, since: '2026-01-02' }]], '지난 시즌에는 지금 버전을 끼워 넣지 않는다');
  assert.deepEqual([res.season, res.current, res.seasons, res.since, res.runs, res.persistent, res.loading], [7, 0, [0, 7], '2026-01-02', 2, false, false]);
  assert.ok(res.upgrades.every((u) => u.kind === 'passive'));
  assert.deepEqual(res.upgrades[0], { id: 'coffee', name: UPGRADES.coffee.name, icon: UPGRADES.coffee.icon, kind: 'passive', offered: 4, picked: 2, autoPicked: 0, pickRate: 0.5, chest: 0, started: 0, finalOwnedRate: 0.5, avgFinalLevel: 3 });
  assert.deepEqual(res.topRuns, { runs: 2, owned: [{ id: 'coffee', rate: 0.5, avgLevel: 2 }] });
  // 지금 시즌: 아직 센 판이 없다
  const now = must(await stats.response(0, null, null, [0, 7], lb));
  assert.deepEqual([now.runs, now.since, now.topRuns.runs], [0, null, 0]);
});

test('통계: 종료할 때 모아 둔 몫을 마저 더한다', async () => {
  const store = new MemoryStore();
  let calls = 0;
  const slow: LeaderboardStore = {
    persistent: true,
    load: (...a) => store.load(...a),
    save: (r) => store.save(r),
    seasons: () => store.seasons(),
    loadStats: (s) => store.loadStats(s),
    addStats: async (s, v, d: StoredStats, b) => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      await store.addStats(s, v, d, b);
    },
    close: async () => {},
  };
  const stats = new UpgradeStats(slow, 0);
  await stats.init();
  stats.record(report());
  stats.record(report());
  await stats.close();
  assert.equal(sumStats(await store.loadStats(0)).runs, 2);
  assert.ok(calls >= 1);
  stats.record(report());
  assert.equal(stats.unsaved, 0, '닫힌 뒤에는 세지 않는다');
});

/** 가짜 저장소: 안쪽은 MemoryStore, addStats 의 동작만 바꾼다 */
function wrap(inner: MemoryStore, addStats: LeaderboardStore['addStats'], loadStats: LeaderboardStore['loadStats'] = (s) => inner.loadStats(s)): LeaderboardStore {
  return { persistent: true, load: (...a) => inner.load(...a), save: (r) => inner.save(r), seasons: () => inner.seasons(), loadStats, addStats, close: async () => {} };
}

test('통계: 실제로는 더해졌는데 확인 응답만 잃어도, 같은 묶음을 같은 id 로 다시 보내 두 번 더하지 않는다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'error', () => {});
  const inner = new MemoryStore();
  let lose = true;
  const ids: string[] = [];
  const store = wrap(inner, async (s, v, d, b) => {
    ids.push(b);
    await inner.addStats(s, v, d, b);
    if (lose) {
      lose = false;
      throw new Error('connection reset after COMMIT');
    }
  });
  const stats = new UpgradeStats(store, 0);
  await stats.init();
  stats.record(report());
  for (let i = 0; i < 5; i++) await Promise.resolve();
  stats.record(report()); // 다시 보내기를 기다리는 동안 끝난 판은 다음 묶음으로
  t.mock.timers.tick(1_000);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(stats.unsaved, 0);
  assert.equal(ids[0], ids[1], '실패한 묶음을 같은 id 로 다시 보냈다');
  assert.notEqual(ids[2], ids[0], '새로 끝난 판은 다른 묶음');
  assert.equal(sumStats(await inner.loadStats(0)).runs, 2, '두 판이 한 번씩만 더해졌다');
});

test('통계: 저장된 합계를 끝내 불러오지 못했어도, 종료할 때 모아 둔 판은 저장소에 더한다', async (t) => {
  t.mock.method(console, 'error', () => {});
  const inner = new MemoryStore();
  const store = wrap(inner, (s, v, d, b) => inner.addStats(s, v, d, b), async () => {
    throw new Error('db asleep');
  });
  const stats = new UpgradeStats(store, 0);
  void stats.init(); // 실패하고 재시도를 예약한다
  await Promise.resolve();
  stats.record(report());
  stats.record(report());
  assert.equal(sumStats(await inner.loadStats(0)).runs, 0, '불러오기 전에는 더하지 않는다');
  await stats.close(500);
  assert.equal(sumStats(await inner.loadStats(0)).runs, 2);
});

test('통계: 종료할 때 끝내 못 더한 판은 보내는 중이던 묶음까지 세어 남긴다', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const store = wrap(new MemoryStore(), () => new Promise(() => {})); // 답이 오지 않는다
  const stats = new UpgradeStats(store, 0);
  await stats.init();
  stats.record(report());
  await Promise.resolve();
  assert.equal(stats.unsaved, 1, '보내는 중인 묶음도 아직 못 더한 판이다');
  await stats.close(150);
  assert.ok(errors.mock.calls.some((c) => String(c.arguments[0]).includes('판 1개')), '못 더한 판 수를 남긴다');
});

test('통계: 지금 시즌은 순위 기록을 아직 다 불러오지 못했으면 loading 이고, topRuns 는 기록이 바뀔 때만 다시 계산한다', async (t) => {
  t.mock.method(console, 'error', () => {});
  const inner = new MemoryStore();
  let down = true;
  const store: LeaderboardStore = { ...wrap(inner, (s, v, d, b) => inner.addStats(s, v, d, b)), load: async (...a) => { if (down) throw new Error('db down'); return inner.load(...a); } };
  const lb = new Leaderboard(store, 0);
  const stats = new UpgradeStats(store, 0);
  await stats.init();
  void lb.init().catch(() => {});
  await Promise.resolve();
  const early = must(await stats.response(0, null, null, [0], lb));
  assert.equal(lb.ready, false);
  assert.equal(early.loading, true, '순위 기록을 못 불러왔으면 topRuns 가 일부일 수 있다');
  down = false;
  await lb.init();
  const a = must(await stats.response(0, null, null, [0], lb));
  const b = must(await stats.response(0, null, null, [0], lb));
  assert.equal(a.loading, false);
  assert.equal(a.topRuns, b.topRuns, '기록이 그대로면 계산해 둔 것을 쓴다');
  lb.record(report({ itemsBy: [[{ id: 'regex', level: 2 }]] }));
  const c = must(await stats.response(0, null, null, [0], lb));
  assert.notEqual(c.topRuns, b.topRuns, '기록이 바뀌면 다시 계산한다');
  assert.deepEqual(c.topRuns, { runs: 1, owned: [{ id: 'regex', rate: 1, avgLevel: 2 }] });
  assert.notEqual(must(await stats.response(0, null, 'passive', [0], lb)).topRuns, c.topRuns, '종류마다 따로');
});

test('버전: 판은 서버의 게임 버전으로 쌓이고, 버전을 고르면 그 버전만, 고르지 않으면 시즌 전체를 답한다', async () => {
  const store = new MemoryStore();
  // 지난 버전(0.2.1)과 다음 버전(0.3.0)에 쌓인 몫이 이미 있다
  await store.addStats(0, '0.2.1', { runs: 2, since: Date.UTC(2026, 10, 10), upgrades: { regex: { offered: 4, picked: 4, autoPicked: 0, chest: 0, finalOwned: 2, finalLevelSum: 6, started: 0 } } }, 'old');
  await store.addStats(0, '0.3.0', { runs: 1, since: Date.UTC(2026, 10, 30), upgrades: {} }, 'new');
  const lb = new Leaderboard(store, 0, '0.2.5');
  const stats = new UpgradeStats(store, 0, Date.now, '0.2.5');
  await Promise.all([lb.init(), stats.init()]);
  stats.record(report());
  await new Promise((r) => setTimeout(r, 0));
  assert.equal((await store.loadStats(0))['0.2.5']!.runs, 1, '서버의 버전(0.2.5)으로 저장했다');

  const all = must(await stats.response(0, null, null, [0], lb));
  assert.deepEqual([all.version, all.currentVersion, all.runs], [null, '0.2.5', 4], '시즌 전체 = 모든 버전의 합');
  assert.deepEqual(all.versions.map((v) => [v.version, v.runs]), [['0.3.0', 1], ['0.2.5', 1], ['0.2.1', 2]], '최신 버전부터');
  assert.equal(all.upgrades.find((u) => u.id === 'regex')!.offered, 5, '0.2.1 의 4 + 이번 판(0.2.5)의 1');

  const one = must(await stats.response(0, '0.2.1', 'weapon', [0], lb));
  assert.deepEqual([one.version, one.runs, one.since], ['0.2.1', 2, '2026-11-10']);
  assert.deepEqual(one.upgrades.find((u) => u.id === 'regex')!.pickRate, 1);
  assert.equal(one.upgrades.find((u) => u.id === 'console_log')!.offered, 0, '다른 버전의 판은 섞이지 않는다');

  const missing = await stats.response(0, '9.9.9', null, [0], lb);
  assert.ok('unknownVersion' in missing, '없는 버전');
  assert.deepEqual(missing.unknownVersion.map((v) => v.version), ['0.3.0', '0.2.5', '0.2.1']);
});

test('버전: 지금 시즌에서는 아직 판이 없어도 지금 버전을 물을 수 있다 (0 으로 답한다)', async () => {
  const store = new MemoryStore();
  const lb = new Leaderboard(store, 0, '0.4.0');
  const stats = new UpgradeStats(store, 0, Date.now, '0.4.0');
  await Promise.all([lb.init(), stats.init()]);
  const r = must(await stats.response(0, '0.4.0', null, [0], lb));
  assert.deepEqual([r.runs, r.since, r.versions], [0, null, [{ version: '0.4.0', runs: 0, since: null }]]);
});

test('버전: 기록에도 서버의 게임 버전이 붙고, topRuns 는 버전을 고르면 그 버전의 기록만 센다', async () => {
  const store = new MemoryStore();
  await store.save({ id: 'old', board: 'solo', season: 0, names: ['예전'], itemsBy: [[{ id: 'coffee', level: 3 }]], time: 500, kills: 1, level: 1, pausedSeconds: 0, endedAt: 1 });
  const lb = new Leaderboard(store, 0, '0.2.5');
  const stats = new UpgradeStats(store, 0, Date.now, '0.2.5');
  await Promise.all([lb.init(), stats.init()]);
  lb.record(report({ itemsBy: [[{ id: 'regex', level: 2 }]] }));
  const top = lb.top('solo');
  assert.deepEqual(top.map((e) => [e.names[0], e.version]), [['예전', undefined], ['a', '0.2.5']], '새 기록에만 버전이 붙는다');
  assert.equal((await store.load('solo', 0, 10)).find((r) => r.names[0] === 'a')!.version, '0.2.5', '저장소에도 버전이 간다');
  const all = must(await stats.response(0, null, null, [0], lb));
  const mine = must(await stats.response(0, '0.2.5', null, [0], lb));
  assert.equal(all.topRuns.runs, 2);
  assert.deepEqual(mine.topRuns, { runs: 1, owned: [{ id: 'regex', rate: 1, avgLevel: 2 }] }, '버전을 남기기 전의 기록은 빠진다');
});

test('버전: 버전 목록은 시맨틱 버전 순서다 (0.10.0 이 0.9.0 보다 최신)', () => {
  const s = (runs: number) => ({ runs, since: null, upgrades: {} });
  assert.deepEqual(versionList({ '0.9.0': s(1), '0.10.0': s(2), '0.2.2': s(3) }, null).map((v) => v.version), ['0.10.0', '0.9.0', '0.2.2']);
});

test('버전: 저장된 합계를 아직 못 불러왔으면, 지금 버전이 아닌 버전은 없다고 하지 않고 notReady 로 답한다 (서버는 503)', async () => {
  const inner = new MemoryStore();
  await inner.addStats(0, '0.2.1', { runs: 7, since: 1, upgrades: {} }, 'old');
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const store = wrap(inner, (s, v, d, b) => inner.addStats(s, v, d, b), async (s) => {
    await gate;
    return inner.loadStats(s);
  });
  const lb = new Leaderboard(inner, 0, '0.2.2');
  const stats = new UpgradeStats(store, 0, Date.now, '0.2.2');
  const loading = stats.init();
  await lb.init();
  assert.deepEqual(await stats.response(0, '0.2.1', null, [0], lb), { notReady: true }, '아직 모른다');
  const now = must(await stats.response(0, '0.2.2', null, [0], lb));
  assert.equal(now.loading, true, '지금 버전은 답하되 loading');
  release();
  await loading;
  assert.equal(must(await stats.response(0, '0.2.1', null, [0], lb)).runs, 7, '불러온 뒤에는 답한다');
  assert.ok('unknownVersion' in (await stats.response(0, '0.0.1', null, [0], lb)), '불러온 뒤에 없는 버전은 404');
});
