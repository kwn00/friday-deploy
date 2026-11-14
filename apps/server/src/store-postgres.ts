import type { LeaderboardStore } from './leaderboard';

/**
 * PostgreSQL 저장소 (DATABASE_URL 이 설정됐을 때만 쓴다).
 * 구현 예정: 이 파일은 계약(함수 이름과 반환 타입)만 고정해 둔 자리표시다.
 */
export async function createPostgresStore(_url: string): Promise<LeaderboardStore> {
  throw new Error('PostgreSQL 저장소가 아직 구현되지 않았습니다');
}
