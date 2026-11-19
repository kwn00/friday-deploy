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
  INVULN_SECONDS,
  MAX_CHESTS,
  MAX_ENEMIES_ALL,
  MAX_ENEMIES_REGULAR,
  OFFER_COUNT,
  OFFER_TIMEOUT,
  PLAYER_BASE_HP,
  PLAYER_RADIUS,
  SPECTATOR_LEASH,
  SPECTATOR_PULL,
  SPECTATOR_SPEED,
  TICK_RATE,
  VIEW_RADIUS,
  ENEMY_VIEW_RADIUS,
} from './constants';
import {
  ENEMIES,
  ENEMY_IDS,
  FIELD_ITEMS,
  FIELD_ITEM_KINDS,
  PASSIVE_IDS,
  PASSIVE_SLOTS,
  SHOT_KINDS,
  STAGE,
  STAGE_TIME,
  UPGRADES,
  UPGRADE_IDS,
  WEAPON_IDS,
  WEAPON_SLOTS,
  ZONE_KINDS,
  isWeapon,
  type ChestOdds,
  type EnemyId,
  type FieldItemKind,
  type ShotKind,
  type UpgradeId,
  type WeaponId,
  type ZoneKind,
} from './content';
import { Grid, auraRadius, duckState, petPosition, runWeapons, updateShots, updateZones } from './combat';
import { curseOf, effectiveStats, extraOfferChanceOf, growthOf, healAmountOf, hitDamage, luckOf, lv, maxHpOf, moveSpeedOf, pickupOf, recoveryOf } from './stats';
import type { Offer, Snapshot } from './protocol';
import { derivedSecret, sfc32, type Rand, type Seed } from './rng';

/** 적 정의를 지역 상수로 잡아 둔다 (모듈 경계 너머의 이름은 틱마다 수천 번 읽으면 그 자체로 무겁다) */
const EN = ENEMIES;

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
  /**
   * 지금의 입력으로 캐릭터를 움직인 틱 수. 입력이 바뀌면 0 부터 다시 센다.
   * 스냅샷에 실려 가서, 클라이언트가 내 캐릭터를 얼마나 앞서 그릴지 계산하는 데 쓴다 (판정에는 쓰지 않는다).
   */
  held: number;
  /**
   * 이번 틱 도중에 입력이 바뀌었을 때: 지금 입력이 시작된 때(틱의 0~1)와, 그 전의 입력들이 이번 틱에 움직인 몫(방향 × 틱의 비율).
   * 서버는 입력을 도착한 때부터 적용한다. 틱 단위로 끊으면 누르고 뗀 시간과 실제로 움직인 거리가 최대 한 틱만큼 어긋나서,
   * 화면이 내 캐릭터를 앞서 그린 자리와 서버 위치가 멈출 때마다 조금씩 달라진다.
   */
  part: number;
  preX: number;
  preY: number;
  /** 가지고 있는 부활 수 (백업 + 스냅샷). 쓰러질 때 하나를 써서 그 자리에서 되살아난다 */
  revives: number;
  /** 그중 주운 백업의 수 (백업은 하나까지만 가질 수 있다. 스냅샷으로 받은 부활과 따로 센다) */
  backups: number;
  /** 피해를 받지 않는 남은 시간(초). 되살아난 직후에만 0 보다 크다 */
  shield: number;
  /** 한 대 맞은 뒤(또는 레벨업 선택·상자·방패 직후) 피해를 받지 않는 남은 시간(초) */
  iframe: number;
  /** 2단계 인증 방패: 남은 수. 맞을 때 피해 대신 하나 줄고 잠깐 무적이 된다 */
  charges: number;
  /** 쉬지 않고 움직인 시간(초). 스프린트가 세지는 데 쓴다 */
  moveTime: number;
  /** 러버덕이 돌고 있는 남은 시간(초). 0 이면 쉬는 중 */
  duckOn: number;
  /** 코드 프리즈가 다음에 쏠 방향 (시곗바늘 12칸 중 하나) */
  freezeDir: number;
  /** 마지막으로 커밋 히스토리 발자국을 남긴 자리 */
  trailX: number;
  trailY: number;
  /** 소환물(카나리아·부엉이)의 id: 화면에서 같은 새로 이어 그리도록 고정한다 */
  pets: Partial<Record<'canary' | 'night_owl', number>>;
  /** 켜져 있는 남은 시간(초): 카나리아·부엉이가 폭탄을 퍼붓는 동안 */
  on: Partial<Record<UpgradeId, number>>;
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
  /** 이동 속도 배율 (저주로 빨라진다) */
  spd: number;
  /** 얼어 있는 남은 시간(초). 얼어 있으면 움직이지도 때리지도 못한다 */
  frozen: number;
  /** 지금의 넉백 받는 배율 (방화벽에 맞을 때마다 상한까지 오른다)과 빙결 저항 (방화벽에 맞을 때마다 줄어든다) */
  kbTaken: number;
  resFreeze: number;
  /** 넉백으로 밀려나는 남은 시간(초)과 그동안의 배율 (음수면 끌려온다) */
  kbTime: number;
  kbMult: number;
  /** 한 방향으로만 가는 적(버그 떼)의 속도와 남은 수명(초). 아니면 0 */
  vx: number;
  vy: number;
  life: number;
  /** 보스: 쓰러지면 떨어뜨릴 보물상자 설정 */
  chest?: ChestOdds;
  /** 공격별로 다음에 다시 맞을 수 있는 시각 (같은 공격에 너무 자주 맞지 않게) */
  lock?: Map<number, number>;
  /** 이번 틱에 피해를 입고 살아남았는지. 클라이언트가 피격 이펙트를 그리는 데만 쓴다 (체력은 보내지 않는다) */
  hit: boolean;
}

export interface Shot {
  id: number;
  kind: ShotKind;
  /** 어느 무기의 것인지 (치명타·넉백) */
  w: WeaponId;
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
  /** 고양이가 방향을 바꾸기까지 남은 시간 */
  turn: number;
}

/** 바닥에 생기는 공격 영역. dmg 가 0 이면 보이기만 한다 (피해는 만들 때 이미 줬다) */
export interface Zone {
  id: number;
  kind: ZoneKind;
  /** 어느 무기의 것인지 (치명타·넉백) */
  w: WeaponId;
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
  /** 땅의 경험치가 너무 많을 때 새 경험치를 모으는 빨간 경험치 (하나뿐이다) */
  big?: boolean;
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
  /** 보물상자: 떨어뜨린 보스의 상자 설정과 떨어진 틱 */
  chest?: ChestOdds;
  born?: number;
}

export type WorldEvent =
  | { type: 'offers'; pid: number }
  | { type: 'over' }
  /** 보물상자를 열었다: 오른 것들 (같은 것이 여러 번 있을 수 있다)과 대신 찬 체력 */
  | { type: 'chest'; pid: number; items: UpgradeId[]; heal: number };

/** 예약된 맵 이벤트 (버그 떼, 깨지는 테스트 포위) */
interface PendingEvent {
  kind: 'swarm' | 'ring';
  at: number;
  chance: number;
  count: number;
  life: number;
}

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
  /** 마지막 step 에서 틱이 실제로 진행됐는지 (멈춰 있으면 false) */
  stepped: boolean;
  /** 다음 회복 아이템이 떨어질 수 있을 때까지 남은 시간(초) */
  healCd: number;
  /** 지금 웨이브(분). -1 이면 아직 시작 전 */
  wave: number;
  /** 다음 스폰 시도까지 남은 시간(초) */
  spawnCd: number;
  /** 이번 분의 저주 배율 (분이 바뀔 때 살아 있는 사람들의 평균으로 정한다: 속도·수·빈도에 쓴다) */
  waveCurse: number;
  pending: PendingEvent[];
  /** 수명보다 일찍 없어진 바닥 영역 (날아간 커밋): 클라이언트에 지우라고 한 번 알린다 */
  gone: { id: number; tick: number }[];
  /** 30분이 지났는지 (적을 모두 지우고 1분마다 '월요일 아침'을 보낸다)와 다음 것까지 남은 시간 */
  overtime: boolean;
  reaperCd: number;
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
    stepped: false,
    wave: -1,
    spawnCd: 0,
    waveCurse: 1,
    pending: [],
    gone: [],
    overtime: false,
    reaperCd: 0,
    events: [],
  };
}

export { maxHpOf };
/** 레벨 n 까지 모은 경험치의 합 (뱀서 위키의 계산식): min(5 + 1.5·floor(n/20), 8)·n² */
const xpTotal = (n: number): number => Math.min(5 + 1.5 * Math.floor(n / 20), 8) * n * n;
/** 레벨 L 에서 L+1 로 오르는 데 필요한 경험치 (1→2: 5, 2→3: 15, ... 19→20: 185, 20→21: 795, ...) */
export const xpForLevel = (level: number): number => xpTotal(level) - xpTotal(level - 1);

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
    held: 0,
    part: 0,
    preX: 0,
    preY: 0,
    revives: 0,
    backups: 0,
    shield: 0,
    iframe: 0,
    charges: 0,
    moveTime: 0,
    duckOn: 0,
    freezeDir: 0,
    trailX: Number.NaN,
    trailY: Number.NaN,
    pets: {},
    on: {},
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

/**
 * 입력 적용. 값은 이미 파싱 단계에서 유한/범위 검증됨. 여기서 길이를 1 이하로 다시 강제한다.
 * at: 이번 틱의 어디쯤에서 도착했는지 (0~1. 서버가 자기 시계로 잰 값이다: 클라이언트가 보내는 값이 아니다).
 * 그 앞부분은 이전 입력으로, 뒷부분은 새 입력으로 움직인다. 어느 쪽이든 길이가 1 이하라서 한 틱에 가는 거리는 늘지 않는다.
 */
export function setInput(world: World, id: number, dx: number, dy: number, at = 0): void {
  const p = world.players.get(id);
  if (!p) return;
  const len = Math.hypot(dx, dy);
  if (len > 1) {
    dx /= len;
    dy /= len;
  }
  // 한 틱 안에서 시간은 앞으로만 간다 (늦게 온 입력이 앞의 입력이 쓴 시간을 다시 쓰지 못한다)
  const t = Math.min(1, Math.max(p.part, Number.isFinite(at) ? at : 0));
  p.preX += p.dx * (t - p.part);
  p.preY += p.dy * (t - p.part);
  p.part = t;
  p.dx = dx;
  p.dy = dy;
  p.held = 0;
}

/** 레벨업 선택. 서버가 제시한 선택지의 인덱스만 받는다. 유효하지 않으면 false. */
export function pickOffer(world: World, id: number, choice: number): boolean {
  const p = world.players.get(id);
  if (!p || !p.offers) return false;
  const up = p.offers[choice];
  if (up === undefined) return false;
  levelUp(p, up);
  p.offers = null;
  p.offerTimer = 0;
  // 고르고 나서 잠깐 무적 (뱀서: 레벨업 뒤 "a brief moment of invulnerability")
  p.iframe = Math.max(p.iframe, INVULN_SECONDS);
  checkLevelUp(world, p);
  return true;
}

/** 강화 하나를 한 단계 올린다 (레벨업 선택과 보물상자가 같이 쓴다) */
function levelUp(p: Player, up: UpgradeId): void {
  p.up[up] = Math.min(UPGRADES[up].max, lv(p, up) + 1);
  // 스냅샷: 고를 때마다 부활을 하나 준다
  if (up === 'snapshot') p.revives++;
  // 무기는 얻거나 오르면 바로 한 번 쓴다 (뱀서). 러버덕·카나리아·부엉이는 바로 켜진다
  if (isWeapon(up)) {
    p.cd[up] = 0;
    if (up === 'canary' || up === 'night_owl') p.on[up] = 0;
  }
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
  if (kind === 'heal') return Math.ceil(p.hp) < Math.ceil(maxHpOf(p));
  // 백업은 하나만 가질 수 있다 (스냅샷으로 받은 부활은 따로 센다)
  if (kind === 'revive') return p.backups < MAX_REVIVES;
  return true;
}

/** 회복 아이템: 30, 워라밸 0.2 마다 20% 더 (뱀서 Floor Chicken) */
function heal(p: Player): void {
  p.hp = Math.min(maxHpOf(p), p.hp + healAmountOf(p));
}

function takeItem(world: World, p: Player, it: FieldItem): void {
  const kind = it.kind;
  if (kind === 'heal') {
    heal(p);
  } else if (kind === 'chest') {
    openChest(world, p, it.chest ?? [1, 0, 0, 0]);
  } else if (kind === 'revive') {
    p.revives++;
    p.backups++;
  } else {
    // 지금 레벨을 채우는 데 필요한 만큼을 통째로 준다: 정확히 한 레벨 오르고, 모으던 경험치는 그대로 남는다
    p.xp += p.xpNext;
    checkLevelUp(world, p);
  }
}

/**
 * 보물상자를 연다 (뱀서 Treasure Chest). 5개 → 3개 → 1개 순서로 각각 따로 굴려 처음 성공한 것, 셋 다 실패하면 보스에 정해진 기본 단계.
 * 확률에는 운을 곱한다. 들어 있는 것은 가진 무기·패시브 중 아직 최대가 아닌 것을 하나씩 무작위로 (같은 것이 또 나올 수 있다).
 * 올릴 것이 하나도 없으면 그 몫만큼 회복한다. 모두 비밀 난수로 정한다.
 */
function openChest(world: World, p: Player, odds: ChestOdds): void {
  const [base, p5, p3, p1] = odds;
  const luck = luckOf(p);
  const roll = (pct: number): boolean => world.secret() * 100 < pct * luck;
  const tier = roll(p5) ? 3 : roll(p3) ? 2 : roll(p1) ? 1 : base;
  const n = tier === 3 ? 5 : tier === 2 ? 3 : 1;
  const items: UpgradeId[] = [];
  let healed = 0;
  for (let i = 0; i < n; i++) {
    const owned = UPGRADE_IDS.filter((u) => lv(p, u) > 0 && lv(p, u) < UPGRADES[u].max);
    if (owned.length === 0) {
      const before = p.hp;
      heal(p);
      healed += p.hp - before;
      continue;
    }
    const up = owned[Math.floor(world.secret() * owned.length)]!;
    levelUp(p, up);
    items.push(up);
  }
  p.iframe = Math.max(p.iframe, INVULN_SECONDS);
  world.events.push({ type: 'chest', pid: p.id, items, heal: Math.round(healed) });
}

/** 쓰러질 순간에 부활을 하나 써서 그 자리에서 되살아난다 */
function revive(world: World, p: Player): void {
  p.revives--;
  // 백업부터 쓴다 (다음 백업을 주울 수 있게)
  if (p.backups > 0) p.backups--;
  // 스냅샷으로 받은 부활을 다 쓰면 스냅샷이 칸에서 빠진다 (뱀서 Tiragisu: 다시 얻을 수 있다)
  else if (p.revives <= p.backups) delete p.up.snapshot;
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

/**
 * 레벨업 선택지 (뱀서 Level up 규칙).
 * - 가진 것은 최대 단계 전까지, 새 것은 칸이 남아 있을 때만 (무기 6칸, 패시브 6칸)
 * - 칸이 다 차지 않았으면 먼저 두 번, 확률 1 + 0.3x - 1/운 (x: 짝수 레벨 2, 홀수 레벨 1) 으로 가진 것 하나씩을 넣는다
 * - 나머지는 rarity 를 무게로 겹치지 않게 뽑는다. 3개, 확률 1 - 1/운 으로 4개
 * - 올릴 것이 하나도 없으면 회복 아이템 하나만큼 회복한다
 * 모두 비밀 난수로 정한다: 보이는 스폰을 관찰해도 다음 선택지를 알 수 없게
 */
function checkLevelUp(world: World, p: Player): void {
  while (p.offers === null && p.xp >= p.xpNext - 1e-9) {
    p.xp = Math.max(0, p.xp - p.xpNext);
    p.level++;
    p.xpNext = xpForLevel(p.level);
    const weapons = WEAPON_IDS.filter((u) => lv(p, u) > 0).length;
    const passives = PASSIVE_IDS.filter((u) => lv(p, u) > 0).length;
    const pool = UPGRADE_IDS.filter((u) => {
      const l = lv(p, u);
      if (l >= UPGRADES[u].max) return false;
      if (l > 0) return true;
      return isWeapon(u) ? weapons < WEAPON_SLOTS : passives < PASSIVE_SLOTS;
    });
    if (pool.length === 0) {
      heal(p);
      continue;
    }
    const luck = luckOf(p);
    const count = Math.min(pool.length, OFFER_COUNT + (world.secret() < extraOfferChanceOf(p) ? 1 : 0));
    const picked: UpgradeId[] = [];
    if (weapons < WEAPON_SLOTS || passives < PASSIVE_SLOTS) {
      const ownedChance = 1 + 0.3 * (p.level % 2 === 0 ? 2 : 1) - 1 / luck;
      for (let k = 0; k < 2 && picked.length < count; k++) {
        if (world.secret() >= ownedChance) continue;
        const owned = pool.filter((u) => lv(p, u) > 0 && !picked.includes(u));
        if (owned.length > 0) picked.push(owned[Math.floor(world.secret() * owned.length)]!);
      }
    }
    while (picked.length < count) {
      const rest = pool.filter((u) => !picked.includes(u));
      let roll = world.secret() * rest.reduce((sum, u) => sum + UPGRADES[u].rarity, 0);
      let choice = rest[rest.length - 1]!;
      for (const u of rest) {
        roll -= UPGRADES[u].rarity;
        if (roll < 0) {
          choice = u;
          break;
        }
      }
      picked.push(choice);
    }
    // 보여 주는 순서도 섞는다 (가진 것이 늘 앞에 오지 않게)
    for (let i = picked.length - 1; i > 0; i--) {
      const j = Math.floor(world.secret() * (i + 1));
      [picked[i], picked[j]] = [picked[j]!, picked[i]!];
    }
    p.offers = picked;
    p.offerTimer = 0;
    world.events.push({ type: 'offers', pid: p.id });
  }
}

/** 함께 하는 사람 수에 따른 적 배율 (사람이 늘면 적도 는다: 우리 게임의 규칙) */
const coopOf = (alive: number): number => 0.6 + 0.4 * alive;

/**
 * 적 하나를 낸다. 위치는 보이는 난수로: 살아 있는 사람 중 하나의 둘레 300~360px (화면 바로 밖).
 * 체력은 그 사람의 저주(바로 적용)와, HP x Level 인 적이면 그 사람의 레벨을 곱한다. 속도는 이번 분의 저주.
 */
function spawnEnemy(world: World, type: EnemyId, anchor: Player, x?: number, y?: number): Enemy {
  const def = EN[type];
  if (x === undefined || y === undefined) {
    const a = world.rng() * Math.PI * 2;
    const d = 300 + world.rng() * 60;
    x = anchor.x + Math.cos(a) * d;
    y = anchor.y + Math.sin(a) * d;
  }
  const e: Enemy = {
    id: world.nextId++,
    type,
    x,
    y,
    hp: def.hp * (def.lvHp ? anchor.level : 1) * curseOf(anchor),
    spd: world.waveCurse,
    frozen: 0,
    kbTaken: def.kb,
    resFreeze: def.resFreeze,
    kbTime: 0,
    kbMult: 0,
    vx: 0,
    vy: 0,
    life: 0,
    hit: false,
  };
  world.enemies.push(e);
  return e;
}

/** 이 분의 이벤트를 예약한다 (분 시작 시각 + at, 그 뒤 delay 간격으로 repeat 번) */
function scheduleEvents(world: World, minute: number): void {
  for (const ev of STAGE[minute]?.events ?? []) {
    for (let k = 0; k < ev.repeat; k++) {
      world.pending.push({ kind: ev.kind, at: minute * 60 + ev.at + k * ev.delay, chance: ev.chance, count: ev.count, life: ev.life });
    }
  }
}

/**
 * 맵 이벤트 (뱀서의 Bat Swarm / Flower Wall 과 같은 규칙: 확률은 운으로 나누고 반복마다 따로 굴린다).
 * - swarm: 한 사람 옆에서 한 줄로 늘어선 버그 떼가 반대쪽으로 화면을 가로지른다 (쫓지 않는다, 6초 뒤 사라진다)
 * - ring: 한 사람 둘레에 깨지는 테스트가 원을 이루고 천천히 좁혀 온다
 */
function runEvent(world: World, ev: PendingEvent, alive: Player[], capAll: number): void {
  const anchor = alive[Math.floor(world.rng() * alive.length)]!;
  const luck = alive.reduce((sum, p) => sum + luckOf(p), 0) / alive.length;
  if (world.rng() >= ev.chance / luck) return;
  const room = Math.max(0, capAll - world.enemies.length);
  const n = Math.min(room, Math.round(ev.count * coopOf(alive.length)));
  if (ev.kind === 'ring') {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      spawnEnemy(world, 'flaky_test', anchor, anchor.x + Math.cos(a) * 260, anchor.y + Math.sin(a) * 260).life = ev.life;
    }
    return;
  }
  const a = world.rng() * Math.PI * 2;
  const dirX = -Math.cos(a);
  const dirY = -Math.sin(a);
  const sp = ENEMIES.bug_swarm.speed;
  for (let i = 0; i < n; i++) {
    // 떼의 가운데가 그 사람을 지나가도록, 진행 방향에 수직으로 늘어선다 (조금씩 흩어진다)
    const off = (i - (n - 1) / 2) * 9 + (world.rng() - 0.5) * 12;
    const back = world.rng() * 40;
    const e = spawnEnemy(
      world,
      'bug_swarm',
      anchor,
      anchor.x + Math.cos(a) * (340 + back) - dirY * off,
      anchor.y + Math.sin(a) * (340 + back) + dirX * off,
    );
    e.vx = dirX * sp;
    e.vy = dirY * sp;
    e.life = ev.life;
  }
}

/**
 * 적 스폰 (뱀서 웨이브 규칙). 1분에 웨이브 하나 (STAGE).
 * - 웨이브가 바뀌면: 이번 분의 저주를 정하고, 보스를 내고, 이벤트를 예약한다
 * - interval/저주 초마다: 살아 있는 적이 최소×저주보다 적으면 최소까지 한꺼번에 채우고, 아니면 종류마다 한 마리씩
 * - 살아 있는 적이 300 이상이면 주기적인 스폰은 멈춘다. 보스·이벤트는 500 까지 (사람 수와 상관없이 같다)
 * - 30분이 되면 모든 적이 사라지고, 그 뒤로 1분마다 '월요일 아침'이 하나씩 온다
 */
function spawnEnemies(world: World, alive: Player[], dt: number): void {
  // 상한은 사람 수와 상관없이 같다 (무료 서버의 CPU). 사람이 늘면 최소 수와 한 번에 나오는 수만 늘어난다
  const coop = coopOf(alive.length);
  const capRegular = MAX_ENEMIES_REGULAR;
  const capAll = MAX_ENEMIES_ALL;
  if (world.time >= STAGE_TIME) {
    if (!world.overtime) {
      world.overtime = true;
      world.enemies = [];
      world.pending = [];
      world.reaperCd = 0;
    }
    world.reaperCd -= dt;
    if (world.reaperCd <= 0) {
      world.reaperCd += 60;
      spawnEnemy(world, 'monday', alive[Math.floor(world.rng() * alive.length)]!);
    }
    return;
  }
  const minute = Math.min(STAGE.length - 1, Math.floor(world.time / 60));
  const wave = STAGE[minute]!;
  if (minute !== world.wave) {
    world.wave = minute;
    // 저주의 속도·수·빈도는 다음 분부터 적용된다 (뱀서 Curse). 체력은 나올 때 그 사람의 저주로 바로 적용된다
    world.waveCurse = alive.reduce((sum, p) => sum + curseOf(p), 0) / alive.length;
    world.spawnCd = 0;
    if (wave.boss && world.enemies.length < capAll) {
      const anchor = alive[Math.floor(world.rng() * alive.length)]!;
      spawnEnemy(world, wave.boss.type, anchor).chest = wave.boss.chest;
    }
    scheduleEvents(world, minute);
  }
  if (world.pending.length > 0) {
    const due = world.pending.filter((ev) => ev.at <= world.time);
    if (due.length > 0) {
      world.pending = world.pending.filter((ev) => ev.at > world.time);
      for (const ev of due) runEvent(world, ev, alive, capAll);
    }
  }
  world.spawnCd -= dt;
  while (world.spawnCd <= 0) {
    world.spawnCd += wave.interval / world.waveCurse;
    if (world.enemies.length >= capRegular) continue;
    const quota = Math.round(wave.min * world.waveCurse * coop);
    const pickType = (): EnemyId => wave.types[Math.floor(world.rng() * wave.types.length)]!;
    const anchorOf = (): Player => alive[Math.floor(world.rng() * alive.length)]!;
    if (world.enemies.length < quota) {
      const n = Math.min(quota, capRegular) - world.enemies.length;
      for (let i = 0; i < n; i++) spawnEnemy(world, pickType(), anchorOf());
    } else {
      // 최소를 넘었으면 종류마다 한 마리씩 (함께 하면 그만큼 더)
      for (const type of wave.types) {
        const n = Math.floor(coop) + (world.rng() < coop - Math.floor(coop) ? 1 : 0);
        for (let i = 0; i < n && world.enemies.length < capRegular; i++) spawnEnemy(world, type, anchorOf());
      }
    }
  }
}

export function step(world: World, dt: number): void {
  advance(world, dt);
  // 틱 도중에 바뀐 입력의 몫은 이번 틱에만 쓴다 (월드가 멈춰 있어 쓰지 않았더라도 다음 틱으로 넘기지 않는다)
  for (const p of world.players.values()) {
    p.part = 0;
    p.preX = 0;
    p.preY = 0;
  }
}

function advance(world: World, dt: number): void {
  world.stepped = false;
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
  world.stepped = true;
  // 누적 덧셈 대신 틱에서 계산: 오차가 쌓이지 않고, 클라이언트가 tick 만으로 같은 시간을 구할 수 있다 (러버덕 각도)
  world.time = world.tick * dt;
  world.healCd -= dt;
  if (world.gone.length > 0) world.gone = world.gone.filter((g) => world.tick - g.tick < 200);

  // 필드 아이템: 수명이 다한 것을 치우고, 때가 되면 하나 놓는다 (가득 차 있으면 이번 차례는 건너뛴다)
  if (world.items.length > 0) {
    for (const it of world.items) it.ttl -= dt;
    world.items = world.items.filter((it) => it.ttl > 0);
  }
  world.itemCd -= dt;
  if (world.itemCd <= 0) {
    world.itemCd = fieldItemDelay(world.secret);
    if (world.items.filter((it) => it.kind !== 'chest').length < MAX_FIELD_ITEMS) spawnFieldItem(world, alive);
  }
  for (const p of players) {
    if (p.shield > 0) p.shield = Math.max(0, p.shield - dt);
    if (p.iframe > 0) p.iframe = Math.max(0, p.iframe - dt);
  }

  // 선택 중인 플레이어는 이동/피격/공격 없음
  const active = alive.filter((p) => p.offers === null);

  for (const p of active) {
    // 워라밸: 가만히 있어도 조금씩 찬다
    const regen = recoveryOf(p);
    if (regen > 0) p.hp = Math.min(maxHpOf(p), p.hp + regen * dt);
    const sp = moveSpeedOf(p);
    p.x += (p.preX + p.dx * (1 - p.part)) * sp * dt;
    p.y += (p.preY + p.dy * (1 - p.part)) * sp * dt;
    if (p.held < 255) p.held++;
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

  // 적 이동 + 접촉. 접촉 피해는 한 대씩: 닿아 있는 적 가운데 가장 센 공격 하나를 맞고, 잠깐(0.24초) 무적이 된다 (뱀서)
  const strongest = new Map<Player, number>();
  for (const e of world.enemies) {
    const def = EN[e.type];
    e.hit = false;
    // 이벤트로 나온 적(버그 떼, 포위): 수명이 다하면 경험치 없이 사라진다
    if (e.life > 0) {
      e.life -= dt;
      if (e.life <= 0) {
        e.hp = 0;
        continue;
      }
    }
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
    const reach = def.r + PLAYER_RADIUS;
    let touching: boolean;
    if (def.fixed) {
      // 한 방향으로 아주 빠르게 지나간다: 이번 틱에 지나간 선분이 플레이어에 닿았는지로 본다 (한 틱에 건너뛰지 않게)
      const x0 = e.x;
      const y0 = e.y;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      touching = segmentDist(target.x, target.y, x0, y0, e.x, e.y) < reach;
    } else {
      // 너무 멀어진 적은 화면 바로 밖으로 다시 데려온다 (맵이 무한이므로. 보스도 체력을 그대로 가지고 돌아온다).
      // 이벤트로 나온 적은 데려오지 않는다 (수명이 다하면 사라진다)
      if (dist > 520 && e.life <= 0) {
        const a = world.rng() * Math.PI * 2;
        e.x = target.x + Math.cos(a) * 320;
        e.y = target.y + Math.sin(a) * 320;
        continue;
      }
      // 넉백: 남은 넉백 시간만큼 거꾸로 (배율만큼) 움직인다. 배율이 음수면 오히려 끌려온다
      let step = def.speed * e.spd * dt;
      if (e.kbTime > 0) {
        const kt = Math.min(dt, e.kbTime);
        step = def.speed * e.spd * (dt - kt) - def.speed * e.spd * kt * e.kbMult;
        e.kbTime -= kt;
      }
      // 빠른 적(사신 등)이 한 틱에 플레이어를 지나쳐 버리지 않게, 닿는 거리 안쪽까지만 다가간다
      step = Math.min(step, Math.max(0, dist - reach * 0.5));
      e.x += ((target.x - e.x) / dist) * step;
      e.y += ((target.y - e.y) / dist) * step;
      touching = Math.hypot(target.x - e.x, target.y - e.y) < reach;
    }
    if (touching) strongest.set(target, Math.max(strongest.get(target) ?? 0, def.power));
  }
  for (const [target, power] of strongest) {
    // 되살아난 직후(shield)와 무적 시간(iframe) 동안에는 맞지 않는다
    if (target.shield > 0 || target.iframe > 0) continue;
    target.iframe = INVULN_SECONDS;
    // 2단계 인증 방패가 있으면 피해 대신 하나를 쓰고 더 오래 무적이 된다
    if (target.charges > 0) {
      target.charges--;
      target.iframe = Math.max(INVULN_SECONDS, effectiveStats(target, 'two_factor').dur);
      continue;
    }
    target.hp -= hitDamage(target, power);
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
  world.enemies = world.enemies.filter((e) => e.hp > 0);

  // 적끼리 살짝 밀어내기 (공간 격자로 가까운 것끼리만 본다). 적이 300 마리까지 몰리면 틱에서 가장 무거운 일이라
  // 두 틱에 한 번만 한다 (화면에서는 차이가 거의 없다). 짝마다 한 번만 보도록 id 를 먼저 비교해서 거리 계산을 반으로 줄인다
  if (world.tick % 2 === 0) {
    const sep = new Grid(world.enemies);
    for (const a of world.enemies) {
      const ra = EN[a.type].r;
      // 후보는 밀기 전 자리(ax, ay)로 거르고, 실제로 미는 양은 지금 자리로 잰다
      const ax = a.x;
      const ay = a.y;
      sep.candidates(ax, ay, ra, (b) => {
        if (b.id <= a.id || b.hp <= 0) return;
        const min = ra + EN[b.type].r;
        if ((b.x - ax) ** 2 + (b.y - ay) ** 2 > min * min) return;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
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
  }

  // 무기 · 투사체 · 바닥 영역 (밀어낸 뒤의 자리로 격자를 만든다)
  const grid = new Grid(world.enemies);
  for (const p of active) if (p.alive) runWeapons(world, grid, p, dt);
  updateShots(world, grid, dt);
  updateZones(world, grid, dt);
  world.enemies = world.enemies.filter((e) => e.hp > 0);

  // 경험치(커밋): 획득 범위에 들어오면 그 플레이어에게 끌려가고, 닿으면 획득한다.
  // 범위는 예전의 "즉시 획득" 범위와 같다. 한번 끌리기 시작한 것은 범위를 벗어나도 계속 따라온다.
  const pullers = active.filter((p) => p.alive);
  // 경험치가 400 개까지 있으므로 획득 범위는 한 사람에 한 번만 계산한다
  const pullR2 = pullers.map((q) => pickupOf(q) ** 2);
  const gains = new Map<Player, number>();
  world.gems = world.gems.filter((g) => {
    let p = g.to === undefined ? undefined : world.players.get(g.to);
    // 끌던 사람이 쓰러졌거나, 나갔거나, 레벨업 선택 중이면 놓는다 (선택 중에는 예전에도 줍지 못했다)
    if (p && (!p.alive || p.offers !== null)) p = undefined;
    if (!p) {
      g.to = undefined;
      g.sp = undefined;
      let best = Infinity;
      for (let i = 0; i < pullers.length; i++) {
        const q = pullers[i]!;
        const d2 = (g.x - q.x) ** 2 + (g.y - q.y) ** 2;
        if (d2 <= pullR2[i]! && d2 < best) {
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
    // 사이드 프로젝트(와 20·40 레벨의 보너스): 같은 경험치를 주워도 더 많이 오른다. 소수도 그대로 쌓인다
    p.xp += gained * growthOf(p);
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
        // 보물상자는 끌려오지 않는다: 직접 닿아야 연다 (뱀서)
        const reach = it.kind === 'chest' ? CHEST_REACH : pickupOf(p);
        if (d2 <= reach ** 2 && d2 < best) {
          best = d2;
          who = p;
        }
      }
      if (!who) return true;
      takeItem(world, who, it);
      return false;
    });
  }

  for (const p of active) {
    if (!p.alive) continue;
    const r2 = pickupOf(p) ** 2;
    // 회복 아이템: 체력이 가득이면 줍지 않고 남겨 둔다
    // 화면에 보이는 체력(올림) 기준: 99.6 처럼 화면에는 가득으로 보일 때 아이템을 써 버리지 않는다
    const maxHp = Math.ceil(maxHpOf(p));
    if (Math.ceil(p.hp) < maxHp && world.heals.length > 0) {
      world.heals = world.heals.filter((h) => {
        if (Math.ceil(p.hp) >= maxHp || (h.x - p.x) ** 2 + (h.y - p.y) ** 2 > r2) return true;
        heal(p);
        return false;
      });
    }
  }
}

const r1 = (n: number): number => Math.round(n * 10) / 10;
/** 점 (px, py) 에서 선분 (ax, ay)-(bx, by) 까지의 거리 */
function segmentDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}
/** 보물상자를 열 수 있는 거리 (몸이 닿을 때) */
const CHEST_REACH = 14;
/** 경험치 색 단계 (뱀서): 2 이하 파랑, 9 이하 초록, 그 위는 빨강 */
export const gemTier = (v: number): 0 | 1 | 2 => (v <= 2 ? 0 : v <= 9 ? 1 : 2);

/**
 * 플레이어 한 명 시점의 스냅샷. 관심 영역(VIEW_RADIUS) 밖의 정보는 포함하지 않는다.
 * zonesAfter: 이 틱 뒤에 생긴 바닥 영역만 싣는다. 방은 연결마다 마지막으로 보낸 틱을 넘겨, 영역이 한 번씩만 가게 한다.
 * 주지 않으면 이번 틱에 새로 생긴 것만 (월드가 멈춰 틱이 그대로면 아무것도).
 */
export function buildSnapshot(world: World, pid: number, zonesAfter?: number): Snapshot | null {
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
    // 입력 번호와 도착한 때는 연결이 아는 값이라 방(room.ts)이 채운다
    ack: 0,
    ackTicks: me.held,
    ackPhase: 0,
    me: {
      id: me.id,
      hp: Math.ceil(me.hp),
      maxHp: Math.ceil(maxHpOf(me)),
      // 경험치는 소수(0.5 단위 등)일 수 있다. 화면의 막대에만 쓰므로 정수로 보낸다
      xp: Math.floor(me.xp),
      xpNext: Math.ceil(me.xpNext),
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
    zr: [],
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
      p.alive ? p.charges : 0,
      p.alive && p.iframe > 0 ? 1 : 0,
    ]);
  }
  const ev2 = ENEMY_VIEW_RADIUS * ENEMY_VIEW_RADIUS;
  for (const e of world.enemies) {
    const d2 = (e.x - cx) ** 2 + (e.y - cy) ** 2;
    if (d2 > (EN[e.type].boss ? v2 : ev2)) continue;
    snap.e.push([e.id, ENEMY_IDS.indexOf(e.type), r1(e.x), r1(e.y), e.hit ? 1 : 0, e.frozen > 0 ? 1 : 0]);
  }
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
  // 바닥 영역: 아직 보내지 않은 것 중 조금이라도 보이는 것 (크기만큼 넓게 본다). 한 번만, 남는 시간과 함께 보낸다
  const after = zonesAfter ?? (world.stepped ? world.tick - 1 : world.tick);
  for (const z of world.zones) {
    if (z.born <= after || z.ttl <= 0) continue;
    const reach = VIEW_RADIUS + z.r;
    if ((z.x - cx) ** 2 + (z.y - cy) ** 2 <= reach * reach) {
      snap.z.push([z.id, ZONE_KINDS.indexOf(z.kind), r1(z.x), r1(z.y), Math.round(z.r), z.aux, Math.min(255, Math.ceil(z.ttl * TICK_RATE))]);
    }
  }
  // 일찍 없어진 영역 (날아간 커밋): 영역처럼 한 번만 알린다
  for (const g of world.gone) if (g.tick > after) snap.zr.push(g.id);
  // 끌려오는 경험치는 움직이므로 소수 좌표로 보낸다 (전송 크기는 같다: 어차피 1/16 픽셀 정수로 부호화한다)
  // 색 단계 순서로 싣는다 (이진 스냅샷이 단계별로 묶어 보내므로, 풀었을 때와 같은 순서가 되게)
  // 넘친 경험치를 모으는 것은 처음부터 빨강이다
  const tierOf = (g: Gem): 0 | 1 | 2 => (g.big ? 2 : gemTier(g.v));
  // 경험치는 화면 바로 바깥(ENEMY_VIEW_RADIUS)까지만 보낸다: 400 개까지 쌓여 스냅샷에서 가장 큰 몫이다.
  // 끌려오기 전에는 움직이지 않으므로, 화면에 들어올 때 갑자기 나타나 보이지 않는다
  const gems: Gem[] = [];
  for (const g of world.gems) if ((g.x - cx) ** 2 + (g.y - cy) ** 2 <= ev2) gems.push(g);
  for (let tier = 0; tier < 3; tier++) {
    for (const g of gems) if (tierOf(g) === tier) snap.g.push([g.id, r1(g.x), r1(g.y), tier]);
  }
  for (const h of world.heals) if (near(h.x, h.y)) snap.h.push([h.id, Math.round(h.x), Math.round(h.y)]);
  // 필드 아이템은 거리와 상관없이 모두에게 보낸다: 찾아가라고 놓는 것이라 숨길 정보가 아니다 (최대 MAX_FIELD_ITEMS 개).
  // 보물상자는 미니맵 범위의 두 배 안의 것만 (보스는 가까이서 쓰러지므로 대개 그 안이다. 최대 MAX_CHESTS 개)
  const c2 = (VIEW_RADIUS * 2) ** 2;
  for (const it of world.items) if (it.kind !== 'chest' || (it.x - cx) ** 2 + (it.y - cy) ** 2 <= c2) snap.i.push([it.id, FIELD_ITEM_KINDS.indexOf(it.kind), r1(it.x), r1(it.y), it.ttl <= FIELD_ITEM_FADE ? 1 : 0]);
  return snap;
}

export { isWeapon };
