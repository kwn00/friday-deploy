/**
 * 전투: 무기 23종의 동작, 투사체·소환물, 바닥 영역, 피해와 처치.
 * 서버에서만 "진짜"로 돈다. 클라이언트에는 결과(위치, 영역, 피격 표시)만 스냅샷으로 간다.
 *
 * 0.1 CPU 서버를 위해: 적은 틱마다 공간 격자에 넣고, 투사체·영역·오라는 주변 칸의 적만 본다.
 */
import { HEAL_DROP_CHANCE, HEAL_DROP_COOLDOWN, MAX_GEMS, MAX_HEALS, MAX_SHOTS, MAX_ZONES } from './constants';
import { ENEMIES, WEAPON_IDS, type ShotKind, type WeaponId, type WeaponStats, type ZoneKind } from './content';
import type { Enemy, Player, Shot, World, Zone } from './sim';
import { areaMultOf, effectiveStats, lv } from './stats';

/* ───────────── 공간 격자 ───────────── */

const CELL = 48;
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
    // 적의 반경(가장 큰 것 12)까지 넉넉히 본다
    const reach = r + 12;
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
          const rr = r + ENEMIES[e.type].r;
          if ((e.x - x) ** 2 + (e.y - y) ** 2 > rr * rr) continue;
          if (fn(e) === true) return;
        }
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

export function damage(world: World, e: Enemy, dmg: number, by: Player | undefined): void {
  if (e.hp <= 0 || dmg <= 0) return;
  e.hp -= dmg;
  e.hit = true;
  if (e.hp > 0) return;
  if (by) by.kills++;
  if (world.gems.length >= MAX_GEMS) world.gems.shift();
  world.gems.push({ id: world.nextId++, x: e.x, y: e.y, v: Math.round(ENEMIES[e.type].xp * e.xpMult) });
  // 회복 아이템: 보스는 반드시, 그 외에는 쿨다운이 끝났을 때 낮은 확률로
  // 드롭 여부는 비밀 난수로 정한다 (보이는 난수를 쓰면 시드를 아는 사람이 드롭을 미리 알고 처치 순서로 조종할 수 있다)
  const boss = ENEMIES[e.type].boss === true;
  if (boss || (world.healCd <= 0 && world.secret() < HEAL_DROP_CHANCE)) {
    if (!boss) world.healCd = HEAL_DROP_COOLDOWN;
    if (world.heals.length >= MAX_HEALS) world.heals.shift();
    world.heals.push({ id: world.nextId++, x: e.x + (boss ? 10 : 0), y: e.y });
  }
}

/** 경험치 없이 지운다 (git clean). 처치 수는 센다 */
function erase(e: Enemy, by: Player): void {
  if (e.hp <= 0) return;
  e.hp = 0;
  by.kills++;
}

function addZone(world: World, z: Omit<Zone, 'id' | 'born'>): Zone | null {
  if (world.zones.length >= MAX_ZONES) return null;
  const zone = { id: world.nextId++, born: world.tick, ...z };
  world.zones.push(zone);
  return zone;
}

/** 보이기만 하는 짧은 영역 (피해는 만들 때 한 번에 준다) */
function flash(world: World, p: Player, kind: ZoneKind, x: number, y: number, r: number, aux: number, ttl: number): void {
  addZone(world, { kind, owner: p.id, x, y, r, aux, ttl, dmg: 0, every: 0 });
}

/** 각도(라디안)를 영역의 aux 바이트(0~255)로 */
const angleByte = (a: number): number => Math.round((((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * 256) & 255;

function blast(world: World, grid: Grid, p: Player, x: number, y: number, r: number, dmg: number): void {
  grid.near(x, y, r, (e) => damage(world, e, dmg, p));
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
    const er = ENEMIES[e.type].r;
    if (along >= -er && along <= len + er && across <= width / 2 + er) fn(e);
  });
}

/* ───────────── 투사체 ───────────── */

interface ShotSpec {
  kind: ShotKind;
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
  /** 터질 때의 반경 (로직 밤) */
  boom?: number;
}

function fire(world: World, p: Player, s: ShotSpec): Shot | null {
  if (world.shots.length >= MAX_SHOTS) return null;
  const shot: Shot = {
    id: world.nextId++,
    kind: s.kind,
    owner: p.id,
    x: s.x,
    y: s.y,
    vx: Math.cos(s.ang) * s.speed,
    vy: Math.sin(s.ang) * s.speed,
    ttl: s.ttl,
    life: s.ttl,
    dmg: s.dmg,
    pierce: s.pierce,
    r: s.r,
    rehit: s.rehit ?? 0,
    hit: new Set(),
    boom: s.boom ?? 0,
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
      // 처음 방향 그대로, 속도가 줄다가 뒤집혀 돌아온다
      const k = 1 - (2 * age) / s.life;
      s.x += s.vx * k * dt;
      s.y += s.vy * k * dt;
    } else {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    if (s.kind === 'ping' && owner) {
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
    if (s.ttl <= 0) {
      if (s.boom > 0 && owner) blast(world, grid, owner, s.x, s.y, s.boom, s.dmg);
      continue;
    }
    grid.near(s.x, s.y, s.r, (e) => {
      if (s.rehit > 0) {
        if (!lock(e, s.id, world.time, s.rehit)) return;
      } else {
        if (s.hit.has(e.id)) return;
        s.hit.add(e.id);
      }
      if (s.boom > 0) {
        // 로직 밤: 처음 닿은 곳에서 터진다
        if (owner) blast(world, grid, owner, s.x, s.y, s.boom, s.dmg);
        s.ttl = 0;
        return true;
      }
      damage(world, e, s.dmg, owner);
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
    grid.near(z.x, z.y, z.r, (e) => {
      if (lock(e, z.id, world.time, z.every)) damage(world, e, z.dmg, owner);
    });
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

/** 카나리아·부엉이가 도는 반경 */
const PET_ORBIT = 64;

export function petPosition(world: World, p: Player, w: 'canary' | 'night_owl'): [number, number] {
  const st = effectiveStats(p, w);
  const dir = w === 'canary' ? 1 : -1;
  const a = dir * world.time * st.speed + (w === 'night_owl' ? Math.PI : 0);
  const r = PET_ORBIT * areaMultOf(p);
  return [p.x + Math.cos(a) * r, p.y + Math.sin(a) * r];
}

/* ───────────── 무기 ───────────── */

/** 무기가 겨누는 거리의 기본값 (듀얼 모니터로 늘어난다) */
const AIM = 200;

/**
 * 한 플레이어의 무기를 한 틱 돌린다.
 * 쿨다운이 끝난 무기는 쏜다. 겨눌 적이 없어 못 쏜 무기는 쿨다운을 다시 걸지 않고 다음 틱에 다시 본다.
 */
export function runWeapons(world: World, grid: Grid, p: Player, dt: number): void {
  const moving = p.dx !== 0 || p.dy !== 0;
  p.moveTime = moving ? p.moveTime + dt : 0;
  const reach = AIM * areaMultOf(p);

  for (const w of WEAPON_IDS) {
    if (lv(p, w) === 0) continue;
    const st = effectiveStats(p, w);

    // 쿨다운과 상관없이 계속 붙어 있는 것들
    if (w === 'firewall') {
      grid.near(p.x, p.y, st.area, (e) => {
        if (!lock(e, ownKey(p, w), world.time, st.cd)) return;
        damage(world, e, st.dmg, p);
        // 살짝 밀어낸다
        const d = Math.hypot(e.x - p.x, e.y - p.y) || 1;
        if (!ENEMIES[e.type].boss) {
          e.x += ((e.x - p.x) / d) * 6;
          e.y += ((e.y - p.y) / d) * 6;
        }
      });
      continue;
    }
    if (w === 'rubber_duck') {
      runDucks(world, grid, p, st, dt);
      continue;
    }
    if (w === 'canary' || w === 'night_owl') {
      if (p.pets[w] === undefined) p.pets[w] = world.nextId++;
    }

    const cd = (p.cd[w] ?? 0) - dt;
    if (cd > 0) {
      p.cd[w] = cd;
      continue;
    }
    if (w === 'commit_history' && !moving) {
      p.cd[w] = 0;
      continue;
    }
    if (useWeapon(world, grid, p, w, st, reach)) p.cd[w] = st.cd;
    else p.cd[w] = 0;
  }
}

function runDucks(world: World, grid: Grid, p: Player, st: WeaponStats, dt: number): void {
  // 지속 시간 동안 돌고, 쿨다운 동안 쉰다
  if (p.duckOn > 0) {
    p.duckOn -= dt;
    if (p.duckOn <= 0) {
      p.duckOn = 0;
      p.cd.rubber_duck = st.cd;
    }
  } else {
    const cd = (p.cd.rubber_duck ?? 0) - dt;
    p.cd.rubber_duck = Math.max(0, cd);
    if (cd <= 0) p.duckOn = st.dur;
  }
  const ds = duckState(p);
  for (let i = 0; i < ds.n; i++) {
    const [ox, oy] = duckOffset(world.time, i, ds.n, ds.radius, ds.speed);
    grid.near(p.x + ox, p.y + oy, 6, (e) => {
      if (lock(e, ownKey(p, 'rubber_duck'), world.time, 0.35)) damage(world, e, st.dmg, p);
    });
  }
}

/** 쐈으면 true (겨눌 것이 없으면 false) */
function useWeapon(world: World, grid: Grid, p: Player, w: WeaponId, st: WeaponStats, reach: number): boolean {
  const n = Math.max(1, Math.round(st.amount));
  const area = areaMultOf(p);
  switch (w) {
    case 'console_log': {
      const t = grid.nearest(p.x, p.y, reach);
      if (!t) return false;
      const base = Math.atan2(t.y - p.y, t.x - p.x);
      for (let i = 0; i < n; i++) {
        fire(world, p, { kind: 'log', x: p.x, y: p.y, ang: base + (i - (n - 1) / 2) * 0.18, speed: st.speed, ttl: st.dur * area, dmg: st.dmg, pierce: st.pierce, r: st.area });
      }
      return true;
    }
    case 'regex': {
      // 바라보는 방향으로 나란히
      const ang = Math.atan2(p.fy, p.fx);
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * 6;
        fire(world, p, { kind: 'regex', x: p.x - p.fy * off, y: p.y + p.fx * off, ang, speed: st.speed, ttl: st.dur * area, dmg: st.dmg, pierce: st.pierce, r: st.area });
      }
      return true;
    }
    case 'ai_agent': {
      const near = grid.within(p.x, p.y, reach * 1.1);
      if (near.length === 0) return false;
      for (let i = 0; i < n; i++) {
        const t = near[Math.floor(world.rng() * near.length)]!;
        // 15% 확률로 할루시네이션: 자신만만하게 엉뚱한 곳을 쏜다
        const ang = world.rng() < 0.15 ? world.rng() * Math.PI * 2 : Math.atan2(t.y - p.y, t.x - p.x);
        fire(world, p, { kind: 'ai', x: p.x, y: p.y, ang, speed: st.speed, ttl: st.dur * area, dmg: st.dmg, pierce: st.pierce, r: st.area });
      }
      return true;
    }
    case 'ctrl_x': {
      // 좌우로만 자른다: 첫 번째는 바라보는 쪽, 두 번째는 반대쪽, 그다음은 조금씩 위아래로 비켜서
      for (let i = 0; i < n; i++) {
        const side = i % 2 === 0 ? p.face : -p.face;
        const y = p.y + Math.floor(i / 2) * (i % 4 < 2 ? -12 : 12);
        strip(grid, p.x, y, side, 0, st.area, st.area * 0.4, (e) => damage(world, e, st.dmg, p));
        flash(world, p, 'slash', p.x + (side * st.area) / 2, y, st.area, angleByte(side > 0 ? 0 : Math.PI), st.dur);
      }
      return true;
    }
    case 'brick_book': {
      for (let i = 0; i < n; i++) {
        const vx = (world.rng() * 2 - 1) * 70;
        const shot = fire(world, p, { kind: 'book', x: p.x, y: p.y, ang: -Math.PI / 2, speed: st.speed, ttl: st.dur, dmg: st.dmg, pierce: st.pierce, r: st.area });
        if (shot) shot.vx = vx;
      }
      return true;
    }
    case 'rollback': {
      const t = grid.nearest(p.x, p.y, reach * 1.2);
      const base = t ? Math.atan2(t.y - p.y, t.x - p.x) : Math.atan2(p.fy, p.fx);
      for (let i = 0; i < n; i++) {
        fire(world, p, { kind: 'rollback', x: p.x, y: p.y, ang: base + (i - (n - 1) / 2) * 0.35, speed: st.speed, ttl: st.dur, dmg: st.dmg, pierce: 999, r: st.area, rehit: 0.5 });
      }
      return true;
    }
    case 'hotfix': {
      const near = grid.within(p.x, p.y, reach);
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
        addZone(world, { kind: 'pool', owner: p.id, x, y, r: st.area, aux: 0, ttl: st.dur, dmg: st.dmg, every: 0.4 });
      }
      return true;
    }
    case 'ping_pong': {
      for (let i = 0; i < n; i++) {
        fire(world, p, { kind: 'ping', x: p.x, y: p.y, ang: world.rng() * Math.PI * 2, speed: st.speed, ttl: st.dur, dmg: st.dmg, pierce: 999, r: st.area, rehit: 0.5 });
      }
      return true;
    }
    case 'hot_reload': {
      const near = grid.within(p.x, p.y, reach * 1.2);
      if (near.length === 0) return false;
      for (let i = 0; i < n && near.length > 0; i++) {
        const t = near.splice(Math.floor(world.rng() * near.length), 1)[0]!;
        const x = t.x;
        const y = t.y;
        grid.near(x, y, st.area, (e) => damage(world, e, st.dmg, p));
        flash(world, p, 'bolt', x, y, st.area, 0, st.dur);
      }
      return true;
    }
    case 'git_clean': {
      const r = st.area;
      grid.near(p.x, p.y, r, (e) => {
        if (ENEMIES[e.type].boss) damage(world, e, st.dmg, p);
        else erase(e, p);
      });
      // 떨어진 경험치도 같이 지워진다
      world.gems = world.gems.filter((g) => (g.x - p.x) ** 2 + (g.y - p.y) ** 2 > r * r);
      flash(world, p, 'wipe', p.x, p.y, r, 0, st.dur);
      return true;
    }
    case 'canary':
    case 'night_owl': {
      const [bx, by] = petPosition(world, p, w);
      for (let i = 0; i < n; i++) {
        const a = world.rng() * Math.PI * 2;
        const d = i === 0 ? 0 : world.rng() * 18;
        blast(world, grid, p, bx + Math.cos(a) * d, by + Math.sin(a) * d, st.area, st.dmg);
      }
      return true;
    }
    case 'broadcast':
    case 'multicast': {
      const turn = w === 'multicast' ? Math.PI / 4 : 0;
      for (let k = 0; k < 4; k++) {
        const ang = turn + (k * Math.PI) / 2;
        for (let i = 0; i < n; i++) {
          const off = (i - (n - 1) / 2) * 7;
          fire(world, p, { kind: 'packet', x: p.x - Math.sin(ang) * off, y: p.y + Math.cos(ang) * off, ang, speed: st.speed, ttl: st.dur * area, dmg: st.dmg, pierce: st.pierce, r: st.area });
        }
      }
      return true;
    }
    case 'keyboard_cat': {
      for (let i = 0; i < n; i++) {
        const shot = fire(world, p, { kind: 'cat', x: p.x, y: p.y, ang: world.rng() * Math.PI * 2, speed: st.speed, ttl: st.dur, dmg: st.dmg, pierce: 999, r: st.area, rehit: 0.5 });
        if (shot) shot.turn = CAT_TURN;
      }
      return true;
    }
    case 'infinite_scroll': {
      const height = 240 * area;
      for (let i = 0; i < n; i++) {
        const x = p.x + (i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * st.area);
        strip(grid, x, p.y - height / 2, 0, 1, height, st.area, (e) => damage(world, e, st.dmg, p));
        flash(world, p, 'band', x, p.y, st.area, Math.min(255, Math.round(height / 4)), st.dur);
      }
      return true;
    }
    case 'commit_history': {
      addZone(world, { kind: 'trail', owner: p.id, x: p.x, y: p.y + 4, r: st.area, aux: 0, ttl: st.dur, dmg: st.dmg, every: 0.5 });
      return true;
    }
    case 'code_freeze': {
      // 시곗바늘처럼 쏠 때마다 30도씩 돈다
      p.freezeDir = (p.freezeDir + 1) % 12;
      const base = -Math.PI / 2 + (p.freezeDir * Math.PI) / 6;
      for (let i = 0; i < n; i++) {
        const a = base + (i * Math.PI * 2) / n;
        strip(grid, p.x, p.y, Math.cos(a), Math.sin(a), st.area, 10, (e) => {
          e.frozen = Math.max(e.frozen, ENEMIES[e.type].boss ? st.dur / 2 : st.dur);
        });
        flash(world, p, 'beam', p.x, p.y, st.area, angleByte(a), 0.25);
      }
      return true;
    }
    case 'two_factor': {
      p.guard = Math.max(p.guard, st.dur);
      return true;
    }
    case 'sprint': {
      // 오래 달릴수록 세진다 (2초 달리면 2배)
      const dmg = st.dmg * (1 + Math.min(1, p.moveTime / 2));
      const base = Math.atan2(p.fy, p.fx);
      for (let i = 0; i < n; i++) {
        const a = base + (i - (n - 1) / 2) * 0.45;
        strip(grid, p.x, p.y, Math.cos(a), Math.sin(a), st.area, st.area * 0.45, (e) => damage(world, e, dmg, p));
        flash(world, p, 'slash', p.x + (Math.cos(a) * st.area) / 2, p.y + (Math.sin(a) * st.area) / 2, st.area, angleByte(a), st.dur);
      }
      return true;
    }
    case 'logic_bomb': {
      const t = grid.nearest(p.x, p.y, reach * 1.1);
      if (!t) return false;
      const base = Math.atan2(t.y - p.y, t.x - p.x);
      for (let i = 0; i < n; i++) {
        fire(world, p, { kind: 'bomb', x: p.x, y: p.y, ang: base + (i - (n - 1) / 2) * 0.25, speed: st.speed, ttl: st.dur, dmg: st.dmg, pierce: 0, r: 5, boom: st.area });
      }
      return true;
    }
    case 'firewall':
    case 'rubber_duck':
      return true;
  }
}
