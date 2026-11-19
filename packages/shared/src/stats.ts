/**
 * 플레이어 능력치: 패시브 단계 → 실제 값. 서버 시뮬레이션만 쓴다 (클라이언트는 서버가 보낸 결과를 그릴 뿐이다).
 */
import { PLAYER_BASE_HP, PLAYER_BASE_PICKUP, PLAYER_BASE_SPEED } from './constants';
import { UPGRADES, weaponStats, type StatKind, type UpgradeId, type WeaponDef, type WeaponId, type WeaponStats } from './content';

/** 능력치 계산에 필요한 것만 (sim.ts 의 Player 와 순환 참조하지 않게) */
export interface HasUpgrades {
  up: Partial<Record<UpgradeId, number>>;
}

export const lv = (p: HasUpgrades, id: UpgradeId): number => Math.max(0, Math.min(UPGRADES[id].max, p.up[id] ?? 0));

/** npm install 단계마다 끌어당기는 범위에 곱하는 값 (뱀서 Attractorb: 1.5, 1.995, 2.494, 2.993, 3.980 배) */
const MAGNET_STEPS = [1.5, 1.33, 1.25, 1.2, 1.33];

/** 최대 체력: 다크 모드 단계마다 1.2 배 (곱한다. 뱀서 Hollow Heart: 5단계 2.488 배) */
export const maxHpOf = (p: HasUpgrades): number => PLAYER_BASE_HP * 1.2 ** lv(p, 'dark_mode');
export const moveSpeedOf = (p: HasUpgrades): number => PLAYER_BASE_SPEED * (1 + 0.1 * lv(p, 'coffee'));
export const mightOf = (p: HasUpgrades): number => 1 + 0.1 * lv(p, 'stack_overflow');
export const cooldownMultOf = (p: HasUpgrades): number => 1 - 0.08 * lv(p, 'mech_keyboard');
export const areaMultOf = (p: HasUpgrades): number => 1 + 0.1 * lv(p, 'dual_monitor');
export const speedMultOf = (p: HasUpgrades): number => 1 + 0.1 * lv(p, 'cdn');
export const durationMultOf = (p: HasUpgrades): number => 1 + 0.1 * lv(p, 'keep_alive');
export const amountBonusOf = (p: HasUpgrades): number => lv(p, 'git_fork');
export const pickupOf = (p: HasUpgrades): number => {
  let r = PLAYER_BASE_PICKUP;
  const n = lv(p, 'npm_install');
  for (let i = 0; i < n; i++) r *= MAGNET_STEPS[i]!;
  return r;
};
/** 테스트 커버리지(방어): 한 대 맞을 때 피해를 단계마다 1 줄인다. 그래도 1 아래로는 줄지 않는다 (뱀서 Armor) */
export const armorOf = (p: HasUpgrades): number => lv(p, 'test_coverage');
export const hitDamage = (p: HasUpgrades, power: number): number => Math.max(1, power - armorOf(p));
/** 워라밸: 1초에 회복하는 체력 (뱀서 Pummarola) */
export const recoveryOf = (p: HasUpgrades): number => 0.2 * lv(p, 'work_life');
/** 회복 아이템 하나로 차는 체력: 30, 회복력 0.1 마다 10% 더 (뱀서 Floor Chicken) */
export const HEAL_AMOUNT = 30;
export const healAmountOf = (p: HasUpgrades): number => HEAL_AMOUNT * (1 + recoveryOf(p));
/** 운: 기본 1, 배포 기도 단계마다 +0.1 (뱀서 Clover) */
export const luckOf = (p: HasUpgrades): number => 1 + 0.1 * lv(p, 'deploy_prayer');
/** 레벨업 선택지가 하나 더(4개) 나올 확률: 1 - 1/운 (뱀서) */
export const extraOfferChanceOf = (p: HasUpgrades): number => 1 - 1 / luckOf(p);
/** 사이드 프로젝트: 얻는 경험치 배율. 20, 40 레벨에 머무는 동안은 +100% 더 (뱀서 Growth) */
export const growthOf = (p: HasUpgrades & { level?: number }): number =>
  1 + 0.08 * lv(p, 'side_project') + (p.level === 20 || p.level === 40 ? 1 : 0);
/** 운영 서버 직접 수정(저주): 버그의 체력·속도·수·빈도 배율 (뱀서 Curse) */
export const curseOf = (p: HasUpgrades): number => 1 + 0.1 * lv(p, 'prod_hotfix');

/** 쿨다운의 하한 (초): 패시브를 다 모아도 한 틱에 여러 번 쓰지 않게 */
const MIN_COOLDOWN = 0.1;

/** 패시브까지 적용한 무기 능력치. 무기가 받지 않는 패시브(뱀서의 "Ignores ...")는 건너뛴다 */
export function effectiveStats(p: HasUpgrades, id: WeaponId): WeaponStats {
  const s = weaponStats(id, lv(p, id));
  const ignores: readonly StatKind[] = (UPGRADES[id] as WeaponDef).ignores ?? [];
  const use = (k: StatKind, v: number): number => (ignores.includes(k) ? 1 : v);
  return {
    dmg: s.dmg * use('might', mightOf(p)),
    cd: Math.max(MIN_COOLDOWN, s.cd * use('cd', cooldownMultOf(p))),
    amount: s.amount + (ignores.includes('amount') ? 0 : amountBonusOf(p)),
    area: s.area * use('area', areaMultOf(p)),
    speed: s.speed * use('speed', speedMultOf(p)),
    dur: s.dur * use('dur', durationMultOf(p)),
    pierce: s.pierce,
    chance: s.chance * luckOf(p),
  };
}
