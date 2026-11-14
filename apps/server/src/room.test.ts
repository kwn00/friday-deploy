import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { WebSocket } from 'ws';
import { decodeSnapshot, type RunResult, type ServerMsg, type Snapshot } from '@friday-deploy/shared';
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
