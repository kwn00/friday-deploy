import { FIELD_ITEMS, sanitizeName, type FieldItemKind } from '@friday-deploy/shared';

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

/** 동료가 자석을 주웠을 때. name 은 서버가 보낸 동료의 이름이라 다시 정제해서 쓴다 (모르면 '동료') */
export function magnetPeerText(name: unknown): string {
  const who = typeof name === 'string' && name.length > 0 ? `${sanitizeName(name)} 님이` : '동료가';
  return `${FIELD_ITEMS.magnet.icon} ${who} 자석을 주웠어요! 경험치가 모두 그쪽으로 끌려가요`;
}

/**
 * 한 번에 여러 아이템이 새로 놓였을 때 알릴 순서 (앞일수록 먼저). 놓일 때의 비중(weight)은 0 이 "따로 놓는다"는 뜻이라
 * 드문 정도로 쓸 수 없다: 자석(평균 3분에 하나)은 백업(평균 3시간에 하나)보다 흔하다
 */
const NOTICE_ORDER: readonly FieldItemKind[] = ['chest', 'revive', 'magnet', 'levelup', 'heal'];
export const noticeRank = (kind: FieldItemKind): number => {
  const i = NOTICE_ORDER.indexOf(kind);
  return i < 0 ? NOTICE_ORDER.length : i;
};
