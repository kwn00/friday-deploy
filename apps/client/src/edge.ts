/**
 * 화면 밖 아이템을 화면 가장자리에 표시할 자리 계산 (DOM 에 의존하지 않는 순수 함수 → 테스트 가능).
 *
 * 화면 가운데(내 캐릭터 또는 관전 시점)에서 아이템 쪽으로 곧게 가다가, 화면 가장자리에 닿거나
 * HUD(체력바·장비·메뉴 버튼·미니맵·알림)에 닿기 직전의 자리에 표시를 놓는다.
 * 그래서 표시는 HUD 에 가려지지 않고, 언제나 아이템이 있는 쪽을 가리킨다.
 * 좌표는 모두 캔버스의 기기 픽셀이다.
 */

/** 화면 위의 사각형: 왼쪽 위 (x0, y0), 오른쪽 아래 (x1, y1) */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 표시할 아이템 하나 (가장자리 표시의 대상) */
export interface EdgeTarget {
  id: number;
  /** 화면 좌표 (기기 픽셀). 화면 밖일 수 있다 */
  x: number;
  y: number;
}

/** 가장자리에 놓을 보물상자 표시의 최대 수 (가까운 것부터. 필드 아이템은 동시에 3개뿐이라 모두 표시한다) */
export const EDGE_MAX_CHESTS = 3;

/**
 * 아이템이 화면에서 보이지 않는지: 그림의 가운데가 화면 밖이거나 HUD 에 가려졌다.
 * (가운데가 화면 안이면 반쯤 걸쳐 보이는 것이라 표시하지 않는다)
 */
export function hiddenAt(x: number, y: number, w: number, h: number, hud: readonly Box[]): boolean {
  if (x < 0 || y < 0 || x > w || y > h) return true;
  return hud.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
}

/**
 * 가운데 (cx, cy) 에서 (tx, ty) 쪽으로 가는 반직선이 사각형 b 에 처음 들어가는 지점의 t (P = C + t·(T − C)).
 * 만나지 않거나 가운데가 이미 사각형 안이면 Infinity.
 */
function entryT(cx: number, cy: number, dx: number, dy: number, b: Box): number {
  let enter = -Infinity;
  let exit = Infinity;
  for (const [c, d, lo, hi] of [
    [cx, dx, b.x0, b.x1],
    [cy, dy, b.y0, b.y1],
  ] as const) {
    if (d === 0) {
      if (c < lo || c > hi) return Infinity;
      continue;
    }
    const t1 = (lo - c) / d;
    const t2 = (hi - c) / d;
    enter = Math.max(enter, Math.min(t1, t2));
    exit = Math.min(exit, Math.max(t1, t2));
  }
  if (enter > exit || exit <= 0 || enter <= 0) return Infinity;
  return enter;
}

/**
 * 표시의 가운데 자리.
 * - bounds: 표시가 들어갈 수 있는 화면 영역 (노치와 HUD 의 바깥 여백을 뺀 것)
 * - hud: 가리면 안 되는 HUD 사각형들
 * - r: 표시의 반지름 (화살표 끝까지). 테두리와 HUD 에서 이만큼 떨어뜨린다
 * - min: 가운데에서 이보다 가까이 오지는 않는다 (HUD 가 화면을 거의 다 덮는 아주 작은 화면에서 캐릭터를 덮지 않게)
 * 가운데와 같은 자리면 null (방향이 없다).
 */
export function edgeSpot(cx: number, cy: number, tx: number, ty: number, bounds: Box, hud: readonly Box[], r: number, min: number): [number, number] | null {
  const dx = tx - cx;
  const dy = ty - cy;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  // 화면 가장자리 (표시가 통째로 들어가도록 r 만큼 안쪽). 화면이 표시보다 작으면 가운데에 붙는다
  const x0 = Math.min(cx, bounds.x0 + r);
  const x1 = Math.max(cx, bounds.x1 - r);
  const y0 = Math.min(cy, bounds.y0 + r);
  const y1 = Math.max(cy, bounds.y1 - r);
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (x1 - cx) / dx);
  else if (dx < 0) t = Math.min(t, (x0 - cx) / dx);
  if (dy > 0) t = Math.min(t, (y1 - cy) / dy);
  else if (dy < 0) t = Math.min(t, (y0 - cy) / dy);
  // 아이템이 화면 가장자리보다 안쪽이면(HUD 에 가려진 경우) 아이템 자리를 넘어가지 않는다
  t = Math.min(t, 1);
  // HUD 에 닿기 직전 (r 만큼 키운 사각형에 들어가기 전).
  // 가운데가 이미 키운 사각형 안이면(HUD 가 가운데 바로 옆까지 온 아주 작은 화면) HUD 에 닿기 r 전에서 멈춘다 (아래에서 min 까지는 물러난다)
  for (const b of hud) {
    const g: Box = { x0: b.x0 - r, y0: b.y0 - r, x1: b.x1 + r, y1: b.y1 + r };
    let e = entryT(cx, cy, dx, dy, g);
    if (e === Infinity && cx > g.x0 && cx < g.x1 && cy > g.y0 && cy < g.y1) {
      const real = entryT(cx, cy, dx, dy, b);
      if (real !== Infinity) e = Math.max(0, real - r / len);
    }
    t = Math.min(t, e);
  }
  const far = Math.min(Math.max(t * len, Math.min(min, len)), len);
  return [cx + (dx / len) * far, cy + (dy / len) * far];
}

/**
 * 가장자리에 표시할 것을 고른다: 필드 아이템은 모두, 보물상자는 가까운 EDGE_MAX_CHESTS 개.
 * 돌려주는 순서는 그리는 순서다 (먼 것부터: 겹치면 가까운 것이 위에 보인다).
 */
export function pickEdgeTargets<T extends EdgeTarget>(items: readonly T[], isChest: (it: T) => boolean, cx: number, cy: number): T[] {
  const d2 = (it: T): number => (it.x - cx) ** 2 + (it.y - cy) ** 2;
  const chests = items.filter(isChest).sort((a, b) => d2(a) - d2(b)).slice(0, EDGE_MAX_CHESTS);
  return [...items.filter((it) => !isChest(it)), ...chests].sort((a, b) => d2(b) - d2(a) || a.id - b.id);
}

/** 겹친 표시를 비킬 때 방향을 한 번에 돌리는 각도와 한쪽으로 돌려 보는 최대 횟수 (4° × 15 = 60°) */
const TURN = (4 * Math.PI) / 180;
const TURNS = 15;

/**
 * 표시들의 자리를 정한다 (targets 는 그리는 순서 = 먼 것부터. 같은 순서로 돌려준다).
 * 가까운 것부터 edgeSpot 으로 자리를 잡는다. 먼저 자리 잡은 표시와 겹치면(표시는 네모라서 가로·세로 중 큰 쪽의 거리가 gap 보다 작으면)
 * 방향을 조금씩 돌려 다시 놓는다: 겹친 표시에서 멀어지는 쪽으로 60° 까지, 그래도 자리가 없으면 반대쪽으로.
 * 돌린 자리도 edgeSpot 이 정하므로 화면 끝과 HUD 를 똑같이 피한다. 끝내 자리가 없으면 겹친 채로 둔다.
 */
export function placeEdge(
  targets: readonly EdgeTarget[],
  cx: number,
  cy: number,
  bounds: Box,
  hud: readonly Box[],
  r: number,
  min: number,
  gap: number,
): [number, number][] {
  const out: [number, number][] = new Array(targets.length);
  const placed: [number, number][] = [];
  const clash = (p: readonly number[]): [number, number] | undefined =>
    placed.find((o) => Math.max(Math.abs(o[0] - p[0]!), Math.abs(o[1] - p[1]!)) < gap);
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i]!;
    const dist = Math.hypot(t.x - cx, t.y - cy);
    const base = Math.atan2(t.y - cy, t.x - cx);
    const at = (a: number): [number, number] => edgeSpot(cx, cy, cx + Math.cos(a) * dist, cy + Math.sin(a) * dist, bounds, hud, r, min) ?? [cx, cy + min];
    let spot = at(base);
    const o = clash(spot);
    if (o) {
      // 겹친 표시가 놓인 방향보다 시계 방향 쪽이면 시계 방향으로 (화면 좌표: y 가 아래)
      const other = Math.atan2(o[1] - cy, o[0] - cx);
      const away = Math.sin(base - other) >= 0 ? 1 : -1;
      let found: [number, number] | undefined;
      for (const dir of [away, -away]) {
        for (let n = 1; n <= TURNS && !found; n++) {
          const cand = at(base + dir * n * TURN);
          if (!clash(cand)) found = cand;
        }
        if (found) break;
      }
      if (found) spot = found;
    }
    out[i] = spot;
    placed.push(spot);
  }
  return out;
}
