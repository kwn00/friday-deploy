import type { BoardId, LeaderboardEntry } from '@friday-deploy/shared';

/** 이번 브라우저 세션에서 방금 순위표에 오른 기록 (그 줄을 강조하는 데 쓴다) */
export interface MyPlace {
  board: BoardId;
  rank: number;
  /** 내 결과의 값들: 함께 한 판에서는 시간·처치 수가 "나 개인"의 것이라 순위표의 팀 합계와 다르다 */
  name: string;
  time: number;
  kills: number;
  level: number;
}

/** 판이 시작된 직후(서버가 "처음부터 있던 사람"으로 치는 시간)에 들어온 사람은 결과의 시간이 판 전체보다 이만큼까지 짧다 */
const JOIN_GRACE_SECONDS = 5;

/**
 * 순위표에서 방금 내가 세운 기록을 찾는다 (없으면 -1). 그 사이 다른 기록이 앞에 들어와 순위가 밀렸을 수 있으므로
 * 순위가 아니라 내용으로 찾고, 후보가 여럿이면 알려준 순위에 가장 가까운 것을 고른다.
 * - 개인별 처치 수가 있는 기록: 내 이름 자리의 처치 수가 내 결과와 같은 줄 (함께 한 판도 찾을 수 있다)
 * - 없는 기록(예전 방식): 시간·처치 수·레벨이 모두 같은 줄
 */
export function findMine(entries: LeaderboardEntry[], m: MyPlace): number {
  const mine = entries.filter((e) => {
    if (e.killsBy && e.killsBy.length === e.names.length) {
      const late = e.time - m.time;
      return late >= 0 && late <= JOIN_GRACE_SECONDS && e.names.some((n, i) => n === m.name && e.killsBy![i] === m.kills);
    }
    return e.time === m.time && e.kills === m.kills && e.level === m.level;
  });
  mine.sort((a, b) => Math.abs(a.rank - m.rank) - Math.abs(b.rank - m.rank));
  return mine[0]?.rank ?? -1;
}
