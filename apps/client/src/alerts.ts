import { FIELD_ITEMS } from '@friday-deploy/shared';

/**
 * 서버가 알려 준 자석·체력 채우기의 알림 문구. 숫자는 서버에서 온 값이라 모양을 확인하고 쓴다:
 * 0 이상의 정수이고 터무니없이 크지 않을 때만 문구에 넣고, 아니면 숫자 없이 알린다.
 * (화면에는 textContent 로 들어간다. 이 파일은 화면(DOM)을 쓰지 않아 단위 테스트에서 검사한다)
 */
const count = (v: unknown, max: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null);

/** 땅에 있을 수 있는 경험치 수(400)보다 넉넉히 */
const MAX_GEMS_SHOWN = 100_000;
/** 최대 체력보다 넉넉히 */
const MAX_HP_SHOWN = 1_000_000;

/** 자석을 주웠을 때. 예: "🧲 자석! 경험치 37개가 끌려와요" */
export function magnetText(gems: unknown): string {
  const head = `${FIELD_ITEMS.magnet.icon} 자석!`;
  const n = count(gems, MAX_GEMS_SHOWN);
  if (n === null) return `${head} 맵의 경험치가 모두 끌려와요`;
  return n > 0 ? `${head} 경험치 ${n}개가 끌려와요` : `${head} 지금은 끌려올 경험치가 없어요`;
}

/** 강화를 모두 마친 뒤 레벨업해서 체력을 가득 채웠을 때. 예: "❤️ 레벨 업! 체력을 가득 채웠어요 (+42)" */
export function refillText(hp: unknown): string {
  const n = count(hp, MAX_HP_SHOWN);
  return `❤️ 레벨 업! 체력을 가득 채웠어요${n !== null && n > 0 ? ` (+${n})` : ''}`;
}
