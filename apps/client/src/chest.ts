import { FIELD_ITEMS, UPGRADES, isUpgradeId, type UpgradeId } from '@friday-deploy/shared';

/** 보물상자 하나에 들어 있을 수 있는 강화의 최대 수 (서버는 1, 3, 5개를 준다) */
export const CHEST_MAX_ITEMS = 5;

export interface ChestMsg {
  t: 'chest';
  items: UpgradeId[];
  heal: number;
}

/**
 * 서버가 보낸 보물상자 메시지를 그대로 믿지 않고 모양을 확인한다.
 * 강화 id 는 아는 것만, 개수는 5개까지, 회복량은 0 이상의 유한한 수. 하나라도 어긋나면 null (메시지를 버린다).
 */
export function parseChest(raw: unknown): ChestMsg | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.t !== 'chest' || !Array.isArray(o.items) || o.items.length > CHEST_MAX_ITEMS) return null;
  if (!o.items.every(isUpgradeId)) return null;
  if (typeof o.heal !== 'number' || !Number.isFinite(o.heal) || o.heal < 0) return null;
  return { t: 'chest', items: [...(o.items as UpgradeId[])], heal: o.heal };
}

/**
 * 보물상자를 열었을 때의 알림 문구. 같은 것이 여러 번 오르면 묶는다 (러버덕 +2).
 * 예: "🎁 보물상자: console.log() +1, 러버덕 +2" / 올릴 것이 없어 체력만 찼으면 "🎁 보물상자: 체력 +30"
 */
export function chestText(items: readonly UpgradeId[], heal: number): string {
  const counts = new Map<UpgradeId, number>();
  for (const id of items) counts.set(id, (counts.get(id) ?? 0) + 1);
  const parts = [...counts].map(([id, n]) => `${UPGRADES[id].name} +${n}`);
  const hp = Math.round(heal);
  if (hp > 0) parts.push(`체력 +${hp}`);
  const head = `${FIELD_ITEMS.chest.icon} 보물상자`;
  return parts.length > 0 ? `${head}: ${parts.join(', ')}` : `${head}: 더 올릴 것이 없어요`;
}
