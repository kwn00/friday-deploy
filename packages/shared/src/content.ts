/** 개발자 컨셉 콘텐츠 정의: 적(버그들), 무기(도구들), 패시브(개발자 버프) */

/**
 * 적 종류. 순서가 곧 통신에서 쓰는 번호다 (6비트, 64종까지). 새 것은 맨 뒤에 추가할 것.
 * 수치는 뱀서 위키의 같은 역할 적의 값을 그대로 옮겼다 (체력·공격력·넉백·빙결 저항·경험치). 예외: 월요일 아침의 빙결 저항 (아래 보스 주석).
 * 속도: 위키에 단위가 없어서, 뱀서 플레이어의 기본 속도를 적 속도 단위 200 으로 보고 우리 플레이어 기본 속도(70 px/s)에 맞췄다
 * (뱀서 값 × 70/200). 해골·좀비(100)는 플레이어의 절반, 박쥐(140)는 0.7배, 유령(200)은 플레이어와 같다.
 */
export const ENEMY_IDS = [
  'bug',
  'null_ptr',
  'merge_conflict',
  'mem_leak',
  'legacy_code',
  'bug_red',
  'off_by_one',
  'typo',
  'merge_hell',
  'tech_debt',
  'flaky_test',
  'bug_swarm',
  'boss_bug',
  'spaghetti',
  'god_class',
  'monolith',
  'monday',
] as const;
export type EnemyId = (typeof ENEMY_IDS)[number];

export interface EnemyDef {
  name: string;
  /** 체력. lvHp 이면 나오는 순간 가까운 플레이어의 레벨을 곱한다 (뱀서의 HP x Level) */
  hp: number;
  lvHp?: boolean;
  /** 한 대 칠 때의 피해 (뱀서의 Power). 맞은 플레이어는 잠깐 무적이 된다 */
  power: number;
  /** 이동 속도 (px/s) */
  speed: number;
  /** 넉백을 받는 배율과 그 상한 (방화벽에 맞으면 상한까지 오른다). 음수면 맞을 때 오히려 끌려온다 */
  kb: number;
  kbMax: number;
  /**
   * 빙결 저항: 코드 프리즈의 빙결 확률(1)보다 크면 얼지 않는다 (디버거의 중단점도 같다. 디버거는 보스를 아예 멈추지 않는다).
   * 방화벽에 맞을 때마다 0.1 씩 줄어서 1.1 인 보스도 한 번 맞으면 언다. 월요일 아침은 방화벽의 약화를 받지 않아(debuffRes) 끝까지 얼지 않는다
   */
  resFreeze: number;
  xp: number;
  /** 크기(px) */
  r: number;
  boss?: boolean;
  /** git clean 에 지워지지 않는다 (뱀서의 instant kill resistance: 사신만) */
  killRes?: boolean;
  /** 방화벽의 약화(넉백·빙결 저항 깎기)를 받지 않는다 */
  debuffRes?: boolean;
  /** 플레이어를 쫓지 않고 처음 방향으로만 간다 (버그 떼) */
  fixed?: boolean;
}

const V = 70 / 200; // 뱀서 속도 → px/s

export const ENEMIES: Record<EnemyId, EnemyDef> = {
  // 일반 (뱀서의 Pipeestrello, Zombie, Skeleton, Ghost, Mudman, Werewolf, Big Mummy, Flower Wall, Bat Swarm 과 같은 수치)
  bug: { name: '버그', hp: 1, power: 5, speed: 140 * V, kb: 1, kbMax: 3, resFreeze: 0, xp: 1, r: 5 },
  bug_red: { name: '빨간 버그', hp: 5, power: 5, speed: 140 * V, kb: 1, kbMax: 3, resFreeze: 0, xp: 1, r: 5 },
  null_ptr: { name: 'NullPointerException', hp: 10, power: 10, speed: 100 * V, kb: 0.8, kbMax: 3, resFreeze: 0, xp: 1, r: 6 },
  off_by_one: { name: 'Off-by-one', hp: 15, power: 10, speed: 100 * V, kb: 1, kbMax: 3, resFreeze: 0, xp: 2, r: 6 },
  typo: { name: '오타', hp: 10, power: 5, speed: 200 * V, kb: 0, kbMax: 3, resFreeze: 0, xp: 1.5, r: 5 },
  merge_conflict: { name: 'Merge Conflict', hp: 70, power: 10, speed: 100 * V, kb: 0.3, kbMax: 3, resFreeze: 0, xp: 2.5, r: 7 },
  merge_hell: { name: '머지 지옥', hp: 150, power: 10, speed: 100 * V, kb: 0.3, kbMax: 3, resFreeze: 0, xp: 2.5, r: 8 },
  mem_leak: { name: 'Memory Leak', hp: 180, power: 14, speed: 130 * V, kb: 0.8, kbMax: 3, resFreeze: 0, xp: 2, r: 7 },
  tech_debt: { name: '기술 부채', hp: 500, power: 20, speed: 80 * V, kb: 0, kbMax: 3, resFreeze: 0, xp: 3, r: 10 },
  flaky_test: { name: '깨지는 테스트', hp: 30, lvHp: true, power: 1, speed: 20 * V, kb: 1, kbMax: 3, resFreeze: 0, xp: 2, r: 6 },
  bug_swarm: { name: '버그 떼', hp: 1, power: 1, speed: 700 * V, kb: 1, kbMax: 3, resFreeze: 0, xp: 1, r: 4, fixed: true },
  // 보스 (뱀서의 Glowing Bat, Giant Werewolf, Giant Mummy, Mantichana 보스, Giant Bat 보스, The Reaper 와 같은 수치).
  // 다만 월요일 아침(사신)의 빙결 저항은 위키에서 옮긴 1 이 아니라 1.1 이다: 30분 뒤에는 판 길이에 상한이 없고
  // 순위는 버틴 시간이 먼저라, 사신을 얼려 몇 분씩 더 버티지 못하게 한다. 사신은 멈추거나 밀어낼 수 없는 끝이다
  // (넉백은 음수라 밀려나지 않고 걷는 것보다 느려지지도 않으며(sim.ts 의 적 이동), 방화벽의 약화를 받지 않고,
  // 디버거는 보스를 멈추지 않는다)
  boss_bug: { name: '왕버그', hp: 50, lvHp: true, power: 10, speed: 140 * V, kb: 1, kbMax: 3, resFreeze: 0, xp: 30, r: 8, boss: true },
  legacy_code: { name: '레거시 코드', hp: 200, lvHp: true, power: 20, speed: 130 * V, kb: 0.1, kbMax: 1, resFreeze: 0, xp: 2, r: 12, boss: true },
  spaghetti: { name: '스파게티 코드', hp: 250, lvHp: true, power: 20, speed: 80 * V, kb: 0, kbMax: 1, resFreeze: 1.1, xp: 25, r: 13, boss: true },
  god_class: { name: 'God Class', hp: 150, lvHp: true, power: 20, speed: 160 * V, kb: 0, kbMax: 1, resFreeze: 1.1, xp: 50, r: 12, boss: true },
  monolith: { name: '모놀리스', hp: 500, lvHp: true, power: 20, speed: 140 * V, kb: 0, kbMax: 1, resFreeze: 1, xp: 25, r: 14, boss: true },
  monday: {
    name: '월요일 아침', hp: 655350, lvHp: true, power: 65535, speed: 1200 * V, kb: -0.5, kbMax: 0, resFreeze: 1.1, xp: 0, r: 10,
    boss: true, killRes: true, debuffRes: true,
  },
};

/* ───────────── 스테이지 (1분에 웨이브 하나) ─────────────
 * 규칙은 뱀서와 같다: 간격마다 화면의 적이 최소보다 적으면 최소까지 한꺼번에 채우고, 아니면 종류마다 한 마리씩 더 나온다.
 * 일반 적이 300 이상이면 더 나오지 않는다 (보스·이벤트는 500 까지). 표 자체는 우리 스테이지로 새로 짰다. */

/** 상자: [기본 단계(1~3), 5개 확률, 3개 확률, 1개 확률] (확률은 %, 운이 곱해진다) */
export type ChestOdds = readonly [base: 1 | 2 | 3, p5: number, p3: number, p1: number];

export interface WaveEvent {
  /** swarm: 버그 떼가 한쪽에서 화면을 가로지른다 / ring: 깨지는 테스트가 둘레를 에워싸고 좁혀 온다 */
  kind: 'swarm' | 'ring';
  /** 그 분이 시작되고 몇 초 뒤에 */
  at: number;
  /** 일어날 확률. 반복마다 따로 굴리고 운으로 나눈다 (뱀서: 운이 좋으면 덜 일어난다) */
  chance: number;
  /** 몇 번, 몇 초 간격으로 */
  repeat: number;
  delay: number;
  /** 한 번에 나오는 수 */
  count: number;
  /** 나온 적이 남아 있는 시간(초) (버그 떼 6초, 포위 30~60초) */
  life: number;
}

export interface Wave {
  types: readonly EnemyId[];
  min: number;
  /** 스폰을 시도하는 간격(초) */
  interval: number;
  boss?: { type: EnemyId; chest: ChestOdds };
  events?: readonly WaveEvent[];
}

const swarm = (chance: number, repeat = 1, delay = 5, count = 30, at = 5): WaveEvent => ({ kind: 'swarm', at, chance, repeat, delay, count, life: 6 });
const ring = (chance: number, count = 24, life = 30, at = 1): WaveEvent => ({ kind: 'ring', at, chance, repeat: 1, delay: 0, count, life });

/** 0분부터 29분까지의 웨이브. 30분이 되면 화면의 적이 모두 사라지고 1분마다 '월요일 아침'이 온다 */
export const STAGE: readonly Wave[] = [
  { types: ['bug'], min: 12, interval: 1.0 },
  { types: ['bug', 'bug_red'], min: 25, interval: 1.0, boss: { type: 'boss_bug', chest: [1, 0, 0, 30] } },
  { types: ['bug_red', 'null_ptr'], min: 40, interval: 0.5, events: [swarm(1, 2, 6)] },
  { types: ['off_by_one'], min: 40, interval: 0.25 },
  { types: ['off_by_one', 'typo'], min: 35, interval: 1.0, boss: { type: 'boss_bug', chest: [1, 0, 5, 40] }, events: [swarm(0.15)] },
  { types: ['typo', 'merge_conflict'], min: 20, interval: 1.0, events: [ring(1, 24)] },
  { types: ['merge_conflict', 'null_ptr'], min: 40, interval: 0.5, boss: { type: 'god_class', chest: [1, 1, 5, 100] } },
  { types: ['bug_red', 'merge_conflict', 'off_by_one'], min: 90, interval: 0.5, events: [swarm(0.7, 3, 8)] },
  { types: ['merge_hell'], min: 25, interval: 1.0, boss: { type: 'boss_bug', chest: [2, 3, 10, 50] } },
  { types: ['merge_hell', 'typo'], min: 60, interval: 0.5, boss: { type: 'monolith', chest: [1, 3, 10, 50] }, events: [swarm(0.6, 2, 12)] },
  { types: ['mem_leak'], min: 15, interval: 1.0, events: [ring(1, 32, 60)] },
  { types: ['off_by_one'], min: 250, interval: 0.1, boss: { type: 'boss_bug', chest: [1, 1, 5, 50] } },
  { types: ['mem_leak', 'typo', 'merge_conflict'], min: 40, interval: 0.25, events: [swarm(0.2)] },
  { types: ['mem_leak', 'typo'], min: 160, interval: 0.5, boss: { type: 'boss_bug', chest: [1, 3, 10, 100] }, events: [swarm(0.7, 10, 2)] },
  { types: ['merge_hell', 'mem_leak'], min: 30, interval: 0.1 },
  { types: ['mem_leak', 'merge_hell', 'merge_conflict'], min: 110, interval: 0.1, boss: { type: 'legacy_code', chest: [1, 3, 10, 100] }, events: [ring(0.8, 32, 60)] },
  { types: ['tech_debt'], min: 25, interval: 1.0 },
  { types: ['tech_debt', 'merge_hell'], min: 70, interval: 0.5, boss: { type: 'boss_bug', chest: [1, 3, 10, 100] } },
  { types: ['tech_debt', 'merge_conflict'], min: 110, interval: 0.5, events: [swarm(0.5, 5, 4)] },
  { types: ['tech_debt', 'mem_leak', 'merge_hell'], min: 120, interval: 0.2, boss: { type: 'spaghetti', chest: [1, 3, 10, 100] } },
  { types: ['flaky_test'], min: 280, interval: 0.1, events: [swarm(0.7, 10, 2)] },
  { types: ['flaky_test', 'tech_debt'], min: 220, interval: 0.1, boss: { type: 'boss_bug', chest: [1, 3, 10, 100] } },
  { types: ['tech_debt', 'merge_hell'], min: 300, interval: 0.1 },
  { types: ['tech_debt', 'mem_leak'], min: 200, interval: 0.1, boss: { type: 'monolith', chest: [1, 3, 10, 100] }, events: [ring(1, 40)] },
  { types: ['flaky_test', 'merge_hell'], min: 300, interval: 0.1 },
  { types: ['tech_debt'], min: 120, interval: 0.1, boss: { type: 'god_class', chest: [1, 3, 10, 100] }, events: [swarm(0.7, 10, 2)] },
  { types: ['tech_debt', 'flaky_test'], min: 160, interval: 0.1, boss: { type: 'boss_bug', chest: [1, 3, 10, 100] } },
  { types: ['tech_debt', 'merge_hell', 'merge_conflict'], min: 300, interval: 0.1, events: [swarm(1, 15, 3)] },
  { types: ['mem_leak', 'tech_debt'], min: 300, interval: 0.1, boss: { type: 'legacy_code', chest: [1, 3, 10, 100] } },
  { types: ['tech_debt', 'mem_leak', 'merge_hell'], min: 300, interval: 0.1, boss: { type: 'spaghetti', chest: [1, 3, 10, 100] }, events: [ring(1, 40)] },
];

/** 판의 제한 시간(초). 이때 화면의 적이 모두 사라지고 1분마다 '월요일 아침'(사신)이 하나씩 온다 */
export const STAGE_TIME = 30 * 60;

/**
 * 투사체·소환물 종류. 순서가 곧 통신에서 쓰는 번호다 (중간에 끼워 넣지 말고 뒤에 추가할 것).
 * 소환물(카나리아, 부엉이, 고양이)도 위치가 움직이는 것이라 투사체 목록으로 보낸다.
 */
export const SHOT_KINDS = ['log', 'regex', 'ai', 'book', 'rollback', 'ping', 'packet', 'bomb', 'canary', 'owl', 'cat', 'drill', 'breakpoint', 'socket'] as const;
export type ShotKind = (typeof SHOT_KINDS)[number];

/**
 * 바닥에 생기는 공격 영역 종류 (통신 번호 = 순서). 그리는 모양:
 * slash: 각도 a 방향으로 길이 r 인 베기 / pool: 반경 r 웅덩이 / bolt: 반경 r 번개 / wipe: 반경 r 전체 지우기 /
 * blast: 반경 r 폭발 / band: 폭 r 의 세로 띠 / trail: 반경 r 발자국 / beam: 각도 a 방향 길이 r 광선 / fire: 반경 r 불바다(금요일 배포).
 * wipe 의 aux 는 0 이면 git clean, 1 이면 rm -rf node_modules (색만 다르다)
 */
export const ZONE_KINDS = ['slash', 'pool', 'bolt', 'wipe', 'blast', 'band', 'trail', 'beam', 'fire'] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];

/* ───────────── 강화 (무기 · 패시브) ─────────────
 * 순서가 곧 통신에서 쓰는 순서다 (스냅샷에 내 강화 단계를 이 순서로 싣는다). 새 것은 각 목록의 맨 뒤에 추가할 것. */

export const WEAPON_IDS = [
  'console_log',
  'rubber_duck',
  'regex',
  'ai_agent',
  'ctrl_x',
  'brick_book',
  'rollback',
  'firewall',
  'hotfix',
  'ping_pong',
  'hot_reload',
  'git_clean',
  'canary',
  'night_owl',
  'broadcast',
  'multicast',
  'keyboard_cat',
  'infinite_scroll',
  'commit_history',
  'code_freeze',
  'two_factor',
  'sprint',
  'logic_bomb',
  // 진화한 무기 (레벨업 선택지에는 나오지 않는다. 보물상자로만 바뀐다: EVOLUTIONS)
  'debugger',
  'websocket',
  'friday_deploy',
  'rm_rf',
  'monitoring',
  'flooding',
] as const;
export type WeaponId = (typeof WEAPON_IDS)[number];

export const PASSIVE_IDS = [
  'coffee',
  'mech_keyboard',
  'stack_overflow',
  'npm_install',
  'dark_mode',
  'dual_monitor',
  'test_coverage',
  'work_life',
  'cdn',
  'keep_alive',
  'git_fork',
  'deploy_prayer',
  'side_project',
  'prod_hotfix',
  'snapshot',
] as const;
export type PassiveId = (typeof PASSIVE_IDS)[number];

export const UPGRADE_IDS = [...WEAPON_IDS, ...PASSIVE_IDS] as const;
export type UpgradeId = WeaponId | PassiveId;

/**
 * 생존·편의 패시브 7종 (무기를 세게 하지 않는 것): 고르면 모든 무기의 피해가 조금 오른다 (우리 규칙. 뱀서에는 없다. stats.ts 의 mightOf).
 * 고르는 결정은 1단계에서 나므로 1단계에 몰았다: 1단계 +5%, 2~5단계는 +1%씩 (하나에 최대 +9%, 6칸을 모두 채우면 +54% 로
 * Stack Overflow 5단계 +50% 와 비슷하다). 스냅샷(다 쓰면 칸에서 빠진다)과 저주(운영 서버 직접 수정)는 넣지 않는다
 */
export const SUPPORT_PASSIVES = ['coffee', 'npm_install', 'dark_mode', 'test_coverage', 'work_life', 'side_project', 'deploy_prayer'] as const satisfies readonly PassiveId[];
/** 생존·편의 패시브 하나가 그 단계까지 더하는 피해 배율 (단계 0 이면 0) */
export const supportMight = (level: number): number => (level > 0 ? 0.04 + 0.01 * Math.min(level, 5) : 0);

/**
 * 한 번 가지면 더 오르지 않는 것: 가진 뒤에는 레벨업 선택지와 보물상자에 나오지 않는다 (sim.ts 의 offerPool, openChest).
 * 운영 서버 직접 수정(저주): 금요일 배포의 짝으로 1단계만 노려도, 가진 것을 먼저 넣는 굴림과 보물상자로 원하지 않는 단계가 붙었다.
 * 최대 단계(max)는 낮추지 않는다: 예전 기록의 2~5단계가 ownedUpgrades 에서 버려져 순위표에서 사라지지 않게
 */
export const PICK_ONCE: readonly UpgradeId[] = ['prod_hotfix'];

/** 한 판에 가질 수 있는 무기 / 패시브 수 (처음 갖고 시작하는 무기 포함) */
export const WEAPON_SLOTS = 6;
export const PASSIVE_SLOTS = 6;

/**
 * 무기의 능력치. 단계가 오르면 levels 의 값이 더해진다. 수치는 뱀서 위키의 같은 무기 값(피해·쿨다운·개수·지속·관통·최대 단계)에서
 * 시작해 우리 밸런스로 고친다 (0.4.0 부터. 고친 값과 까닭은 docs/releases 와 upgrades.test.ts 의 수치 표에 있다).
 * 최대 단계는 바꾸지 않는다 (예전 기록의 단계가 ownedUpgrades 에서 버려지지 않게).
 * 크기와 속도는 우리 화면 단위(px)라 기본값은 우리 것이고, 단계 증가분만 비율로 옮겼다.
 * - dmg: 한 번 맞힐 때의 피해 (Stack Overflow 로 늘어난다)
 * - cd: 쿨다운(초). 다시 쓰기까지의 시간 (기계식 키보드로 줄어든다)
 * - amount: 한 번에 나가는 개수 (git fork 로 늘어난다)
 * - area: 크기(px). 반경·길이 등 무기마다 뜻이 다르다. 단계 증가분은 기본값에 대한 비율이다 (0.2 = +20%). 듀얼 모니터로 커진다
 * - speed: 빠르기(px/s 또는 rad/s). 단계 증가분은 비율이다. CDN 으로 빨라진다
 * - dur: 지속 시간(초) (keep-alive 로 늘어난다)
 * - pierce: 한 개가 더 맞힐 수 있는 적 수 (뱀서의 pierce 1 = 우리 0)
 * - chance: 무기마다 따로 쓰는 확률 (git clean: 아이템을 남길 확률). 운으로 커진다
 */
export interface WeaponStats {
  dmg: number;
  cd: number;
  amount: number;
  area: number;
  speed: number;
  dur: number;
  pierce: number;
  chance: number;
}

/** 무기가 받지 않는 패시브 (뱀서 위키의 "Ignores ..." 를 옮긴 것) */
export type StatKind = 'might' | 'cd' | 'amount' | 'area' | 'speed' | 'dur';

export interface WeaponDef {
  kind: 'weapon';
  name: string;
  icon: string;
  desc: string;
  max: number;
  base: WeaponStats;
  /** levels[i] = (i + 2) 단계에서 더해지는 값 */
  levels: Partial<WeaponStats>[];
  /** 레벨업 선택지에 나오는 무게 (뱀서의 rarity) */
  rarity: number;
  /** 맞힌 적을 밀어내는 세기 (뱀서의 knockback). 0 이면 밀지 않는다 */
  kb: number;
  /** 치명타: 확률(운이 곱해진다)과 배율 */
  crit?: { chance: number; mult: number };
  /** 남아 있는 공격이 같은 적을 다시 다치게 하는 간격(초) (뱀서의 hitbox delay) */
  rehit?: number;
  ignores?: StatKind[];
  /** 선택지 문구에서 능력치 이름을 바꿔 부를 때 (예: 2단계 인증의 개수 = 방패) */
  labels?: Partial<Record<keyof WeaponStats, string>>;
}

export interface PassiveDef {
  kind: 'passive';
  name: string;
  icon: string;
  desc: string;
  max: number;
  /** 단계마다 붙는 효과 (선택지에 보여준다). 배열이면 단계마다 다르다: per[단계 - 1] */
  per: string | string[];
  /** 레벨업 선택지에 나오는 무게 (뱀서의 rarity) */
  rarity: number;
}

export type UpgradeDef = WeaponDef | PassiveDef;

type Extra = Pick<WeaponDef, 'rarity' | 'kb'> & Partial<Pick<WeaponDef, 'crit' | 'rehit' | 'ignores' | 'labels'>>;
type Base = Omit<WeaponStats, 'chance'> & { chance?: number };

const W = (name: string, icon: string, desc: string, base: Base, levels: Partial<WeaponStats>[], extra: Extra): WeaponDef => ({
  kind: 'weapon',
  name,
  icon,
  desc,
  max: levels.length + 1,
  base: { chance: 0, ...base },
  levels,
  ...extra,
});
const P = (name: string, icon: string, desc: string, per: string | string[], rarity: number, max = 5): PassiveDef => ({
  kind: 'passive',
  name,
  icon,
  desc,
  max,
  per,
  rarity,
});
/** 생존·편의 패시브의 단계별 문구: 본래 효과 뒤에 그 단계에서 오르는 피해량(supportMight)을 붙인다 */
const withMight = (per: string | string[], max = 5): string[] =>
  Array.from({ length: max }, (_, i) => `${Array.isArray(per) ? per[i] : per}, 피해량 +${Math.round((supportMight(i + 1) - supportMight(i)) * 100)}%`);

/** 카나리아·야근 부엉이 (뱀서의 Peachone·Ebony Wings 에서 시작. 0.4.0: 1단계 피해 10 → 15, 3단계 증가분 10 → 5 로 8단계 30 은 그대로) */
const BIRD: [Base, Partial<WeaponStats>[]] = [
  { dmg: 15, cd: 1.0, amount: 4, area: 18, speed: 1.4, dur: 4.0, pierce: 0 },
  [
    { amount: 1, area: 0.4 },
    { amount: 1, dmg: 5 },
    { amount: 1, cd: -0.25 },
    { amount: 1, area: 0.4 },
    { amount: 1, dmg: 10 },
    { amount: 1, cd: -0.25 },
    { amount: 1, area: 0.4 },
  ],
];
/**
 * 브로드캐스트·멀티캐스트 (뱀서의 Phiera Der Tuphello·Eight The Sparrow 에서 시작).
 * 0.4.0: 7단계 속도 +50% → +25% (한 틱에 19.5px 를 가서 작은 적을 건너뛰었다. 16px 면 판정 폭 안이다)
 */
const CAST: [Base, Partial<WeaponStats>[]] = [
  { dmg: 5, cd: 1.4, amount: 1, area: 5, speed: 260, dur: 0.9, pierce: 0 },
  [{ amount: 1 }, { pierce: 2 }, { amount: 1 }, { dmg: 5 }, { pierce: 2 }, { dmg: 5, speed: 0.25 }, { pierce: 2 }],
];

export const UPGRADES: Record<UpgradeId, UpgradeDef> = {
  /* ── 무기 (뱀서의 같은 무기: Magic Wand, King Bible, Knife, Fire Wand, Whip, Axe, Cross, Garlic, Santa Water, Runetracer,
   *    Lightning Ring, Pentagram, Peachone, Ebony Wings, Phiera Der Tuphello, Eight The Sparrow, Gatti Amari, Song of Mana,
   *    Shadow Pinion, Clock Lancet, Laurel, Vento Sacro, Bracelet 순서) ── */
  console_log: W('console.log()', '🖨️', '가장 가까운 버그에게 로그를 찍는다. 디버거는 사치.',
    { dmg: 10, cd: 1.2, amount: 1, area: 4, speed: 220, dur: 1.0, pierce: 0 },
    [{ amount: 1 }, { cd: -0.2 }, { amount: 1 }, { dmg: 10 }, { amount: 1 }, { pierce: 1 }, { dmg: 10 }],
    { rarity: 100, kb: 1, ignores: ['dur'] }),
  rubber_duck: W('러버덕', '🦆', '잠깐씩 주위를 도는 오리. 설명하다 보면 버그가 죽는다.',
    { dmg: 10, cd: 2.5, amount: 1, area: 36, speed: 2.6, dur: 3.0, pierce: 0 },
    [{ amount: 1 }, { area: 0.25, speed: 0.3 }, { dur: 0.5, dmg: 10 }, { amount: 1 }, { area: 0.25, speed: 0.3 }, { dur: 0.5, dmg: 10 }, { amount: 1 }],
    { rarity: 80, kb: 1, rehit: 1.7 }),
  regex: W('정규표현식', '🔣', '가장 가까운 버그 쪽으로 나란히 날린다. 쓴 사람도 못 읽는다.',
    { dmg: 10, cd: 1.0, amount: 1, area: 5, speed: 320, dur: 0.75, pierce: 0 },
    [{ amount: 1 }, { amount: 1, dmg: 5 }, { amount: 1 }, { pierce: 1 }, { amount: 1 }, { amount: 1, dmg: 5 }, { pierce: 1 }],
    { rarity: 100, kb: 0.5, ignores: ['dur'] }),
  ai_agent: W('AI 에이전트', '🤖', '아무 버그 하나를 골라 여러 발을 세게 쏜다.',
    { dmg: 20, cd: 2.0, amount: 3, area: 6, speed: 180, dur: 1.4, pierce: 0 },
    [{ dmg: 10 }, { dmg: 10, speed: 0.2 / 0.75 }, { dmg: 10 }, { dmg: 10, speed: 0.2 / 0.75 }, { dmg: 10, amount: 1 }, { dmg: 10, speed: 0.2 / 0.75 }, { dmg: 10 }],
    { rarity: 80, kb: 1, ignores: ['dur'] }),
  ctrl_x: W('Ctrl+X', '✂️', '바라보는 쪽을 옆으로 크게 잘라낸다. 개수가 늘면 반대쪽도.',
    { dmg: 15, cd: 1.1, amount: 1, area: 64, speed: 0, dur: 0.15, pierce: 0 },
    [{ amount: 1 }, { dmg: 5 }, { dmg: 5, area: 0.1 }, { dmg: 5 }, { dmg: 5, area: 0.1 }, { dmg: 5 }, { dmg: 5 }],
    { rarity: 100, kb: 1, ignores: ['speed', 'dur'] }),
  brick_book: W('벽돌책', '🧱', '두꺼운 기술서를 던진다. 위로 날아갔다 떨어지며 버그를 짓누른다.',
    { dmg: 20, cd: 3.0, amount: 1, area: 8, speed: 260, dur: 3.0, pierce: 2 },
    [{ amount: 1 }, { dmg: 20 }, { pierce: 2 }, { amount: 1 }, { dmg: 20 }, { pierce: 2 }, { dmg: 20 }],
    { rarity: 100, kb: 1, ignores: ['dur'] }),
  rollback: W('롤백', '↩️', '부메랑처럼 날아갔다 돌아온다. 오가며 두 번 벤다.',
    { dmg: 5, cd: 2.0, amount: 1, area: 9, speed: 300, dur: 1.8, pierce: 999 },
    [{ dmg: 10 }, { area: 0.1, speed: 0.25 }, { amount: 1 }, { dmg: 10 }, { area: 0.1, speed: 0.25 }, { amount: 1 }, { dmg: 10 }],
    { rarity: 80, kb: 1, ignores: ['dur'] }),
  firewall: W('방화벽', '🔥', '내 주위의 버그를 계속 태운다. 맞을수록 잘 밀리고 잘 언다.',
    { dmg: 8, cd: 1.3, amount: 1, area: 30, speed: 0, dur: 0, pierce: 0 },
    [{ area: 0.4 }, { cd: -0.1 }, { area: 0.2, dmg: 1 }, { cd: -0.1, dmg: 2 }, { area: 0.2, dmg: 1 }, { cd: -0.1, dmg: 1 }, { area: 0.2, dmg: 2 }],
    { rarity: 70, kb: 0, ignores: ['speed', 'amount', 'dur'] }),
  hotfix: W('핫픽스', '💧', '급하게 뿌린 패치가 바닥에 고인다. 밟은 버그가 녹는다.',
    { dmg: 10, cd: 4.5, amount: 1, area: 22, speed: 0, dur: 2.0, pierce: 0 },
    [{ amount: 1, area: 0.2 }, { dur: 0.5, dmg: 10 }, { amount: 1, area: 0.2 }, { dur: 0.25, dmg: 10 }, { amount: 1, area: 0.2 }, { dur: 0.25, dmg: 5 }, { area: 0.2, dmg: 5 }],
    { rarity: 100, kb: 0, rehit: 0.5, ignores: ['speed'] }),
  ping_pong: W('핑퐁', '🏓', '아무 방향으로 날아가 화면 끝쯤에서 튕긴다. 계속 오가며 맞힌다.',
    { dmg: 15, cd: 3.0, amount: 1, area: 6, speed: 200, dur: 2.25, pierce: 999 },
    [{ speed: 0.2 }, { dur: 0.25, dmg: 5 }, { amount: 1 }, { dmg: 5, speed: 0.2 }, { dur: 0.25, dmg: 5 }, { amount: 1 }, { dur: 0.5 }],
    { rarity: 80, kb: 1, rehit: 0.5 }),
  hot_reload: W('핫 리로드', '⚡', '갑자기 번쩍. 주변의 아무 버그에게나 내리친다.',
    { dmg: 15, cd: 4.5, amount: 2, area: 14, speed: 0, dur: 0.25, pierce: 0 },
    [{ amount: 1 }, { area: 1.0, dmg: 10 }, { amount: 1 }, { area: 1.0, dmg: 20 }, { amount: 1 }, { area: 1.0, dmg: 20 }, { amount: 1 }],
    { rarity: 80, kb: 1, ignores: ['speed', 'dur'] }),
  git_clean: W('git clean -fd', '🧹', '가끔 화면의 버그를 보스까지 통째로 지운다. 경험치는 자주 같이 지워지지만 보물상자는 남는다.',
    { dmg: 0, cd: 90, amount: 1, area: 0, speed: 0, dur: 1.0, pierce: 0, chance: 0.25 },
    [{ cd: -10 }, { chance: 0.15 }, { cd: -10 }, { chance: 0.2 }, { cd: -5 }, { chance: 0.2 }, { cd: -5 }],
    { rarity: 60, kb: 0, ignores: ['might', 'amount', 'area', 'speed', 'dur'], labels: { chance: '아이템과 경험치를 남길 확률' } }),
  canary: W('카나리아', '🐤', '내 주위를 시계 방향으로 돌며 4초 동안 폭탄을 퍼붓는다. 배포 전에 먼저 날려 보낸다.', ...BIRD,
    { rarity: 50, kb: 2 }),
  night_owl: W('야근 부엉이', '🦉', '카나리아와 반대 방향으로 돌며 4초 동안 폭탄을 퍼붓는다. 야근이 체질이다.', ...BIRD,
    { rarity: 50, kb: 2 }),
  broadcast: W('브로드캐스트', '📡', '위아래 왼쪽 오른쪽 네 방향으로 패킷을 쏜다.', ...CAST,
    { rarity: 50, kb: 0.1, ignores: ['dur'] }),
  multicast: W('멀티캐스트', '📨', '대각선 네 방향으로 패킷을 쏜다.', ...CAST,
    { rarity: 50, kb: 0.1, ignores: ['dur'] }),
  keyboard_cat: W('키보드 고양이', '🐈', '고양이를 풀어 둔다. 제멋대로 돌아다니며 닿는 버그를 할퀸다.',
    { dmg: 15, cd: 5.0, amount: 1, area: 8, speed: 60, dur: 5.0, pierce: 999 },
    [{ speed: 0.2 / 0.4, dmg: 5 }, { dur: 1.5 }, { speed: 0.2 / 0.4, dmg: 5 }, { amount: 1 }, { dur: 1.5 }, { speed: 0.2 / 0.4, dmg: 10 }, { amount: 1 }],
    { rarity: 50, kb: 0.1, rehit: 1.0 }),
  infinite_scroll: W('무한 스크롤', '🖱️', '내 자리를 위아래로 길게 쓸어내린다. 단계가 오르면 더 오래 남는다.',
    { dmg: 10, cd: 2.0, amount: 1, area: 22, speed: 0, dur: 0.5, pierce: 0 },
    [{ area: 1.0 }, { dur: 0.5, cd: 0.75 }, { area: 0.25, dmg: 5 }, { dur: 0.5, cd: 0.75 }, { area: 0.25, dmg: 5 }, { dur: 0.5, cd: 0.75 }, { area: 0.25, dmg: 5 }],
    { rarity: 50, kb: 1, rehit: 0.5, ignores: ['amount', 'speed'] }),
  commit_history: W('커밋 히스토리', '👣', '걸으면 발자국이 남고, 밟은 버그가 다친다. 멈추면 발자국을 앞으로 날린다.',
    { dmg: 10, cd: 6.0, amount: 1, area: 10, speed: 0, dur: 1.0, pierce: 0 },
    [{ amount: 1 }, { dmg: 5 }, { dur: 0.25 }, { dmg: 5 }, { dur: 0.25 }, { dmg: 5 }, { dur: 0.25 }],
    { rarity: 50, kb: 1, rehit: 2.0 }),
  code_freeze: W('코드 프리즈', '🧊', '시곗바늘처럼 돌아가며 광선을 쏜다. 맞은 버그는 조금 다치고 잠깐 얼어붙는다.',
    { dmg: 5, cd: 1.5, amount: 1, area: 110, speed: 0, dur: 2.0, pierce: 999 },
    [{ dur: 1 }, { cd: -0.5 }, { dur: 1 }, { dur: 1 }, { cd: -0.5 }, { dur: 1 }],
    { rarity: 70, kb: 0, ignores: ['amount', 'speed', 'area'], labels: { dur: '얼리는 시간' } }),
  two_factor: W('2단계 인증', '🔐', '방패가 대신 맞아 주고 둘레의 버그를 밀쳐 낸다. 다 쓰면 다시 찬다.',
    { dmg: 10, cd: 8, amount: 1, area: 48, speed: 0, dur: 0.24, pierce: 0 },
    [{ cd: -0.5, dur: 0.2 }, { cd: -0.5, dur: 0.2 }, { amount: 1 }, { cd: -0.5, dur: 0.2 }, { cd: -0.5, dur: 0.2 }, { amount: 1 }],
    { rarity: 60, kb: 2, ignores: ['amount', 'area', 'speed', 'dur'], labels: { dmg: '반격 피해', amount: '방패', dur: '무적' } }),
  sprint: W('스프린트', '🌪️', '양옆을 번갈아 여러 번 벤다. 쉬지 않고 걸을수록 세진다.',
    { dmg: 5, cd: 2.0, amount: 4, area: 56, speed: 0, dur: 0.4, pierce: 0 },
    [{ dmg: 2 }, { amount: 1, area: 0.2 / 1.4 }, { dmg: 2 }, { amount: 1, area: 0.2 / 1.4 }, { dmg: 2 }, { amount: 1, area: 0.2 / 1.4 }, { dmg: 2 }],
    { rarity: 50, kb: 0.1, crit: { chance: 0.05, mult: 2 }, ignores: ['dur'] }),
  logic_bomb: W('멀티스레드', '🧵', '무작위 버그 하나에게 스레드 여러 개를 한꺼번에 보낸다.',
    { dmg: 10, cd: 1.4, amount: 3, area: 22, speed: 350, dur: 0.6, pierce: 0 },
    [{ dmg: 10 }, { pierce: 1 }, { amount: 1, area: 0.1 / 0.9 }, { pierce: 1 }, { dmg: 10 }],
    { rarity: 60, kb: 1 }),

  /* ── 진화한 무기 (EVOLUTIONS). 단계가 하나뿐이고 레벨업 선택지에는 나오지 않는다 (rarity 0).
   *    수치는 우리 게임의 것이다 (뱀서의 진화를 옮긴 것이 아니다). 재료 무기의 최대 단계보다 1.5~3배쯤 세다.
   *    합치기는 칸 하나가 비는 몫이 있어 1.5~2배쯤으로 잡았다 ── */
  debugger: W('디버거', '🐞', '로그 대신 중단점. 꿰뚫고 날아가, 맞은 버그를 잠깐 멈춰 세운다.',
    { dmg: 40, cd: 0.7, amount: 5, area: 5, speed: 260, dur: 1.0, pierce: 1 }, [],
    { rarity: 0, kb: 1, ignores: ['dur'] }),
  websocket: W('웹소켓', '🔌', '연결이 끊기지 않는다. 공이 쉬지 않고 튕기며 계속 맞힌다.',
    { dmg: 50, cd: 4.0, amount: 4, area: 8, speed: 260, dur: 4.0, pierce: 999 }, [],
    { rarity: 0, kb: 1, rehit: 0.5 }),
  friday_deploy: W('금요일 배포', '🌋', '내 발밑과 버그들 자리에 불이 붙는다. 오늘 퇴근은 없다.',
    { dmg: 40, cd: 3.5, amount: 5, area: 48, speed: 0, dur: 3.5, pierce: 0 }, [],
    { rarity: 0, kb: 0, rehit: 0.5, ignores: ['speed'] }),
  rm_rf: W('rm -rf node_modules', '♻️', '화면을 지우고 새로 받는다. 경험치는 모두 남아 내 쪽으로 끌려온다.',
    { dmg: 0, cd: 45, amount: 1, area: 0, speed: 0, dur: 1.0, pierce: 0, chance: 1 }, [],
    { rarity: 0, kb: 0, ignores: ['might', 'amount', 'area', 'speed', 'dur'] }),
  monitoring: W('24시간 모니터링', '🕐', '카나리아와 부엉이가 쉬지 않고 함께 돌며 폭탄을 퍼붓는다.',
    { dmg: 40, cd: 0.5, amount: 11, area: 40, speed: 1.4, dur: 0, pierce: 0 }, [],
    { rarity: 0, kb: 2, ignores: ['dur'] }),
  flooding: W('패킷 플러딩', '🌊', '여덟 방향으로 패킷을 한꺼번에 쏟아낸다.',
    { dmg: 20, cd: 1.0, amount: 3, area: 5, speed: 390, dur: 0.9, pierce: 8 }, [],
    { rarity: 0, kb: 0.1, ignores: ['dur'] }),

  /* ── 패시브 (뱀서의 Wings, Empty Tome, Spinach, Attractorb, Hollow Heart, Candelabrador, Armor, Pummarola, Bracer,
   *    Spellbinder, Duplicator, Clover, Crown, Skull O'Maniac, Tiragisu 순서) ── */
  coffee: P('아이스 아메리카노', '☕', '이동 속도가 빨라진다.', withMight('이동 속도 +10%'), 50),
  mech_keyboard: P('기계식 키보드', '⌨️', '모든 무기를 더 자주 쓴다.', '쿨다운 -8%', 50),
  stack_overflow: P('Stack Overflow', '📋', '복붙의 힘. 모든 공격이 세진다.', '피해량 +10%', 100),
  npm_install: P('npm install', '📦', '일단 다 끌어온다. 경험치와 아이템을 멀리서 끌어당긴다.', withMight(['끌어당기는 범위 +50%', '끌어당기는 범위 +33%', '끌어당기는 범위 +25%', '끌어당기는 범위 +20%', '끌어당기는 범위 +33%']), 100),
  dark_mode: P('다크 모드', '🌙', '최대 체력이 늘고, 늘어난 만큼 바로 찬다.', withMight('최대 체력 ×1.2'), 90),
  dual_monitor: P('듀얼 모니터', '🖥️', '화면이 넓어지니 공격이 더 커진다.', '공격 범위 +10%', 100),
  test_coverage: P('테스트 커버리지', '🧪', '버그에게 덜 아프게 맞는다.', withMight('한 대 맞을 때 피해 -1'), 100),
  work_life: P('워라밸', '🧘', '가만히 있어도 체력이 차고, 회복 아이템도 더 잘 듣는다.', withMight('1초에 체력 +0.5'), 90),
  cdn: P('CDN', '🚀', '날아가거나 도는 것이 빨라지고, 더 멀리서 겨눈다.', '속도 +10%', 100),
  keep_alive: P('keep-alive', '⏳', '남는 공격이 더 오래 남는다.', '지속 시간 +10%', 100),
  git_fork: P('git fork', '🍴', '쏘거나 던지거나 부르는 것이 하나씩 늘어난다.', '개수 +1', 50, 2),
  deploy_prayer: P('배포 기도', '🙏', '운이 좋아지고, 레벨업 새로고침이 늘어난다.', withMight('운 +10%, 새로고침 +1'), 100),
  side_project: P('사이드 프로젝트', '📚', '같은 일을 해도 더 많이 배운다.', withMight('얻는 경험치 +15%'), 70),
  prod_hotfix: P('운영 서버 직접 수정', '☠️', '버그가 더 많이, 더 세게, 더 빨리 몰려온다. 한 번만 고른다.', '버그 체력·속도·수·빈도 +10%', 40),
  snapshot: P('스냅샷', '📸', '쓰러져도 그 자리에서 되살아난다. 다 쓰면 칸이 비어 다시 얻을 수 있다.', '부활 +1', 40, 2),
};

/* ───────────── 진화 ─────────────
 * 최대 단계인 무기(합치기는 두 무기 모두)와 짝 패시브(단계는 상관없다)를 함께 가지고 있으면, 다음에 여는 보물상자에서 바뀐다.
 * 진화한 무기는 재료 무기의 칸을 쓰고(합치기는 칸 하나가 빈다) 더 오르지 않는다. 짝 패시브는 그대로 남는다.
 * 재료였던 무기는 그 판에서 다시 나오지 않는다. 판정은 서버의 시뮬레이션이 한다 (sim.ts openChest):
 * 클라이언트는 레벨업 선택지와 칸에 짝을 알려 주기만 한다.
 * 짝은 우리 게임의 농담으로 정했다 (핑퐁 + keep-alive = 웹소켓처럼 이름만 보고 짐작할 수 있게).
 */
export interface Evolution {
  /** 진화한 무기 */
  id: WeaponId;
  /** 최대 단계여야 하는 무기. 둘이면 합치기 */
  from: readonly WeaponId[];
  /** 함께 가지고 있어야 하는 패시브 (합치기는 없다) */
  with: PassiveId | null;
}

/** 진화 목록. 한 상자에서 여러 개가 가능하면 이 순서대로 바뀐다 */
export const EVOLUTIONS: readonly Evolution[] = [
  { id: 'debugger', from: ['console_log'], with: 'test_coverage' },
  { id: 'websocket', from: ['ping_pong'], with: 'keep_alive' },
  { id: 'friday_deploy', from: ['hotfix'], with: 'prod_hotfix' },
  { id: 'rm_rf', from: ['git_clean'], with: 'npm_install' },
  { id: 'monitoring', from: ['canary', 'night_owl'], with: null },
  { id: 'flooding', from: ['broadcast', 'multicast'], with: null },
];

const EVOLVED = new Map<UpgradeId, Evolution>(EVOLUTIONS.map((e) => [e.id, e]));

/** 진화한 무기라면 그 진화 (아니면 undefined) */
export const evolutionOf = (id: UpgradeId): Evolution | undefined => EVOLVED.get(id);

/** 이 무기·패시브를 재료로 쓰는 진화들 (선택지와 칸에 짝을 알려 줄 때) */
export const evolutionsUsing = (id: UpgradeId): Evolution[] => EVOLUTIONS.filter((e) => e.with === id || (e.from as readonly UpgradeId[]).includes(id));

type Levels = Partial<Record<UpgradeId, number>>;
const has = (up: Levels, id: UpgradeId): boolean => (up[id] ?? 0) > 0;
const maxed = (up: Levels, id: UpgradeId): boolean => (up[id] ?? 0) >= UPGRADES[id].max;

/** 지금 진화할 수 있는 것들 (EVOLUTIONS 순서): 재료 무기가 모두 최대 단계이고, 짝 패시브가 있고, 아직 진화하지 않았다 */
export function readyEvolutions(up: Levels): Evolution[] {
  return EVOLUTIONS.filter((e) => !has(up, e.id) && e.from.every((f) => maxed(up, f)) && (e.with === null || has(up, e.with)));
}

/** 진화해서 없어진 재료 무기인지 (그 판에서 다시 선택지에 나오지 않는다) */
export const evolvedAway = (up: Levels, id: UpgradeId): boolean =>
  EVOLUTIONS.some((e) => has(up, e.id) && (e.from as readonly UpgradeId[]).includes(id));

export function isWeapon(id: UpgradeId): id is WeaponId {
  return UPGRADES[id].kind === 'weapon';
}

export function isUpgradeId(v: unknown): v is UpgradeId {
  return typeof v === 'string' && (UPGRADE_IDS as readonly string[]).includes(v);
}

/** 이 단계(2 이상)에 오를 때 더해지는 능력치 */
export function weaponLevelBonus(id: WeaponId, level: number): Partial<WeaponStats> {
  const def = UPGRADES[id] as WeaponDef;
  return def.levels[level - 2] ?? {};
}

/** 무기의 능력치 (패시브를 적용하기 전) */
export function weaponStats(id: WeaponId, level: number): WeaponStats {
  const def = UPGRADES[id] as WeaponDef;
  const s = { ...def.base };
  let area = 0;
  let speed = 0;
  for (let i = 0; i < Math.min(level, def.max) - 1; i++) {
    const d = def.levels[i]!;
    s.dmg += d.dmg ?? 0;
    s.cd += d.cd ?? 0;
    s.amount += d.amount ?? 0;
    s.dur += d.dur ?? 0;
    s.pierce += d.pierce ?? 0;
    s.chance += d.chance ?? 0;
    area += d.area ?? 0;
    speed += d.speed ?? 0;
  }
  s.area *= 1 + area;
  s.speed *= 1 + speed;
  return s;
}

const fmt = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * 레벨업 선택지에 보여줄 한 줄. 새로 얻는 것이면 설명, 이미 가진 것이면 이번 단계에서 무엇이 좋아지는지.
 */
export function upgradeText(id: UpgradeId, level: number): string {
  const def = UPGRADES[id];
  if (def.kind === 'passive') {
    const per = Array.isArray(def.per) ? (def.per[Math.max(0, Math.min(def.per.length, level) - 1)] ?? '') : def.per;
    // 처음 얻을 때는 무엇인지와 이번 단계의 효과를 함께
    return level <= 1 ? `${def.desc} (${per})` : per;
  }
  if (level <= 1) return def.desc;
  const d = weaponLevelBonus(id as WeaponId, level);
  const name = (k: keyof WeaponStats, fallback: string): string => def.labels?.[k] ?? fallback;
  const signed = (n: number): string => (n > 0 ? `+${fmt(n)}` : fmt(n));
  const parts: string[] = [];
  if (d.dmg) parts.push(`${name('dmg', '피해')} ${signed(d.dmg)}`);
  if (d.amount) parts.push(`${name('amount', '개수')} ${signed(d.amount)}`);
  if (d.cd) parts.push(`${name('cd', '쿨다운')} ${signed(d.cd)}초`);
  if (d.area) parts.push(`${name('area', '범위')} +${Math.round(d.area * 100)}%`);
  if (d.speed) parts.push(`${name('speed', '속도')} +${Math.round(d.speed * 100)}%`);
  if (d.dur) parts.push(`${name('dur', '지속')} ${signed(d.dur)}초`);
  if (d.pierce) parts.push(`${name('pierce', '관통')} ${signed(d.pierce)}`);
  if (d.chance) parts.push(`${name('chance', '확률')} +${Math.round(d.chance * 100)}%`);
  return parts.join(', ');
}

/* ───────────── 가진 것 (순위표에 남기는 모양) ───────────── */

/** 순위표에 남기는 아이템 하나 (protocol.ts 의 LeaderboardItem 과 같은 모양) */
export interface OwnedUpgrade {
  id: UpgradeId;
  level: number;
}

/**
 * 가진 무기·패시브 목록을 정리한다. 게임 화면의 칸과 같은 순서(UPGRADE_IDS 순: 무기 먼저, 그다음 패시브)로 둔다.
 * 모르는 id, 범위 밖 단계, 중복, 칸 수를 넘는 것은 버린다. 배열이 아니면 null.
 * 서버가 기록할 때, DB 에서 읽을 때, 클라이언트가 응답을 받을 때 같은 규칙으로 걸러 낸다.
 */
export function ownedUpgrades(raw: unknown): OwnedUpgrade[] | null {
  if (!Array.isArray(raw)) return null;
  const weapons: OwnedUpgrade[] = [];
  const passives: OwnedUpgrade[] = [];
  const seen = new Set<string>();
  for (const it of raw.slice(0, 64)) {
    if (typeof it !== 'object' || it === null) continue;
    const { id, level } = it as { id?: unknown; level?: unknown };
    if (!isUpgradeId(id) || seen.has(id)) continue;
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > UPGRADES[id].max) continue;
    const list = isWeapon(id) ? weapons : passives;
    if (list.length >= (isWeapon(id) ? WEAPON_SLOTS : PASSIVE_SLOTS)) continue;
    seen.add(id);
    list.push({ id, level });
  }
  const order = (u: OwnedUpgrade): number => (UPGRADE_IDS as readonly string[]).indexOf(u.id);
  return [...weapons, ...passives].sort((a, b) => order(a) - order(b));
}

/** 플레이어가 지금 가진 무기·패시브 (단계 1 이상) */
export function upgradesOf(up: Partial<Record<UpgradeId, number>>): OwnedUpgrade[] {
  return ownedUpgrades(Object.entries(up).map(([id, level]) => ({ id, level })))!;
}

/* ───────────── 필드 아이템 ───────────── */

/** 순서가 곧 통신에서 쓰는 번호다. 중간에 끼워 넣지 말고 뒤에 추가할 것 */
export const FIELD_ITEM_KINDS = ['heal', 'levelup', 'revive', 'chest', 'magnet'] as const;
export type FieldItemKind = (typeof FIELD_ITEM_KINDS)[number];

export interface FieldItemDef {
  name: string;
  icon: string;
  desc: string;
  /** 놓일 때 이 종류가 뽑힐 비중 (0 이면 이 굴림으로는 나오지 않는다: 보물상자는 보스가, 자석은 따로 센 시간이 놓는다) */
  weight: number;
}

export const FIELD_ITEMS: Record<FieldItemKind, FieldItemDef> = {
  heal: { name: '야근 피자', icon: '🍕', desc: '체력 30 회복', weight: 65 },
  levelup: { name: 'LGTM', icon: '✅', desc: '즉시 1레벨 업', weight: 34 },
  revive: { name: '백업', icon: '💾', desc: '쓰러져도 한 번 되살아난다', weight: 1 },
  // 보스가 떨어뜨린다 (저절로 놓이지 않는다). 열면 가진 무기·패시브가 1, 3 또는 5번 오른다
  chest: { name: '보물상자', icon: '🎁', desc: '가진 것이 1~5번 강화된다', weight: 0 },
  // 다른 필드 아이템과 따로, 평균 MAGNET_INTERVAL 초에 하나 놓인다 (sim.ts). 주우면 맵의 경험치가 모두 끌려온다
  magnet: { name: '자석', icon: '🧲', desc: '맵의 경험치를 모두 끌어당긴다', weight: 0 },
};
