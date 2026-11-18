/**
 * 플레이어 능력치: 패시브 단계 → 실제 값. 서버 시뮬레이션만 쓴다 (클라이언트는 서버가 보낸 결과를 그릴 뿐이다).
 */
import { PLAYER_BASE_HP, PLAYER_BASE_PICKUP, PLAYER_BASE_SPEED } from './constants';
import { UPGRADES, weaponStats, type UpgradeId, type WeaponId, type WeaponStats } from './content';

/** 능력치 계산에 필요한 것만 (sim.ts 의 Player 와 순환 참조하지 않게) */
export interface HasUpgrades {
  up: Partial<Record<UpgradeId, number>>;
}

export const lv = (p: HasUpgrades, id: UpgradeId): number => Math.max(0, Math.min(UPGRADES[id].max, p.up[id] ?? 0));

/** npm install 단계마다 끌어당기는 범위에 곱하는 값 (뒤로 갈수록 작아지다 마지막에 조금 크다) */
const MAGNET_STEPS = [1.4, 1.3, 1.2, 1.2, 1.25];

/** 최대 체력: 다크 모드 단계마다 기본의 +20% */
export const maxHpOf = (p: HasUpgrades): number => Math.round(PLAYER_BASE_HP * (1 + 0.2 * lv(p, 'dark_mode')));
/** 다크 모드 한 단계로 늘어나는 최대 체력 (고를 때 그만큼 회복한다) */
export const DARK_MODE_HP = PLAYER_BASE_HP * 0.2;
export const moveSpeedOf = (p: HasUpgrades): number => PLAYER_BASE_SPEED * (1 + 0.1 * lv(p, 'coffee'));
export const mightOf = (p: HasUpgrades): number => 1 + 0.1 * lv(p, 'stack_overflow');
export const cooldownMultOf = (p: HasUpgrades): number => 1 - 0.08 * lv(p, 'mech_keyboard');
export const areaMultOf = (p: HasUpgrades): number => 1 + 0.1 * lv(p, 'dual_monitor');
export const speedMultOf = (p: HasUpgrades): number => 1 + 0.1 * lv(p, 'cdn');
export const durationMultOf = (p: HasUpgrades): number => 1 + 0.1 * lv(p, 'keep_alive');
export const amountBonusOf = (p: HasUpgrades): number => lv(p, 'git_fork');
export const pickupOf = (p: HasUpgrades): number => {
  let r = PLAYER_BASE_PICKUP;
  for (let i = 0; i < lv(p, 'npm_install'); i++) r *= MAGNET_STEPS[i]!;
  return r;
};
/** 테스트 커버리지: 버그 하나에게 1초에 받는 피해를 단계마다 1 줄인다 (원래 피해의 20% 아래로는 줄지 않는다) */
export const armorOf = (p: HasUpgrades): number => lv(p, 'test_coverage');
export const contactDps = (p: HasUpgrades, dps: number): number => Math.max(dps * 0.2, dps - armorOf(p));
/** 워라밸: 1초에 회복하는 체력 */
export const recoveryOf = (p: HasUpgrades): number => 0.2 * lv(p, 'work_life');
/** 배포 기도: 레벨업 선택지가 하나 더(4개) 나올 확률 */
export const extraOfferChanceOf = (p: HasUpgrades): number => 0.1 * lv(p, 'deploy_prayer');
/** 사이드 프로젝트: 얻는 경험치 배율 */
export const growthOf = (p: HasUpgrades): number => 1 + 0.08 * lv(p, 'side_project');
/** 운영 서버 직접 수정: 이 사람 주변에 나오는 버그의 체력·속도, 그리고 등장 빈도 배율 */
export const curseOf = (p: HasUpgrades): number => 1 + 0.1 * lv(p, 'prod_hotfix');

/** 쿨다운의 하한 (초): 패시브를 다 모아도 한 틱에 여러 번 쓰지 않게 */
const MIN_COOLDOWN = 0.1;

/** 패시브까지 적용한 무기 능력치 */
export function effectiveStats(p: HasUpgrades, id: WeaponId): WeaponStats {
  const s = weaponStats(id, lv(p, id));
  return {
    dmg: s.dmg * mightOf(p),
    cd: Math.max(MIN_COOLDOWN, s.cd * cooldownMultOf(p)),
    amount: s.amount + amountBonusOf(p),
    area: s.area * areaMultOf(p),
    speed: s.speed * speedMultOf(p),
    dur: s.dur * durationMultOf(p),
    pierce: s.pierce,
  };
}
