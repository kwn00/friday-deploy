import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEADERBOARD_MIN_SECONDS, UPGRADES, UPGRADE_IDS, newTally, type UpgradeTally } from '@friday-deploy/shared';
import { Leaderboard, MemoryStore, emptyStats, type LeaderboardStore, type RunRecord, type RunReport, type StoredStats } from './leaderboard';
import { UpgradeStats, statsOfRun, topRunsOf, upgradeList } from './stats';

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
  assert.deepEqual(d.upgrades.console_log, { offered: 2, picked: 1, autoPicked: 0, chest: 1, finalOwned: 1, finalLevelSum: 3 });
  assert.deepEqual(d.upgrades.regex, { offered: 1, picked: 0, autoPicked: 1, chest: 0, finalOwned: 0, finalLevelSum: 0 });
  assert.equal(Object.keys(d.upgrades).length, 2, '센 것이 없는 아이템은 싣지 않는다');
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
  s.upgrades.regex = { offered: 10, picked: 6, autoPicked: 2, chest: 0, finalOwned: 3, finalLevelSum: 12 };
  s.upgrades.coffee = { offered: 10, picked: 9, autoPicked: 0, chest: 1, finalOwned: 4, finalLevelSum: 10 };
  s.upgrades.console_log = { offered: 3, picked: 0, autoPicked: 0, chest: 5, finalOwned: 4, finalLevelSum: 20 };
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
  assert.equal((await stats.statsOf(0)).runs, 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await store.loadStats(0)).runs, 1);
  assert.equal((await store.loadStats(0)).upgrades.console_log!.picked, 1);
});

test('통계: 저장된 합계를 불러오기 전에 센 판은 불러온 뒤에 더한다 (두 번 세지 않는다)', async () => {
  const store = new MemoryStore();
  await store.addStats(0, statsOfRun(report(), 1)!, 'seed');
  const stats = new UpgradeStats(store, 0);
  stats.record(report());
  assert.equal(stats.ready, false);
  assert.equal((await stats.statsOf(0)).runs, 1, '불러오기 전: 이 서버가 센 것만');
  assert.equal((await store.loadStats(0)).runs, 1, '불러오기 전에는 저장소에 더하지 않는다');
  await stats.init();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await stats.statsOf(0)).runs, 2);
  assert.equal((await store.loadStats(0)).runs, 2);
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
    addStats: async (s, d, b) => {
      if (down) throw new Error('db down');
      await inner.addStats(s, d, b);
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
  assert.equal((await stats.statsOf(0)).runs, 3, '응답에는 바로 보인다');
  down = false;
  t.mock.timers.tick(1_000);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(stats.unsaved, 0);
  assert.equal((await inner.loadStats(0)).runs, 3, '세 판이 모두 한 번씩 더해졌다');
});

test('통계: 지난 시즌은 저장소에서 읽고, 응답은 약속한 모양이다', async () => {
  const store = new MemoryStore();
  await store.addStats(7, { runs: 2, since: Date.UTC(2026, 0, 2, 3), upgrades: { coffee: { offered: 4, picked: 2, autoPicked: 0, chest: 0, finalOwned: 1, finalLevelSum: 3 } } }, 's7');
  const old: RunRecord = { id: 'old', board: 'coop', season: 7, names: ['x', 'y'], itemsBy: [[{ id: 'coffee', level: 2 }], []], time: 300, kills: 1, level: 1, pausedSeconds: 0, endedAt: 1 };
  await store.save(old);
  const lb = new Leaderboard(store, 0);
  const stats = new UpgradeStats(store, 0);
  await Promise.all([lb.init(), stats.init()]);
  const res = await stats.response(7, 'passive', (await lb.seasons())!, lb);
  assert.deepEqual(Object.keys(res).sort(), ['current', 'loading', 'persistent', 'runs', 'season', 'seasons', 'since', 'topRuns', 'upgrades']);
  assert.deepEqual([res.season, res.current, res.seasons, res.since, res.runs, res.persistent, res.loading], [7, 0, [0, 7], '2026-01-02', 2, false, false]);
  assert.ok(res.upgrades.every((u) => u.kind === 'passive'));
  assert.deepEqual(res.upgrades[0], { id: 'coffee', name: UPGRADES.coffee.name, icon: UPGRADES.coffee.icon, kind: 'passive', offered: 4, picked: 2, autoPicked: 0, pickRate: 0.5, chest: 0, finalOwnedRate: 0.5, avgFinalLevel: 3 });
  assert.deepEqual(res.topRuns, { runs: 2, owned: [{ id: 'coffee', rate: 0.5, avgLevel: 2 }] });
  // 지금 시즌: 아직 센 판이 없다
  const now = await stats.response(0, null, [0, 7], lb);
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
    addStats: async (s, d: StoredStats, b) => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      await store.addStats(s, d, b);
    },
    close: async () => {},
  };
  const stats = new UpgradeStats(slow, 0);
  await stats.init();
  stats.record(report());
  stats.record(report());
  await stats.close();
  assert.equal((await store.loadStats(0)).runs, 2);
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
  const store = wrap(inner, async (s, d, b) => {
    ids.push(b);
    await inner.addStats(s, d, b);
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
  assert.equal((await inner.loadStats(0)).runs, 2, '두 판이 한 번씩만 더해졌다');
});

test('통계: 저장된 합계를 끝내 불러오지 못했어도, 종료할 때 모아 둔 판은 저장소에 더한다', async (t) => {
  t.mock.method(console, 'error', () => {});
  const inner = new MemoryStore();
  const store = wrap(inner, (s, d, b) => inner.addStats(s, d, b), async () => {
    throw new Error('db asleep');
  });
  const stats = new UpgradeStats(store, 0);
  void stats.init(); // 실패하고 재시도를 예약한다
  await Promise.resolve();
  stats.record(report());
  stats.record(report());
  assert.equal((await inner.loadStats(0)).runs, 0, '불러오기 전에는 더하지 않는다');
  await stats.close(500);
  assert.equal((await inner.loadStats(0)).runs, 2);
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
  const store: LeaderboardStore = { ...wrap(inner, (s, d, b) => inner.addStats(s, d, b)), load: async (...a) => { if (down) throw new Error('db down'); return inner.load(...a); } };
  const lb = new Leaderboard(store, 0);
  const stats = new UpgradeStats(store, 0);
  await stats.init();
  void lb.init().catch(() => {});
  await Promise.resolve();
  const early = await stats.response(0, null, [0], lb);
  assert.equal(lb.ready, false);
  assert.equal(early.loading, true, '순위 기록을 못 불러왔으면 topRuns 가 일부일 수 있다');
  down = false;
  await lb.init();
  const a = await stats.response(0, null, [0], lb);
  const b = await stats.response(0, null, [0], lb);
  assert.equal(a.loading, false);
  assert.equal(a.topRuns, b.topRuns, '기록이 그대로면 계산해 둔 것을 쓴다');
  lb.record(report({ itemsBy: [[{ id: 'regex', level: 2 }]] }));
  const c = await stats.response(0, null, [0], lb);
  assert.notEqual(c.topRuns, b.topRuns, '기록이 바뀌면 다시 계산한다');
  assert.deepEqual(c.topRuns, { runs: 1, owned: [{ id: 'regex', rate: 1, avgLevel: 2 }] });
  assert.notEqual((await stats.response(0, 'passive', [0], lb)).topRuns, c.topRuns, '종류마다 따로');
});
