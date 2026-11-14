/** 개발자 컨셉 콘텐츠 정의: 적(버그들), 무기(도구들), 패시브(개발자 버프) */

export const ENEMY_IDS = ['bug', 'null_ptr', 'merge_conflict', 'mem_leak', 'legacy_code'] as const;
export type EnemyId = (typeof ENEMY_IDS)[number];

export interface EnemyDef {
  name: string;
  hp: number;
  speed: number;
  /** 접촉 시 초당 피해 */
  dps: number;
  r: number;
  xp: number;
  /** 등장 시작 시각(초) */
  from: number;
  weight: number;
  boss?: boolean;
}

export const ENEMIES: Record<EnemyId, EnemyDef> = {
  bug: { name: '버그', hp: 10, speed: 48, dps: 8, r: 5, xp: 1, from: 0, weight: 10 },
  null_ptr: { name: 'NullPointerException', hp: 28, speed: 38, dps: 12, r: 6, xp: 2, from: 40, weight: 6 },
  merge_conflict: { name: 'Merge Conflict', hp: 80, speed: 26, dps: 18, r: 7, xp: 5, from: 110, weight: 3 },
  mem_leak: { name: 'Memory Leak', hp: 45, speed: 56, dps: 10, r: 6, xp: 3, from: 180, weight: 4 },
  legacy_code: { name: '레거시 코드', hp: 900, speed: 22, dps: 35, r: 12, xp: 50, from: 150, weight: 0, boss: true },
};

export const BOSS_INTERVAL = 150;

export const SHOT_KINDS = ['log', 'regex', 'ai'] as const;
export type ShotKind = (typeof SHOT_KINDS)[number];

export const WEAPON_IDS = ['console_log', 'rubber_duck', 'regex', 'ai_agent'] as const;
export type WeaponId = (typeof WEAPON_IDS)[number];

export const PASSIVE_IDS = ['coffee', 'mech_keyboard', 'stack_overflow', 'npm_install', 'dark_mode'] as const;
export type PassiveId = (typeof PASSIVE_IDS)[number];

export const UPGRADE_IDS = [...WEAPON_IDS, ...PASSIVE_IDS] as const;
export type UpgradeId = WeaponId | PassiveId;

export interface UpgradeDef {
  kind: 'weapon' | 'passive';
  name: string;
  icon: string;
  desc: string;
}

export const UPGRADES: Record<UpgradeId, UpgradeDef> = {
  console_log: { kind: 'weapon', name: 'console.log()', icon: '🖨️', desc: '가장 가까운 버그에게 로그를 찍는다. 디버거는 사치.' },
  rubber_duck: { kind: 'weapon', name: '러버덕', icon: '🦆', desc: '주위를 도는 오리. 설명하다 보면 버그가 죽는다.' },
  regex: { kind: 'weapon', name: '정규표현식', icon: '🔣', desc: '바라보는 방향을 관통. 쓴 사람도 못 읽는다.' },
  ai_agent: { kind: 'weapon', name: 'AI 에이전트', icon: '🤖', desc: '알아서 강하게 쏜다. 가끔 할루시네이션으로 엉뚱한 곳을 쏜다.' },
  coffee: { kind: 'passive', name: '아이스 아메리카노', icon: '☕', desc: '이동 속도 +8%' },
  mech_keyboard: { kind: 'passive', name: '기계식 키보드', icon: '⌨️', desc: '공격 쿨다운 -8%' },
  stack_overflow: { kind: 'passive', name: 'Stack Overflow', icon: '📋', desc: '복붙의 힘. 피해량 +15%' },
  npm_install: { kind: 'passive', name: 'npm install', icon: '📦', desc: '일단 다 끌어온다. 경험치를 끌어당기는 범위 +30%' },
  dark_mode: { kind: 'passive', name: '다크 모드', icon: '🌙', desc: '눈이 편안. 최대 체력 +20, 체력 20 회복' },
};

export function isWeapon(id: UpgradeId): id is WeaponId {
  return UPGRADES[id].kind === 'weapon';
}

export function isUpgradeId(v: unknown): v is UpgradeId {
  return typeof v === 'string' && (UPGRADE_IDS as readonly string[]).includes(v);
}

/* ───────────── 필드 아이템 ───────────── */

/** 순서가 곧 통신에서 쓰는 번호다. 중간에 끼워 넣지 말고 뒤에 추가할 것 */
export const FIELD_ITEM_KINDS = ['heal', 'levelup', 'revive'] as const;
export type FieldItemKind = (typeof FIELD_ITEM_KINDS)[number];

export interface FieldItemDef {
  name: string;
  icon: string;
  desc: string;
  /** 놓일 때 이 종류가 뽑힐 비중 */
  weight: number;
}

export const FIELD_ITEMS: Record<FieldItemKind, FieldItemDef> = {
  heal: { name: '야근 피자', icon: '🍕', desc: '체력 20% 회복', weight: 65 },
  levelup: { name: 'LGTM', icon: '✅', desc: '즉시 1레벨 업', weight: 34 },
  revive: { name: '백업', icon: '💾', desc: '쓰러져도 한 번 되살아난다', weight: 1 },
};
