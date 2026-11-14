import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { WebSocket } from 'ws';
import { decodeSnapshot, type RunResult, type ServerMsg, type Snapshot } from '@friday-deploy/shared';
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

test('리더보드: 함께 한 판은 coop 순위표에, 처음부터 끝까지 있던 사람만 이름이 오른다', () => {
  const reports: RunReport[] = [];
  const lb = new Leaderboard(new MemoryStore());
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
  down(room, a.conn);
  down(room, b.conn);
  down(room, late.conn);
  advance(100);
  assert.equal(reports.length, 1, '판 하나에 기록 하나');
  assert.deepEqual([reports[0]!.board, reports[0]!.names, reports[0]!.kills], ['coop', ['host', 'mate'], 42]);
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
  down(room, a.conn);
  down(room, late.conn);
  advance(100);
  assert.equal(reports.length, 2);
  assert.deepEqual([reports[1]!.board, reports[1]!.names], ['coop', ['host', 'late']]);
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
