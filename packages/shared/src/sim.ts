/**
 * 결정론적 게임 시뮬레이션. 서버에서만 "진짜"로 실행된다.
 * (shared 에 둔 이유: 추후 클라이언트 예측/리플레이 검증에 동일 코드를 재사용하기 위함)
 */
import {
  DUCK_ORBIT_RADIUS,
  DUCK_ORBIT_SPEED,
  HEAL_DROP_CHANCE,
  HEAL_DROP_COOLDOWN,
  GEM_CONTACT,
  GEM_PULL_ACCEL,
  GEM_PULL_MAX,
  GEM_PULL_SPEED,
  HEAL_FRACTION,
  MAX_ENEMIES_BASE,
  MAX_ENEMIES_PER_EXTRA_PLAYER,
  MAX_GEMS,
  MAX_HEALS,
  MAX_SHOTS,
  MAX_UPGRADE_LEVEL,
  OFFER_COUNT,
  OFFER_TIMEOUT,
  PLAYER_BASE_HP,
  PLAYER_BASE_PICKUP,
  PLAYER_BASE_SPEED,
  PLAYER_RADIUS,
  SPECTATOR_LEASH,
  SPECTATOR_PULL,
  SPECTATOR_SPEED,
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
import { derivedSecret, sfc32, type Rand, type Seed } from './rng';

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
  /** 스프라이트 좌우 방향. 좌우 입력이 뚜렷할 때만 바뀐다 (위아래로 움직일 때 미세한 흔들림으로 뒤집히지 않게) */
  face: 1 | -1;
  hp: number;
  level: number;
  xp: number;
  xpNext: number;
  kills: number;
  alive: boolean;
  /**
   * 월드에 몸이 있는지: 살아 있는 캐릭터이거나, 이번 판에서 쓰러져 묘비가 남아 있다.
   * 관전으로 합류한 사람은 false 이고 누구의 화면에도 그려지지 않는다.
   */
  body: boolean;
  /**
   * 이 플레이어가 보고 있는 곳(스냅샷의 관심 영역 중심). 살아 있는 동안에는 캐릭터 위치와 같고,
   * 쓰러진 뒤(또는 관전 중)에는 입력으로 움직이는 관전 시점이다. 서버가 계산한다.
   */
  camX: number;
  camY: number;
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
  /** 이번 틱에 피해를 입고 살아남았는지. 클라이언트가 피격 이펙트를 그리는 데만 쓴다 (체력은 보내지 않는다) */
  hit: boolean;
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
  /** 지금 이 경험치를 끌어당기고 있는 플레이어 id (없으면 제자리에 있다) */
  to?: number;
  /** 끌려가는 현재 속도 (px/s) */
  sp?: number;
}

export interface Heal {
  id: number;
  x: number;
  y: number;
}

export type WorldEvent = { type: 'offers'; pid: number } | { type: 'over' };

export interface World {
  tick: number;
  time: number;
  paused: boolean;
  over: boolean;
  nextId: number;
  /**
   * 보이는 난수: 결과가 스냅샷에 그대로 드러나는 것(스폰 위치/종류, 재배치, 합류 위치, AI 에이전트 조준)에만 쓴다.
   * 실제 서버는 이것도 CSPRNG 로 넘긴다. 시드로 만들 때(테스트, 도구)는 sfc32 이고 암호학적이지 않다.
   */
  rng: Rand;
  /**
   * 비밀 난수: 미리 알면 이득인 것(레벨업 선택지, 회복 아이템 드롭)에만 쓴다. 서버는 CSPRNG 를 넘긴다.
   * 규칙: 두 난수가 몇 번 소비되는지는 서로의 결과에 따라 달라지면 안 된다.
   * (예: 비밀 난수 결과에 따라 보이는 난수를 한 번 더 뽑으면, 보이는 스폰이 어긋나는 것으로 비밀 결과가 새어 나간다.
   *  서버에서는 둘 다 CSPRNG 라 새어 나가도 쓸 데가 없지만, 한 겹 더 막아 두는 규칙으로 유지한다)
   */
  secret: Rand;
  players: Map<number, Player>;
  enemies: Enemy[];
  shots: Shot[];
  gems: Gem[];
  heals: Heal[];
  /** 다음 회복 아이템이 떨어질 수 있을 때까지 남은 시간(초) */
  healCd: number;
  spawnAcc: number;
  nextBossAt: number;
  events: WorldEvent[];
}

/** 월드가 쓸 두 난수를 직접 넘길 때의 모양 (서버: 둘 다 CSPRNG) */
export interface WorldRandom {
  rng: Rand;
  secret: Rand;
}

/**
 * 새 월드.
 * - 시드(숫자 = 테스트용, splitmix32 로 128비트로 펼침 / 32비트 단어 4개): 같은 시드는 같은 판을 만든다 (테스트, 밸런스 도구).
 *   secret 을 주지 않으면 시드에서 유도한 별도의 결정론적 난수를 쓴다.
 * - { rng, secret }: 난수 함수를 그대로 쓴다. 실제 서버는 이쪽으로 CSPRNG 두 개를 넘긴다 (재현할 수 없고, 예측할 수도 없다).
 */
export function createWorld(source: Seed | WorldRandom, secret?: Rand): World {
  const random: WorldRandom =
    typeof source === 'object' && 'rng' in source ? source : { rng: sfc32(source), secret: secret ?? derivedSecret(source) };
  return {
    tick: 0,
    time: 0,
    paused: false,
    over: false,
    nextId: 1,
    rng: random.rng,
    secret: random.secret,
    players: new Map(),
    enemies: [],
    shots: [],
    gems: [],
    heals: [],
    healCd: HEAL_DROP_COOLDOWN,
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

/**
 * 플레이어를 추가한다.
 * spectator 가 true 면 캐릭터 없이 관전으로만 들어온다 (이번 판이 끝날 때까지 시점만 움직일 수 있다).
 */
export function addPlayer(world: World, name: string, spectator = false): Player {
  const id = world.nextId++;
  // 합류 시 기존 플레이어 근처에 스폰
  const anchor = [...world.players.values()].find((p) => p.alive);
  const a = world.rng() * Math.PI * 2;
  const x = (anchor?.x ?? 0) + Math.cos(a) * 24;
  const y = (anchor?.y ?? 0) + Math.sin(a) * 24;
  const p: Player = {
    id,
    name,
    x,
    y,
    dx: 0,
    dy: 0,
    fx: 1,
    fy: 0,
    face: 1,
    hp: spectator ? 0 : PLAYER_BASE_HP,
    level: 1,
    xp: 0,
    xpNext: xpForLevel(1),
    kills: 0,
    alive: !spectator,
    body: !spectator,
    camX: x,
    camY: y,
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
    // 선택지는 비밀 난수로 섞는다: 보이는 스폰을 관찰해도 다음 선택지를 알 수 없게
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(world.secret() * (i + 1));
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
  e.hit = true;
  if (e.hp <= 0) {
    if (by) by.kills++;
    if (world.gems.length >= MAX_GEMS) world.gems.shift();
    world.gems.push({ id: world.nextId++, x: e.x, y: e.y, v: ENEMIES[e.type].xp });
    // 회복 아이템: 보스는 반드시, 그 외에는 쿨다운이 끝났을 때 낮은 확률로
    // 드롭 여부는 비밀 난수로 정한다 (보이는 난수를 쓰면 시드를 아는 사람이 드롭을 미리 알고 처치 순서로 조종할 수 있다)
    const boss = ENEMIES[e.type].boss === true;
    if (boss || (world.healCd <= 0 && world.secret() < HEAL_DROP_CHANCE)) {
      if (!boss) world.healCd = HEAL_DROP_COOLDOWN;
      if (world.heals.length >= MAX_HEALS) world.heals.shift();
      world.heals.push({ id: world.nextId++, x: e.x + (boss ? 10 : 0), y: e.y });
    }
  }
}

/** 러버덕 i 번째(총 n 마리)의 주인 기준 상대 위치. 서버 판정과 클라이언트 그리기가 함께 쓴다. */
export function duckOffset(time: number, i: number, n: number): [number, number] {
  const a = time * DUCK_ORBIT_SPEED + (i * Math.PI * 2) / n;
  return [Math.cos(a) * DUCK_ORBIT_RADIUS, Math.sin(a) * DUCK_ORBIT_RADIUS];
}

export function duckPositions(world: World, p: Player): [number, number][] {
  const n = lv(p, 'rubber_duck');
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const [ox, oy] = duckOffset(world.time, i, n);
    out.push([p.x + ox, p.y + oy]);
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
      hit: false,
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
  // 누적 덧셈 대신 틱에서 계산: 오차가 쌓이지 않고, 클라이언트가 tick 만으로 같은 시간을 구할 수 있다 (러버덕 각도)
  world.time = world.tick * dt;
  world.healCd -= dt;

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
      if (Math.abs(p.fx) >= 0.3) p.face = p.fx < 0 ? -1 : 1;
    }
  }

  // 관전 시점: 쓰러졌거나 관전으로 들어온 사람은 입력으로 시점만 움직인다 (몸·묘비는 그대로, 월드에는 영향 없음).
  // 가장 가까운 살아 있는 동료에게서 SPECTATOR_LEASH 보다 멀어질 수 없다.
  for (const p of players) {
    if (p.alive) {
      p.camX = p.x;
      p.camY = p.y;
      continue;
    }
    p.camX += p.dx * SPECTATOR_SPEED * dt;
    p.camY += p.dy * SPECTATOR_SPEED * dt;
    let best = Infinity;
    let tx = p.camX;
    let ty = p.camY;
    for (const q of alive) {
      const d2 = (q.x - p.camX) ** 2 + (q.y - p.camY) ** 2;
      if (d2 < best) {
        best = d2;
        tx = q.x;
        ty = q.y;
      }
    }
    const dist = Math.sqrt(best);
    if (dist > SPECTATOR_LEASH && Number.isFinite(dist)) {
      const pull = Math.min(dist - SPECTATOR_LEASH, SPECTATOR_PULL * dt);
      p.camX += ((tx - p.camX) / dist) * pull;
      p.camY += ((ty - p.camY) / dist) * pull;
    }
  }

  spawnEnemies(world, alive, dt);

  // 적 이동 + 접촉 피해
  for (const e of world.enemies) {
    const def = ENEMIES[e.type];
    e.duckCd -= dt;
    e.hit = false;
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

  // 경험치(커밋): 획득 범위에 들어오면 그 플레이어에게 끌려가고, 닿으면 획득한다.
  // 범위는 예전의 "즉시 획득" 범위와 같다. 한번 끌리기 시작한 것은 범위를 벗어나도 계속 따라온다.
  const pullers = active.filter((p) => p.alive);
  const gains = new Map<Player, number>();
  world.gems = world.gems.filter((g) => {
    let p = g.to === undefined ? undefined : world.players.get(g.to);
    // 끌던 사람이 쓰러졌거나, 나갔거나, 레벨업 선택 중이면 놓는다 (선택 중에는 예전에도 줍지 못했다)
    if (p && (!p.alive || p.offers !== null)) p = undefined;
    if (!p) {
      g.to = undefined;
      g.sp = undefined;
      let best = Infinity;
      for (const q of pullers) {
        const d2 = (g.x - q.x) ** 2 + (g.y - q.y) ** 2;
        if (d2 <= pickupOf(q) ** 2 && d2 < best) {
          best = d2;
          p = q;
        }
      }
      if (!p) return true;
      g.to = p.id;
      g.sp = GEM_PULL_SPEED;
    }
    const dx = p.x - g.x;
    const dy = p.y - g.y;
    const dist = Math.hypot(dx, dy);
    const sp = g.sp ?? GEM_PULL_SPEED;
    const move = sp * dt;
    if (dist <= move + GEM_CONTACT) {
      gains.set(p, (gains.get(p) ?? 0) + g.v);
      return false;
    }
    g.x += (dx / dist) * move;
    g.y += (dy / dist) * move;
    g.sp = Math.min(GEM_PULL_MAX, sp + GEM_PULL_ACCEL * dt);
    return true;
  });
  for (const [p, gained] of gains) {
    p.xp += gained;
    checkLevelUp(world, p);
  }

  for (const p of active) {
    if (!p.alive) continue;
    const r2 = pickupOf(p) ** 2;
    // 회복 아이템: 체력이 가득이면 줍지 않고 남겨 둔다
    // 화면에 보이는 체력(올림) 기준: 99.6 처럼 화면에는 가득으로 보일 때 아이템을 써 버리지 않는다
    const maxHp = maxHpOf(p);
    if (Math.ceil(p.hp) < maxHp && world.heals.length > 0) {
      world.heals = world.heals.filter((h) => {
        if (Math.ceil(p.hp) >= maxHp || (h.x - p.x) ** 2 + (h.y - p.y) ** 2 > r2) return true;
        p.hp = Math.min(maxHp, p.hp + Math.ceil(maxHp * HEAL_FRACTION));
        return false;
      });
    }
  }
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** 플레이어 한 명 시점의 스냅샷. 관심 영역(VIEW_RADIUS) 밖의 정보는 포함하지 않는다. */
export function buildSnapshot(world: World, pid: number): Snapshot | null {
  const me = world.players.get(pid);
  if (!me) return null;
  const v2 = VIEW_RADIUS * VIEW_RADIUS;
  // 관심 영역의 중심: 살아 있으면 캐릭터, 관전 중이면 관전 시점
  const cx = me.alive ? me.x : me.camX;
  const cy = me.alive ? me.y : me.camY;
  const near = (x: number, y: number): boolean => (x - cx) ** 2 + (y - cy) ** 2 <= v2;
  const snap: Snapshot = {
    t: 'snap',
    tick: world.tick,
    time: r1(world.time),
    paused: world.paused,
    view: [r1(cx), r1(cy)],
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
    h: [],
  };
  // 같은 방의 플레이어는 멀리 있어도 보낸다 (아군 위치는 숨길 정보가 아니고, 미니맵에서 서로를 찾을 수 있어야 한다)
  // 몸이 없는 사람(관전으로 합류)은 보내지 않는다: 그릴 것이 없다
  for (const p of world.players.values()) {
    if (!p.body) continue;
    snap.p.push([p.id, r1(p.x), r1(p.y), p.face, p.alive ? 1 : 0, Math.round((p.hp / maxHpOf(p)) * 100), p.alive ? lv(p, 'rubber_duck') : 0]);
  }
  for (const e of world.enemies) if (near(e.x, e.y)) snap.e.push([e.id, ENEMY_IDS.indexOf(e.type), r1(e.x), r1(e.y), e.hit ? 1 : 0]);
  for (const s of world.shots) if (near(s.x, s.y)) snap.s.push([s.id, SHOT_KINDS.indexOf(s.kind), r1(s.x), r1(s.y)]);
  // 끌려오는 경험치는 움직이므로 소수 좌표로 보낸다 (전송 크기는 같다: 어차피 1/16 픽셀 정수로 부호화한다)
  for (const g of world.gems) if (near(g.x, g.y)) snap.g.push([g.id, r1(g.x), r1(g.y)]);
  for (const h of world.heals) if (near(h.x, h.y)) snap.h.push([h.id, Math.round(h.x), Math.round(h.y)]);
  return snap;
}

export { isWeapon };
