import { randomInt } from 'node:crypto';
import { createWorld, type World } from '@friday-deploy/shared';

/**
 * 새 판의 월드를 만든다. 난수는 서버의 CSPRNG 에서 뽑고 클라이언트에 공개하지 않는다
 * (스폰/드롭/선택지 예측 방지). 방(Room)은 이 함수만 쓴다.
 */
export function newWorld(): World {
  return createWorld(randomInt(0, 2 ** 31));
}
