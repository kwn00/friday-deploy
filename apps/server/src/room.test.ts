import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { WebSocket } from 'ws';
import { OFFER_REROLLS, UPGRADES, decodeSnapshot, maxHpOf, xpForLevel, type RunResult, type ServerMsg, type Snapshot } from '@friday-deploy/shared';
import { Leaderboard, MemoryStore, type RunReport } from './leaderboard';
import { RoomManager, type Conn, type Room } from './room';

// 방은 실제 시간(setInterval, Date)에 맞춰 돈다. 테스트에서는 시계를 직접 넘긴다.
mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
/** 한 번에 크게 넘기면 그 사이의 콜백들이 모두 "끝 시각"을 보게 되므로, 서버 틱 간격으로 나눠서 넘긴다 */
const advance = (ms: number): void => {
  for (let t = 0; t < ms; t += 50) mock.timers.tick(50);
};
const MIN = 60_000;

interface FakeSocket {
  readyState: number;
  OPEN: number;
  bufferedAmount: number;
  msgs: ServerMsg[];
  snaps: Snapshot[];
  closed: [number, string] | null;
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
  terminate(): void;
}

function socket(): FakeSocket {
  return {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    msgs: [],
    snaps: [],
    closed: null,
    send(data) {
      if (typeof data === 'string') this.msgs.push(JSON.parse(data) as ServerMsg);
      else this.snaps.push(decodeSnapshot(data));
    },
    close(code, reason) {
      this.closed = [code, reason];
      this.readyState = 3;
    },
    terminate() {
      this.readyState = 3;
    },
  };
}

function join(room: Room, name: string): { conn: Conn; ws: FakeSocket } {
  const ws = socket();
  const conn = room.join(ws as unknown as WebSocket, `sid-${name}`, name);
  return { conn, ws };
}
const last = <T extends ServerMsg['t']>(ws: FakeSocket, t: T): Extract<ServerMsg, { t: T }> | undefined =>
  ws.msgs.filter((m): m is Extract<ServerMsg, { t: T }> => m.t === t).at(-1);

test('대기실: 입력만 보내서는 대기실을 붙잡아 둘 수 없다', () => {
  const rooms = new RoomManager();
  const room = rooms.create('coop')!;
  const a = join(room, 'a');
  advance(9 * MIN);
  assert.equal(room.onInput(a.conn, 1, 1, 0), true);
  advance(2 * MIN);
  assert.deepEqual(a.ws.closed, [4008, 'lobby_idle']);
  assert.equal(room.closed, true);
  assert.equal(rooms.count, 0);
  assert.equal(rooms.find(room.code), undefined, '닫힌 방의 코드는 더 이상 통하지 않는다');
});

test('솔로 일시정지: 한 번에 10분, 한 판에 합쳐서 30분까지만', () => {
  const rooms = new RoomManager();
  const room = rooms.create('solo')!;
  const a = join(room, 'a');
  const me = room.world.players.get(a.conn.pid)!;
  let seq = 1;
  const keepAlive = (): void => {
    me.hp = 1e9; // 이 테스트는 시간 제한만 본다
    room.onInput(a.conn, seq++, 0, 0);
  };
  advance(1000);
  const ticksBefore = room.world.tick;

  // 한 번의 일시정지는 10분 뒤 서버가 스스로 푼다
  room.onPause(a.conn, true);
  assert.deepEqual(last(a.ws, 'pause'), { t: 'pause', on: true, max: 600 });
  advance(9 * MIN);
  assert.equal(room.world.tick, ticksBefore, '멈춘 동안 시뮬레이션은 돌지 않는다');
  assert.equal(a.ws.closed, null, '멈춰 둔 방은 방치로 끊기지 않는다');
  advance(MIN + 1000);
  assert.deepEqual(last(a.ws, 'pause'), { t: 'pause', on: false, max: 0 });
  assert.ok(room.world.tick > ticksBefore, '자동으로 재개된다');

  // 껐다 켜기를 반복해도 합계 30분을 넘길 수 없다 (이미 10분 사용)
  keepAlive();
  room.onPause(a.conn, true);
  advance(10 * MIN + 1000);
  keepAlive();
  room.onPause(a.conn, true);
  advance(7 * MIN);
  room.onPause(a.conn, false); // 27분 사용
  keepAlive();
  room.onPause(a.conn, true);
  const left = last(a.ws, 'pause');
  assert.ok(left?.on === true && left.max >= 178 && left.max <= 180, `남은 약 3분만 허용: ${JSON.stringify(left)}`);
  advance(3 * MIN + 1000);
  assert.deepEqual(last(a.ws, 'pause'), { t: 'pause', on: false, max: 0 }, '예산이 끝나면 자동 재개');
  keepAlive();
  const tick = room.world.tick;
  const pausesBefore = a.ws.msgs.filter((m) => m.t === 'pause').length;
  room.onPause(a.conn, true);
  assert.deepEqual(last(a.ws, 'pause'), { t: 'pause', on: false, max: 0 }, '더는 받아주지 않는다');
  assert.equal(a.ws.msgs.filter((m) => m.t === 'pause').length, pausesBefore + 1);
  advance(500);
  assert.ok(room.world.tick > tick, '월드는 계속 돈다');
});

/** 혼자 하는 방 하나: 죽지 않게 해 두고(시간만 본다) 일시정지 예산을 24분 써서 6분(360초)만 남긴다 */
function soloWithBudgetLeft360(): { room: Room; a: { conn: Conn; ws: FakeSocket }; keepAlive: () => void; leftNow: () => number } {
  const rooms = new RoomManager();
  const room = rooms.create('solo')!;
  const a = join(room, 'a');
  const me = room.world.players.get(a.conn.pid)!;
  let seq = 1;
  const keepAlive = (): void => {
    me.hp = 1e9;
    room.onInput(a.conn, seq++, 0, 0);
  };
  keepAlive();
  advance(1000);
  for (let i = 0; i < 3; i++) {
    keepAlive();
    room.onPause(a.conn, true);
    advance(8 * MIN);
    room.onPause(a.conn, false);
  }
  keepAlive();
  /** 지금 멈추면 서버가 주는 시간(초). 확인한 뒤 바로 풀지 않는다 (푸는 것도 예산을 쓴다) */
  const leftNow = (): number => {
    room.onPause(a.conn, true);
    const m = last(a.ws, 'pause')!;
    assert.equal(m.on, true, `멈출 수 있어야 한다: ${JSON.stringify(m)}`);
    return m.max;
  };
  return { room, a, keepAlive, leftNow };
}

test('솔로 일시정지: 한 번 멈추면 적어도 3초를 쓴다. 3초보다 길게 멈추면 멈춘 만큼만 쓴다', () => {
  {
    const { leftNow } = soloWithBudgetLeft360();
    assert.equal(leftNow(), 360, '24분을 썼으면 6분이 남는다');
  }
  {
    // 5초 멈추면 5초만 쓴다
    const { room, a, leftNow } = soloWithBudgetLeft360();
    room.onPause(a.conn, true);
    advance(5000);
    room.onPause(a.conn, false);
    assert.equal(leftNow(), 355);
  }
  {
    // 2초만 멈췄어도 3초를 쓴다
    const { room, a, leftNow } = soloWithBudgetLeft360();
    room.onPause(a.conn, true);
    advance(2000);
    room.onPause(a.conn, false);
    assert.equal(leftNow(), 357);
  }
  {
    // 1초 동안 20번 껐다 켜면 예산이 60초 넘게 준다 (실제로 멈춘 시간은 0.5초)
    const { room, a, leftNow } = soloWithBudgetLeft360();
    for (let i = 0; i < 20; i++) {
      room.onPause(a.conn, true);
      mock.timers.tick(25);
      room.onPause(a.conn, false);
      mock.timers.tick(25);
    }
    const left = leftNow();
    assert.ok(left <= 300, `360초에서 60초 넘게 줄어야 한다: ${left}초 남음`);
  }
});

test('솔로 일시정지: 50ms 마다 껐다 켜서 느린 화면으로 버틸 수 없다 (30분 예산이 600번 만에 바닥나고, 그 뒤로는 거절)', () => {
  const reports: RunReport[] = [];
  const rooms = new RoomManager((r) => (reports.push(r), null));
  const room = rooms.create('solo')!;
  const a = join(room, 'a');
  const me = room.world.players.get(a.conn.pid)!;
  let seq = 1;
  /** 죽지 않게, 레벨업 선택지는 바로 고르고(선택을 기다리는 동안은 월드가 멈춘다), 입력은 계속 보낸다 */
  const tend = (): void => {
    me.hp = 1e9;
    if (me.offers) room.onPick(a.conn, 0);
    room.onInput(a.conn, seq++, 0, 0);
  };
  let toggles = 0;
  let rejected = false;
  for (; toggles < 1000; toggles++) {
    tend();
    room.onPause(a.conn, true);
    if (last(a.ws, 'pause')!.on === false) {
      rejected = true;
      break;
    }
    mock.timers.tick(25);
    room.onPause(a.conn, false);
    mock.timers.tick(25);
  }
  assert.ok(rejected, '예산이 바닥나 거절돼야 한다');
  assert.ok(toggles <= 600, `껐다 켜기 ${toggles}번 만에 바닥난다 (실제로 멈춘 시간은 ${(toggles * 25) / 1000}초)`);
  assert.deepEqual(last(a.ws, 'pause'), { t: 'pause', on: false, max: 0 }, '거절은 지금과 같은 모양');

  // 그 뒤로는 멈출 수 없다: 월드는 제 속도로 돈다 (1초에 20틱)
  const tick = room.world.tick;
  for (let i = 0; i < 20; i++) {
    tend();
    room.onPause(a.conn, true);
    mock.timers.tick(25);
    room.onPause(a.conn, false);
    mock.timers.tick(25);
  }
  assert.ok(room.world.tick - tick >= 19, `${room.world.tick - tick}틱`);

  // 기록에는 실제로 멈춰 있던 시간이 남는다 (예산에서 뺀 최소 몫이 아니라)
  survive(room, [a.conn], 31);
  down(room, a.conn);
  advance(100);
  assert.equal(reports.length, 1);
  const real = Math.round((toggles * 25) / 1000);
  assert.ok(Math.abs(reports[0]!.pausedSeconds - real) <= 1, `pausedSeconds ${reports[0]!.pausedSeconds} (실제 약 ${real}초)`);
});

test('페어: 누군가 쓰러진 뒤에 들어온 사람은 관전하고, 결과에는 함께 한 시간만 적힌다', () => {
  const rooms = new RoomManager();
  const room = rooms.create('coop')!;
  const a = join(room, 'a');
  const b = join(room, 'b');
  room.onStart(b.conn);
  advance(200);
  assert.equal(a.ws.snaps.length, 0, '방장이 아닌 사람은 시작할 수 없다');
  room.onStart(a.conn);
  advance(1000);

  // 쓰러지기 전에 들어온 사람은 살아서 합류한다
  const early = join(room, 'early');
  assert.equal(room.world.players.get(early.conn.pid)!.alive, true);
  room.leave(early.conn);

  // b 가 쓰러진다
  const pb = room.world.players.get(b.conn.pid)!;
  pb.alive = false;
  pb.hp = 0;
  advance(100);

  // 쓰러진 사람이 나갔다가 새로 들어와도 살아나지 않는다
  room.leave(b.conn);
  const again = join(room, 'b');
  const p2 = room.world.players.get(again.conn.pid)!;
  assert.equal(p2.alive, false);
  assert.equal(p2.hp, 0);
  advance(2000);
  assert.equal(again.ws.snaps.at(-1)!.me.alive, false);

  // 마지막 사람이 쓰러지면 판이 끝난다. 늦게 들어온 사람의 결과 시간은 판 전체가 아니라 본인이 있던 시간
  const total = room.world.time;
  const pa = room.world.players.get(a.conn.pid)!;
  pa.alive = false;
  pa.hp = 0;
  advance(100);
  const ra = last(a.ws, 'over')!.result as RunResult;
  const rb = last(again.ws, 'over')!.result as RunResult;
  assert.equal(ra.time, Math.floor(total));
  assert.ok(rb.time <= 2 && rb.time < ra.time, `늦게 온 사람 ${rb.time}s / 처음부터 한 사람 ${ra.time}s`);
  assert.equal(ra.run, 1);

  // 같은 방 대기실로 돌아가고, 다음 판에서는 모두 살아서 시작한다
  assert.equal(room.closed, false);
  assert.deepEqual(last(a.ws, 'roster')?.started, false);
  room.onStart(a.conn);
  advance(200);
  for (const p of room.world.players.values()) assert.equal(p.alive, true);
  const late = join(room, 'late');
  assert.equal(room.world.players.get(late.conn.pid)!.alive, true, '새 판에서는 쓰러진 사람이 없으므로 살아서 합류');
});

test('방 하나에서 오류가 나도 프로세스는 죽지 않고 그 방만 닫힌다', () => {
  const rooms = new RoomManager();
  const broken = rooms.create('solo')!;
  const healthy = rooms.create('solo')!;
  const a = join(broken, 'a');
  const b = join(healthy, 'b');
  const errors = mock.method(console, 'error', () => {});
  (broken as unknown as { world: unknown }).world = null; // 시뮬레이션이 예외를 던지게 만든다
  assert.doesNotThrow(() => advance(200));
  assert.deepEqual(a.ws.closed, [4008, 'server_error']);
  assert.equal(broken.closed, true);
  assert.ok(errors.mock.callCount() >= 1);
  errors.mock.restore();
  assert.equal(healthy.closed, false);
  assert.ok(b.ws.snaps.length > 0, '다른 방은 계속 돈다');
});

test('선택 시간이 끝난 뒤 늦게 도착한 선택은 위반이 아니고, 대기 중의 엉뚱한 번호는 위반이다', () => {
  const rooms = new RoomManager();
  const room = rooms.create('solo')!;
  const a = join(room, 'a');
  const me = room.world.players.get(a.conn.pid)!;
  assert.equal(room.onPick(a.conn, 0), true, '선택 대기 중이 아닐 때의 클릭은 조용히 무시');
  assert.deepEqual(me.up, { console_log: 1 }, '아무것도 바뀌지 않는다');
  me.xp = me.xpNext;
  room.world.gems.push({ id: 99_999, x: me.x, y: me.y, v: 1 });
  advance(100);
  assert.ok(me.offers, '레벨업 선택 대기');
  assert.equal(room.onPick(a.conn, 7), false, '제시되지 않은 번호는 위반');
  assert.equal(room.onPick(a.conn, 0), true);
  assert.equal(room.onPick(a.conn, 0), true, '같은 클릭이 한 번 더 와도 위반이 아니다');
});

/** 방 안의 플레이어를 쓰러뜨린다 (테스트용) */
function down(room: Room, conn: Conn): void {
  const p = room.world.players.get(conn.pid)!;
  p.alive = false;
  p.hp = 0;
}
/** 죽지 않게 하면서 게임 시간을 seconds 만큼 흘린다 */
function survive(room: Room, conns: Conn[], seconds: number): void {
  let seq = 10_000 + Math.floor(room.world.tick);
  for (let t = 0; t < seconds * 1000; t += 50) {
    for (const c of conns) {
      const p = room.world.players.get(c.pid);
      if (p?.alive) p.hp = 1e9;
      if (p?.offers) room.onPick(c, 0);
    }
    if (t % 1000 === 0) for (const c of conns) room.onInput(c, seq++, 0, 0);
    mock.timers.tick(50);
  }
}

test('리더보드: 솔로 판은 끝날 때 서버가 직접 기록하고, 결과에 순위가 실린다', () => {
  const reports: RunReport[] = [];
  const lb = new Leaderboard(new MemoryStore());
  const rooms = new RoomManager((r) => (reports.push(r), lb.record(r)));
  const room = rooms.create('solo')!;
  const a = join(room, 'solo-dev');
  survive(room, [a.conn], 40);
  room.world.players.get(a.conn.pid)!.kills = 77;
  down(room, a.conn);
  advance(100);
  const over = last(a.ws, 'over')!;
  assert.deepEqual(over.place, { board: 'solo', rank: 1 });
  assert.equal(reports.length, 1);
  assert.deepEqual([reports[0]!.board, reports[0]!.names, reports[0]!.kills], ['solo', ['solo-dev'], 77]);
  assert.ok(reports[0]!.time >= 39 && reports[0]!.time <= 41);
  assert.deepEqual(lb.top('solo').map((e) => [e.rank, e.names, e.kills]), [[1, ['solo-dev'], 77]]);
});

test('리더보드: 너무 짧은 판은 순위가 없고 결과에도 순위가 실리지 않는다', () => {
  const lb = new Leaderboard(new MemoryStore());
  const rooms = new RoomManager((r) => lb.record(r));
  const room = rooms.create('solo')!;
  const a = join(room, 'quick');
  advance(2000);
  down(room, a.conn);
  advance(100);
  assert.equal(last(a.ws, 'over')!.place, undefined);
  assert.equal(last(a.ws, 'over')!.unranked, 'short');
  assert.deepEqual(lb.top('solo'), []);
});

test('리더보드: 함께 한 판은 coop 순위표에, 처음부터 끝까지 있던 사람만 이름이 오른다', async () => {
  const reports: RunReport[] = [];
  const store = new MemoryStore();
  const lb = new Leaderboard(store);
  const rooms = new RoomManager((r) => (reports.push(r), lb.record(r)));
  const room = rooms.create('coop')!;
  const a = join(room, 'host');
  const b = join(room, 'mate');
  room.onStart(a.conn);
  survive(room, [a.conn, b.conn], 20);
  const late = join(room, 'late'); // 20초 뒤 합류: 순위표에는 오르지 않는다
  survive(room, [a.conn, b.conn, late.conn], 20);
  room.world.players.get(a.conn.pid)!.kills = 30;
  room.world.players.get(b.conn.pid)!.kills = 12;
  room.world.players.get(late.conn.pid)!.kills = 99;
  room.world.players.get(a.conn.pid)!.up = { console_log: 3, coffee: 2 };
  room.world.players.get(b.conn.pid)!.up = { rubber_duck: 1 };
  // 판이 끝나면 방은 새 월드로 돌아가므로, 이번 판의 횟수를 미리 잡아 둔다
  const tallyA = room.world.players.get(a.conn.pid)!.tally;
  const tallyB = room.world.players.get(b.conn.pid)!.tally;
  tallyA.picked.console_log = 2;
  down(room, a.conn);
  down(room, b.conn);
  down(room, late.conn);
  advance(100);
  assert.equal(reports.length, 1, '판 하나에 기록 하나');
  assert.deepEqual([reports[0]!.board, reports[0]!.names, reports[0]!.kills], ['coop', ['host', 'mate'], 42]);
  assert.deepEqual(reports[0]!.killsBy, [30, 12], '이름이 오르는 사람의 개인별 처치 수 (도중에 들어온 사람의 99 는 없다)');
  assert.deepEqual([lb.top('coop')[0]!.names, lb.top('coop')[0]!.killsBy], [['host', 'mate'], [30, 12]]);
  assert.deepEqual(reports[0]!.itemsBy, [
    [{ id: 'console_log', level: 3 }, { id: 'coffee', level: 2 }],
    [{ id: 'rubber_duck', level: 1 }],
  ], '쓰러질 때 가지고 있던 무기·패시브 (서버가 가진 값)');
  assert.deepEqual(lb.top('coop')[0]!.itemsBy, reports[0]!.itemsBy);
  // 아이템 통계용 횟수: 이름이 오르는 사람마다, 서버가 센 값 그대로 (도중에 들어온 사람의 것은 없다)
  assert.equal(reports[0]!.tallies!.length, 2);
  assert.equal(reports[0]!.tallies![0], tallyA);
  assert.equal(reports[0]!.tallies![1], tallyB);
  assert.equal(reports[0]!.tallies![0]!.picked.console_log, 2);
  const saved = await store.load('coop', lb.season, 10);
  assert.equal(saved.length, 1);
  assert.ok(!('tallies' in saved[0]!), '리더보드 기록(저장소에 넘기는 것)에는 남지 않는다');
  assert.deepEqual(last(a.ws, 'over')!.place, { board: 'coop', rank: 1 });
  assert.deepEqual(last(b.ws, 'over')!.place, { board: 'coop', rank: 1 });
  assert.equal(last(late.ws, 'over')!.place, undefined, '도중에 들어온 사람에게는 순위를 주지 않는다');
  assert.equal(last(late.ws, 'over')!.unranked, 'late', '순위표 밖이 아니라 도중 합류라고 알려준다');
  assert.equal(last(a.ws, 'over')!.unranked, undefined);
  assert.deepEqual(lb.top('solo'), []);

  // 같은 방의 다음 판: 한 사람이 나가도 "함께 시작한 판"이면 coop 으로 남는다. 같은 판이 두 번 기록되지 않는다.
  room.onStart(a.conn);
  survive(room, [a.conn, b.conn, late.conn], 10);
  room.leave(b.conn);
  survive(room, [a.conn, late.conn], 30);
  // 이번에는 나중 이름(late)이 더 많이 잡았다: 순위표에는 기여도가 큰 사람이 앞에 온다
  room.world.players.get(a.conn.pid)!.kills = 5;
  room.world.players.get(late.conn.pid)!.kills = 20;
  down(room, a.conn);
  down(room, late.conn);
  advance(100);
  assert.equal(reports.length, 2);
  assert.deepEqual([reports[1]!.board, reports[1]!.names, reports[1]!.killsBy], ['coop', ['host', 'late'], [5, 20]]);
  const second = lb.top('coop').find((e) => e.names.includes('late'))!;
  assert.deepEqual([second.names, second.killsBy, second.kills], [['late', 'host'], [20, 5], 25]);
  assert.notEqual(reports[0]!.id, reports[1]!.id);
});

test('리더보드: 페어 방에서 혼자 한 판은 솔로 순위표에 오른다', () => {
  const reports: RunReport[] = [];
  const rooms = new RoomManager((r) => (reports.push(r), null));
  const room = rooms.create('coop')!;
  const a = join(room, 'alone');
  room.onStart(a.conn);
  survive(room, [a.conn], 35);
  down(room, a.conn);
  advance(100);
  assert.deepEqual([reports[0]!.board, reports[0]!.names], ['solo', ['alone']]);
  assert.equal(last(a.ws, 'over')!.unranked, 'outside');
});

test('리더보드: 대기실에만 있다가 나간 사람은 인원으로 세지 않는다 (혼자 한 판이 함께 순위표로 가지 않는다)', () => {
  const reports: RunReport[] = [];
  const rooms = new RoomManager((r) => (reports.push(r), 1));
  const room = rooms.create('coop')!;
  const a = join(room, 'host');
  // (가) 친구(또는 본인의 두 번째 접속)가 대기실에 들어왔다 나간 뒤 혼자 시작
  const ghost = join(room, 'ghost');
  room.leave(ghost.conn);
  room.onStart(a.conn);
  survive(room, [a.conn], 35);
  down(room, a.conn);
  advance(100);
  assert.deepEqual([reports[0]!.board, reports[0]!.names], ['solo', ['host']]);
  assert.deepEqual(last(a.ws, 'over')!.place, { board: 'solo', rank: 1 });

  // (나) 같은 방에서 둘이 한 판 한 뒤, 상대가 대기실에서 나가고 다음 판을 혼자
  const b = join(room, 'mate');
  room.onStart(a.conn);
  survive(room, [a.conn, b.conn], 35);
  down(room, a.conn);
  down(room, b.conn);
  advance(100);
  assert.deepEqual([reports[1]!.board, reports[1]!.names], ['coop', ['host', 'mate']]);
  room.leave(b.conn);
  room.onStart(a.conn);
  survive(room, [a.conn], 35);
  down(room, a.conn);
  advance(100);
  assert.deepEqual([reports[2]!.board, reports[2]!.names], ['solo', ['host']]);

  // (다) 판이 시작된 뒤에 잠깐이라도 함께 있었다면 함께 한 판이다 (도움을 받은 판이 혼자 순위표에 오르지 않는다)
  const c = join(room, 'helper');
  room.onStart(a.conn);
  survive(room, [a.conn, c.conn], 10);
  room.leave(c.conn);
  survive(room, [a.conn], 30);
  down(room, a.conn);
  advance(100);
  assert.deepEqual([reports[3]!.board, reports[3]!.names], ['coop', ['host']]);

  // (라) 혼자 시작했어도 도중에 누가 합류했다면 함께 한 판이고, 이름은 처음부터 있던 사람만
  room.onStart(a.conn);
  survive(room, [a.conn], 20);
  const d = join(room, 'late');
  survive(room, [a.conn, d.conn], 20);
  down(room, a.conn);
  down(room, d.conn);
  advance(100);
  assert.deepEqual([reports[4]!.board, reports[4]!.names], ['coop', ['host']]);
});

test('리더보드: 저장된 기록을 아직 못 불러왔으면 순위 대신 그 사실을 알려준다', () => {
  const rooms = new RoomManager(() => 'pending');
  const room = rooms.create('solo')!;
  const a = join(room, 'early');
  survive(room, [a.conn], 35);
  down(room, a.conn);
  advance(100);
  const over = last(a.ws, 'over')!;
  assert.equal(over.place, undefined);
  assert.equal(over.unranked, 'pending');
});

test('리더보드: 일시정지한 시간은 기록에 남고, 기록 함수가 예외를 던져도 판은 정상적으로 끝난다', () => {
  const reports: RunReport[] = [];
  const errors = mock.method(console, 'error', () => {});
  const rooms = new RoomManager((r) => {
    reports.push(r);
    throw new Error('leaderboard exploded');
  });
  const room = rooms.create('solo')!;
  const a = join(room, 'p');
  survive(room, [a.conn], 20);
  room.onPause(a.conn, true);
  advance(60_000);
  room.onPause(a.conn, false);
  survive(room, [a.conn], 15);
  down(room, a.conn);
  assert.doesNotThrow(() => advance(100));
  errors.mock.restore();
  assert.ok(reports[0]!.pausedSeconds >= 59 && reports[0]!.pausedSeconds <= 61, `${reports[0]!.pausedSeconds}s`);
  assert.ok(reports[0]!.time >= 34 && reports[0]!.time <= 36, '멈춰 있던 시간은 생존 시간에 들어가지 않는다');
  const over = last(a.ws, 'over')!;
  assert.equal(over.place, undefined);
  assert.deepEqual(a.ws.closed, [1000, 'over']);
});

test('페어: 진행 중인 판에서 나갔다 다시 들어오면 살아 있었더라도 관전으로 들어온다 (나갔다 들어와 체력을 채울 수 없다)', () => {
  const rooms = new RoomManager();
  const room = rooms.create('coop')!;
  const a = join(room, 'a');
  const b = join(room, 'b');
  room.onStart(a.conn);
  advance(1000);
  // 아무도 쓰러지지 않은 동안 처음 들어온 사람은 살아서 합류한다
  const fresh = join(room, 'fresh');
  assert.equal(room.world.players.get(fresh.conn.pid)!.alive, true);

  // b 가 체력이 줄어든 채로 나갔다 들어온다
  room.world.players.get(b.conn.pid)!.hp = 7;
  room.leave(b.conn);
  const again = join(room, 'b');
  const pb = room.world.players.get(again.conn.pid)!;
  assert.deepEqual([pb.alive, pb.body, pb.hp], [false, false, 0]);
  // 그 뒤에 들어오는 사람은 누구든 이번 판을 관전한다 (서버는 "아까 그 사람"인지 알 수 없다)
  const other = join(room, 'someone-else');
  assert.equal(room.world.players.get(other.conn.pid)!.alive, false);

  advance(500);
  const snap = again.ws.snaps.at(-1)!;
  assert.equal(snap.me.alive, false);
  assert.deepEqual(snap.p.map((row) => row[0]).sort(), [a.conn.pid, fresh.conn.pid].sort(), '관전자는 그려지지 않는다');
  const pa = room.world.players.get(a.conn.pid)!;
  assert.ok(Math.hypot(snap.view[0] - pa.x, snap.view[1] - pa.y) < 400, '살아 있는 사람 근처를 본다');

  // 관전자의 입력은 시점만 움직인다
  const x0 = snap.view[0];
  room.onInput(again.conn, 1, 1, 0);
  advance(500);
  assert.ok(again.ws.snaps.at(-1)!.view[0] > x0 + 40, `${x0} → ${again.ws.snaps.at(-1)!.view[0]}`);
  assert.deepEqual([pa.alive, room.world.players.get(fresh.conn.pid)!.alive], [true, true]);

  // 판이 끝나면 같은 방에서 모두 살아서 다시 시작한다
  for (const c of [a.conn, fresh.conn]) down(room, c);
  advance(100);
  assert.ok(last(again.ws, 'over'), '관전자도 결과를 받는다');
  room.onStart(a.conn);
  advance(200);
  for (const p of room.world.players.values()) assert.deepEqual([p.alive, p.body], [true, true]);
});

test('페어: 쓰러진 사람은 관전하며 시점을 움직일 수 있고, 다른 사람에게는 묘비만 보인다', () => {
  const rooms = new RoomManager();
  const room = rooms.create('coop')!;
  const a = join(room, 'a');
  const b = join(room, 'b');
  room.onStart(a.conn);
  advance(500);
  const pb = room.world.players.get(b.conn.pid)!;
  const grave = [pb.x, pb.y];
  down(room, b.conn);
  advance(100);
  const x0 = b.ws.snaps.at(-1)!.view[0];
  let seq = 1;
  for (let i = 0; i < 20; i++) {
    room.world.players.get(a.conn.pid)!.hp = 1e9;
    room.onInput(b.conn, seq++, 1, 0);
    advance(50);
  }
  const mine = b.ws.snaps.at(-1)!;
  assert.ok(mine.view[0] > x0 + 100, `시점이 움직였다: ${x0} → ${mine.view[0]}`);
  assert.equal(mine.me.alive, false);
  const seen = a.ws.snaps.at(-1)!.p.find((row) => row[0] === b.conn.pid)!;
  assert.ok(Math.abs(seen[1] - grave[0]!) < 0.11 && Math.abs(seen[2] - grave[1]!) < 0.11 && seen[4] === 0, '동료에게는 쓰러진 자리의 묘비로 보인다');
});

test('리더보드: 관전으로 들어온 사람은 판이 시작된 직후에 들어왔어도 이름이 오르지 않는다 (플레이하지 않은 사람이 순위표에 오르지 않는다)', () => {
  const reports: RunReport[] = [];
  const rooms = new RoomManager((r) => (reports.push(r), 1));
  const room = rooms.create('coop')!;
  const a = join(room, 'host');
  const b = join(room, 'reloader');
  room.onStart(a.conn);
  advance(1000);
  // 시작 1초 만에 한 사람이 새로고침한다: 나간 순간부터 이 판에 들어오는 사람은 관전이다
  room.leave(b.conn);
  const again = join(room, 'reloader');
  const stranger = join(room, 'stranger');
  for (const c of [again, stranger]) assert.equal(room.world.players.get(c.conn.pid)!.body, false);
  assert.ok(again.conn.joinedAt <= 5 && stranger.conn.joinedAt <= 5, '둘 다 "처음부터 있던 사람"으로 치는 5초 안에 들어왔다');

  survive(room, [a.conn], 35);
  room.world.players.get(a.conn.pid)!.kills = 40;
  down(room, a.conn);
  advance(100);
  assert.equal(reports.length, 1);
  assert.deepEqual([reports[0]!.board, reports[0]!.names, reports[0]!.killsBy], ['coop', ['host'], [40]], '플레이한 사람만');
  assert.deepEqual(last(a.ws, 'over')!.place, { board: 'coop', rank: 1 });
  for (const c of [again, stranger]) {
    const over = last(c.ws, 'over')!;
    assert.equal(over.place, undefined);
    assert.equal(over.unranked, 'watched', '관전만 했다고 알려준다 (짧은 판이나 순위표 밖이라고 하지 않는다)');
  }

  // 플레이하던 사람이 나가 버리고 관전자만 남으면 판은 끝나고, 아무 기록도 남지 않는다
  room.onStart(a.conn);
  advance(1000);
  room.leave(again.conn);
  const watcher = join(room, 'watcher');
  survive(room, [a.conn, stranger.conn], 40);
  room.leave(a.conn);
  room.leave(stranger.conn);
  advance(200);
  assert.equal(reports.length, 1, '관전자만 남은 판은 기록되지 않는다');
  const over = last(watcher.ws, 'over')!;
  assert.deepEqual([over.place, over.unranked], [undefined, 'watched']);
});

/* ───────────── 끊긴 연결 다시 붙기 ───────────── */

/** 통신이 끊겼다 (스스로 나간 것이 아니다): 소켓이 닫히고, 서버의 연결 처리가 방에 알린다. 자리를 지켜 두었으면 true */
function hangUp(room: Room, who: { conn: Conn; ws: FakeSocket }, onFree?: () => void): boolean {
  who.ws.readyState = 3;
  return room.disconnect(who.conn, who.ws as unknown as WebSocket, true, onFree);
}
const keyOf = (ws: FakeSocket): string => last(ws, 'welcome')!.key;
/** 입력 없이(자리를 비운 채로) 시간을 흘린다. 서 있는 캐릭터가 쓰러지지는 않게 한다 */
function unattended(room: Room, conn: Conn, seconds: number): void {
  for (let t = 0; t < seconds * 1000; t += 50) {
    const p = room.world.players.get(conn.pid);
    if (p?.alive) p.hp = 1e9;
    mock.timers.tick(50);
  }
}
const rosterOf = (ws: FakeSocket, pid: number) => last(ws, 'roster')!.players.find((p) => p.id === pid);

test('재접속(솔로): 연결이 끊기면 월드를 멈추고 자리를 지킨다. 같은 열쇠로 돌아오면 그 캐릭터 그대로 이어서 한다', () => {
  const reports: RunReport[] = [];
  const rooms = new RoomManager((r) => (reports.push(r), 1));
  const room = rooms.create('solo')!;
  const a = join(room, 'a');
  const key = keyOf(a.ws);
  assert.match(key, /^[0-9a-f]{8}\.[A-Za-z0-9_-]{32}$/, '방 id 와 192비트 비밀 값');
  survive(room, [a.conn], 35);
  const p = room.world.players.get(a.conn.pid)!;
  p.hp = 37;
  p.kills = 5;
  room.onInput(a.conn, 900_000, 1, 0);
  const tick = room.world.tick;
  let freed = 0;
  assert.equal(hangUp(room, a, () => freed++), true, '자리를 지켜 둔다');
  assert.deepEqual([p.dx, p.dy], [0, 0], '달리던 방향 그대로 계속 가지 않는다');
  advance(60_000);
  assert.equal(room.closed, false);
  assert.equal(rooms.count, 1);
  assert.equal(room.world.tick, tick, '자리를 비운 동안 월드는 멈춰 있다');
  assert.equal(freed, 0);

  const ws2 = socket();
  const back = rooms.resume(key, ws2 as unknown as WebSocket);
  assert.ok(back && back.conn === a.conn && back.room === room, '같은 자리를 돌려받는다');
  assert.equal(freed, 1, '지켜 두던 자리 하나가 풀렸다');
  const w = last(ws2, 'welcome')!;
  assert.deepEqual([w.id, w.resumed, w.key, w.mode], [a.conn.pid, true, key, 'solo']);
  assert.equal(last(ws2, 'roster')!.started, true);
  const pause = last(ws2, 'pause')!;
  assert.ok(pause.on && pause.max > 530 && pause.max <= 540, `멈춰 있다고 알려주고 남은 시간도 준다 (${pause.max}s)`);
  const snap = ws2.snaps.at(-1)!;
  assert.deepEqual([snap.me.hp, snap.me.kills, snap.paused, snap.tick], [37, 5, true, tick], '체력·처치 수·시간 모두 끊기기 전 그대로');

  // 계속하기: 새 연결의 입력 번호는 처음부터 다시 센다
  room.onPause(a.conn, false);
  assert.equal(room.onInput(a.conn, 1, 1, 0), true);
  survive(room, [a.conn], 1);
  assert.ok(room.world.tick > tick + 15 && ws2.snaps.at(-1)!.tick > tick + 15, '다시 돌아간다');
  assert.equal(a.ws.snaps.at(-1)!.tick <= tick, true, '옛 소켓으로는 더 보내지 않는다');

  // 자리를 비운 시간은 일시정지와 똑같이 기록에 남는다
  down(room, a.conn);
  advance(100);
  assert.equal(reports.length, 1);
  assert.ok(reports[0]!.pausedSeconds >= 59 && reports[0]!.pausedSeconds <= 61, `pausedSeconds ${reports[0]!.pausedSeconds}`);
  assert.ok(reports[0]!.time >= 35 && reports[0]!.time <= 37, '멈춰 있던 60초는 생존 시간에 들어가지 않는다');
});

test('재접속(솔로): 돌아오지 않으면 일시정지가 끝날 때(10분) 방을 닫는다. 일시정지 시간을 다 쓴 판은 2분만 기다린다', () => {
  const rooms = new RoomManager();
  const room = rooms.create('solo')!;
  const a = join(room, 'a');
  const key = keyOf(a.ws);
  survive(room, [a.conn], 3);
  let freed = 0;
  hangUp(room, a, () => freed++);
  advance(9 * MIN + 55_000);
  assert.equal(room.closed, false, '멈춰 있는 동안에는 드는 것이 없으므로 일시정지가 끝날 때까지 기다린다');
  advance(10_000);
  assert.equal(room.closed, true);
  assert.equal(rooms.count, 0);
  assert.equal(freed, 1, '방이 닫히면 지켜 두던 자리도 풀린다');
  assert.equal(rooms.resume(key, socket() as unknown as WebSocket), null, '닫힌 방의 열쇠는 통하지 않는다');

  // 일시정지 시간(한 판에 30분)을 다 쓴 판: 멈출 수 없으므로 월드는 계속 돌고, 자리는 2분만 지킨다
  const room2 = rooms.create('solo')!;
  const b = join(room2, 'b');
  for (let i = 0; i < 3; i++) {
    room2.onPause(b.conn, true);
    advance(10 * MIN + 1000);
  }
  room2.onPause(b.conn, true);
  assert.equal(last(b.ws, 'pause')!.on, false, '일시정지 시간을 다 썼다');
  survive(room2, [b.conn], 1);
  const tick = room2.world.tick;
  hangUp(room2, b);
  unattended(room2, b.conn, 119);
  assert.equal(room2.closed, false);
  // (레벨업 선택 대기로 잠깐씩 멈추는 것은 접속해 있을 때와 같다: 20초 뒤 서버가 대신 고른다)
  assert.ok(room2.world.tick > tick + 400, `끊어서 일시정지 한도를 넘길 수는 없다: 월드는 계속 돈다 (${room2.world.tick - tick}틱)`);
  unattended(room2, b.conn, 2);
  assert.equal(room2.closed, true);
});

test('재접속(페어): 끊긴 사람의 캐릭터는 그 자리에 남아 계속 맞는다. 판은 멈추지 않고, 돌아오면 같은 캐릭터다', () => {
  const rooms = new RoomManager();
  const room = rooms.create('coop')!;
  const a = join(room, 'a');
  const b = join(room, 'b');
  room.onStart(a.conn);
  survive(room, [a.conn, b.conn], 2);
  const key = keyOf(b.ws);
  const pb = room.world.players.get(b.conn.pid)!;
  room.onInput(b.conn, 800_000, 0, 1);
  advance(100);
  pb.hp = 60;
  pb.level = 3;
  let freed = 0;
  assert.equal(hangUp(room, b, () => freed++), true);
  assert.deepEqual([pb.dx, pb.dy], [0, 0]);
  assert.equal(rosterOf(a.ws, b.conn.pid)?.away, true, '동료에게 연결이 끊겼다고 알려준다');
  assert.equal(last(a.ws, 'roster')!.players.length, 2);

  // 판은 멈추지 않는다 (페어에서는 누구도 다른 사람의 게임을 멈출 수 없다)
  const tick = room.world.tick;
  const { x, y } = pb;
  survive(room, [a.conn], 2);
  assert.ok(room.world.tick > tick + 35);
  assert.equal(a.ws.snaps.at(-1)!.paused, false);
  assert.deepEqual([pb.x, pb.y], [x, y], '가만히 서 있다');
  assert.ok(a.ws.snaps.at(-1)!.p.some((row) => row[0] === b.conn.pid), '동료의 화면에 그대로 보인다');

  // 무적이 아니다: 붙어 있는 적에게 맞는다 (끊는 것으로 피해를 피할 수 없다)
  room.world.enemies.push({ id: 990_001, type: 'bug', x: pb.x, y: pb.y, hp: 1e9, spd: 1, frozen: 0, kbTaken: 0, resFreeze: 0, kbTime: 0, kbMult: 0, vx: 0, vy: 0, life: 0, hit: false });
  survive(room, [a.conn], 1);
  assert.ok(pb.hp < 60, `체력 60 -> ${pb.hp}`);
  const hurt = pb.hp;

  // 끊긴 뒤에 코드로 들어온 사람은 관전한다 (끊긴 본인이 새 캐릭터로 들어올 수 없다)
  const again = join(room, 'b');
  assert.equal(room.world.players.get(again.conn.pid)!.alive, false);
  room.leave(again.conn);

  // 같은 열쇠로 돌아온다: 같은 캐릭터, 체력은 채워지지 않는다
  room.world.enemies.length = 0;
  const ws2 = socket();
  assert.equal(rooms.resume(key, ws2 as unknown as WebSocket)?.conn, b.conn);
  assert.equal(freed, 1);
  assert.equal(last(ws2, 'welcome')!.id, b.conn.pid);
  assert.equal(last(ws2, 'pause'), undefined, '페어에는 일시정지 상태가 없다');
  assert.deepEqual([ws2.snaps.at(-1)!.me.hp, ws2.snaps.at(-1)!.me.level, ws2.snaps.at(-1)!.me.alive], [Math.ceil(hurt), 3, true]);
  assert.equal(rosterOf(a.ws, b.conn.pid)?.away, undefined, '동료에게 돌아왔다고 알려준다');
  assert.equal(room.onInput(b.conn, 1, 1, 0), true);

  // 다시 끊기고 2분 동안 돌아오지 않으면 자리를 비운다 (그 뒤에는 나간 것과 같다)
  const b2 = { conn: b.conn, ws: ws2 };
  hangUp(room, b2, () => freed++);
  pb.hp = 1e9;
  survive(room, [a.conn], 119);
  assert.ok(room.world.players.has(b.conn.pid));
  assert.equal(freed, 1);
  survive(room, [a.conn], 2);
  assert.equal(room.world.players.has(b.conn.pid), false);
  assert.equal(freed, 2);
  assert.equal(last(a.ws, 'roster')!.players.length, 1);
  assert.equal(rooms.resume(key, socket() as unknown as WebSocket), null, '비워진 자리의 열쇠는 통하지 않는다');
  assert.equal(room.closed, false);
});

test('재접속: 틀린 열쇠는 통하지 않고, 서버가 끊긴 줄 모르는 옛 연결이 남아 있으면 닫고 넘겨준다', () => {
  const rooms = new RoomManager();
  const room = rooms.create('coop')!;
  const other = rooms.create('coop')!;
  const a = join(room, 'a');
  const b = join(room, 'b');
  const c = join(other, 'c');
  const key = keyOf(a.ws);
  const ws = (): WebSocket => socket() as unknown as WebSocket;
  assert.notEqual(key, keyOf(b.ws), '자리마다 열쇠가 다르다');
  assert.equal(rooms.resume(`${key.slice(0, 9)}${'A'.repeat(32)}`, ws()), null, '비밀 값이 틀리다');
  assert.equal(rooms.resume(`00000000${key.slice(8)}`, ws()), null, '없는 방');
  assert.equal(rooms.resume(`${other.id}${key.slice(8)}`, ws()), null, '다른 방에서는 통하지 않는다');
  assert.equal(rooms.resume(`${key.slice(0, 9)}short`, ws()), null, '길이가 다른 값도 예외 없이 거절한다');
  assert.equal(rooms.resume('', ws()), null);
  assert.equal(a.conn.ws, a.ws, '실패한 시도는 자리 주인에게 아무 영향이 없다');
  assert.equal(a.ws.closed, null);

  // 옛 연결이 아직 열려 있는 채로 이어받기: 옛 연결을 닫고 새 연결에 넘긴다 (한 자리는 한 연결만 쓴다)
  const ws2 = socket();
  assert.equal(rooms.resume(key, ws2 as unknown as WebSocket)?.conn, a.conn);
  assert.deepEqual(a.ws.closed, [4009, 'replaced']);
  assert.equal(last(ws2, 'welcome')!.resumed, true);
  // 옛 연결의 close 가 뒤늦게 온다: 자리를 건드리지 않고, 지켜 둔 자리로 세지도 않는다
  let freed = 0;
  assert.equal(room.disconnect(a.conn, a.ws as unknown as WebSocket, true, () => freed++), false);
  assert.equal(a.conn.away, false);
  assert.equal(last(b.ws, 'roster')!.players.length, 2);
  advance(5 * MIN);
  assert.equal(last(b.ws, 'roster')!.players.length, 2, '옛 연결 때문에 자리가 만료되지 않는다');
  assert.equal(freed, 0);
  assert.equal(c.ws.closed, null);
});

test('재접속: 스스로 나갔거나 서버가 끊은 연결은 자리를 지켜 주지 않는다', () => {
  const rooms = new RoomManager();
  // 스스로 나감 / 쫓겨남: 연결 처리가 닫히기 전에 자리를 비운다
  const solo = rooms.create('solo')!;
  const a = join(solo, 'a');
  const key = keyOf(a.ws);
  solo.leave(a.conn);
  assert.equal(solo.closed, true);
  assert.equal(rooms.resume(key, socket() as unknown as WebSocket), null);
  // 그 뒤에 소켓이 닫혀도 지켜 둔 자리로 세지 않는다
  let freed = 0;
  assert.equal(hangUp(solo, a, () => freed++), false);
  assert.equal(freed, 0);

  // 이 주소가 지켜 둔 자리가 이미 많을 때(hold = false)도 바로 비운다
  const coop = rooms.create('coop')!;
  const b = join(coop, 'b');
  const c = join(coop, 'c');
  b.ws.readyState = 3;
  assert.equal(coop.disconnect(b.conn, b.ws as unknown as WebSocket, false), false);
  assert.equal(last(c.ws, 'roster')!.players.length, 1);
  assert.equal(rooms.resume(keyOf(b.ws), socket() as unknown as WebSocket), null);

  // 방이 닫히면(방치 등) 지켜 두던 자리도 함께 풀린다
  hangUp(coop, c, () => freed++);
  assert.equal(coop.closed, false, '자리를 지키는 동안에는 방이 남아 있다');
  advance(11 * MIN);
  assert.equal(coop.closed, true);
  assert.equal(freed, 1);
  assert.equal(rooms.count, 0);
});

test('재접속(대기실): 끊긴 사람의 자리는 대기실이 닫힐 때까지 지킨다. 방장이 없는 동안에는 접속해 있는 사람이 시작할 수 있다', () => {
  const rooms = new RoomManager();
  const room = rooms.create('coop')!;
  const a = join(room, 'host');
  const key = keyOf(a.ws);
  // 방장이 초대 링크를 보내러 다른 앱에 간 사이에 연결이 끊긴다. 그동안 친구가 들어온다
  hangUp(room, a);
  advance(3 * MIN);
  assert.equal(room.closed, false, '2분이 지나도 대기실 자리는 그대로다');
  const b = join(room, 'mate');
  assert.equal(last(b.ws, 'roster')!.players.length, 2);
  assert.equal(rosterOf(b.ws, a.conn.pid)?.away, true);
  assert.equal(last(b.ws, 'roster')!.host, b.conn.pid, '방장이 없는 동안에는 접속해 있는 사람이 시작할 수 있다');

  // 방장이 돌아오면 다시 방장이다
  const ws2 = socket();
  assert.equal(rooms.resume(key, ws2 as unknown as WebSocket)?.conn, a.conn);
  assert.equal(last(ws2, 'roster')!.started, false);
  assert.equal(last(ws2, 'roster')!.host, a.conn.pid);
  assert.equal(last(b.ws, 'roster')!.host, a.conn.pid);
  room.onStart(b.conn);
  advance(200);
  assert.equal(b.ws.snaps.length, 0, '방장이 있으면 방장만 시작한다');

  // 방장이 다시 끊긴 사이에 친구가 시작하면: 자리를 비운 사람은 빼고 시작한다 (서 있기만 하는 캐릭터를 넣지 않는다)
  hangUp(room, { conn: a.conn, ws: ws2 });
  room.onStart(b.conn);
  advance(200);
  assert.ok(b.ws.snaps.length > 0);
  assert.equal(room.world.players.size, 1);
  assert.equal(last(b.ws, 'roster')!.players.length, 1);
  assert.equal(rooms.resume(key, socket() as unknown as WebSocket), null);
  // 빠진 사람은 방 코드로 다시 들어와 함께 한다 (아무도 쓰러지거나 나가지 않은 판이므로 관전이 아니다)
  const back = join(room, 'host');
  assert.equal(room.world.players.get(back.conn.pid)!.alive, true);
});

test('재접속: 판이 끝나는 순간 통신이 막혀 있던 사람은 돌아와서 결과를 받는다', () => {
  const reports: RunReport[] = [];
  const rooms = new RoomManager((r) => (reports.push(r), 1));
  // 페어: 끊긴 채로 판이 끝났다. 처음부터 함께 한 사람이므로 기록에 이름이 오르고, 돌아오면 결과를 본다
  const room = rooms.create('coop')!;
  const a = join(room, 'a');
  const b = join(room, 'b');
  room.onStart(a.conn);
  survive(room, [a.conn, b.conn], 31);
  const key = keyOf(b.ws);
  hangUp(room, b);
  down(room, a.conn);
  down(room, b.conn);
  advance(100);
  assert.deepEqual([reports[0]!.board, [...reports[0]!.names].sort()], ['coop', ['a', 'b']]);
  assert.equal(last(b.ws, 'over'), undefined, '닫힌 소켓으로는 가지 않았다');
  const ws2 = socket();
  rooms.resume(key, ws2 as unknown as WebSocket);
  assert.deepEqual(
    ws2.msgs.map((m) => m.t),
    ['welcome', 'over', 'roster'],
  );
  assert.equal(last(ws2, 'over')!.result.name, 'b');
  assert.deepEqual(last(ws2, 'over')!.place, { board: 'coop', rank: 1 });
  assert.equal(last(ws2, 'roster')!.started, false);
  // 다음 판이 시작된 뒤에는 지난 결과를 다시 주지 않는다
  room.onStart(a.conn);
  advance(100);
  const ws3 = socket();
  rooms.resume(key, ws3 as unknown as WebSocket);
  assert.equal(last(ws3, 'over'), undefined);
  assert.equal(last(ws3, 'roster')!.started, true);

  // 솔로: 통신이 막힌 줄 서버가 알기 전에 쓰러져 방이 닫혔다. 열쇠가 맞는 사람에게만 2분 동안 결과를 다시 준다
  const solo = rooms.create('solo')!;
  const c = join(solo, 'c');
  const ckey = keyOf(c.ws);
  survive(solo, [c.conn], 2);
  down(solo, c.conn);
  advance(100);
  assert.equal(solo.closed, true);
  assert.equal(rooms.resume(ckey, socket() as unknown as WebSocket), null);
  assert.deepEqual(rooms.resultFor(ckey), last(c.ws, 'over'));
  assert.equal(rooms.resultFor(`${ckey.slice(0, 9)}${'B'.repeat(32)}`), null, '열쇠가 틀리면 주지 않는다');
  assert.equal(rooms.resultFor(key), null, '다른 방의 열쇠로도 주지 않는다');
  advance(2 * MIN + 1000);
  assert.equal(rooms.resultFor(ckey), null, '2분이 지나면 지운다');
});

test('입력이 멈춘 연결: 4초 넘게 입력이 없으면 캐릭터를 세운다. 혼자 하는 판은 스스로 멈춘다', () => {
  const rooms = new RoomManager();
  const room = rooms.create('coop')!;
  const a = join(room, 'a');
  const b = join(room, 'b');
  advance(30_000);
  room.onStart(a.conn);
  advance(1000);
  assert.equal(rosterOf(a.ws, b.conn.pid)?.idle, undefined, '대기실에서 조용했던 시간은 세지 않는다');
  room.onInput(b.conn, 1, 1, 0);
  const pb = room.world.players.get(b.conn.pid)!;
  survive(room, [a.conn], 3);
  assert.equal(pb.dx, 1, '3초까지는 마지막 입력대로 움직인다');
  survive(room, [a.conn], 2);
  assert.deepEqual([pb.dx, pb.dy], [0, 0], '4초 넘게 조용하면 세운다 (하트비트가 끊긴 연결을 알아채기까지 달리게 두지 않는다)');
  assert.equal(rosterOf(a.ws, b.conn.pid)?.idle, true);
  assert.equal(rosterOf(a.ws, b.conn.pid)?.away, undefined, '연결이 끊긴 것과는 구분한다');
  assert.equal(a.ws.snaps.at(-1)!.paused, false, '페어 판은 멈추지 않는다');
  const rosters = a.ws.msgs.filter((m) => m.t === 'roster').length;
  survive(room, [a.conn], 20);
  assert.equal(a.ws.msgs.filter((m) => m.t === 'roster').length, rosters, '조용한 동안 명단을 되풀이해 보내지 않는다');
  room.onInput(b.conn, 2, 0, 0);
  assert.equal(rosterOf(a.ws, b.conn.pid)?.idle, undefined, '입력이 오면 풀린다');

  // 솔로: 스스로 멈춘다 (일시정지와 같은 예산). 서버가 밀려 틱이 늦게 돈 것은 세지 않는다
  const solo = rooms.create('solo')!;
  const c = join(solo, 'c');
  survive(solo, [c.conn], 2);
  mock.timers.tick(6000); // 서버가 6초 동안 밀렸다: 그동안 온 입력을 아직 못 읽었을 뿐이다
  assert.equal(last(c.ws, 'pause'), undefined);
  survive(solo, [c.conn], 1);
  const tick = solo.world.tick;
  advance(4200);
  assert.equal(last(c.ws, 'pause')?.on, true, '입력이 4초 넘게 끊기면 멈춘다');
  assert.ok(solo.world.tick - tick <= 82, `멈추기 전까지 돈 틱 ${solo.world.tick - tick}`);
  const frozen = solo.world.tick;
  advance(30_000);
  assert.equal(solo.world.tick, frozen);
  solo.onPause(c.conn, false);
  survive(solo, [c.conn], 1);
  assert.ok(solo.world.tick > frozen + 15, '같은 연결로 이어서 한다');
});

test('재접속: 판 도중에 끊긴 사람은, 판이 끝나 대기실로 돌아가면 대기실 기준(닫힐 때까지)으로 자리를 지킨다', () => {
  const rooms = new RoomManager();
  const room = rooms.create('coop')!;
  const a = join(room, 'a');
  const b = join(room, 'b');
  room.onStart(a.conn);
  survive(room, [a.conn, b.conn], 2);
  const key = keyOf(b.ws);
  hangUp(room, b);
  // 끊긴 채로 판이 끝난다
  down(room, a.conn);
  down(room, b.conn);
  advance(100);
  assert.equal(last(a.ws, 'roster')!.started, false);
  // 2분이 지나도 대기실에서는 자리가 남아 있다 (예전에는 판 기준 2분으로 비워졌다)
  for (let i = 0; i < 5; i++) {
    room.onInput(a.conn, 700_000 + i, 0, 0);
    advance(MIN);
  }
  assert.equal(rosterOf(a.ws, b.conn.pid)?.away, true);
  const ws2 = socket();
  assert.equal(rooms.resume(key, ws2 as unknown as WebSocket)?.conn, b.conn, '5분 뒤에도 이어받는다');
  assert.equal(last(ws2, 'over')!.result.name, 'b', '놓친 판의 결과도 받는다');
  assert.equal(last(ws2, 'roster')!.started, false);
});

test('바닥 영역: 연결마다 한 번씩만 보낸다 (레벨업 선택으로 월드가 멈춰 있어도 같은 영역을 거듭 보내지 않는다)', () => {
  const rooms = new RoomManager();
  const room = rooms.create('solo')!;
  const a = join(room, 'a');
  const p = room.world.players.get(a.conn.pid)!;
  p.up = { console_log: 1, hotfix: 3 };
  p.xpNext = 1e9;
  room.world.itemCd = 1e9;
  room.world.magnetCd = 1e9;
  const seen = new Map<number, number>();
  const count = (): void => {
    for (const s of a.ws.snaps.splice(0)) for (const z of s.z) seen.set(z[0], (seen.get(z[0]) ?? 0) + 1);
  };
  for (let i = 0; i < 20 * 6; i++) {
    p.hp = 1e9;
    mock.timers.tick(50);
  }
  count();
  assert.ok(seen.size > 0, '웅덩이가 생겼다');
  // 레벨업 선택: 혼자라 월드가 멈춘다. 그동안 스냅샷은 계속 가지만 영역은 다시 실리지 않는다
  p.offers = ['coffee', 'cdn', 'work_life'];
  for (let i = 0; i < 20 * 3; i++) mock.timers.tick(50);
  count();
  assert.ok([...seen.values()].every((n) => n === 1), `같은 영역을 여러 번 보냈다: ${[...seen.entries()].filter(([, n]) => n > 1).length}개`);
  room.onPick(a.conn, 0);
  for (let i = 0; i < 20 * 5; i++) {
    p.hp = 1e9;
    mock.timers.tick(50);
  }
  count();
  assert.ok([...seen.values()].every((n) => n === 1));
  room.leave(a.conn);
});

test('입력 확인: 스냅샷에 마지막으로 받은 입력 번호, 그 입력으로 움직인 틱 수, 틱 사이의 어디쯤에서 도착했는지가 실린다', () => {
  const rooms = new RoomManager();
  const room = rooms.create('solo')!;
  const a = join(room, 'a');
  const me = room.world.players.get(a.conn.pid)!;
  const tick = (ms = 50): void => {
    me.hp = 1e9;
    if (me.offers) room.onPick(a.conn, 0);
    mock.timers.tick(ms);
  };
  tick();
  assert.deepEqual([a.ws.snaps.at(-1)!.ack, a.ws.snaps.at(-1)!.ackTicks], [0, 1], '입력을 받기 전에는 0 번');
  // 틱에서 20ms 지나서 도착한 입력: 20/50 틱 = 102/256
  tick(20);
  room.onInput(a.conn, 7, 1, 0);
  tick(30);
  let snap = a.ws.snaps.at(-1)!;
  assert.deepEqual([snap.ack, snap.ackTicks, snap.ackPhase], [7, 1, 102]);
  const x = snap.view[0];
  tick();
  tick();
  snap = a.ws.snaps.at(-1)!;
  assert.deepEqual([snap.ack, snap.ackTicks, snap.ackPhase], [7, 3, 102]);
  assert.ok(Math.abs(snap.view[0] - (x + 2 * 3.5)) < 0.11, '위치는 서버가 틱마다 계산한 그대로다');
  // 다시 연결하면 입력 번호를 처음부터 센다
  hangUp(room, a);
  const ws = socket();
  assert.ok(rooms.resume(keyOf(a.ws), ws as unknown as WebSocket));
  mock.timers.tick(50);
  assert.equal(ws.snaps.at(-1)!.ack, 0);
});

test('새로고침: 선택지와 함께 남은 횟수가 가고, 새로고침하면 새 선택지가 제한 시간을 처음부터 다시 세며 온다', () => {
  const rooms = new RoomManager();
  const room = rooms.create('solo')!;
  const a = join(room, 'a');
  const me = room.world.players.get(a.conn.pid)!;
  room.onReroll(a.conn, me.level);
  assert.equal(last(a.ws, 'levelup'), undefined, '선택 중이 아니면 아무것도 보내지 않는다');
  assert.equal(me.rerolls, OFFER_REROLLS);
  me.xp = me.xpNext;
  room.world.gems.push({ id: 99_999, x: me.x, y: me.y, v: 1 });
  advance(100);
  const first = last(a.ws, 'levelup')!;
  assert.deepEqual([first.timeout, first.rerolls, first.rerollable], [20, OFFER_REROLLS, true]);
  advance(8000);
  room.onReroll(a.conn, me.level);
  advance(50);
  const second = last(a.ws, 'levelup')!;
  assert.notDeepEqual(second.offers, first.offers);
  assert.ok(second.offers.every((o) => !first.offers.some((f) => f.id === o.id)), '지금 카드는 다시 나오지 않는다');
  assert.deepEqual([second.timeout, second.rerolls, second.rerollable], [20, OFFER_REROLLS - 1, true]);

  // 일시정지 중에는 틱이 돌지 않으므로 바로 보낸다 (남은 것을 모두 쓴다)
  room.onPause(a.conn, true);
  let third = second;
  for (let left = OFFER_REROLLS - 2; left >= 0; left--) {
    const n = a.ws.msgs.length;
    room.onReroll(a.conn, me.level);
    third = last(a.ws, 'levelup')!;
    assert.ok(a.ws.msgs.length > n, '바로 왔다');
    assert.deepEqual([third.rerolls, third.rerollable], [left, left > 0]);
  }

  // 다 쓴 뒤의 새로고침: 위반이 아니고, 지금 선택지를 (한 번) 다시 보내 화면이 기다리며 멈춰 있지 않게 한다
  const before = a.ws.msgs.length;
  room.onReroll(a.conn, me.level);
  const resent = a.ws.msgs.slice(before).filter((m) => m.t === 'levelup');
  assert.equal(resent.length, 1, '지금 선택지를 다시 보냈다');
  assert.deepEqual(resent[0], third);
  assert.equal(me.rerolls, 0);
  // 같은 선택지에는 한 번만 답한다: 멈춰 둔 채 거듭 보내도 답이 쌓이지 않는다 (전송량)
  const sent = a.ws.msgs.length;
  for (let i = 0; i < 50; i++) room.onReroll(a.conn, me.level);
  room.onReroll(a.conn, me.level - 1);
  assert.equal(a.ws.msgs.length, sent, '더는 답하지 않는다');
  room.onPause(a.conn, false);
  assert.equal(room.onPick(a.conn, 0), true);
  assert.equal(me.up[third.offers[0]!.id], third.offers[0]!.level, '고른 것은 마지막 새 선택지의 첫 카드');

  // 새 선택지가 뜨면 다시 한 번 답한다 (한 번만 답하는 것은 선택지마다다)
  me.xp = me.xpNext;
  room.world.gems.push({ id: 99_998, x: me.x, y: me.y, v: 1 });
  advance(100);
  const next = last(a.ws, 'levelup')!;
  assert.deepEqual([next.level, next.rerolls, next.rerollable], [third.level + 1, 0, false]);
  const m0 = a.ws.msgs.length;
  room.onReroll(a.conn, next.level);
  room.onReroll(a.conn, next.level);
  assert.equal(a.ws.msgs.slice(m0).filter((m) => m.t === 'levelup').length, 1);
});

test('새로고침: 다시 연결해도 남은 새로고침 수가 이어진다', () => {
  const rooms = new RoomManager();
  const room = rooms.create('solo')!;
  const a = join(room, 'a');
  const me = room.world.players.get(a.conn.pid)!;
  me.xp = me.xpNext;
  room.world.gems.push({ id: 99_999, x: me.x, y: me.y, v: 1 });
  advance(100);
  room.onReroll(a.conn, me.level);
  advance(50);
  const shown = last(a.ws, 'levelup')!;
  hangUp(room, a);
  const ws = socket();
  assert.ok(rooms.resume(keyOf(a.ws), ws as unknown as WebSocket));
  const again = last(ws, 'levelup')!;
  assert.deepEqual(again.offers, shown.offers);
  assert.deepEqual([again.rerolls, again.rerollable], [OFFER_REROLLS - 1, true]);
});

test('새로고침: 시간이 다 되어 서버가 대신 고르고 다음 레벨업으로 넘어간 뒤에 늦게 온 새로고침은 받지 않는다 (보지 못한 카드에 횟수를 쓰지 않는다)', () => {
  const rooms = new RoomManager();
  const room = rooms.create('solo')!;
  const a = join(room, 'a');
  const me = room.world.players.get(a.conn.pid)!;
  // 레벨업 두 번만큼의 경험치
  me.xp = me.xpNext + xpForLevel(me.level + 1) + 1;
  room.world.gems.push({ id: 99_999, x: me.x, y: me.y, v: 1 });
  advance(100);
  const first = last(a.ws, 'levelup')!;
  assert.equal(first.level, me.level);
  // 입력이 없으면 서버가 자리를 비운 것으로 보고 멈춰 둔다: 화면을 보고 있는 것처럼 입력을 보낸다
  for (let i = 0; i < 21; i++) {
    room.onInput(a.conn, i + 1, 0, 0);
    advance(1000);
  }
  const second = last(a.ws, 'levelup')!;
  assert.equal(second.level, first.level + 1, '서버가 대신 골랐고 다음 선택지가 떴다');
  // 화면은 아직 첫 선택지를 보고 새로고침을 눌렀다
  const before = a.ws.msgs.length;
  room.onReroll(a.conn, first.level);
  advance(50);
  assert.equal(a.ws.msgs.slice(before).filter((m) => m.t === 'levelup').length, 1, '지금 선택지를 한 번 다시 보낸다');
  assert.equal(me.rerolls, OFFER_REROLLS, '횟수가 줄지 않는다');
  assert.deepEqual(me.offers, second.offers.map((o) => o.id), '다음 선택지는 그대로');
  assert.deepEqual(last(a.ws, 'levelup')!.offers, second.offers);
  // 지금 선택지의 레벨로 보내면 받는다
  room.onReroll(a.conn, second.level);
  advance(50);
  assert.equal(me.rerolls, OFFER_REROLLS - 1);
});

test('자석은 방의 모두에게 누가 주웠는지, 체력 채우기는 채워진 사람에게만 알린다. 끌어당기기와 체력은 서버가 한다', () => {
  const rooms = new RoomManager();
  const room = rooms.create('coop')!;
  const a = join(room, 'a');
  const b = join(room, 'b');
  room.onStart(a.conn);
  const w = room.world;
  w.itemCd = 1e9;
  w.magnetCd = 1e9;
  const pa = w.players.get(a.conn.pid)!;
  const pb = w.players.get(b.conn.pid)!;
  pb.x = pa.x + 3000;
  pb.y = pa.y;
  for (const p of [pa, pb]) {
    p.xpNext = 1e9;
    p.cd.console_log = 1e9;
  }
  w.gems.push({ id: 90_001, x: pa.x + 2000, y: pa.y, v: 1 }, { id: 90_002, x: pa.x - 1200, y: pa.y + 900, v: 1 });
  w.items.push({ id: 90_010, kind: 'magnet', x: pa.x + 3, y: pa.y, ttl: 90 });
  mock.timers.tick(50);
  assert.deepEqual(last(a.ws, 'magnet'), { t: 'magnet', by: pa.id, gems: 2 });
  assert.deepEqual(last(b.ws, 'magnet'), { t: 'magnet', by: pa.id, gems: 2 }, '동료에게도 누가 주웠는지 알린다 (동료 근처의 경험치도 날아가므로)');
  assert.ok(w.gems.every((g) => g.to === pa.id), '끌어당기는 것은 서버');

  // 강화를 모두 마친 뒤의 레벨업 (무기 6칸·패시브 6칸이 모두 최대. 저절로 차는 워라밸은 빼서 찬 양을 정확히 잰다): 체력이 가득 차고 그 사람에게만 알린다
  for (const id of ['console_log', 'rubber_duck', 'hotfix', 'regex', 'ai_agent', 'firewall', 'coffee', 'cdn', 'stack_overflow', 'dark_mode', 'npm_install', 'mech_keyboard'] as const) {
    pb.up[id] = UPGRADES[id].max;
  }
  pb.hp = 7;
  pb.xp = 0;
  pb.xpNext = 5;
  w.gems.push({ id: 90_003, x: pb.x + 2, y: pb.y, v: 5 });
  mock.timers.tick(50);
  const refill = last(b.ws, 'refill');
  assert.ok(refill, '알림이 간다');
  assert.equal(refill.hp, Math.ceil(maxHpOf(pb)) - 7);
  assert.equal(pb.hp, maxHpOf(pb));
  assert.equal(last(b.ws, 'levelup'), undefined, '선택지는 오지 않는다');
  assert.equal(last(a.ws, 'refill'), undefined);
  room.leave(a.conn);
  room.leave(b.conn);
});
