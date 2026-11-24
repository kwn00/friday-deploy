import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EDGE_MAX_CHESTS, edgeSpot, hiddenAt, pickEdgeTargets, placeEdge, type Box } from './edge';

/** 400×800 화면 (세로 휴대폰), 가운데 (200, 400) */
const W = 400;
const H = 800;
const C = [W / 2, H / 2] as const;
const SCREEN: Box = { x0: 0, y0: 0, x1: W, y1: H };
const inside = (p: readonly number[], b: Box): boolean => p[0]! > b.x0 && p[0]! < b.x1 && p[1]! > b.y0 && p[1]! < b.y1;
const grow = (b: Box, r: number): Box => ({ x0: b.x0 - r, y0: b.y0 - r, x1: b.x1 + r, y1: b.y1 + r });
/** 가운데에서 p 로 가는 방향이 가운데에서 t 로 가는 방향과 같은지 */
const sameWay = (p: readonly number[], t: readonly number[]): boolean => {
  const a = Math.atan2(p[1]! - C[1], p[0]! - C[0]);
  const b = Math.atan2(t[1]! - C[1], t[0]! - C[0]);
  return Math.abs(a - b) < 1e-9;
};

test('edge: 화면 밖이거나 HUD 에 가려진 것만 표시한다', () => {
  const hud: Box[] = [{ x0: 300, y0: 0, x1: 400, y1: 100 }];
  assert.equal(hiddenAt(200, 400, W, H, hud), false, '화면 안');
  assert.equal(hiddenAt(0, 400, W, H, hud), false, '가장자리에 반쯤 걸친 것은 보인다');
  assert.equal(hiddenAt(-1, 400, W, H, hud), true);
  assert.equal(hiddenAt(200, 801, W, H, hud), true);
  assert.equal(hiddenAt(350, 50, W, H, hud), true, '미니맵에 가려졌다');
});

test('edge: 화면 끝에서 표시 반지름만큼 안쪽, 아이템 쪽으로 곧게', () => {
  const r = 30;
  assert.deepEqual(edgeSpot(C[0], C[1], 5000, 400, SCREEN, [], r, 0), [W - r, 400], '오른쪽');
  assert.deepEqual(edgeSpot(C[0], C[1], 200, -5000, SCREEN, [], r, 0), [200, r], '위');
  const t = [-300, 1500];
  const p = edgeSpot(C[0], C[1], t[0]!, t[1]!, SCREEN, [], r, 0)!;
  assert.ok(sameWay(p, t), '방향이 같다');
  assert.ok(Math.abs(p[1] - (H - r)) < 1e-9 || Math.abs(p[0] - r) < 1e-9, `화면 끝에 닿았다 (${p})`);
  assert.equal(edgeSpot(C[0], C[1], C[0], C[1], SCREEN, [], r, 0), null, '방향이 없다');
});

test('edge: HUD 에 닿기 직전에 멈춘다 (가려지지 않는다)', () => {
  const r = 30;
  // 오른쪽 위: 메뉴 버튼과 미니맵, 왼쪽 위: 체력바와 장비
  const hud: Box[] = [
    { x0: 300, y0: 8, x1: 392, y1: 140 },
    { x0: 8, y0: 8, x1: 200, y1: 90 },
  ];
  for (const t of [
    [900, -900],
    [250, -3000],
    [-50, -400],
    [350, 60], // 화면 안이지만 미니맵에 가려진 아이템
  ]) {
    const p = edgeSpot(C[0], C[1], t[0]!, t[1]!, SCREEN, hud, r, 0)!;
    assert.ok(sameWay(p, t), `${t}: 아이템 쪽`);
    for (const b of hud) assert.ok(!inside(p, grow(b, r - 1e-6)), `${t}: HUD 와 겹치지 않는다 (${p})`);
    assert.ok(p[0] >= r - 1e-9 && p[0] <= W - r + 1e-9 && p[1] >= r - 1e-9 && p[1] <= H - r + 1e-9, `${t}: 화면 안 (${p})`);
  }
  // 아래쪽은 HUD 가 없으므로 화면 끝까지
  assert.deepEqual(edgeSpot(C[0], C[1], 200, 5000, SCREEN, hud, r, 0), [200, H - r]);
});

test('edge: 노치·여백을 뺀 영역 안에, 캐릭터에서 너무 가깝지 않게', () => {
  const bounds: Box = { x0: 44, y0: 8, x1: 356, y1: 792 };
  assert.deepEqual(edgeSpot(C[0], C[1], -5000, 400, bounds, [], 20, 0), [64, 400]);
  // HUD 가 가운데 바로 옆까지 덮는 작은 화면: 최소 거리에서 멈춘다
  const p = edgeSpot(C[0], C[1], 200, -5000, SCREEN, [{ x0: 0, y0: 0, x1: 400, y1: 395 }], 20, 60)!;
  assert.deepEqual(p, [200, 340]);
});

test('edge: 필드 아이템은 모두, 보물상자는 가까운 것만. 먼 것부터 그린다', () => {
  const item = (id: number, x: number, chest = false): { id: number; x: number; y: number; chest: boolean } => ({ id, x, y: 0, chest });
  const items = [item(1, 900), item(2, -700), ...[100, 300, 500, 700, 1100].map((x, i) => item(10 + i, x, true))];
  const picked = pickEdgeTargets(items, (it) => it.chest, 0, 0);
  // 가장 먼 상자 둘(700, 1100)은 빠지고, 남은 것은 먼 것부터: 900, 700, 500, 300, 100
  assert.deepEqual(
    picked.map((it) => it.id),
    [1, 2, 12, 11, 10],
  );
  assert.equal(picked.filter((it) => it.chest).length, EDGE_MAX_CHESTS);
});

test('edge: 한곳에 몰린 표시는 방향을 돌려 겹치지 않게 놓는다 (가까운 것이 제자리, 화면 끝과 HUD 는 그대로 피한다)', () => {
  const cheb = (a: readonly number[], b: readonly number[]): number => Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!));
  const r = 30;
  const gap = 50;
  const check = (spots: [number, number][], hud: Box[], label: string): void => {
    for (let i = 0; i < spots.length; i++) {
      const p = spots[i]!;
      assert.ok(p[0] >= r - 1e-9 && p[0] <= W - r + 1e-9 && p[1] >= r - 1e-9 && p[1] <= H - r + 1e-9, `${label} ${i}: 화면 안 (${p})`);
      for (const b of hud) assert.ok(!inside(p, grow(b, r - 1e-6)), `${label} ${i}: HUD 와 겹치지 않는다 (${p})`);
      for (let j = i + 1; j < spots.length; j++) assert.ok(cheb(p, spots[j]!) >= gap - 1e-9, `${label} ${i}, ${j}: ${p} ${spots[j]}`);
    }
  };
  // 오른쪽으로 거의 같은 방향의 셋 (먼 것부터)
  const right = [
    { id: 1, x: 3000, y: 410 },
    { id: 2, x: 2000, y: 400 },
    { id: 3, x: 1000, y: 395 },
  ];
  const spots = placeEdge(right, C[0], C[1], SCREEN, [], r, 0, gap);
  assert.deepEqual(spots[2], edgeSpot(C[0], C[1], 1000, 395, SCREEN, [], r, 0), '가장 가까운 것은 제자리');
  check(spots, [], '오른쪽');

  // 좁은 화면: 캐릭터 바로 아래에 알림이 떠 있고, 아래쪽에 셋이 몰렸다
  const toast: Box[] = [{ x0: 60, y0: 480, x1: 340, y1: 560 }];
  const down = [
    { id: 4, x: 230, y: 2000 },
    { id: 5, x: 150, y: 1500 },
    { id: 6, x: 200, y: 1200 },
  ];
  check(placeEdge(down, C[0], C[1], SCREEN, toast, r, 40, gap), toast, '아래');
});
