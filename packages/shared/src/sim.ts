/**
 * 결정론적 게임 시뮬레이션. 서버에서만 "진짜"로 실행된다.
 * (shared 에 둔 이유: 추후 클라이언트 예측/리플레이 검증에 동일 코드를 재사용하기 위함)
 */
import {
  MAX_ENEMIES_BASE,
  MAX_ENEMIES_PER_EXTRA_PLAYER,
  MAX_GEMS,
  MAX_SHOTS,
  MAX_UPGRADE_LEVEL,
  OFFER_COUNT,
  OFFER_TIMEOUT,
  PLAYER_BASE_HP,
  PLAYER_BASE_PICKUP,
  PLAYER_BASE_SPEED,
  PLAYER_RADIUS,
  VIEW_RADIUS,
} from './constants';
import {
  BOSS_INTERVAL,
  ENEMIES,
  ENEMY_IDS,
  SHOT_KINDS,
  UPGRADE_IDS,
  WEAPON_IDS,
  isWeapon,
  type EnemyId,
  type ShotKind,
  type UpgradeId,
} from './content';
import type { Offer, Snapshot } from './protocol';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Player {
  id: number;
  name: string;
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** 마지막으로 바라본 방향 (정규화) */
  fx: number;
  fy: number;
  hp: number;
  level: number;
  xp: number;
  xpNext: number;
  kills: number;
  alive: boolean;
  up: Partial<Record<UpgradeId, number>>;
  cd: Partial<Record<UpgradeId, number>>;
  offers: UpgradeId[] | null;
  offerTimer: number;
}

export interface Enemy {
  id: number;
  type: EnemyId;
  x: number;
  y: number;
  hp: number;
  duckCd: number;
}

export interface Shot {
  id: number;
  kind: ShotKind;
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ttl: number;
  dmg: number;
  pierce: number;
  r: number;
  hit: Set<number>;
}

export interface Gem {
  id: number;
  x: number;
  y: number;
  v: number;
}

export type WorldEvent = { type: 'offers'; pid: number } | { type: 'over' };

export interface World {
  tick: number;
  time: number;
  paused: boolean;
  over: boolean;
  nextId: number;
  rng: () => number;
  players: Map<number, Player>;
  enemies: Enemy[];
  shots: Shot[];
  gems: Gem[];
  spawnAcc: number;
  nextBossAt: number;
  events: WorldEvent[];
}

export function createWorld(seed: number): World {
  return {
    tick: 0,
    time: 0,
    paused: false,
    over: false,
    nextId: 1,
    rng: mulberry32(seed),
    players: new Map(),
    enemies: [],
    shots: [],
    gems: [],
    spawnAcc: 0,
    nextBossAt: BOSS_INTERVAL,
    events: [],
  };
}

const lv = (p: Player, id: UpgradeId): number => p.up[id] ?? 0;
export const maxHpOf = (p: Player): number => PLAYER_BASE_HP + 20 * lv(p, 'dark_mode');
const speedOf = (p: Player): number => PLAYER_BASE_SPEED * (1 + 0.08 * lv(p, 'coffee'));
const cdMultOf = (p: Player): number => Math.pow(0.92, lv(p, 'mech_keyboard'));
const dmgMultOf = (p: Player): number => 1 + 0.15 * lv(p, 'stack_overflow');
const pickupOf = (p: Player): number => PLAYER_BASE_PICKUP * (1 + 0.3 * lv(p, 'npm_install'));
const xpForLevel = (level: number): number => 3 + level * 3 + Math.floor(level * level * 0.4);

export function addPlayer(world: World, name: string): Player {
  const id = world.nextId++;
  // 합류 시 기존 플레이어 근처에 스폰
  const anchor = [...world.players.values()].find((p) => p.alive);
  const a = world.rng() * Math.PI * 2;
  const p: Player = {
    id,
    name,
    x: (anchor?.x ?? 0) + Math.cos(a) * 24,
    y: (anchor?.y ?? 0) + Math.sin(a) * 24,
    dx: 0,
    dy: 0,
    fx: 1,
    fy: 0,
    hp: PLAYER_BASE_HP,
    level: 1,
    xp: 0,
    xpNext: xpForLevel(1),
    kills: 0,
    alive: true,
    up: { console_log: 1 },
    cd: {},
    offers: null,
    offerTimer: 0,
  };
  world.players.set(id, p);
  return p;
}

export function removePlayer(world: World, id: number): void {
  world.players.delete(id);
}

/** 입력 적용. 값은 이미 파싱 단계에서 유한/범위 검증됨. 여기서 길이를 1 이하로 다시 강제한다. */
export function setInput(world: World, id: number, dx: number, dy: number): void {
  const p = world.players.get(id);
  if (!p) return;
  const len = Math.hypot(dx, dy);
  if (len > 1) {
    dx /= len;
    dy /= len;
  }
  p.dx = dx;
  p.dy = dy;
}

/** 레벨업 선택. 서버가 제시한 선택지의 인덱스만 받는다. 유효하지 않으면 false. */
export function pickOffer(world: World, id: number, choice: number): boolean {
  const p = world.players.get(id);
  if (!p || !p.offers) return false;
  const up = p.offers[choice];
  if (up === undefined) return false;
  p.up[up] = Math.min(MAX_UPGRADE_LEVEL, lv(p, up) + 1);
  if (up === 'dark_mode') p.hp = Math.min(maxHpOf(p), p.hp + 40);
  p.offers = null;
  p.offerTimer = 0;
  checkLevelUp(world, p);
  return true;
}

export function offersOf(p: Player): Offer[] {
  return (p.offers ?? []).map((id) => ({ id, level: lv(p, id) + 1 }));
}

function checkLevelUp(world: World, p: Player): void {
  while (p.offers === null && p.xp >= p.xpNext) {
    p.xp -= p.xpNext;
    p.level++;
    p.xpNext = xpForLevel(p.level);
    const pool = UPGRADE_IDS.filter((u) => lv(p, u) < MAX_UPGRADE_LEVEL);
    if (pool.length === 0) {
      p.hp = Math.min(maxHpOf(p), p.hp + 20);
      continue;
    }
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(world.rng() * (i + 1));
      const tmp = pool[i]!;
      pool[i] = pool[j]!;
      pool[j] = tmp;
    }
    p.offers = pool.slice(0, OFFER_COUNT);
    p.offerTimer = 0;
    world.events.push({ type: 'offers', pid: p.id });
  }
}

function nearestEnemy(world: World, x: number, y: number, maxDist: number): Enemy | null {
  let best: Enemy | null = null;
  let bestD = maxDist * maxDist;
  for (const e of world.enemies) {
    const d = (e.x - x) ** 2 + (e.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function fire(world: World, p: Player, kind: ShotKind, ang: number, speed: number, dmg: number, pierce: number, ttl: number, r: number): void {
  if (world.shots.length >= MAX_SHOTS) return;
  world.shots.push({
    id: world.nextId++,
    kind,
    owner: p.id,
    x: p.x,
    y: p.y,
    vx: Math.cos(ang) * speed,
    vy: Math.sin(ang) * speed,
    ttl,
    dmg: dmg * dmgMultOf(p),
    pierce,
    r,
    hit: new Set(),
  });
}

function damage(world: World, e: Enemy, dmg: number, by: Player | undefined): void {
  if (e.hp <= 0) return;
  e.hp -= dmg;
  if (e.hp <= 0) {
    if (by) by.kills++;
    if (world.gems.length >= MAX_GEMS) world.gems.shift();
    world.gems.push({ id: world.nextId++, x: e.x, y: e.y, v: ENEMIES[e.type].xp });
  }
}

export function duckPositions(world: World, p: Player): [number, number][] {
  const n = lv(p, 'rubber_duck');
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = world.time * 2.6 + (i * Math.PI * 2) / n;
    out.push([p.x + Math.cos(a) * 36, p.y + Math.sin(a) * 36]);
  }
  return out;
}

function runWeapons(world: World, p: Player, dt: number): void {
  const cdm = cdMultOf(p);
  for (const w of WEAPON_IDS) {
    const level = lv(p, w);
    if (level === 0 || w === 'rubber_duck') continue;
    const cd = (p.cd[w] ?? 0) - dt;
    if (cd > 0) {
      p.cd[w] = cd;
      continue;
    }
    if (w === 'console_log') {
      const target = nearestEnemy(world, p.x, p.y, 200);
      if (!target) continue;
      const base = Math.atan2(target.y - p.y, target.x - p.x);
      const n = 1 + (level >= 3 ? 1 : 0) + (level >= 5 ? 1 : 0);
      for (let i = 0; i < n; i++) fire(world, p, 'log', base + (i - (n - 1) / 2) * 0.18, 220, 8 + 4 * level, level >= 4 ? 1 : 0, 1.2, 4);
      p.cd[w] = 0.9 * cdm;
    } else if (w === 'regex') {
      fire(world, p, 'regex', Math.atan2(p.fy, p.fx), 300, 12 + 6 * level, 999, 0.7, 7);
      p.cd[w] = Math.max(0.6, 2.4 - 0.25 * level) * cdm;
    } else if (w === 'ai_agent') {
      const near = world.enemies.filter((e) => (e.x - p.x) ** 2 + (e.y - p.y) ** 2 < 220 * 220);
      if (near.length === 0) continue;
      const target = near[Math.floor(world.rng() * near.length)]!;
      // 15% 확률로 할루시네이션: 자신만만하게 엉뚱한 곳을 쏜다
      const ang = world.rng() < 0.15 ? world.rng() * Math.PI * 2 : Math.atan2(target.y - p.y, target.x - p.x);
      fire(world, p, 'ai', ang, 260, 16 + 8 * level, 2, 1.1, 5);
      p.cd[w] = Math.max(0.5, 1.5 - 0.15 * level) * cdm;
    }
  }
  const ducks = lv(p, 'rubber_duck');
  if (ducks > 0) {
    const dmg = (6 + 3 * ducks) * dmgMultOf(p);
    for (const [dx, dy] of duckPositions(world, p)) {
      for (const e of world.enemies) {
        if (e.duckCd > 0) continue;
        const rr = ENEMIES[e.type].r + 6;
        if ((e.x - dx) ** 2 + (e.y - dy) ** 2 < rr * rr) {
          e.duckCd = 0.35;
          damage(world, e, dmg, p);
        }
      }
    }
  }
}

function spawnEnemies(world: World, alive: Player[], dt: number): void {
  const cap = MAX_ENEMIES_BASE + MAX_ENEMIES_PER_EXTRA_PLAYER * (alive.length - 1);
  const hpScale = 1 + world.time / 240;
  const spawnAt = (type: EnemyId): void => {
    const anchor = alive[Math.floor(world.rng() * alive.length)]!;
    const a = world.rng() * Math.PI * 2;
    const d = 300 + world.rng() * 60;
    world.enemies.push({
      id: world.nextId++,
      type,
      x: anchor.x + Math.cos(a) * d,
      y: anchor.y + Math.sin(a) * d,
      hp: ENEMIES[type].hp * hpScale,
      duckCd: 0,
    });
  };
  if (world.time >= world.nextBossAt) {
    world.nextBossAt += BOSS_INTERVAL;
    spawnAt('legacy_code');
  }
  const rate = Math.min(14, (1.2 + world.time / 22) * (0.6 + 0.4 * alive.length));
  world.spawnAcc += rate * dt;
  const pool = ENEMY_IDS.filter((id) => ENEMIES[id].weight > 0 && ENEMIES[id].from <= world.time);
  const total = pool.reduce((s, id) => s + ENEMIES[id].weight, 0);
  while (world.spawnAcc >= 1) {
    world.spawnAcc -= 1;
    if (world.enemies.length >= cap) continue;
    let roll = world.rng() * total;
    let pick: EnemyId = 'bug';
    for (const id of pool) {
      roll -= ENEMIES[id].weight;
      if (roll <= 0) {
        pick = id;
        break;
      }
    }
    spawnAt(pick);
  }
}

export function step(world: World, dt: number): void {
  if (world.over) return;
  const players = [...world.players.values()];

  for (const p of players) {
    if (!p.offers) continue;
    p.offerTimer += dt;
    if (p.offerTimer >= OFFER_TIMEOUT) pickOffer(world, p.id, 0);
  }

  const alive = players.filter((p) => p.alive);
  if (alive.length === 0) {
    if (players.length > 0) {
      world.over = true;
      world.events.push({ type: 'over' });
    }
    return;
  }

  // 살아있는 모든 플레이어가 레벨업 선택 중이면 월드 정지 (솔로에서는 익숙한 '일시정지' 느낌)
  world.paused = alive.every((p) => p.offers !== null);
  if (world.paused) return;

  world.tick++;
  world.time += dt;

  // 선택 중인 플레이어는 이동/피격/공격 없음
  const active = alive.filter((p) => p.offers === null);

  for (const p of active) {
    const sp = speedOf(p);
    p.x += p.dx * sp * dt;
    p.y += p.dy * sp * dt;
    if (p.dx !== 0 || p.dy !== 0) {
      const len = Math.hypot(p.dx, p.dy);
      p.fx = p.dx / len;
      p.fy = p.dy / len;
    }
  }

  spawnEnemies(world, alive, dt);

  // 적 이동 + 접촉 피해
  for (const e of world.enemies) {
    const def = ENEMIES[e.type];
    e.duckCd -= dt;
    let target: Player | null = null;
    let best = Infinity;
    for (const p of active) {
      const d = (p.x - e.x) ** 2 + (p.y - e.y) ** 2;
      if (d < best) {
        best = d;
        target = p;
      }
    }
    if (!target) continue;
    const dist = Math.sqrt(best) || 1;
    // 너무 멀어진 적은 플레이어 진행 방향 쪽으로 재배치 (맵이 무한이므로)
    if (dist > 520 && !def.boss) {
      const a = world.rng() * Math.PI * 2;
      e.x = target.x + Math.cos(a) * 320;
      e.y = target.y + Math.sin(a) * 320;
      continue;
    }
    e.x += ((target.x - e.x) / dist) * def.speed * dt;
    e.y += ((target.y - e.y) / dist) * def.speed * dt;
    if (dist < def.r + PLAYER_RADIUS) {
      target.hp -= def.dps * dt;
      if (target.hp <= 0) {
        target.hp = 0;
        target.alive = false;
        target.dx = 0;
        target.dy = 0;
      }
    }
  }

  // 적끼리 살짝 밀어내기
  const es = world.enemies;
  for (let i = 0; i < es.length; i++) {
    const a = es[i]!;
    for (let j = i + 1; j < es.length; j++) {
      const b = es[j]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const min = ENEMIES[a.type].r + ENEMIES[b.type].r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const push = ((min - d) / d) * 0.25;
      a.x -= dx * push;
      a.y -= dy * push;
      b.x += dx * push;
      b.y += dy * push;
    }
  }

  for (const p of active) if (p.alive) runWeapons(world, p, dt);

  // 투사체
  for (const s of world.shots) {
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.ttl -= dt;
    if (s.ttl <= 0) continue;
    for (const e of world.enemies) {
      if (e.hp <= 0 || s.hit.has(e.id)) continue;
      const rr = ENEMIES[e.type].r + s.r;
      if ((e.x - s.x) ** 2 + (e.y - s.y) ** 2 < rr * rr) {
        s.hit.add(e.id);
        damage(world, e, s.dmg, world.players.get(s.owner));
        if (s.pierce-- <= 0) {
          s.ttl = 0;
          break;
        }
      }
    }
  }
  world.shots = world.shots.filter((s) => s.ttl > 0);
  world.enemies = world.enemies.filter((e) => e.hp > 0);

  // 경험치(커밋) 획득
  for (const p of active) {
    if (!p.alive) continue;
    const r2 = pickupOf(p) ** 2;
    let gained = 0;
    world.gems = world.gems.filter((g) => {
      if ((g.x - p.x) ** 2 + (g.y - p.y) ** 2 > r2) return true;
      gained += g.v;
      return false;
    });
    if (gained > 0) {
      p.xp += gained;
      checkLevelUp(world, p);
    }
  }
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** 플레이어 한 명 시점의 스냅샷. 관심 영역(VIEW_RADIUS) 밖의 정보는 포함하지 않는다. */
export function buildSnapshot(world: World, pid: number): Snapshot | null {
  const me = world.players.get(pid);
  if (!me) return null;
  const v2 = VIEW_RADIUS * VIEW_RADIUS;
  const near = (x: number, y: number): boolean => (x - me.x) ** 2 + (y - me.y) ** 2 <= v2;
  const snap: Snapshot = {
    t: 'snap',
    tick: world.tick,
    time: r1(world.time),
    paused: world.paused,
    me: {
      id: me.id,
      hp: Math.ceil(me.hp),
      maxHp: maxHpOf(me),
      xp: me.xp,
      xpNext: me.xpNext,
      level: me.level,
      kills: me.kills,
      alive: me.alive,
      up: me.up,
    },
    p: [],
    e: [],
    s: [],
    g: [],
    d: [],
  };
  for (const p of world.players.values()) {
    if (p !== me && !near(p.x, p.y)) continue;
    snap.p.push([p.id, r1(p.x), r1(p.y), p.fx < 0 ? -1 : 1, p.alive ? 1 : 0, Math.round((p.hp / maxHpOf(p)) * 100)]);
    if (p.alive) for (const [dx, dy] of duckPositions(world, p)) snap.d.push([r1(dx), r1(dy)]);
  }
  for (const e of world.enemies) if (near(e.x, e.y)) snap.e.push([e.id, ENEMY_IDS.indexOf(e.type), r1(e.x), r1(e.y)]);
  for (const s of world.shots) if (near(s.x, s.y)) snap.s.push([s.id, SHOT_KINDS.indexOf(s.kind), r1(s.x), r1(s.y)]);
  for (const g of world.gems) if (near(g.x, g.y)) snap.g.push([g.id, Math.round(g.x), Math.round(g.y)]);
  return snap;
}

export { isWeapon };
