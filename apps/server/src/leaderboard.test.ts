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
  // 저장된 기록을 아직 못 불러왔으면 순위를 말하지 않는다 (지금 메모리에는 이번 실행의 기록뿐이라 순위가 부풀려진다)
  assert.equal(lb.record(run({ time: 300 })), 'pending');
  assert.deepEqual(lb.top('solo').map((e) => e.time), [400, 300], '그래도 기록은 받아 둔다');
  await tick();
  assert.equal(lb.unsaved, 2);
  down = false;
  t.mock.timers.tick(1000);
  await tick();
  await tick();
  assert.equal(lb.unsaved, 0);
  assert.deepEqual(saved.map((r) => r.time), [400, 300], '순서대로 저장');
  assert.ok(errors.mock.callCount() >= 2);
  // 불러오기는 3초 뒤에 다시 시도하고, 성공하면 그때부터 순위를 알려준다
  assert.equal(lb.ready, false);
  t.mock.timers.tick(2000);
  await tick();
  await tick();
  assert.equal(lb.ready, true);
  assert.equal(lb.record(run({ time: 350 })), 2);
});

test('불러오기 전에 받은 기록은 불러온 기록과 합쳐지고, 순위는 합친 뒤의 것이다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'error', () => {});
  let down = true;
  const old: RunRecord[] = [500, 450, 420].map((time, i) => ({ id: `old${i}`, board: 'solo', season: 1, names: ['old'], time, kills: 1, level: 1, pausedSeconds: 0, endedAt: 1000 + i }));
  const store: LeaderboardStore = {
    persistent: true,
    load: async (board) => { if (down) throw new Error('db asleep'); return board === 'solo' ? old : []; },
    save: async () => {},
    close: async () => {},
  };
  const lb = new Leaderboard(store, 1);
  await lb.init();
  assert.equal(lb.record(run({ names: ['new'], time: 430 })), 'pending', '메모리에는 이 기록뿐이지만 1위라고 말하지 않는다');
  down = false;
  t.mock.timers.tick(3000);
  await tick();
  await tick();
  assert.equal(lb.ready, true);
  assert.deepEqual(lb.top('solo').map((e) => [e.rank, e.names[0], e.time]), [[1, 'old', 500], [2, 'old', 450], [3, 'new', 430], [4, 'old', 420]]);
});

test('메모리 저장소는 불러올 것이 없으므로 init 을 기다리지 않아도 순위를 알려준다', () => {
  const lb = new Leaderboard(new MemoryStore());
  assert.equal(lb.ready, true);
  assert.equal(lb.record(run({ time: 100 })), 1);
});

test('DB 가 잠깐 안 되는 동안 판이 여러 번 끝나도 기록을 버리지 않는다 (새 기록이 재시도 횟수를 써 버리지 않는다)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'error', () => {});
  const saved: string[] = [];
  let calls = 0;
  let down = true;
  const store: LeaderboardStore = {
    persistent: true,
    load: async () => [],
    save: async (r) => { calls++; if (down) throw new Error('db down'); saved.push(r.names[0]!); },
    close: async () => {},
  };
  const lb = new Leaderboard(store);
  await lb.init();
  for (let i = 0; i < 8; i++) {
    lb.record(run({ names: [`p${i}`], time: 100 + i }));
    await tick();
    await tick();
  }
  assert.equal(calls, 1, '쉬는 동안에는 저장소를 다시 두드리지 않는다');
  assert.equal(lb.unsaved, 8);
  down = false;
  t.mock.timers.tick(1000);
  await tick();
  await tick();
  assert.deepEqual(saved, ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'], '하나도 빠지지 않고 순서대로');
  assert.equal(lb.unsaved, 0);
  // 다시 정상이면 새 기록은 바로 저장한다
  lb.record(run({ names: ['after'], time: 90 }));
  await tick();
  assert.equal(saved.at(-1), 'after');
});

test('compareRuns 는 완전한 순서를 준다 (정렬이 흔들리지 않는다)', () => {
  const base: RunRecord = { id: 'a', board: 'solo', season: 1, names: ['n'], time: 100, kills: 1, level: 1, pausedSeconds: 0, endedAt: 5 };
  assert.equal(compareRuns(base, { ...base }), 0);
  assert.ok(compareRuns(base, { ...base, id: 'b' }) < 0);
  assert.ok(compareRuns({ ...base, id: 'b' }, base) > 0);
  assert.ok(compareRuns({ ...base, time: 101 }, base) < 0);
});

test('close: 저장이 진행 중이어도 밀린 기록을 전부 쓴 뒤에 저장소를 닫는다', async () => {
  const saved: string[] = [];
  let closedAt = -1;
  const slow: LeaderboardStore = {
    persistent: true,
    load: async () => [],
    save: async (r) => {
      await new Promise((res) => setTimeout(res, 5));
      if (closedAt >= 0) throw new Error('store closed');
      saved.push(r.id);
    },
    close: async () => {
      closedAt = saved.length;
    },
  };
  const lb = new Leaderboard(slow);
  for (let i = 0; i < 25; i++) lb.record(run({ time: 100 + i }));
  assert.ok(lb.unsaved > 0, '아직 저장 중');
  await lb.close();
  assert.equal(saved.length, 25, '전부 저장됨');
  assert.equal(closedAt, 25, '저장이 끝난 뒤에 닫았다');
  assert.equal(lb.unsaved, 0);
});

test('close: DB 가 죽어 있으면 정해진 시간 안에 포기하고 끝난다 (종료가 매달리지 않는다)', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const dead: LeaderboardStore = { persistent: true, load: async () => [], save: async () => { throw new Error('db down'); }, close: async () => {} };
  const lb = new Leaderboard(dead);
  lb.record(run({ time: 100 }));
  const t0 = Date.now();
  await lb.close(400);
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
  assert.ok(errors.mock.callCount() >= 1);
});

test('함께 한 판: 이름은 기여도(개인 처치 수)가 큰 사람부터 적고, 기여도를 함께 돌려준다', () => {
  const lb = new Leaderboard(new MemoryStore());
  lb.record(run({ board: 'coop', names: ['host', 'mate', 'third'], killsBy: [12, 30, 12], kills: 54, time: 200 }));
  const [entry] = lb.top('coop');
  assert.deepEqual(entry!.names, ['mate', 'host', 'third'], '많이 잡은 사람부터, 같으면 들어온 순서');
  assert.deepEqual(entry!.killsBy, [30, 12, 12]);
  assert.equal(entry!.kills, 54);

  // 값은 서버 쪽에서도 다듬는다: 음수·소수·숫자가 아닌 값
  lb.record(run({ board: 'coop', names: ['a', 'b'], killsBy: [-5, Number.NaN] as number[], time: 190 }));
  assert.deepEqual(lb.top('coop')[1]!.killsBy, [0, 0]);
  lb.record(run({ board: 'coop', names: ['a', 'b'], killsBy: [2.9, 7.2], time: 180 }));
  assert.deepEqual([lb.top('coop')[2]!.names, lb.top('coop')[2]!.killsBy], [['b', 'a'], [7, 2]]);

  // 개수가 이름과 맞지 않거나 없으면 기여도 없이 넘겨받은 순서 그대로 (예전 방식의 기록)
  lb.record(run({ board: 'coop', names: ['x', 'y'], killsBy: [9], time: 170 }));
  lb.record(run({ board: 'coop', names: ['p', 'q'], time: 160 }));
  for (const e of lb.top('coop').slice(3)) assert.equal(e.killsBy, undefined);
  assert.deepEqual(lb.top('coop').slice(3).map((e) => e.names), [['x', 'y'], ['p', 'q']]);

  // 혼자 한 판에도 값은 남는다 (화면에서는 보여주지 않는다)
  lb.record(run({ names: ['solo'], killsBy: [41], kills: 41, time: 150 }));
  assert.deepEqual(lb.top('solo')[0]!.killsBy, [41]);
});

test('아이템: 사람별 무기·패시브가 이름과 함께 정렬되고, 서버가 다시 걸러 낸다. 없는 기록은 없는 대로', () => {
  const lb = new Leaderboard(new MemoryStore());
  lb.record(
    run({
      board: 'coop',
      names: ['host', 'mate'],
      killsBy: [3, 9],
      itemsBy: [
        [{ id: 'console_log', level: 2 }],
        [{ id: 'coffee', level: 1 }, { id: 'rubber_duck', level: 4 }, { id: 'hack' as never, level: 1 }],
      ],
      time: 200,
    }),
  );
  const [entry] = lb.top('coop');
  assert.deepEqual(entry!.names, ['mate', 'host']);
  assert.deepEqual(entry!.itemsBy, [
    [{ id: 'rubber_duck', level: 4 }, { id: 'coffee', level: 1 }],
    [{ id: 'console_log', level: 2 }],
  ], '기여도 순으로 바뀌어도 아이템은 제 주인을 따라간다. 모르는 id 는 버린다');

  // 개수가 이름과 맞지 않거나 없으면 남기지 않는다 (이 값을 남기기 전의 기록)
  lb.record(run({ board: 'coop', names: ['x', 'y'], itemsBy: [[{ id: 'coffee', level: 1 }]], time: 190 }));
  lb.record(run({ names: ['old'], time: 150 }));
  assert.equal(lb.top('coop')[1]!.itemsBy, undefined);
  assert.equal(lb.top('solo')[0]!.itemsBy, undefined);

  // 목록이 배열이 아니면 그 사람은 빈 목록
  lb.record(run({ names: ['solo'], itemsBy: ['bad' as never], time: 160 }));
  assert.deepEqual(lb.top('solo')[0]!.itemsBy, [[]]);
});
