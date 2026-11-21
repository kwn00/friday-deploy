/**
 * 진화 안내 문구: 레벨업 선택지 카드와 무기 칸에 짝을 알려 준다.
 * 진화할지는 서버가 정한다 (보물상자를 열 때). 여기는 이미 받은 내 강화 단계로 보여 주기만 한다.
 *
 * 이 파일은 화면(DOM)을 쓰지 않는다 (단위 테스트에서 검사한다).
 */
import { UPGRADES, evolutionsUsing, readyEvolutions, type UpgradeId } from '@friday-deploy/shared';

type Levels = Partial<Record<UpgradeId, number>>;

const label = (id: UpgradeId): string => `${UPGRADES[id].icon} ${UPGRADES[id].name}`;

/**
 * 선택지 카드의 진화 안내 한 줄. 이 무기·패시브를 재료로 쓰는 진화가 없거나 이미 진화했으면 null.
 * - 무기: "✨ 진화: 최대 단계 + 🧪 테스트 커버리지 → 🐞 디버거"
 * - 합치기: "✨ 합치기: 🦉 야근 부엉이와 둘 다 최대 단계 → 🕐 24시간 모니터링"
 * - 패시브: "✨ 진화: 🖨️ console.log() 최대 단계와 함께 → 🐞 디버거"
 */
export function evolveHint(id: UpgradeId, up: Levels): string | null {
  const e = evolutionsUsing(id).find((x) => !((up[x.id] ?? 0) > 0));
  if (!e) return null;
  const to = label(e.id);
  if (e.with === null) {
    const other = e.from.find((f) => f !== id);
    return other ? `✨ 합치기: ${label(other)}와 둘 다 최대 단계 → ${to}` : null;
  }
  if (e.with === id) return `✨ 진화: ${e.from.map(label).join(', ')} 최대 단계와 함께 → ${to}`;
  return `✨ 진화: 최대 단계 + ${label(e.with)} → ${to}`;
}

/** 지금 조건이 맞아 보물상자를 열면 바뀔 재료 무기들 (무기 칸에 표시한다. 1개짜리 상자는 EVOLUTIONS 순서로 하나만 바꾼다) */
export function readyMaterials(up: Levels): Set<UpgradeId> {
  const out = new Set<UpgradeId>();
  for (const e of readyEvolutions(up)) for (const f of e.from) out.add(f);
  return out;
}
