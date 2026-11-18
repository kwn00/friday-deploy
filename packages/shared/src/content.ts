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

/**
 * 투사체·소환물 종류. 순서가 곧 통신에서 쓰는 번호다 (중간에 끼워 넣지 말고 뒤에 추가할 것).
 * 소환물(카나리아, 부엉이, 고양이)도 위치가 움직이는 것이라 투사체 목록으로 보낸다.
 */
export const SHOT_KINDS = ['log', 'regex', 'ai', 'book', 'rollback', 'ping', 'packet', 'bomb', 'canary', 'owl', 'cat'] as const;
export type ShotKind = (typeof SHOT_KINDS)[number];

/**
 * 바닥에 생기는 공격 영역 종류 (통신 번호 = 순서). 그리는 모양:
 * slash: 각도 a 방향으로 길이 r 인 베기 / pool: 반경 r 웅덩이 / bolt: 반경 r 번개 / wipe: 반경 r 전체 지우기 /
 * blast: 반경 r 폭발 / band: 폭 r 의 세로 띠 / trail: 반경 r 발자국 / beam: 각도 a 방향 길이 r 광선
 */
export const ZONE_KINDS = ['slash', 'pool', 'bolt', 'wipe', 'blast', 'band', 'trail', 'beam'] as const;
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

/** 한 판에 가질 수 있는 무기 / 패시브 수 (처음 갖고 시작하는 무기 포함) */
export const WEAPON_SLOTS = 6;
export const PASSIVE_SLOTS = 6;

/**
 * 무기의 능력치. 단계가 오르면 levels 의 값이 더해진다.
 * - dmg: 한 번 맞힐 때의 피해 (Stack Overflow 로 늘어난다)
 * - cd: 쿨다운(초). 다시 쓰기까지의 시간 (기계식 키보드로 줄어든다)
 * - amount: 한 번에 나가는 개수 (git fork 로 늘어난다)
 * - area: 크기(px). 반경·길이 등 무기마다 뜻이 다르다. 단계 증가분은 비율이다 (0.2 = +20%). 듀얼 모니터로 커진다
 * - speed: 빠르기(px/s 또는 rad/s). 단계 증가분은 비율이다. CDN 으로 빨라진다
 * - dur: 지속 시간(초) (keep-alive 로 늘어난다)
 * - pierce: 한 개가 더 맞힐 수 있는 적 수
 */
export interface WeaponStats {
  dmg: number;
  cd: number;
  amount: number;
  area: number;
  speed: number;
  dur: number;
  pierce: number;
}

export interface WeaponDef {
  kind: 'weapon';
  name: string;
  icon: string;
  desc: string;
  max: number;
  base: WeaponStats;
  /** levels[i] = (i + 2) 단계에서 더해지는 값 */
  levels: Partial<WeaponStats>[];
}

export interface PassiveDef {
  kind: 'passive';
  name: string;
  icon: string;
  desc: string;
  max: number;
  /** 단계마다 붙는 효과 (선택지에 보여준다). 배열이면 단계마다 다르다: per[단계 - 1] */
  per: string | string[];
}

export type UpgradeDef = WeaponDef | PassiveDef;

const W = (
  name: string,
  icon: string,
  desc: string,
  base: WeaponStats,
  levels: Partial<WeaponStats>[],
): WeaponDef => ({ kind: 'weapon', name, icon, desc, max: levels.length + 1, base, levels });
const P = (name: string, icon: string, desc: string, per: string | string[], max = 5): PassiveDef => ({ kind: 'passive', name, icon, desc, max, per });

export const UPGRADES: Record<UpgradeId, UpgradeDef> = {
  /* ── 무기 ── */
  console_log: W('console.log()', '🖨️', '가장 가까운 버그에게 로그를 찍는다. 디버거는 사치.',
    { dmg: 12, cd: 1.0, amount: 1, area: 4, speed: 220, dur: 1.0, pierce: 0 },
    [{ amount: 1 }, { cd: -0.2 }, { amount: 1 }, { dmg: 8 }, { amount: 1 }, { pierce: 1 }, { dmg: 8 }]),
  rubber_duck: W('러버덕', '🦆', '잠깐씩 주위를 도는 오리. 설명하다 보면 버그가 죽는다.',
    { dmg: 9, cd: 3.0, amount: 1, area: 36, speed: 2.6, dur: 3.0, pierce: 0 },
    [{ amount: 1 }, { speed: 0.3, area: 0.25 }, { dur: 0.5, dmg: 5 }, { amount: 1 }, { speed: 0.3, area: 0.25 }, { dur: 0.5, dmg: 5 }, { amount: 1 }]),
  regex: W('정규표현식', '🔣', '바라보는 방향으로 나란히 날린다. 쓴 사람도 못 읽는다.',
    { dmg: 8, cd: 1.0, amount: 1, area: 5, speed: 320, dur: 0.6, pierce: 1 },
    [{ amount: 1 }, { amount: 1, dmg: 5 }, { amount: 1 }, { pierce: 1 }, { amount: 1 }, { amount: 1, dmg: 5 }, { pierce: 1 }]),
  ai_agent: W('AI 에이전트', '🤖', '아무 버그에게나 세게 쏜다. 가끔 할루시네이션으로 엉뚱한 곳을 쏜다.',
    { dmg: 20, cd: 3.0, amount: 3, area: 6, speed: 180, dur: 1.4, pierce: 0 },
    [{ dmg: 10 }, { dmg: 10, speed: 0.2 }, { dmg: 10 }, { dmg: 10, speed: 0.2 }, { dmg: 10 }, { dmg: 10, speed: 0.2 }, { dmg: 10 }]),
  ctrl_x: W('Ctrl+X', '✂️', '바라보는 쪽을 옆으로 크게 잘라낸다. 개수가 늘면 반대쪽도.',
    { dmg: 10, cd: 1.35, amount: 1, area: 56, speed: 0, dur: 0.15, pierce: 0 },
    [{ amount: 1 }, { dmg: 5 }, { dmg: 5, area: 0.1 }, { dmg: 5 }, { dmg: 5, area: 0.1 }, { dmg: 5 }, { dmg: 5 }]),
  brick_book: W('벽돌책', '🧱', '두꺼운 기술서를 던진다. 위로 날아갔다 떨어지며 버그를 짓누른다.',
    { dmg: 20, cd: 4.0, amount: 1, area: 8, speed: 260, dur: 3.0, pierce: 2 },
    [{ amount: 1 }, { dmg: 15 }, { pierce: 2 }, { amount: 1 }, { dmg: 15 }, { pierce: 2 }, { dmg: 15 }]),
  rollback: W('롤백', '↩️', '가까운 버그 쪽으로 날아갔다가 던진 자리로 돌아온다. 오가며 맞힌다.',
    { dmg: 8, cd: 2.0, amount: 1, area: 9, speed: 300, dur: 1.8, pierce: 999 },
    [{ dmg: 8 }, { area: 0.3 }, { amount: 1 }, { dmg: 8, speed: 0.25 }, { area: 0.3 }, { amount: 1 }, { dmg: 8 }]),
  firewall: W('방화벽', '🔥', '내 주위에 다가온 버그를 계속 태우고 살짝 밀어낸다.',
    { dmg: 5, cd: 1.0, amount: 1, area: 30, speed: 0, dur: 0, pierce: 0 },
    [{ dmg: 2, area: 0.2 }, { cd: -0.1, dmg: 1 }, { dmg: 1, area: 0.2 }, { cd: -0.1, dmg: 2 }, { dmg: 1, area: 0.2 }, { cd: -0.1, dmg: 1 }, { dmg: 1, area: 0.2 }]),
  hotfix: W('핫픽스', '💧', '급하게 뿌린 패치가 바닥에 고인다. 밟은 버그가 녹는다.',
    { dmg: 10, cd: 4.5, amount: 1, area: 22, speed: 0, dur: 2.0, pierce: 0 },
    [{ amount: 1 }, { dmg: 10, area: 0.2 }, { amount: 1, dur: 0.5 }, { dmg: 10 }, { amount: 1, area: 0.2 }, { dur: 0.5 }, { dmg: 5, area: 0.2 }]),
  ping_pong: W('핑퐁', '🏓', '아무 방향으로 날아가 화면 끝에서 튕긴다. 계속 오가며 맞힌다.',
    { dmg: 10, cd: 3.0, amount: 1, area: 6, speed: 200, dur: 2.25, pierce: 999 },
    [{ dmg: 5, speed: 0.2 }, { dur: 0.3, dmg: 5 }, { amount: 1 }, { dmg: 5, speed: 0.2 }, { dur: 0.3, dmg: 5 }, { amount: 1 }, { dur: 0.5 }]),
  hot_reload: W('핫 리로드', '⚡', '갑자기 번쩍. 주변의 아무 버그에게나 내리친다.',
    { dmg: 15, cd: 4.5, amount: 2, area: 14, speed: 0, dur: 0.25, pierce: 0 },
    [{ amount: 1 }, { dmg: 10, area: 0.5 }, { amount: 1 }, { dmg: 15, area: 0.5 }, { amount: 1 }, { dmg: 15, area: 0.5 }, { amount: 1 }]),
  git_clean: W('git clean -fd', '🧹', '가끔 주변을 통째로 지운다. 떨어진 경험치까지 같이 지워진다.',
    { dmg: 300, cd: 60, amount: 1, area: 240, speed: 0, dur: 0.5, pierce: 0 },
    [{ cd: -5 }, { cd: -5 }, { cd: -5 }, { cd: -5 }, { cd: -5 }, { cd: -5 }, { cd: -5 }]),
  canary: W('카나리아', '🐤', '내 주위를 시계 방향으로 돌며 폭탄을 떨어뜨린다. 배포 전에 먼저 날려 보낸다.',
    { dmg: 10, cd: 1.0, amount: 1, area: 18, speed: 1.4, dur: 0.2, pierce: 0 },
    [{ dmg: 5 }, { amount: 1 }, { area: 0.2 }, { dmg: 5 }, { amount: 1 }, { area: 0.2 }, { dmg: 10 }]),
  night_owl: W('야근 부엉이', '🦉', '카나리아와 반대 방향으로 돌며 폭탄을 떨어뜨린다. 야근이 체질이다.',
    { dmg: 10, cd: 1.0, amount: 1, area: 18, speed: 1.4, dur: 0.2, pierce: 0 },
    [{ dmg: 5 }, { amount: 1 }, { area: 0.2 }, { dmg: 5 }, { amount: 1 }, { area: 0.2 }, { dmg: 10 }]),
  broadcast: W('브로드캐스트', '📡', '위아래 왼쪽 오른쪽 네 방향으로 패킷을 쏜다.',
    { dmg: 8, cd: 1.4, amount: 1, area: 5, speed: 260, dur: 0.9, pierce: 0 },
    [{ dmg: 5 }, { amount: 1 }, { dmg: 5 }, { cd: -0.2 }, { amount: 1 }, { dmg: 5 }, { pierce: 1 }]),
  multicast: W('멀티캐스트', '📨', '대각선 네 방향으로 패킷을 쏜다.',
    { dmg: 8, cd: 1.4, amount: 1, area: 5, speed: 260, dur: 0.9, pierce: 0 },
    [{ dmg: 5 }, { amount: 1 }, { dmg: 5 }, { cd: -0.2 }, { amount: 1 }, { dmg: 5 }, { pierce: 1 }]),
  keyboard_cat: W('키보드 고양이', '🐈', '고양이를 풀어 둔다. 제멋대로 돌아다니며 닿는 버그를 할퀸다.',
    { dmg: 10, cd: 5.0, amount: 1, area: 8, speed: 60, dur: 3.0, pierce: 999 },
    [{ amount: 1 }, { dmg: 10 }, { dur: 1 }, { amount: 1 }, { dmg: 10 }, { dur: 1 }, { amount: 1 }]),
  infinite_scroll: W('무한 스크롤', '🖱️', '내 자리를 위아래로 길게 쓸어내린다.',
    { dmg: 12, cd: 2.0, amount: 1, area: 22, speed: 0, dur: 0.25, pierce: 0 },
    [{ dmg: 5, area: 0.2 }, { dmg: 5 }, { cd: -0.2 }, { dmg: 5, area: 0.2 }, { dmg: 5 }, { cd: -0.2 }, { dmg: 10, area: 0.2 }]),
  commit_history: W('커밋 히스토리', '👣', '움직이는 동안 지나간 자리에 커밋을 남긴다. 밟은 버그가 다친다.',
    { dmg: 8, cd: 0.3, amount: 1, area: 10, speed: 0, dur: 1.5, pierce: 0 },
    [{ dmg: 4 }, { area: 0.2 }, { dur: 0.5 }, { dmg: 4 }, { area: 0.2 }, { dur: 0.5 }, { dmg: 8 }]),
  code_freeze: W('코드 프리즈', '🧊', '시곗바늘처럼 돌아가며 광선을 쏜다. 맞은 버그는 잠깐 얼어붙는다.',
    { dmg: 0, cd: 2.5, amount: 1, area: 110, speed: 0, dur: 1.5, pierce: 999 },
    [{ cd: -0.3 }, { dur: 0.5 }, { amount: 1 }]),
  two_factor: W('2단계 인증', '🔐', '가끔 잠깐 동안 어떤 피해도 받지 않는다.',
    { dmg: 0, cd: 10, amount: 1, area: 0, speed: 0, dur: 1.0, pierce: 0 },
    [{ cd: -1 }, { dur: 0.3 }, { cd: -1 }, { dur: 0.3 }, { cd: -1 }, { dur: 0.3 }, { cd: -1 }]),
  sprint: W('스프린트', '🌪️', '움직이는 방향으로 벤다. 오래 달릴수록 세진다 (최대 2배).',
    { dmg: 10, cd: 1.2, amount: 1, area: 48, speed: 0, dur: 0.15, pierce: 0 },
    [{ amount: 1 }, { dmg: 5 }, { dmg: 5, area: 0.1 }, { dmg: 5 }, { dmg: 5, area: 0.1 }, { dmg: 5 }, { dmg: 5 }]),
  logic_bomb: W('로직 폭탄', '💣', '가까운 버그에게 던진다. 닿으면 터져서 주변까지 다친다.',
    { dmg: 15, cd: 2.5, amount: 1, area: 22, speed: 200, dur: 1.2, pierce: 0 },
    [{ amount: 1 }, { dmg: 10 }, { area: 0.2 }, { amount: 1 }, { dmg: 10 }, { area: 0.2 }, { amount: 1 }]),

  /* ── 패시브 ── */
  coffee: P('아이스 아메리카노', '☕', '이동 속도가 빨라진다.', '이동 속도 +10%'),
  mech_keyboard: P('기계식 키보드', '⌨️', '모든 무기를 더 자주 쓴다.', '쿨다운 -8%'),
  stack_overflow: P('Stack Overflow', '📋', '복붙의 힘. 모든 공격이 세진다.', '피해량 +10%'),
  npm_install: P('npm install', '📦', '일단 다 끌어온다. 경험치와 아이템을 더 멀리서 끌어당긴다.', ['끌어당기는 범위 +40%', '끌어당기는 범위 +30%', '끌어당기는 범위 +20%', '끌어당기는 범위 +20%', '끌어당기는 범위 +25%']),
  dark_mode: P('다크 모드', '🌙', '눈이 편안. 최대 체력이 늘고, 늘어난 만큼 회복한다.', '최대 체력 +20%'),
  dual_monitor: P('듀얼 모니터', '🖥️', '화면이 넓어지니 공격이 더 크고 멀리 닿는다.', '공격 범위 +10%'),
  test_coverage: P('테스트 커버리지', '🧪', '버그에게 덜 아프게 맞는다.', '받는 피해 -1 (버그 하나당 1초에)'),
  work_life: P('워라밸', '🧘', '가만히 있어도 체력이 조금씩 찬다.', '1초에 체력 +0.2'),
  cdn: P('CDN', '🚀', '날아가거나 도는 것들이 더 빨라진다.', '속도 +10%'),
  keep_alive: P('keep-alive', '⏳', '남는 공격은 더 오래, 날아가는 것은 더 멀리 간다.', '지속 시간 +10%'),
  git_fork: P('git fork', '🍴', '쏘거나 던지거나 부르는 것이 하나씩 늘어난다.', '개수 +1', 2),
  deploy_prayer: P('배포 기도', '🙏', '운이 좋아진다. 레벨업 때 선택지가 4개 나오기도 한다.', '선택지 4개가 나올 확률 +10%'),
  side_project: P('사이드 프로젝트', '📚', '같은 일을 해도 더 많이 배운다.', '얻는 경험치 +8%'),
  prod_hotfix: P('운영 서버 직접 수정', '☠️', '버그가 더 많이, 더 세게, 더 빨리 몰려온다. 그만큼 경험치도 많다.', '버그 체력·속도·등장 +10%'),
  snapshot: P('스냅샷', '📸', '쓰러져도 그 자리에서 되살아난다.', '부활 +1', 2),
};

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
  const parts: string[] = [];
  if (d.dmg) parts.push(`피해 +${fmt(d.dmg)}`);
  if (d.amount) parts.push(`개수 +${fmt(d.amount)}`);
  if (d.cd) parts.push(`쿨다운 ${fmt(d.cd)}초`);
  if (d.area) parts.push(`범위 +${Math.round(d.area * 100)}%`);
  if (d.speed) parts.push(`속도 +${Math.round(d.speed * 100)}%`);
  if (d.dur) parts.push(`지속 +${fmt(d.dur)}초`);
  if (d.pierce) parts.push(`관통 +${fmt(d.pierce)}`);
  return parts.join(', ');
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
