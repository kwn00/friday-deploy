/**
 * 일시정지(메뉴) 화면의 "가진 아이템" 목록: 내 강화 단계와 부활 수 → 묶음(무기, 패시브)별 줄 데이터.
 *
 * 수치는 서버 시뮬레이션이 쓰는 공용 함수(packages/shared/src/stats.ts 의 effectiveStats, moveSpeedOf 등)로 계산한다.
 * 여기서 손으로 다시 계산하지 않는다: 그래야 화면의 숫자가 실제 판정과 어긋나지 않는다.
 * 내 강화 단계는 서버가 스냅샷에 실어 보낸 것이다. 이 목록은 보여 주기만 하고, 판정에는 쓰지 않는다.
 *
 * 이 파일은 화면(DOM)을 쓰지 않는다 (단위 테스트에서 검사한다). 화면에 넣는 것은 main.ts 가 textContent 로 한다.
 */
import {
  FIELD_ITEMS,
  PASSIVE_IDS,
  PASSIVE_SLOTS,
  UPGRADES,
  WEAPON_IDS,
  WEAPON_SLOTS,
  amountBonusOf,
  areaMultOf,
  armorOf,
  cooldownMultOf,
  curseOf,
  durationMultOf,
  effectiveStats,
  evolutionOf,
  extraOfferChanceOf,
  growthOf,
  healAmountOf,
  luckOf,
  lv,
  maxHpOf,
  mightOf,
  moveSpeedOf,
  pickupOf,
  recoveryOf,
  speedMultOf,
  upgradeText,
  weaponStats,
  type HasUpgrades,
  type PassiveId,
  type StatKind,
  type UpgradeId,
  type WeaponDef,
  type WeaponId,
  type WeaponStats,
} from '@friday-deploy/shared';
import { evolveHint, readyMaterials } from './evolve';

type Levels = Partial<Record<UpgradeId, number>>;

/** 지금 효과 한 조각: "피해" + "24" (화면에서 값만 눈에 띄게 칠한다) */
export interface Effect {
  label: string;
  value: string;
}

/** 진화 안내 한 줄. ready: 지금 보물상자를 열면 진화한다 / hint: 진화의 짝 / from: 진화한 무기의 재료 */
export interface EvoLine {
  tone: 'ready' | 'hint' | 'from';
  text: string;
}

export interface LoadoutItem {
  id: UpgradeId;
  kind: 'weapon' | 'passive';
  icon: string;
  name: string;
  level: number;
  max: number;
  /** 단계: "Lv.3/8". 진화한 무기는 단계 대신 "★ 진화" */
  tag: string;
  /** 최대 단계면 "최대" (진화한 무기는 tag 가 이미 알린다) */
  badge: string | null;
  evolved: boolean;
  /** 지금 조건이 맞아 보물상자를 열면 진화한다 (게임 칩의 노란 테두리와 같은 뜻) */
  ready: boolean;
  /** 한 줄 설명 */
  desc: string;
  /** 지금 효과 (패시브는 그 패시브 하나만의 효과, 무기는 패시브까지 적용한 지금 수치) */
  now: Effect[];
  /** 다음 단계에서 좋아지는 것 (레벨업 선택지 카드와 같은 문구). 최대 단계·진화한 무기는 null */
  next: { tag: string; text: string } | null;
  evo: EvoLine[];
}

export interface LoadoutGroup {
  kind: 'weapon' | 'passive';
  /** "무기 3/6" */
  title: string;
  items: LoadoutItem[];
  /** 하나도 없을 때의 문구 */
  empty: string;
}

export interface Loadout {
  /** 무기 묶음, 패시브 묶음 (게임 화면의 칩과 같은 순서) */
  groups: [LoadoutGroup, LoadoutGroup];
  /** 되살아날 수 있는 횟수 줄 (게임 화면의 💾 칩과 같은 뜻). 없으면 null */
  revives: string | null;
}

/* ───────────── 숫자 쓰기 ───────────── */

/** 소수 digits 자리까지 반올림하고 뒤의 0 은 뺀다 (1.20 → "1.2", -0 → "0") */
export function num(n: number, digits = 2): string {
  const f = 10 ** digits;
  const r = Math.round(n * f) / f;
  return String(r === 0 ? 0 : r);
}
/** 부호를 붙인 수: +2, -0.6 */
const signed = (n: number, digits = 2): string => (Math.round(n * 10 ** digits) > 0 ? `+${num(n, digits)}` : num(n, digits));
/** 퍼센트의 소수 자리: 10% 아래만 한 자리 (6.5%), 그 위는 정수 (23%) */
const pctDigits = (p: number): number => (Math.abs(p) < 9.95 ? 1 : 0);
/** 비율(0.23) → "23%" */
const pct = (r: number): string => `${num(r * 100, pctDigits(r * 100))}%`;
/** 배율의 바뀐 몫(0.3, -0.16) → "+30%", "-16%" */
const signedPct = (d: number): string => `${signed(d * 100, pctDigits(d * 100))}%`;
/** 곱해지는 배율 → "×2.49" */
const times = (r: number): string => `×${num(r)}`;
/** 반올림하면 0% 인지 (바뀐 것이 없다) */
const zeroPct = (d: number): boolean => Math.round(d * 1000) === 0;

/* ───────────── 패시브 ───────────── */

/** 패시브가 하나도 없을 때 (기본값) */
const NONE: HasUpgrades = { up: {} };

/**
 * 패시브의 지금 효과: 그 패시브 하나만 지금 단계로 가진 것처럼 공용 함수에 넣어, 기본값과 비교한다.
 * (사이드 프로젝트의 20·40 레벨 보너스처럼 레벨에 따라 잠깐 붙는 것은 넣지 않는다)
 */
function passiveEffects(id: PassiveId, level: number, revives: number): Effect[] {
  const only: HasUpgrades = { up: { [id]: level } };
  /** 기본값에 대한 배율 */
  const rel = (f: (p: HasUpgrades) => number): number => f(only) / f(NONE);
  /** 기본값에서 더해진 양 */
  const add = (f: (p: HasUpgrades) => number): number => f(only) - f(NONE);
  switch (id) {
    case 'coffee':
      return [{ label: '이동 속도', value: signedPct(rel(moveSpeedOf) - 1) }];
    case 'mech_keyboard':
      return [{ label: '쿨다운', value: signedPct(rel(cooldownMultOf) - 1) }];
    case 'stack_overflow':
      return [{ label: '피해량', value: signedPct(rel(mightOf) - 1) }];
    case 'npm_install':
      return [{ label: '끌어당기는 범위', value: times(rel(pickupOf)) }];
    case 'dark_mode':
      return [{ label: '최대 체력', value: times(rel(maxHpOf)) }];
    case 'dual_monitor':
      return [{ label: '공격 범위', value: signedPct(rel(areaMultOf) - 1) }];
    case 'test_coverage':
      return [{ label: '한 대 맞을 때 피해', value: signed(-add(armorOf)) }];
    case 'work_life':
      return [
        { label: '1초에 체력', value: signed(add(recoveryOf)) },
        { label: '회복 아이템', value: `${num(healAmountOf(NONE))} → ${num(healAmountOf(only))}` },
      ];
    case 'cdn':
      return [{ label: '속도', value: signedPct(rel(speedMultOf) - 1) }];
    case 'keep_alive':
      return [{ label: '지속 시간', value: signedPct(rel(durationMultOf) - 1) }];
    case 'git_fork':
      return [{ label: '개수', value: signed(add(amountBonusOf)) }];
    case 'deploy_prayer':
      return [
        { label: '운', value: signedPct(rel(luckOf) - 1) },
        { label: '선택지 4개 나올 확률', value: pct(extraOfferChanceOf(only)) },
      ];
    case 'side_project':
      return [{ label: '얻는 경험치', value: signedPct(rel(growthOf) - 1) }];
    case 'prod_hotfix':
      return [{ label: '버그 체력·속도·수·빈도', value: signedPct(rel(curseOf) - 1) }];
    case 'snapshot':
      // 부활 수는 주운 백업과 스냅샷으로 받은 것을 합한 값만 온다 (어느 쪽이 몇 개인지는 오지 않는다)
      return [{ label: '남은 부활(백업 포함)', value: `${revives}번` }];
  }
}

/* ───────────── 무기 ───────────── */

/** 무기 능력치 → 그 능력치를 바꾸는 패시브 종류 (관통·확률은 패시브로 바뀌지 않는다) */
const STAT_KIND: Record<keyof WeaponStats, StatKind | null> = {
  dmg: 'might',
  cd: 'cd',
  amount: 'amount',
  area: 'area',
  speed: 'speed',
  dur: 'dur',
  pierce: null,
  chance: null,
};

/** 이만큼 이상이면 사실상 끝없이 꿰뚫는다 (롤백·핑퐁 등의 999) */
const PIERCE_ENDLESS = 999;

/** 러버덕이 한 번 나와서 도는 시간(on)과 다시 나오는 주기(period), 초 */
export interface DuckCycle {
  on: number;
  period: number;
}

/**
 * 러버덕은 쿨다운을 그대로 쓰지 않는다 (packages/shared/src/combat.ts 의 runDucks, 뱀서 King Bible):
 * (그 단계의 쿨다운 + 그 단계의 지속) × 쿨다운 배율마다 다시 나오고, 나오면 그 단계의 지속 × 지속 배율 동안 돈다.
 * 그래서 effectiveStats 의 쿨다운(쿨다운 × 배율)은 주기도 쉬는 시간도 아니다.
 * runDucks 와 같은 공용 함수(weaponStats, cooldownMultOf, durationMultOf)를 같은 식으로 조합한다.
 * 실제 시뮬레이션과 어긋나지 않는지는 loadout.test.ts 가 판을 돌려 잰다 (runDucks 를 바꾸면 그 테스트가 실패한다).
 */
export function duckCycleOf(up: Levels): DuckCycle {
  const me: HasUpgrades = { up };
  const s = weaponStats('rubber_duck', lv(me, 'rubber_duck'));
  return { on: s.dur * durationMultOf(me), period: (s.cd + s.dur) * cooldownMultOf(me) };
}

/** 쉬는 시간이 이만큼 이하면 쉬지 않는다 (도는 시간이 주기 이상이면 끝나기 전에 다시 켜진다) */
const NO_REST = 1e-9;

/** 러버덕의 지속(도는 시간)과 쉬는 시간. keep-alive 로 도는 시간이 주기 이상이면 쉬지 않고 계속 돈다 */
function duckEffects(up: Levels): Effect[] {
  const { on, period } = duckCycleOf(up);
  const rest = period - on;
  return [
    { label: '지속', value: `${num(on)}초` },
    { label: '쉬는 시간', value: rest > NO_REST ? `${num(rest)}초` : '없음 (계속 돌아요)' },
  ];
}

/**
 * 무기의 지금 수치: 내 강화 전체(패시브 포함)로 effectiveStats 를 그대로 쓴다 (러버덕의 쿨다운·지속만 예외: duckCycleOf).
 * 그 무기에 뜻이 있는 것만: 무기가 받지 않는 패시브의 능력치(ignores)는 빼고 (따로 이름을 붙인 것은 남긴다: 2단계 인증의 방패·무적),
 * 기본값이 0 이라 쓰지 않는 것도 뺀다. 범위·속도는 px 이 뜻이 없으니 그 무기 1단계·패시브 없음 대비로, 늘지 않았으면 뺀다.
 * 순서는 레벨업 선택지 문구(upgradeText)와 같다.
 */
function weaponEffects(id: WeaponId, up: Levels): Effect[] {
  const def = UPGRADES[id] as WeaponDef;
  const me: HasUpgrades = { up };
  const s = effectiveStats(me, id);
  const first = weaponStats(id, 1);
  const ignores: readonly StatKind[] = def.ignores ?? [];
  const name = (k: keyof WeaponStats, fallback: string): string => def.labels?.[k] ?? fallback;
  const shown = (k: keyof WeaponStats): boolean => {
    const kind = STAT_KIND[k];
    return kind === null || !ignores.includes(kind) || def.labels?.[k] !== undefined;
  };
  // 러버덕은 쿨다운 대신 시뮬레이션이 실제로 쓰는 지속·쉬는 시간을 보여 준다 (duckCycleOf)
  const duck = id === 'rubber_duck';
  const out: Effect[] = [];
  if (shown('dmg') && s.dmg > 0) out.push({ label: name('dmg', '피해'), value: num(s.dmg, 1) });
  if (shown('amount') && s.amount > 0) out.push({ label: name('amount', '개수'), value: num(s.amount) });
  if (shown('cd') && !duck) out.push({ label: name('cd', '쿨다운'), value: `${num(s.cd)}초` });
  for (const [k, fallback] of [
    ['area', '범위'],
    ['speed', '속도'],
  ] as const) {
    if (!shown(k) || !(first[k] > 0)) continue;
    const d = s[k] / first[k] - 1;
    if (!zeroPct(d)) out.push({ label: name(k, fallback), value: signedPct(d) });
  }
  if (duck) out.push(...duckEffects(up));
  else if (shown('dur') && s.dur > 0) out.push({ label: name('dur', '지속'), value: `${num(s.dur)}초` });
  if (s.pierce > 0) out.push({ label: name('pierce', '관통'), value: s.pierce >= PIERCE_ENDLESS ? '무한' : num(s.pierce) });
  // 언제나 걸리는 확률(rm -rf node_modules 는 늘 남긴다)은 뜻이 없다
  if (s.chance > 0 && def.base.chance < 1) out.push({ label: name('chance', '확률'), value: pct(Math.min(1, s.chance)) });
  if (def.crit) out.push({ label: '치명타', value: `${pct(Math.min(1, def.crit.chance * luckOf(me)))} ×${num(def.crit.mult)}` });
  return out;
}

/* ───────────── 목록 ───────────── */

const label = (id: UpgradeId): string => `${UPGRADES[id].icon} ${UPGRADES[id].name}`;

function itemOf(id: UpgradeId, level: number, up: Levels, ready: Set<UpgradeId>, revives: number): LoadoutItem {
  const def = UPGRADES[id];
  const evo = evolutionOf(id);
  const evolved = evo !== undefined;
  const maxed = level >= def.max;
  const lines: EvoLine[] = [];
  if (evo) {
    lines.push({ tone: 'from', text: `재료: ${[...evo.from, ...(evo.with ? [evo.with] : [])].map(label).join(' + ')}` });
  } else {
    if (ready.has(id)) lines.push({ tone: 'ready', text: '🎁 지금 보물상자를 열면 진화해요' });
    const hint = evolveHint(id, up);
    if (hint) lines.push({ tone: 'hint', text: hint });
  }
  return {
    id,
    kind: def.kind,
    icon: def.icon,
    name: def.name,
    level,
    max: def.max,
    tag: evolved ? '★ 진화' : `Lv.${level}/${def.max}`,
    badge: !evolved && maxed ? '최대' : null,
    evolved,
    ready: ready.has(id),
    desc: def.desc,
    now: def.kind === 'weapon' ? weaponEffects(id as WeaponId, up) : passiveEffects(id as PassiveId, level, revives),
    next: evolved || maxed ? null : { tag: `다음 Lv.${level + 1}`, text: upgradeText(id, level + 1) },
    evo: lines,
  };
}

/**
 * 메뉴에 보여 줄 가진 아이템. 순서는 게임 화면의 칩과 같다 (무기 먼저, 각각 UPGRADE_IDS 순).
 * up: 서버가 스냅샷에 실어 보낸 내 강화 단계 / revives: 되살아날 수 있는 횟수 (백업 + 스냅샷)
 */
export function loadoutOf(up: Levels, revives: number): Loadout {
  const ready = readyMaterials(up);
  const me: HasUpgrades = { up };
  const n = Number.isInteger(revives) && revives > 0 ? revives : 0;
  const items = (ids: readonly UpgradeId[]): LoadoutItem[] =>
    ids.filter((id) => lv(me, id) > 0).map((id) => itemOf(id, lv(me, id), up, ready, n));
  const weapons = items(WEAPON_IDS);
  const passives = items(PASSIVE_IDS);
  return {
    groups: [
      { kind: 'weapon', title: `무기 ${weapons.length}/${WEAPON_SLOTS}`, items: weapons, empty: '아직 가진 무기가 없어요.' },
      { kind: 'passive', title: `패시브 ${passives.length}/${PASSIVE_SLOTS}`, items: passives, empty: '아직 가진 패시브가 없어요. 레벨업할 때 고를 수 있어요.' },
    ],
    revives: n > 0 ? `${FIELD_ITEMS.revive.icon} 되살아날 수 있는 횟수 ${n}번 (백업·스냅샷)` : null,
  };
}

/** 한 조각을 한 줄 글로 ("피해 24") */
export const effectText = (e: Effect): string => `${e.label} ${e.value}`;
