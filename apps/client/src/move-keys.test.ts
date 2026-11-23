import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MoveKeys } from './move-keys';

test('이동 키: 판 중에는 방향키·WASD 를 이동으로 받고(기본 동작을 막는다), 대각선은 길이 1', () => {
  const k = new MoveKeys();
  assert.equal(k.down('ArrowDown', true), true);
  assert.deepEqual(k.dir(), { dx: 0, dy: 1 });
  assert.equal(k.down('KeyD', true), true);
  const d = k.dir();
  assert.ok(Math.abs(Math.hypot(d.dx, d.dy) - 1) < 1e-9 && d.dx > 0 && d.dy > 0);
  k.up('ArrowDown');
  assert.deepEqual(k.dir(), { dx: 1, dy: 0 });
  // 반대 방향을 함께 누르면 서로 지운다
  k.down('KeyA', true);
  assert.deepEqual(k.dir(), { dx: 0, dy: 0 });
  // 이동 키가 아니면 받지 않는다 (Esc, Space, PageDown 등은 그대로 둔다)
  for (const code of ['Escape', 'Space', 'PageDown', 'KeyP', 'KeyM', 'Enter', 'Tab']) assert.equal(k.down(code, true), false, code);
});

test('이동 키: 판이 아니거나 겹친 화면이 떠 있으면 키를 건드리지 않는다 (순위표·새 소식을 방향키로 스크롤할 수 있게)', () => {
  const k = new MoveKeys();
  for (const code of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD']) {
    assert.equal(k.down(code, false), false, code);
  }
  assert.deepEqual(k.dir(), { dx: 0, dy: 0 });
});

test('이동 키: 누른 채 메뉴가 열리면(비운 뒤 받지 않음) 멈추고, 닫힌 뒤 다시 누르면 움직인다', () => {
  const k = new MoveKeys();
  k.down('ArrowRight', true);
  assert.deepEqual(k.dir(), { dx: 1, dy: 0 });
  // 메뉴가 열리면 main.ts 가 input.reset() 으로 비운다. 누르고 있는 동안 계속 오는 keydown(자동 반복)은 받지 않는다
  k.clear();
  assert.equal(k.down('ArrowRight', false), false);
  assert.deepEqual(k.dir(), { dx: 0, dy: 0 });
  k.up('ArrowRight');
  // 메뉴를 닫으면 다시 받는다
  assert.equal(k.down('ArrowRight', true), true);
  assert.deepEqual(k.dir(), { dx: 1, dy: 0 });
});
