import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEADERBOARD_MIN_SECONDS, LEADERBOARD_SIZE } from '@friday-deploy/shared';
import { Leaderboard, MemoryStore, compareRuns, type LeaderboardStore, type RunRecord, type RunReport } from './leaderboard';

let seq = 0;
const run = (over: Partial<RunReport> = {}): RunReport => ({
  id: `r${++seq}`, board: 'solo', names: ['dev'], time: 120, kills: 10, level: 3, pausedSeconds: 0, endedAt: 1_700_000_000_000 + seq, ...over,
});
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test('순위: 오래 버틴 순, 같으면 많이 잡은 순, 그다음 레벨, 그다음 먼저 세운 기록', () => {
  const lb = new Leaderboard(new MemoryStore());
  assert.equal(lb.record(run({ names: ['b'], time: 300, kills: 5 })), 1);
  assert.equal(lb.record(run({ names: ['a'], time: 600, kills: 1 })), 1);
  assert.equal(lb.record(run({ names: ['c'], time: 300, kills: 9 })), 2);
  assert.equal(lb.record(run({ names: ['d'], time: 300, kills: 9, level: 9 })), 2);
  assert.equal(lb.record(run({ names: ['e'], time: 300, kills: 9, level: 9 })), 3, '완전히 같으면 먼저 세운 기록이 위');
  assert.deepEqual(lb.top('solo').map((e) => e.names[0]), ['a', 'd', 'e', 'c', 'b']);
  assert.deepEqual(lb.top('solo').map((e) => e.rank), [1, 2, 3, 4, 5]);
  assert.deepEqual(lb.top('coop'), [], '순위표는 종류별로 따로');
});

test('기록하지 않는 것: 너무 짧은 판, 같은 판의 중복, 이름 없는 기록, 알 수 없는 순위표', () => {
  const lb = new Leaderboard(new MemoryStore());
  assert.equal(lb.record(run({ time: LEADERBOARD_MIN_SECONDS - 1 })), null);
  const once = run({ time: 200 });
  assert.equal(lb.record(once), 1);
  assert.equal(lb.record(once), null, '같은 id 는 한 번만');
  assert.equal(lb.record(run({ names: [] })), null);
  assert.equal(lb.record(run({ board: 'hacked' as 'solo' })), null);
  assert.equal(lb.top('solo').length, 1);
});

test('값을 정리해서 넣는다: 이름 정제, 숫자 범위', () => {
  const lb = new Leaderboard(new MemoryStore());
  lb.record(run({ names: ['<img src=x onerror=alert(1)>', '   '], time: 99.9, kills: -5, level: Number.NaN, endedAt: 12.7 }));
  const e = lb.top('solo')[0]!;
  assert.deepEqual(e.names, ['img srcx one', 'anonymous']);
  assert.deepEqual([e.time, e.kills, e.level, e.at], [99, 0, 1, 12]);
  lb.record(run({ time: 1e12, kills: 1e12 }));
  assert.equal(lb.top('solo')[0]!.time, 24 * 3600);
});

test('순위표는 상위 N 개만 보여주고, 밖으로 밀린 기록은 순위가 없다', () => {
  const lb = new Leaderboard(new MemoryStore());
  for (let i = 0; i < LEADERBOARD_SIZE; i++) assert.equal(lb.record(run({ time: 1000 + i })), 1);
  assert.equal(lb.top('solo').length, LEADERBOARD_SIZE);
  assert.equal(lb.record(run({ time: 900 })), null, '순위표 밖');
  assert.equal(lb.record(run({ time: 1000 })), null, '꼴찌와 동점이면 먼저 세운 기록이 자리를 지킨다');
  assert.equal(lb.record(run({ time: 1001 })), LEADERBOARD_SIZE, '동점인 기록 바로 아래, 마지막 자리로 들어간다');
  assert.equal(lb.top('solo').length, LEADERBOARD_SIZE);
  assert.equal(lb.top('solo').at(-1)!.time, 1001);
  // 아주 많이 넣어도 메모리의 목록은 일정 크기를 넘지 않고, 순위표는 계속 정렬돼 있다
  for (let i = 0; i < 2000; i++) lb.record(run({ time: 31 + ((i * 7919) % 5000), kills: i % 13 }));
  const top = lb.top('solo');
  assert.equal(top.length, LEADERBOARD_SIZE);
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1]!.time >= top[i]!.time);
});

test('저장소: 기록은 뒤에서 저장되고, 다시 시작하면 불러온다', async () => {
  const store = new MemoryStore();
  const a = new Leaderboard(store);
  await a.init();
  a.record(run({ names: ['x'], time: 500 }));
  a.record(run({ names: ['y'], time: 700, board: 'coop' }));
  await tick();
  assert.equal(a.unsaved, 0);
  const b = new Leaderboard(store);
  await b.init();
  assert.deepEqual(b.top('solo').map((e) => [e.names[0], e.time]), [['x', 500]]);
  assert.deepEqual(b.top('coop').map((e) => [e.names[0], e.time]), [['y', 700]]);
  // 시즌이 바뀌면 이전 기록은 보이지 않는다
  const next = new Leaderboard(store, a.season + 1);
  await next.init();
  assert.deepEqual(next.top('solo'), []);
});

test('저장소가 실패해도 예외가 새지 않고, 순위는 계속 계산되며, 나중에 다시 저장한다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const errors = t.mock.method(console, 'error', () => {});
  const saved: RunRecord[] = [];
  let down = true;
  const flaky: LeaderboardStore = {
    persistent: true,
    load: async () => { if (down) throw new Error('db down'); return []; },
    save: async (r) => { if (down) throw new Error('db down'); saved.push(r); },
    close: async () => {},
  };
  const lb = new Leaderboard(flaky);
  await assert.doesNotReject(lb.init());
  assert.equal(lb.ready, false);
  assert.doesNotThrow(() => lb.record(run({ time: 400 })));
  assert.equal(lb.record(run({ time: 300 })), 2, 'DB 가 죽어 있어도 순위는 나온다');
  await tick();
  assert.equal(lb.unsaved, 2);
  down = false;
  t.mock.timers.tick(1000);
  await tick();
  await tick();
  assert.equal(lb.unsaved, 0);
  assert.deepEqual(saved.map((r) => r.time), [400, 300], '순서대로 저장');
  assert.ok(errors.mock.callCount() >= 2);
});

test('compareRuns 는 완전한 순서를 준다 (정렬이 흔들리지 않는다)', () => {
  const base: RunRecord = { id: 'a', board: 'solo', season: 1, names: ['n'], time: 100, kills: 1, level: 1, pausedSeconds: 0, endedAt: 5 };
  assert.equal(compareRuns(base, { ...base }), 0);
  assert.ok(compareRuns(base, { ...base, id: 'b' }) < 0);
  assert.ok(compareRuns({ ...base, id: 'b' }, base) > 0);
  assert.ok(compareRuns({ ...base, time: 101 }, base) < 0);
});
