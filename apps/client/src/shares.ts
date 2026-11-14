/**
 * 함께 한 판에서 각자의 처치 기여도(%). 합이 정확히 100 이 되게 나눈다 (소수점 아래가 큰 사람부터 1 씩 올림).
 * 혼자 한 판이거나, 개인별 처치 수가 없는 예전 기록이거나, 아무도 처치하지 못했으면 null.
 */
export function sharesOf(killsBy: number[] | undefined, members: number): number[] | null {
  if (!killsBy || members < 2 || killsBy.length !== members) return null;
  const total = killsBy.reduce((sum, k) => sum + k, 0);
  if (!(total > 0)) return null;
  const exact = killsBy.map((k) => (k / total) * 100);
  const shares = exact.map(Math.floor);
  let left = 100 - shares.reduce((sum, v) => sum + v, 0);
  const order = exact.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left-- <= 0) break;
    shares[i]!++;
  }
  return shares;
}
