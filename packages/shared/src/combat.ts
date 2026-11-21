/**
 * 전투: 무기 23종과 진화한 무기 6종의 동작, 투사체·소환물, 바닥 영역, 피해와 처치.
 * 서버에서만 "진짜"로 돈다. 클라이언트에는 결과(위치, 영역, 피격 표시)만 스냅샷으로 간다.
 *
 * 0.1 CPU 서버를 위해: 적은 틱마다 공간 격자에 넣고, 투사체·영역·오라는 주변 칸의 적만 본다.
 */
import { ENEMY_VIEW_RADIUS, GEM_PULL_SPEED, HEAL_DROP_CHANCE, HEAL_DROP_COOLDOWN, MAX_CHESTS, MAX_FLASHES, MAX_GEMS, MAX_HEALS, MAX_SHOTS, MAX_ZONES, PLAYER_BASE_SPEED } from './constants';
import { ENEMIES, ENEMY_IDS, UPGRADES, WEAPON_IDS, weaponStats, type ShotKind, type WeaponDef, type WeaponId, type WeaponStats, type ZoneKind } from './content';
import type { Enemy, Player, Shot, World, Zone } from './sim';
import { areaMultOf, cooldownMultOf, durationMultOf, effectiveStats, luckOf, lv, moveSpeedOf } from './stats';

/** 적 정의를 지역 상수로 잡아 둔다 (모듈 경계 너머의 이름은 틱마다 수천 번 읽으면 그 자체로 무겁다) */
const EN = ENEMIES;

/* ───────────── 공간 격자 ───────────── */

const CELL = 48;
/** 가장 큰 적의 반경: 주변 칸을 볼 때 이만큼 넉넉히 본다 */
const MAX_ENEMY_R = Math.max(...ENEMY_IDS.map((id) => EN[id].r));
const cellKey = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);

export class Grid {
  private cells = new Map<number, Enemy[]>();
  constructor(enemies: Enemy[]) {
    for (const e of enemies) {
      const k = cellKey(Math.floor(e.x / CELL), Math.floor(e.y / CELL));
      const list = this.cells.get(k);
      if (list) list.push(e);
      else this.cells.set(k, [e]);
    }
  }
  /** (x, y) 에서 r 안쪽에 몸이 걸치는 살아 있는 적마다 fn. fn 이 true 를 돌려주면 멈춘다 */
  near(x: number, y: number, r: number, fn: (e: Enemy) => boolean | void): void {
    // 적의 반경(가장 큰 것)까지 넉넉히 본다
    const reach = r + MAX_ENEMY_R;
    const x0 = Math.floor((x - reach) / CELL);
    const x1 = Math.floor((x + reach) / CELL);
    const y0 = Math.floor((y - reach) / CELL);
    const y1 = Math.floor((y + reach) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const list = this.cells.get(cellKey(cx, cy));
        if (!list) continue;
        for (const e of list) {
          if (e.hp <= 0) continue;
          const rr = r + EN[e.type].r;
          if ((e.x - x) ** 2 + (e.y - y) ** 2 > rr * rr) continue;
          if (fn(e) === true) return;
        }
      }
    }
  }
  /**
   * (x, y) 에서 r 안쪽에 몸이 걸칠 수 있는 칸에 든 적마다 fn. 거리와 체력은 보지 않는다 (부르는 쪽이 거른다).
   * 적끼리 밀어내기처럼 거리보다 싼 조건으로 먼저 거를 수 있을 때 쓴다
   */
  candidates(x: number, y: number, r: number, fn: (e: Enemy) => void): void {
    const reach = r + MAX_ENEMY_R;
    const x0 = Math.floor((x - reach) / CELL);
    const x1 = Math.floor((x + reach) / CELL);
    const y0 = Math.floor((y - reach) / CELL);
    const y1 = Math.floor((y + reach) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const list = this.cells.get(cellKey(cx, cy));
        if (!list) continue;
        for (const e of list) fn(e);
      }
    }
  }
  /** (x, y) 에서 maxDist 안의 가장 가까운 적 */
  nearest(x: number, y: number, maxDist: number): Enemy | null {
    let best: Enemy | null = null;
    let bd = Infinity;
    this.near(x, y, maxDist, (e) => {
      const d = (e.x - x) ** 2 + (e.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = e;
      }
    });
    return best;
  }
  /** (x, y) 에서 maxDist 안의 적 목록 */
  within(x: number, y: number, maxDist: number): Enemy[] {
    const out: Enemy[] = [];
    this.near(x, y, maxDist, (e) => void out.push(e));
    return out;
  }
}

/* ───────────── 피해 ───────────── */

/**
 * 같은 공격(key)이 같은 적을 너무 자주 때리지 않게 한다. every 초가 지나야 다시 맞힐 수 있다.
 * key: 투사체·영역은 자기 id, 오라·러버덕처럼 계속 붙어 있는 것은 (플레이어, 무기)로 만든 음수.
 */
export function lock(e: Enemy, key: number, now: number, every: number): boolean {
  const map = (e.lock ??= new Map());
  const at = map.get(key);
  if (at !== undefined && at > now) return false;
  map.set(key, now + every);
  if (map.size > 48) for (const [k, t] of map) if (t <= now) map.delete(k);
  return true;
}
const ownKey = (p: Player, w: WeaponId): number => -(p.id * 64 + WEAPON_IDS.indexOf(w) + 1);

/** 넉백이 이어지는 시간(초) (뱀서 Knockback: 120ms) */
const KB_TIME = 0.12;
/** 디버거의 중단점에 맞은 버그가 멈춰 있는 시간(초). 보스와 빙결 저항이 1 보다 큰 적은 멈추지 않는다 */
export const BREAKPOINT_FREEZE = 0.3;

/**
 * 무기로 때린다: 치명타(운이 곱해진 확률), 피해, 넉백, 방화벽의 약화. 결과가 화면에 보이는 일이라 보이는 난수를 쓴다.
 */
export function hit(world: World, e: Enemy, dmg: number, by: Player | undefined, w: WeaponId): void {
  if (e.hp <= 0) return;
  const def = UPGRADES[w] as WeaponDef;
  if (def.crit && by && world.rng() < def.crit.chance * luckOf(by)) dmg *= def.crit.mult;
  damage(world, e, dmg, by);
  if (e.hp <= 0) return;
  const ed = EN[e.type];
  if (w === 'firewall' && !ed.debuffRes) {
    // 방화벽에 맞을 때마다 더 잘 밀리고(상한까지) 더 잘 언다 (뱀서 Garlic)
    e.kbTaken = Math.min(ed.kbMax, e.kbTaken + 0.3);
    e.resFreeze = Math.max(0, e.resFreeze - 0.1);
  }
  // 디버거: 맞은 버그가 잠깐 멈춘다 (얼음과 같은 상태: 움직이지도 때리지도 못한다)
  if (w === 'debugger' && !ed.boss && e.resFreeze <= 1) e.frozen = Math.max(e.frozen, BREAKPOINT_FREEZE);
  const mult = def.kb * e.kbTaken;
  if (mult !== 0) {
    e.kbTime = KB_TIME;
    e.kbMult = mult;
  }
}

export function damage(world: World, e: Enemy, dmg: number, by: Player | undefined): void {
  if (e.hp <= 0 || dmg <= 0) return;
  e.hp -= dmg;
  e.hit = true;
  if (e.hp > 0) return;
  if (by) by.kills++;
  const def = EN[e.type];
  if (def.xp > 0) dropGem(world, e.x, e.y, def.xp);
  // 보스는 보물상자를 떨어뜨린다 (끌려오지 않는다. 직접 닿아야 연다)
  dropChest(world, e);
  // 회복 아이템: 쿨다운이 끝났을 때 낮은 확률로
  // 드롭 여부는 비밀 난수로 정한다 (보이는 난수를 쓰면 시드를 아는 사람이 드롭을 미리 알고 처치 순서로 조종할 수 있다)
  if (!def.boss && world.healCd <= 0 && world.secret() < HEAL_DROP_CHANCE) {
    world.healCd = HEAL_DROP_COOLDOWN;
    if (world.heals.length >= MAX_HEALS) world.heals.shift();
    world.heals.push({ id: world.nextId++, x: e.x, y: e.y });
  }
}

/**
 * 경험치를 떨어뜨린다. 땅에는 MAX_GEMS 개까지만 둔다 (스냅샷과 서버 계산이 커지지 않게).
 * 가득 차 있으면, 살아 있는 모두에게서 가장 멀리 있는 경험치 하나를 없애고 그 값을 새로 떨어지는 경험치에 더한다.
 * 그래서 적을 잡으면 언제나 그 자리에 경험치가 떨어지고, 경험치의 총량도 그대로다 (값이 커지면 색도 빨강이 된다).
 * 예전에는 넘친 경험치를 처음 넘친 자리의 빨간 경험치 하나에 모았는데(뱀서 규칙), 그 자리가 화면 밖이 되면
 * 적을 잡아도 경험치가 하나도 떨어지지 않는 것처럼 보였다. 끌려오는 중인 경험치는 없애지 않는다.
 */
function dropGem(world: World, x: number, y: number, v: number): void {
  if (world.gems.length >= MAX_GEMS) {
    const i = farthestGem(world);
    if (i >= 0) v += world.gems.splice(i, 1)[0]!.v;
    else {
      // 모두 끌려오는 중 (거의 없는 일): 새로 만들지 않고 하나에 더한다
      world.gems[0]!.v += v;
      return;
    }
  }
  world.gems.push({ id: world.nextId++, x, y, v });
}

/** 살아 있는 사람 중 가장 가까운 사람과의 거리가 가장 먼 경험치의 위치 (끌려오는 중인 것은 빼고, 없으면 -1) */
function farthestGem(world: World): number {
  const alive = [...world.players.values()].filter((p) => p.alive);
  let best = -1;
  let far = -1;
  for (let i = 0; i < world.gems.length; i++) {
    const g = world.gems[i]!;
    if (g.to !== undefined) continue;
    let near = Infinity;
    for (const p of alive) near = Math.min(near, (g.x - p.x) ** 2 + (g.y - p.y) ** 2);
    if (near > far) {
      far = near;
      best = i;
    }
  }
  return best;
}

/** 경험치 없이 지운다 (git clean). 처치 수는 센다. 보스의 보물상자는 그 자리에 떨어진다 */
function erase(world: World, e: Enemy, by: Player): void {
  if (e.hp <= 0) return;
  e.hp = 0;
  by.kills++;
  if (e.chest) dropChest(world, e);
}

function dropChest(world: World, e: Enemy): void {
  if (!e.chest) return;
  const chests = world.items.filter((it) => it.kind === 'chest');
  if (chests.length >= MAX_CHESTS) world.items.splice(world.items.indexOf(chests[0]!), 1);
  world.items.push({ id: world.nextId++, kind: 'chest', x: e.x, y: e.y, ttl: Infinity, chest: e.chest, born: world.tick });
}

function addZone(world: World, z: Omit<Zone, 'id' | 'born' | 'w'> & { w?: WeaponId }): Zone | null {
  // 피해를 주는 영역과 보이기만 하는 영역은 따로 센다 (보이기만 하는 것이 웅덩이·발자국의 자리를 빼앗지 않게)
  const hurts = z.dmg > 0;
  let n = 0;
  for (const other of world.zones) if (other.dmg > 0 === hurts) n++;
  if (n >= (hurts ? MAX_ZONES : MAX_FLASHES)) return null;
  const zone: Zone = { id: world.nextId++, born: world.tick, w: z.w ?? 'console_log', ...z };
  world.zones.push(zone);
  return zone;
}

/** 보이기만 하는 짧은 영역 (피해는 만들 때 한 번에 준다) */
function flash(world: World, p: Player, kind: ZoneKind, x: number, y: number, r: number, aux: number, ttl: number): void {
  addZone(world, { kind, owner: p.id, x, y, r, aux, ttl, dmg: 0, every: 0 });
}

/** 각도(라디안)를 영역의 aux 바이트(0~255)로 */
const angleByte = (a: number): number => Math.round((((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * 256) & 255;

function blast(world: World, grid: Grid, p: Player, w: WeaponId, x: number, y: number, r: number, dmg: number): void {
  grid.near(x, y, r, (e) => hit(world, e, dmg, p, w));
  flash(world, p, 'blast', x, y, r, 0, 0.2);
}

/** 방향 (ax, ay) 로 길이 len, 폭 width 인 직사각형 안의 적에게 */
function strip(grid: Grid, x: number, y: number, ax: number, ay: number, len: number, width: number, fn: (e: Enemy) => void): void {
  const cx = x + (ax * len) / 2;
  const cy = y + (ay * len) / 2;
  grid.near(cx, cy, Math.hypot(len / 2, width / 2), (e) => {
    const rx = e.x - x;
    const ry = e.y - y;
    const along = rx * ax + ry * ay;
    const across = Math.abs(rx * -ay + ry * ax);
    const er = EN[e.type].r;
    if (along >= -er && along <= len + er && across <= width / 2 + er) fn(e);
  });
}

/* ───────────── 투사체 ───────────── */

interface ShotSpec {
  kind: ShotKind;
  /** 어느 무기의 것인지 (치명타·넉백) */
  w: WeaponId;
  x: number;
  y: number;
  ang: number;
  speed: number;
  ttl: number;
  dmg: number;
  pierce: number;
  r: number;
  /** 같은 적을 다시 맞힐 수 있는 간격(초). 0 이면 적마다 한 번만 */
  rehit?: number;
  /** 움직임 계산에 쓰는 기준 시간 (롤백: 이 시간의 절반에 되돌아서고, ttl 까지 계속 날아간다). 없으면 ttl */
  life?: number;
}

function fire(world: World, p: Player, s: ShotSpec): Shot | null {
  if (world.shots.length >= MAX_SHOTS) return null;
  const shot: Shot = {
    id: world.nextId++,
    kind: s.kind,
    w: s.w,
    owner: p.id,
    x: s.x,
    y: s.y,
    vx: Math.cos(s.ang) * s.speed,
    vy: Math.sin(s.ang) * s.speed,
    ttl: s.ttl,
    life: s.life ?? s.ttl,
    dmg: s.dmg,
    pierce: s.pierce,
    r: s.r,
    rehit: s.rehit ?? 0,
    hit: new Set(),
    turn: 0,
  };
  world.shots.push(shot);
  return shot;
}

/** 핑퐁이 튕기는 상자: 주인 기준 ± (화면 크기 정도) */
const BOUNCE_X = 190;
const BOUNCE_Y = 120;
/** 벽돌책의 중력 (px/s²) */
const GRAVITY = 420;
/** 고양이가 방향을 바꾸는 간격(초) */
const CAT_TURN = 0.6;

export function updateShots(world: World, grid: Grid, dt: number): void {
  for (const s of world.shots) {
    const owner = world.players.get(s.owner);
    s.ttl -= dt;
    const age = s.life - s.ttl;
    if (s.kind === 'book') s.vy += GRAVITY * dt;
    if (s.kind === 'rollback') {
      // 처음 방향 그대로, 속도가 줄다가 뒤집혀 돌아오고, 던진 자리를 지나 계속 날아간다 (뱀서 Cross)
      const k = Math.max(-1, 1 - (2 * age) / s.life);
      s.x += s.vx * k * dt;
      s.y += s.vy * k * dt;
    } else {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    if ((s.kind === 'ping' || s.kind === 'socket') && owner) {
      if (Math.abs(s.x - owner.x) > BOUNCE_X && Math.sign(s.vx) === Math.sign(s.x - owner.x)) s.vx = -s.vx;
      if (Math.abs(s.y - owner.y) > BOUNCE_Y && Math.sign(s.vy) === Math.sign(s.y - owner.y)) s.vy = -s.vy;
    }
    if (s.kind === 'cat') {
      s.turn -= dt;
      if (s.turn <= 0) {
        s.turn = CAT_TURN;
        const a = world.rng() * Math.PI * 2;
        const sp = Math.hypot(s.vx, s.vy);
        s.vx = Math.cos(a) * sp;
        s.vy = Math.sin(a) * sp;
      }
    }
    if (s.ttl <= 0) continue;
    grid.near(s.x, s.y, s.r, (e) => {
      if (s.rehit > 0) {
        if (!lock(e, s.id, world.time, s.rehit)) return;
      } else {
        if (s.hit.has(e.id)) return;
        s.hit.add(e.id);
      }
      hit(world, e, s.dmg, owner, s.w);
      if (s.pierce-- <= 0) {
        s.ttl = 0;
        return true;
      }
    });
  }
  world.shots = world.shots.filter((s) => s.ttl > 0);
}

/* ───────────── 바닥 영역 ───────────── */

export function updateZones(world: World, grid: Grid, dt: number): void {
  for (const z of world.zones) {
    z.ttl -= dt;
    if (z.ttl <= 0 || z.dmg <= 0) continue;
    const owner = world.players.get(z.owner);
    const fn = (e: Enemy): void => {
      if (lock(e, z.id, world.time, z.every)) hit(world, e, z.dmg, owner, z.w);
    };
    // 세로 띠(무한 스크롤)는 직사각형, 나머지는 원
    if (z.kind === 'band') strip(grid, z.x, z.y - z.aux * 2, 0, 1, z.aux * 4, z.r, fn);
    else grid.near(z.x, z.y, z.r, fn);
  }
  world.zones = world.zones.filter((z) => z.ttl > 0);
}

/* ───────────── 러버덕 · 소환물 ───────────── */

export interface DuckState {
  /** 지금 돌고 있는 수 (쉬는 중이면 0) */
  n: number;
  /** 반경(px, 정수)과 각속도(rad/s, 0.1 단위). 클라이언트가 같은 값으로 같은 자리에 그리도록 반올림해서 쓴다 */
  radius: number;
  speed: number;
}

export function duckState(p: Player): DuckState {
  if (lv(p, 'rubber_duck') === 0 || !p.alive) return { n: 0, radius: 0, speed: 0 };
  const st = effectiveStats(p, 'rubber_duck');
  return {
    n: p.duckOn > 0 ? Math.min(7, st.amount) : 0,
    radius: Math.min(255, Math.round(st.area)),
    speed: Math.min(25.5, Math.round(st.speed * 10) / 10),
  };
}

/** i 번째 오리(총 n 마리)의 주인 기준 위치. 서버 판정과 클라이언트 그리기가 함께 쓴다 */
export function duckOffset(time: number, i: number, n: number, radius: number, speed: number): [number, number] {
  const a = time * speed + (i * Math.PI * 2) / n;
  return [Math.cos(a) * radius, Math.sin(a) * radius];
}

/** 방화벽 반경 (px, 정수. 없으면 0) */
export function auraRadius(p: Player): number {
  if (lv(p, 'firewall') === 0 || !p.alive) return 0;
  return Math.min(255, Math.round(effectiveStats(p, 'firewall').area));
}

/** 카나리아·부엉이가 도는 반경 (뱀서: 공격 범위는 폭탄 크기만 키우고 원의 크기는 그대로) */
const PET_ORBIT = 64;

/** 카나리아·부엉이의 자리. 24시간 모니터링이면 그 무기의 빠르기로 두 마리가 함께 돈다 */
export function petPosition(world: World, p: Player, w: 'canary' | 'night_owl'): [number, number] {
  const st = effectiveStats(p, lv(p, 'monitoring') > 0 ? 'monitoring' : w);
  const dir = w === 'canary' ? 1 : -1;
  const a = dir * world.time * st.speed + (w === 'night_owl' ? Math.PI : 0);
  return [p.x + Math.cos(a) * PET_ORBIT, p.y + Math.sin(a) * PET_ORBIT];
}

/* ───────────── 무기 ───────────── */

/** 무기가 겨누는 거리 */
const AIM = 200;

/** 이만큼 이상 기울여야 "달리는 중"으로 친다 (거의 0 인 입력으로 제자리에서 달리는 척하지 못하게) */
const RUNNING = 0.3;

/** 시간 비교의 오차 (소수 덧셈으로 쌓이는 아주 작은 값) */
const EPS = 1e-9;

/** 커밋 히스토리가 움직이는 동안 커밋을 남기는 간격(초) (뱀서 Shadow Pinion 의 interval) */
const TRAIL_INTERVAL = 0.3;

const rehitOf = (w: WeaponId): number => (UPGRADES[w] as WeaponDef).rehit ?? 0.5;

/**
 * 한 플레이어의 무기를 한 틱 돌린다.
 * 쿨다운이 끝난 무기는 쏜다. 겨눌 적이 없어 못 쏜 무기는 쿨다운을 다시 걸지 않고 다음 틱에 다시 본다.
 */
export function runWeapons(world: World, grid: Grid, p: Player, dt: number): void {
  const moving = Math.hypot(p.dx, p.dy) >= RUNNING;
  const stopped = !moving && p.moveTime > 0;
  p.moveTime = moving ? p.moveTime + dt : 0;

  for (const w of WEAPON_IDS) {
    if (lv(p, w) === 0) continue;
    const st = effectiveStats(p, w);

    // 쿨다운과 상관없이 계속 붙어 있는 것들
    if (w === 'firewall') {
      // 쿨다운 = 같은 적을 다시 태우는 간격 (뱀서 Garlic). 밀어내지는 않고 약하게 만든다
      grid.near(p.x, p.y, st.area, (e) => {
        if (lock(e, ownKey(p, w), world.time, st.cd)) hit(world, e, st.dmg, p, w);
      });
      continue;
    }
    if (w === 'rubber_duck') {
      runDucks(world, grid, p, st, dt);
      continue;
    }
    if (w === 'canary' || w === 'night_owl') {
      if (p.pets[w] === undefined) p.pets[w] = world.nextId++;
      runBirds(world, grid, p, w, st, dt);
      continue;
    }
    if (w === 'monitoring') {
      runMonitoring(world, grid, p, st, dt);
      continue;
    }
    // 2단계 인증: 방패가 남아 있는 동안은 쿨다운이 돌지 않는다 (다 쓰면 다시 채우기 시작)
    if (w === 'two_factor' && p.charges > 0) continue;
    // 커밋 히스토리: 멈추는 순간, 남아 있는 커밋을 바라보는 쪽으로 한꺼번에 날리고 쿨다운을 건다
    if (w === 'commit_history' && stopped) {
      launchTrail(world, p, st);
      continue;
    }

    const cd = (p.cd[w] ?? 0) - dt;
    if (cd > EPS) {
      p.cd[w] = cd;
      continue;
    }
    // 커밋 히스토리: 쿨다운이 끝난 뒤 움직이는 동안, 0.3초 × 쿨다운 배율 ÷ 이동 속도 배율마다 남긴다
    // (뱀서 Shadow Pinion: 움직이는 동안 생기고, 이동 속도가 빠를수록 자주 생긴다. 간격 0.3초는 위키의 interval)
    if (w === 'commit_history') {
      p.cd[w] = 0;
      if (!moving) continue;
      const spawn = (p.on[w] ?? 0) - dt;
      if (spawn > 0) {
        p.on[w] = spawn;
        continue;
      }
      p.on[w] = (TRAIL_INTERVAL * cooldownMultOf(p)) / (moveSpeedOf(p) / PLAYER_BASE_SPEED);
      useWeapon(world, grid, p, w, st);
      continue;
    }
    if (useWeapon(world, grid, p, w, st)) p.cd[w] = st.cd;
    else p.cd[w] = 0;
  }
}

function runDucks(world: World, grid: Grid, p: Player, st: WeaponStats, dt: number): void {
  // 뱀서 King Bible: (쿨다운 + 단계의 지속 시간) × 쿨다운 배율마다 새로 켜지고, 켜지면 지속 시간 × keep-alive 배율 동안 돈다.
  // keep-alive 로 켜져 있는 시간이 주기보다 길어지면 계속 돈다.
  const levelDur = weaponStats('rubber_duck', lv(p, 'rubber_duck')).dur;
  if (p.duckOn > 0) p.duckOn = Math.max(0, p.duckOn - dt);
  const cd = (p.cd.rubber_duck ?? 0) - dt;
  if (cd <= 0) {
    p.cd.rubber_duck = (weaponStats('rubber_duck', lv(p, 'rubber_duck')).cd + levelDur) * cooldownMultOf(p);
    p.duckOn = Math.max(p.duckOn, levelDur * durationMultOf(p));
  } else p.cd.rubber_duck = cd;
  const ds = duckState(p);
  // 오리 크기도 듀얼 모니터로 커진다
  const hitR = 6 * areaMultOf(p);
  for (let i = 0; i < ds.n; i++) {
    const [ox, oy] = duckOffset(world.time, i, ds.n, ds.radius, ds.speed);
    grid.near(p.x + ox, p.y + oy, hitR, (e) => {
      // 오리마다 따로, 같은 적을 1.7초에 한 번 (뱀서 King Bible 의 hitbox delay)
      if (lock(e, ownKey(p, 'rubber_duck') - i * 4096, world.time, rehitOf('rubber_duck'))) hit(world, e, st.dmg, p, 'rubber_duck');
    });
  }
}

/**
 * 카나리아·부엉이 (뱀서 Peachone·Ebony Wings): 지속 시간(4초) 동안 쿨다운마다 폭탄 한 묶음(개수만큼)을 떨어뜨리고,
 * 그다음 쿨다운만큼 쉰다.
 */
function runBirds(world: World, grid: Grid, p: Player, w: 'canary' | 'night_owl', st: WeaponStats, dt: number): void {
  // 시간은 소수 덧셈이라 오차가 쌓인다 (4.0 - 0.05 × 80 = 5.8e-15): 아주 작은 값은 0 으로 본다
  const on = p.on[w] ?? 0;
  if (on > EPS) {
    p.on[w] = on - dt;
    const cd = (p.cd[w] ?? 0) - dt;
    if (cd <= EPS) {
      p.cd[w] = st.cd;
      useWeapon(world, grid, p, w, st);
    } else p.cd[w] = cd;
    if (on - dt <= EPS) {
      p.on[w] = 0;
      p.cd[w] = st.cd; // 쉬는 시간
    }
    return;
  }
  const cd = (p.cd[w] ?? 0) - dt;
  if (cd > EPS) {
    p.cd[w] = cd;
    return;
  }
  p.on[w] = st.dur;
  p.cd[w] = 0;
}

/**
 * 24시간 모니터링 (카나리아 + 부엉이): 두 마리가 쉬지 않고 돌며 쿨다운마다 저마다 폭탄 한 묶음(개수만큼)을 떨어뜨린다.
 * 재료였던 새의 id 를 그대로 쓴다 (테스트처럼 처음부터 가진 경우에는 새로 만든다)
 */
function runMonitoring(world: World, grid: Grid, p: Player, st: WeaponStats, dt: number): void {
  for (const b of ['canary', 'night_owl'] as const) if (p.pets[b] === undefined) p.pets[b] = world.nextId++;
  const cd = (p.cd.monitoring ?? 0) - dt;
  if (cd > EPS) {
    p.cd.monitoring = cd;
    return;
  }
  p.cd.monitoring = st.cd;
  for (const b of ['canary', 'night_owl'] as const) dropBombs(world, grid, p, 'monitoring', petPosition(world, p, b), st);
}

/** 새 한 마리가 자기 자리 둘레에 폭탄을 개수만큼 떨어뜨린다 (첫 발은 바로 아래) */
function dropBombs(world: World, grid: Grid, p: Player, w: WeaponId, [bx, by]: [number, number], st: WeaponStats): void {
  const n = Math.max(1, Math.round(st.amount));
  for (let i = 0; i < n; i++) {
    const a = world.rng() * Math.PI * 2;
    const d = i === 0 ? 0 : world.rng() * 18;
    blast(world, grid, p, w, bx + Math.cos(a) * d, by + Math.sin(a) * d, st.area, st.dmg);
  }
}

/** 커밋 히스토리: 남아 있는 내 커밋을 바라보는 쪽으로 날린다. 오래 남아 있던 것일수록 세다 (피해 × (1 + 남아 있던 초)) */
function launchTrail(world: World, p: Player, st: WeaponStats): void {
  const ang = Math.atan2(p.fy, p.fx);
  let launched = 0;
  for (const z of world.zones) {
    if (z.owner !== p.id || z.kind !== 'trail' || z.ttl <= 0) continue;
    launched++;
    const age = (world.tick - z.born) / 20;
    fire(world, p, { kind: 'drill', w: 'commit_history', x: z.x, y: z.y, ang, speed: 260, ttl: 0.6 * areaMultOf(p), dmg: st.dmg * (1 + age), pierce: 999, r: st.area });
    // 땅의 커밋은 날아갔으니 화면에서도 지우게 알린다
    z.ttl = 0;
    world.gone.push({ id: z.id, tick: world.tick });
  }
  if (launched === 0) return;
  p.cd.commit_history = st.cd;
  p.trailX = Number.NaN;
  p.trailY = Number.NaN;
}

/** 무작위 적 하나 (보이는 난수) */
function randomTarget(world: World, grid: Grid, p: Player, r: number): Enemy | null {
  const near = grid.within(p.x, p.y, r);
  return near.length > 0 ? near[Math.floor(world.rng() * near.length)]! : null;
}

/** 쐈으면 true (겨눌 것이 없으면 false) */
function useWeapon(world: World, grid: Grid, p: Player, w: WeaponId, st: WeaponStats): boolean {
  const n = Math.max(1, Math.round(st.amount));
  switch (w) {
    case 'console_log':
    case 'debugger': {
      // 뱀서 Magic Wand: 가장 가까운 적에게 차례로 쏜다. 앞의 탄이 잡을 적을 빼고 다음으로 가까운 적을 겨눈다
      // (위키의 0.1초 간격은 없이 한 번에 쏘되, 겨누는 순서로 같은 효과를 낸다). 디버거는 중단점을 쏜다 (맞은 버그가 멈춘다: hit)
      const near = grid.within(p.x, p.y, AIM);
      if (near.length === 0) return false;
      near.sort((a, b) => (a.x - p.x) ** 2 + (a.y - p.y) ** 2 - ((b.x - p.x) ** 2 + (b.y - p.y) ** 2));
      const kind = w === 'debugger' ? 'breakpoint' : 'log';
      for (let i = 0; i < n; i++) {
        const t = near[i % near.length]!;
        fire(world, p, { kind, w, x: p.x, y: p.y, ang: Math.atan2(t.y - p.y, t.x - p.x), speed: st.speed, ttl: st.dur, dmg: st.dmg, pierce: st.pierce, r: st.area });
      }
      return true;
    }
    case 'regex': {
      // 바라보는 방향으로 나란히
      const ang = Math.atan2(p.fy, p.fx);
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * 6;
        fire(world, p, { kind: 'regex', w, x: p.x - p.fy * off, y: p.y + p.fx * off, ang, speed: st.speed, ttl: st.dur, dmg: st.dmg, pierce: st.pierce, r: st.area });
      }
      return true;
    }
    case 'ai_agent': {
      // 무작위 적 하나에게 여러 발을 부채꼴로 (뱀서 Fire Wand)
      const t = randomTarget(world, grid, p, AIM * 1.1);
      if (!t) return false;
      const base = Math.atan2(t.y - p.y, t.x - p.x);
      for (let i = 0; i < n; i++) {
        fire(world, p, { kind: 'ai', w, x: p.x, y: p.y, ang: base + (i - (n - 1) / 2) * 0.12, speed: st.speed, ttl: st.dur, dmg: st.dmg, pierce: st.pierce, r: st.area });
      }
      return true;
    }
    case 'ctrl_x': {
      // 좌우로만 자른다: 첫 번째는 바라보는 쪽, 두 번째는 반대쪽, 그다음은 조금씩 위아래로 비켜서
      for (let i = 0; i < n; i++) {
        const side = i % 2 === 0 ? p.face : -p.face;
        const y = p.y + Math.floor(i / 2) * (i % 4 < 2 ? -12 : 12);
        strip(grid, p.x, y, side, 0, st.area, st.area * 0.4, (e) => hit(world, e, st.dmg, p, w));
        flash(world, p, 'slash', p.x + (side * st.area) / 2, y, st.area, angleByte(side > 0 ? 0 : Math.PI), st.dur);
      }
      return true;
    }
    case 'brick_book': {
      for (let i = 0; i < n; i++) {
        const vx = (world.rng() * 2 - 1) * 70;
        const shot = fire(world, p, { kind: 'book', w, x: p.x, y: p.y, ang: -Math.PI / 2, speed: st.speed, ttl: st.dur, dmg: st.dmg, pierce: st.pierce, r: st.area });
        if (shot) shot.vx = vx;
      }
      return true;
    }
    case 'rollback': {
      // 실제로 날아가는 거리(속도 × 지속 / 4) 안의 적만 겨눈다. 돌아온 뒤에도 지속의 절반만큼 더 날아간다
      const t = grid.nearest(p.x, p.y, (st.speed * st.dur) / 4 + 10);
      const base = t ? Math.atan2(t.y - p.y, t.x - p.x) : Math.atan2(p.fy, p.fx);
      for (let i = 0; i < n; i++) {
        fire(world, p, { kind: 'rollback', w, x: p.x, y: p.y, ang: base + (i - (n - 1) / 2) * 0.35, speed: st.speed, ttl: st.dur * 1.5, life: st.dur, dmg: st.dmg, pierce: 999, r: st.area, rehit: 0.5 });
      }
      return true;
    }
    case 'hotfix': {
      const near = grid.within(p.x, p.y, AIM);
      for (let i = 0; i < n; i++) {
        let x: number;
        let y: number;
        if (near.length > 0) {
          const t = near[Math.floor(world.rng() * near.length)]!;
          x = t.x;
          y = t.y;
        } else {
          const a = world.rng() * Math.PI * 2;
          const d = 40 + world.rng() * 80;
          x = p.x + Math.cos(a) * d;
          y = p.y + Math.sin(a) * d;
        }
        addZone(world, { kind: 'pool', w, owner: p.id, x, y, r: st.area, aux: 0, ttl: st.dur, dmg: st.dmg, every: rehitOf(w) });
      }
      return true;
    }
    case 'friday_deploy': {
      // 첫 불은 내 발밑에, 나머지는 가까운 버그들 자리에 (없으면 내 둘레 아무 데나). 같은 적을 0.5초에 한 번 태운다
      const near = grid.within(p.x, p.y, AIM);
      for (let i = 0; i < n; i++) {
        let x = p.x;
        let y = p.y;
        if (i > 0 && near.length > 0) {
          const t = near[Math.floor(world.rng() * near.length)]!;
          x = t.x;
          y = t.y;
        } else if (i > 0) {
          const a = world.rng() * Math.PI * 2;
          const d = 40 + world.rng() * 80;
          x = p.x + Math.cos(a) * d;
          y = p.y + Math.sin(a) * d;
        }
        addZone(world, { kind: 'fire', w, owner: p.id, x, y, r: st.area, aux: 0, ttl: st.dur, dmg: st.dmg, every: rehitOf(w) });
      }
      return true;
    }
    case 'ping_pong':
    case 'websocket': {
      // 웹소켓은 지속(keep-alive 를 가지고 있으면 4.4초 이상)이 쿨다운(4초)보다 길어서 공이 끊이지 않는다
      const kind = w === 'websocket' ? 'socket' : 'ping';
      for (let i = 0; i < n; i++) {
        fire(world, p, { kind, w, x: p.x, y: p.y, ang: world.rng() * Math.PI * 2, speed: st.speed, ttl: st.dur, dmg: st.dmg, pierce: 999, r: st.area, rehit: rehitOf(w) });
      }
      return true;
    }
    case 'hot_reload': {
      const near = grid.within(p.x, p.y, AIM * 1.2);
      if (near.length === 0) return false;
      for (let i = 0; i < n && near.length > 0; i++) {
        const t = near.splice(Math.floor(world.rng() * near.length), 1)[0]!;
        const x = t.x;
        const y = t.y;
        grid.near(x, y, st.area, (e) => hit(world, e, st.dmg, p, w));
        flash(world, p, 'bolt', x, y, st.area, 0, st.dur);
      }
      return true;
    }
    case 'git_clean':
    case 'rm_rf': {
      // 뱀서 Pentagram: 화면 안의 적을 모두 지운다 (사신만 버틴다). 쓸 때마다 한 번 굴려서
      // - 대개는 경험치 없이 지우고, 화면의 경험치·회복 아이템·보물상자도 함께 지운다 (지워진 보스의 상자는 그 자리에 떨어진다)
      // - '남길 확률'(단계와 운으로 오른다)에 걸리면 처치한 것처럼 경험치를 떨어뜨리고, 아이템은 그대로 둔다
      // rm -rf node_modules 는 언제나 남기고, 화면의 경험치를 모두 나에게 끌어당긴다 (굴리기는 똑같이 한 번 한다: 보이는 난수의 흐름을 같게)
      // 화면 안 = 화면의 가장 먼 모서리 바로 바깥까지 (일반 적을 보내는 범위와 같다)
      const r = ENEMY_VIEW_RADIUS;
      const r2 = r * r;
      const inView = (x: number, y: number): boolean => (x - p.x) ** 2 + (y - p.y) ** 2 <= r2;
      const keep = world.rng() < st.chance || w === 'rm_rf';
      for (const e of world.enemies) {
        if (e.hp <= 0 || EN[e.type].killRes || !inView(e.x, e.y)) continue;
        if (keep) damage(world, e, e.hp, p);
        else erase(world, e, p);
      }
      if (!keep) {
        world.gems = world.gems.filter((g) => !inView(g.x, g.y));
        world.heals = world.heals.filter((h) => !inView(h.x, h.y));
        world.items = world.items.filter((it) => it.kind !== 'chest' || !inView(it.x, it.y) || it.born === world.tick);
      }
      if (w === 'rm_rf') {
        // 방금 떨어진 것까지 화면의 경험치를 모두 나에게 (이미 다른 사람에게 끌려가는 것은 그대로)
        for (const g of world.gems) {
          if (g.to !== undefined || !inView(g.x, g.y)) continue;
          g.to = p.id;
          g.sp = GEM_PULL_SPEED;
        }
      }
      flash(world, p, 'wipe', p.x, p.y, Math.min(255 * 4, r), w === 'rm_rf' ? 1 : 0, st.dur);
      return true;
    }
    case 'canary':
    case 'night_owl': {
      dropBombs(world, grid, p, w, petPosition(world, p, w), st);
      return true;
    }
    case 'broadcast':
    case 'multicast':
    case 'flooding': {
      // 브로드캐스트는 위아래·좌우, 멀티캐스트는 대각선, 패킷 플러딩은 여덟 방향 모두
      const dirs = w === 'flooding' ? 8 : 4;
      const turn = w === 'multicast' ? Math.PI / 4 : 0;
      for (let k = 0; k < dirs; k++) {
        const ang = turn + (k * Math.PI * 2) / dirs;
        for (let i = 0; i < n; i++) {
          const off = (i - (n - 1) / 2) * 7;
          fire(world, p, { kind: 'packet', w, x: p.x - Math.sin(ang) * off, y: p.y + Math.cos(ang) * off, ang, speed: st.speed, ttl: st.dur, dmg: st.dmg, pierce: st.pierce, r: st.area });
        }
      }
      return true;
    }
    case 'keyboard_cat': {
      for (let i = 0; i < n; i++) {
        const shot = fire(world, p, { kind: 'cat', w, x: p.x, y: p.y, ang: world.rng() * Math.PI * 2, speed: st.speed, ttl: st.dur, dmg: st.dmg, pierce: 999, r: st.area, rehit: rehitOf(w) });
        if (shot) shot.turn = CAT_TURN;
      }
      return true;
    }
    case 'infinite_scroll': {
      // 세로 띠가 지속 시간 동안 남아, 같은 적을 1초에 한 번 다치게 한다 (뱀서 Song of Mana)
      const height = 240;
      addZone(world, { kind: 'band', w, owner: p.id, x: p.x, y: p.y, r: st.area, aux: Math.min(255, Math.round(height / 4)), ttl: st.dur, dmg: st.dmg, every: rehitOf(w) });
      return true;
    }
    case 'commit_history': {
      // 개수만큼 조금씩 비켜서 남긴다
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * 8;
        addZone(world, { kind: 'trail', w, owner: p.id, x: p.x - p.fy * off, y: p.y + 4 + p.fx * off, r: st.area, aux: 0, ttl: st.dur, dmg: st.dmg, every: rehitOf(w) });
      }
      p.trailX = p.x;
      p.trailY = p.y;
      return true;
    }
    case 'code_freeze': {
      // 시곗바늘처럼 쏠 때마다 30도씩 돈다. 빙결 저항이 1 보다 큰 적(스파게티 코드, God Class)은 얼지 않는다 (뱀서 Clock Lancet)
      p.freezeDir = (p.freezeDir + 1) % 12;
      const a = -Math.PI / 2 + (p.freezeDir * Math.PI) / 6;
      const ax = Math.cos(a);
      const ay = Math.sin(a);
      strip(grid, p.x, p.y, ax, ay, st.area, 10, (e) => {
        // 광선이 나가는 쪽(앞)에 있는 적만: 바로 옆에 붙은 적이 방향과 상관없이 늘 얼지 않게
        if ((e.x - p.x) * ax + (e.y - p.y) * ay < 0) return;
        if (e.resFreeze <= 1) e.frozen = Math.max(e.frozen, st.dur);
      });
      flash(world, p, 'beam', p.x, p.y, st.area, angleByte(a), 0.25);
      return true;
    }
    case 'two_factor': {
      // 방패를 다시 채운다 (맞을 때 하나씩 쓰인다: sim.ts)
      p.charges = n;
      return true;
    }
    case 'sprint': {
      // 바라보는 쪽 옆으로 여러 번 벤다. 쉬지 않고 걸은 거리만큼 고정 피해가 더해진다 (Stack Overflow 는 붙지 않는다).
      // 뱀서는 걸은 거리 ÷ 200,000 (단위 없음). 우리는 기본 속도로 1초 걸을 때 +1, 상한은 단계 × 5
      const bonus = Math.min(5 * lv(p, w), (p.moveTime * moveSpeedOf(p)) / PLAYER_BASE_SPEED);
      const side = p.face;
      for (let i = 0; i < n; i++) {
        const y = p.y + (i % 2 === 0 ? -1 : 1) * Math.ceil(i / 2) * 8;
        strip(grid, p.x, y, side, 0, st.area, 10, (e) => hit(world, e, st.dmg + bonus, p, w));
        flash(world, p, 'slash', p.x + (side * st.area) / 2, y, st.area, angleByte(side > 0 ? 0 : Math.PI), st.dur);
      }
      return true;
    }
    case 'logic_bomb': {
      // 멀티스레드 (뱀서 Bracelet): 무작위 적 하나에게 여러 발을 한꺼번에. 지속 시간만큼만 날아간다
      const t = randomTarget(world, grid, p, AIM);
      if (!t) return false;
      const base = Math.atan2(t.y - p.y, t.x - p.x);
      for (let i = 0; i < n; i++) {
        fire(world, p, { kind: 'bomb', w, x: p.x, y: p.y, ang: base + (i - (n - 1) / 2) * 0.15, speed: st.speed, ttl: st.dur, dmg: st.dmg, pierce: st.pierce, r: Math.max(3, st.area / 4) });
      }
      return true;
    }
    case 'firewall':
    case 'rubber_duck':
    case 'monitoring':
      return true;
  }
}
