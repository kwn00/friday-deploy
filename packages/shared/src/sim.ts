/**
 * 결정론적 게임 시뮬레이션. 서버에서만 "진짜"로 실행된다.
 * (shared 에 둔 이유: 추후 클라이언트 예측/리플레이 검증에 동일 코드를 재사용하기 위함)
 */
import {
  FIELD_ITEM_FADE,
  FIELD_ITEM_INTERVAL,
  FIELD_ITEM_JITTER,
  FIELD_ITEM_MAX_DIST,
  FIELD_ITEM_MIN_DIST,
  FIELD_ITEM_TTL,
  MAX_FIELD_ITEMS,
  MAX_REVIVES,
  REVIVE_BLAST_RADIUS,
  REVIVE_HP_FRACTION,
  REVIVE_SHIELD_SECONDS,
  HEAL_DROP_COOLDOWN,
  GEM_CONTACT,
  GEM_PULL_ACCEL,
  GEM_PULL_MAX,
  GEM_PULL_SPEED,
  HEAL_FRACTION,
  MAX_ENEMIES_BASE,
  MAX_ENEMIES_PER_EXTRA_PLAYER,
  OFFER_COUNT,
  OFFER_TIMEOUT,
  PLAYER_BASE_HP,
  PLAYER_RADIUS,
  SPECTATOR_LEASH,
  SPECTATOR_PULL,
  SPECTATOR_SPEED,
  TICK_RATE,
  VIEW_RADIUS,
} from './constants';
import {
  BOSS_INTERVAL,
  ENEMIES,
  ENEMY_IDS,
  FIELD_ITEMS,
  FIELD_ITEM_KINDS,
  PASSIVE_IDS,
  PASSIVE_SLOTS,
  SHOT_KINDS,
  UPGRADES,
  UPGRADE_IDS,
  WEAPON_IDS,
  WEAPON_SLOTS,
  ZONE_KINDS,
  isWeapon,
  type EnemyId,
  type FieldItemKind,
  type ShotKind,
  type UpgradeId,
  type ZoneKind,
} from './content';
import { Grid, auraRadius, duckState, petPosition, runWeapons, updateShots, updateZones } from './combat';
import { DARK_MODE_HP, contactDps, curseOf, extraOfferChanceOf, growthOf, lv, maxHpOf, moveSpeedOf, pickupOf, recoveryOf } from './stats';
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
  /** 가지고 있는 부활(백업) 수. 쓰러질 때 하나를 써서 그 자리에서 되살아난다 */
  revives: number;
  /** 피해를 받지 않는 남은 시간(초). 되살아난 직후에만 0 보다 크다 */
  shield: number;
  /** 2단계 인증으로 피해를 받지 않는 남은 시간(초) */
  guard: number;
  /** 쉬지 않고 움직인 시간(초). 스프린트가 세지는 데 쓴다 */
  moveTime: number;
  /** 러버덕이 돌고 있는 남은 시간(초). 0 이면 쉬는 중 */
  duckOn: number;
  /** 코드 프리즈가 다음에 쏠 방향 (시곗바늘 12칸 중 하나) */
  freezeDir: number;
  /** 소환물(카나리아·부엉이)의 id: 화면에서 같은 새로 이어 그리도록 고정한다 */
  pets: Partial<Record<'canary' | 'night_owl', number>>;
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
  /** 이동 속도 배율 (운영 서버 직접 수정으로 빨라진다) */
  spd: number;
  /** 경험치 배율 (운영 서버 직접 수정으로 늘어난다) */
  xpMult: number;
  /** 얼어 있는 남은 시간(초). 얼어 있으면 움직이지도 때리지도 못한다 */
  frozen: number;
  /** 공격별로 다음에 다시 맞을 수 있는 시각 (같은 공격에 너무 자주 맞지 않게) */
  lock?: Map<number, number>;
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
  /** 처음 수명 (롤백이 돌아오는 때를 계산한다) */
  life: number;
  dmg: number;
  pierce: number;
  r: number;
  /** 같은 적을 다시 맞힐 수 있는 간격(초). 0 이면 적마다 한 번만 (hit 에 기록) */
  rehit: number;
  hit: Set<number>;
  /** 0 보다 크면 닿거나 수명이 다할 때 이 반경으로 터진다 */
  boom: number;
  /** 고양이가 방향을 바꾸기까지 남은 시간 */
  turn: number;
}

/** 바닥에 생기는 공격 영역. dmg 가 0 이면 보이기만 한다 (피해는 만들 때 이미 줬다) */
export interface Zone {
  id: number;
  kind: ZoneKind;
  owner: number;
  x: number;
  y: number;
  r: number;
  /** 종류별 추가 값(0~255): 베기·광선은 각도, 세로 띠는 높이/4 */
  aux: number;
  ttl: number;
  dmg: number;
  /** 같은 적을 다시 다치게 하는 간격(초) */
  every: number;
  /** 생긴 틱 (스냅샷에는 생긴 틱에만 싣는다) */
  born: number;
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

/** 시간에 따라 맵에 놓이는 아이템. 적이 떨어뜨리는 회복 아이템(Heal)과 달리 멀리서도 미니맵에 보인다 */
export interface FieldItem {
  id: number;
  kind: FieldItemKind;
  x: number;
  y: number;
  /** 사라지기까지 남은 시간(초) */
  ttl: number;
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
  zones: Zone[];
  gems: Gem[];
  heals: Heal[];
  items: FieldItem[];
  /** 다음 필드 아이템이 놓이기까지 남은 시간(초) */
  itemCd: number;
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
    zones: [],
    gems: [],
    heals: [],
    healCd: HEAL_DROP_COOLDOWN,
    items: [],
    itemCd: fieldItemDelay(random.secret),
    spawnAcc: 0,
    nextBossAt: BOSS_INTERVAL,
    events: [],
  };
}

export { maxHpOf };
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
    revives: 0,
    shield: 0,
    guard: 0,
    moveTime: 0,
    duckOn: 0,
    freezeDir: 0,
    pets: {},
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
  p.up[up] = Math.min(UPGRADES[up].max, lv(p, up) + 1);
  // 다크 모드는 늘어난 만큼 회복한다 (체력바가 갑자기 비어 보이지 않게)
  if (up === 'dark_mode') p.hp = Math.min(maxHpOf(p), p.hp + DARK_MODE_HP);
  // 스냅샷: 고를 때마다 부활을 하나 준다
  if (up === 'snapshot') p.revives++;
  p.offers = null;
  p.offerTimer = 0;
  checkLevelUp(world, p);
  return true;
}

export function offersOf(p: Player): Offer[] {
  return (p.offers ?? []).map((id) => ({ id, level: lv(p, id) + 1 }));
}

/** 다음 필드 아이템까지의 시간. 비밀 난수로 정해서 언제 나올지 관찰로 맞힐 수 없다 */
function fieldItemDelay(secret: Rand): number {
  return FIELD_ITEM_INTERVAL * (1 - FIELD_ITEM_JITTER + 2 * FIELD_ITEM_JITTER * secret());
}

/**
 * 필드 아이템 하나를 놓는다. 누구 근처에, 어느 방향·거리에, 무엇을 놓을지 모두 비밀 난수로 정한다
 * (보이는 난수를 쓰지 않으므로 적 스폰의 흐름에 영향을 주지 않는다).
 */
function spawnFieldItem(world: World, alive: Player[]): void {
  const anchor = alive[Math.floor(world.secret() * alive.length)]!;
  const a = world.secret() * Math.PI * 2;
  const d = FIELD_ITEM_MIN_DIST + world.secret() * (FIELD_ITEM_MAX_DIST - FIELD_ITEM_MIN_DIST);
  const total = FIELD_ITEM_KINDS.reduce((sum, k) => sum + FIELD_ITEMS[k].weight, 0);
  let roll = world.secret() * total;
  let kind: FieldItemKind = FIELD_ITEM_KINDS[0];
  for (const k of FIELD_ITEM_KINDS) {
    roll -= FIELD_ITEMS[k].weight;
    if (roll < 0) {
      kind = k;
      break;
    }
  }
  world.items.push({ id: world.nextId++, kind, x: anchor.x + Math.cos(a) * d, y: anchor.y + Math.sin(a) * d, ttl: FIELD_ITEM_TTL });
}

/** 이 플레이어가 지금 이 아이템을 주울 수 있는지 (못 줍는 것은 그 자리에 남는다) */
function canTake(p: Player, kind: FieldItemKind): boolean {
  // 화면에 보이는 체력(올림)이 가득이면 회복 아이템을 써 버리지 않는다
  if (kind === 'heal') return Math.ceil(p.hp) < maxHpOf(p);
  // 백업은 하나만 더 가질 수 있다 (스냅샷으로 받은 부활은 따로 센다)
  if (kind === 'revive') return p.revives < MAX_REVIVES + lv(p, 'snapshot');
  return true;
}

function takeItem(world: World, p: Player, kind: FieldItemKind): void {
  if (kind === 'heal') {
    const maxHp = maxHpOf(p);
    p.hp = Math.min(maxHp, p.hp + Math.ceil(maxHp * HEAL_FRACTION));
  } else if (kind === 'revive') {
    p.revives++;
  } else {
    // 지금 레벨을 채우는 데 필요한 만큼을 통째로 준다: 정확히 한 레벨 오르고, 모으던 경험치는 그대로 남는다
    p.xp += p.xpNext;
    checkLevelUp(world, p);
  }
}

/** 쓰러질 순간에 부활을 하나 써서 그 자리에서 되살아난다 */
function revive(world: World, p: Player): void {
  p.revives--;
  p.hp = Math.ceil(maxHpOf(p) * REVIVE_HP_FRACTION);
  p.shield = REVIVE_SHIELD_SECONDS;
  // 주변의 적을 반경 밖으로 밀어낸다. 방향은 지금 있는 쪽 그대로 (겹쳐 있으면 적마다 다른 고정된 방향)
  for (const e of world.enemies) {
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d >= REVIVE_BLAST_RADIUS) continue;
    const a = d > 0.001 ? Math.atan2(dy, dx) : e.id * 2.399963;
    e.x = p.x + Math.cos(a) * REVIVE_BLAST_RADIUS;
    e.y = p.y + Math.sin(a) * REVIVE_BLAST_RADIUS;
  }
}

function checkLevelUp(world: World, p: Player): void {
  while (p.offers === null && p.xp >= p.xpNext) {
    p.xp -= p.xpNext;
    p.level++;
    p.xpNext = xpForLevel(p.level);
    // 가진 것은 최대 단계 전까지, 새 것은 칸이 남아 있을 때만 (무기 6칸, 패시브 6칸)
    const weapons = WEAPON_IDS.filter((u) => lv(p, u) > 0).length;
    const passives = PASSIVE_IDS.filter((u) => lv(p, u) > 0).length;
    const pool = UPGRADE_IDS.filter((u) => {
      const l = lv(p, u);
      if (l >= UPGRADES[u].max) return false;
      if (l > 0) return true;
      return isWeapon(u) ? weapons < WEAPON_SLOTS : passives < PASSIVE_SLOTS;
    });
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
    // 배포 기도: 가끔 선택지가 하나 더 (이것도 비밀 난수로 정한다)
    const count = OFFER_COUNT + (world.secret() < extraOfferChanceOf(p) ? 1 : 0);
    p.offers = pool.slice(0, count);
    p.offerTimer = 0;
    world.events.push({ type: 'offers', pid: p.id });
  }
}

function spawnEnemies(world: World, alive: Player[], dt: number): void {
  const cap = MAX_ENEMIES_BASE + MAX_ENEMIES_PER_EXTRA_PLAYER * (alive.length - 1);
  const hpScale = 1 + world.time / 240;
  const spawnAt = (type: EnemyId): void => {
    const anchor = alive[Math.floor(world.rng() * alive.length)]!;
    const a = world.rng() * Math.PI * 2;
    const d = 300 + world.rng() * 60;
    // 운영 서버 직접 수정: 그 사람 주변에 나오는 버그는 더 세고 빠르고, 경험치도 그만큼 많다
    const curse = curseOf(anchor);
    world.enemies.push({
      id: world.nextId++,
      type,
      x: anchor.x + Math.cos(a) * d,
      y: anchor.y + Math.sin(a) * d,
      hp: ENEMIES[type].hp * hpScale * curse,
      spd: curse,
      xpMult: curse,
      frozen: 0,
      hit: false,
    });
  };
  if (world.time >= world.nextBossAt) {
    world.nextBossAt += BOSS_INTERVAL;
    spawnAt('legacy_code');
  }
  // 등장 빈도도 운영 서버 직접 수정만큼 늘어난다 (살아 있는 사람들의 평균)
  const curse = alive.reduce((sum, p) => sum + curseOf(p), 0) / alive.length;
  const rate = Math.min(14 * curse, (1.2 + world.time / 22) * (0.6 + 0.4 * alive.length) * curse);
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

  // 필드 아이템: 수명이 다한 것을 치우고, 때가 되면 하나 놓는다 (가득 차 있으면 이번 차례는 건너뛴다)
  if (world.items.length > 0) {
    for (const it of world.items) it.ttl -= dt;
    world.items = world.items.filter((it) => it.ttl > 0);
  }
  world.itemCd -= dt;
  if (world.itemCd <= 0) {
    world.itemCd = fieldItemDelay(world.secret);
    if (world.items.length < MAX_FIELD_ITEMS) spawnFieldItem(world, alive);
  }
  for (const p of players) {
    if (p.shield > 0) p.shield = Math.max(0, p.shield - dt);
    if (p.guard > 0) p.guard = Math.max(0, p.guard - dt);
  }

  // 선택 중인 플레이어는 이동/피격/공격 없음
  const active = alive.filter((p) => p.offers === null);

  for (const p of active) {
    // 워라밸: 가만히 있어도 조금씩 찬다
    const regen = recoveryOf(p);
    if (regen > 0) p.hp = Math.min(maxHpOf(p), p.hp + regen * dt);
    const sp = moveSpeedOf(p);
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
    e.hit = false;
    // 얼어 있는 버그는 움직이지도 때리지도 못한다
    if (e.frozen > 0) {
      e.frozen = Math.max(0, e.frozen - dt);
      continue;
    }
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
    e.x += ((target.x - e.x) / dist) * def.speed * e.spd * dt;
    e.y += ((target.y - e.y) / dist) * def.speed * e.spd * dt;
    // 되살아난 직후(shield)와 2단계 인증(guard) 동안에는 피해를 받지 않는다
    if (dist < def.r + PLAYER_RADIUS && target.shield <= 0 && target.guard <= 0) {
      target.hp -= contactDps(target, def.dps) * dt;
      if (target.hp <= 0) {
        if (target.revives > 0) {
          revive(world, target);
        } else {
          target.hp = 0;
          target.alive = false;
          target.dx = 0;
          target.dy = 0;
        }
      }
    }
  }

  // 적끼리 살짝 밀어내기 (공간 격자로 가까운 것끼리만 본다)
  let grid = new Grid(world.enemies);
  for (const a of world.enemies) {
    const ra = ENEMIES[a.type].r;
    grid.near(a.x, a.y, ra, (b) => {
      if (b.id <= a.id) return;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const min = ra + ENEMIES[b.type].r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min || d2 === 0) return;
      const d = Math.sqrt(d2);
      const push = ((min - d) / d) * 0.25;
      a.x -= dx * push;
      a.y -= dy * push;
      b.x += dx * push;
      b.y += dy * push;
    });
  }

  // 무기 · 투사체 · 바닥 영역 (밀어낸 뒤의 자리로 격자를 다시 만든다)
  grid = new Grid(world.enemies);
  for (const p of active) if (p.alive) runWeapons(world, grid, p, dt);
  updateShots(world, grid, dt);
  updateZones(world, grid, dt);
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
    // 사이드 프로젝트: 같은 경험치를 주워도 더 많이 오른다
    p.xp += Math.round(gained * growthOf(p));
    checkLevelUp(world, p);
  }

  // 필드 아이템: 획득 범위 안에 들어온 사람 중 가장 가까운(그리고 그것을 주울 수 있는) 사람이 갖는다
  if (world.items.length > 0) {
    world.items = world.items.filter((it) => {
      let who: Player | null = null;
      let best = Infinity;
      for (const p of pullers) {
        // 이번 틱에 쓰러졌거나, 방금 다른 아이템으로 레벨업 선택에 들어간 사람은 제외
        if (!p.alive || p.offers !== null || !canTake(p, it.kind)) continue;
        const d2 = (it.x - p.x) ** 2 + (it.y - p.y) ** 2;
        if (d2 <= pickupOf(p) ** 2 && d2 < best) {
          best = d2;
          who = p;
        }
      }
      if (!who) return true;
      takeItem(world, who, it.kind);
      return false;
    });
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
      revives: me.revives,
      up: me.up,
    },
    p: [],
    e: [],
    s: [],
    z: [],
    g: [],
    h: [],
    i: [],
  };
  // 같은 방의 플레이어는 멀리 있어도 보낸다 (아군 위치는 숨길 정보가 아니고, 미니맵에서 서로를 찾을 수 있어야 한다)
  // 몸이 없는 사람(관전으로 합류)은 보내지 않는다: 그릴 것이 없다
  for (const p of world.players.values()) {
    if (!p.body) continue;
    const ducks = duckState(p);
    snap.p.push([
      p.id,
      r1(p.x),
      r1(p.y),
      p.face,
      p.alive ? 1 : 0,
      Math.round((p.hp / maxHpOf(p)) * 100),
      ducks.n,
      p.alive && p.shield > 0 ? 1 : 0,
      ducks.radius,
      Math.round(ducks.speed * 10),
      auraRadius(p),
      p.alive && p.guard > 0 ? 1 : 0,
    ]);
  }
  for (const e of world.enemies) if (near(e.x, e.y)) snap.e.push([e.id, ENEMY_IDS.indexOf(e.type), r1(e.x), r1(e.y), e.hit ? 1 : 0, e.frozen > 0 ? 1 : 0]);
  for (const s of world.shots) if (near(s.x, s.y)) snap.s.push([s.id, SHOT_KINDS.indexOf(s.kind), r1(s.x), r1(s.y)]);
  // 카나리아·부엉이: 서버에서는 위치만 계산하는 것이라 목록에 없다. 보이는 사람에게 투사체처럼 보낸다
  for (const p of world.players.values()) {
    if (!p.alive) continue;
    for (const w of ['canary', 'night_owl'] as const) {
      const id = p.pets[w];
      if (id === undefined || lv(p, w) === 0) continue;
      const [x, y] = petPosition(world, p, w);
      if (near(x, y)) snap.s.push([id, SHOT_KINDS.indexOf(w === 'canary' ? 'canary' : 'owl'), r1(x), r1(y)]);
    }
  }
  // 바닥 영역: 이번 틱에 생긴 것 중 조금이라도 보이는 것 (크기만큼 넓게 본다). 생길 때 한 번만, 남는 시간과 함께 보낸다
  for (const z of world.zones) {
    if (z.born !== world.tick) continue;
    const reach = VIEW_RADIUS + z.r;
    if ((z.x - cx) ** 2 + (z.y - cy) ** 2 <= reach * reach) {
      snap.z.push([z.id, ZONE_KINDS.indexOf(z.kind), r1(z.x), r1(z.y), Math.round(z.r), z.aux, Math.min(255, Math.ceil(z.ttl * TICK_RATE))]);
    }
  }
  // 끌려오는 경험치는 움직이므로 소수 좌표로 보낸다 (전송 크기는 같다: 어차피 1/16 픽셀 정수로 부호화한다)
  for (const g of world.gems) if (near(g.x, g.y)) snap.g.push([g.id, r1(g.x), r1(g.y)]);
  for (const h of world.heals) if (near(h.x, h.y)) snap.h.push([h.id, Math.round(h.x), Math.round(h.y)]);
  // 필드 아이템은 거리와 상관없이 모두에게 보낸다: 찾아가라고 놓는 것이라 숨길 정보가 아니다 (최대 MAX_FIELD_ITEMS 개)
  for (const it of world.items) snap.i.push([it.id, FIELD_ITEM_KINDS.indexOf(it.kind), r1(it.x), r1(it.y), it.ttl <= FIELD_ITEM_FADE ? 1 : 0]);
  return snap;
}

export { isWeapon };
