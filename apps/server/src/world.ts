import { randomFillSync } from 'node:crypto';
import { createWorld, type Rand, type World } from '@friday-deploy/shared';

/**
 * 운영체제 CSPRNG 로 [0,1) 난수를 만드는 함수.
 * 호출마다 randomFillSync 를 부르면 시스템 호출 비용이 커서, 1KB(256개)씩 미리 채워 두고 꺼내 쓴다.
 * 버퍼는 서버 메모리에만 있고 어디로도 보내지 않는다.
 */
export function cryptoRand(): Rand {
  const buf = new Uint32Array(256);
  let at = buf.length;
  return () => {
    if (at === buf.length) {
      randomFillSync(buf);
      at = 0;
    }
    return buf[at++]! / 4294967296;
  };
}

/**
 * 새 판의 월드를 만든다. 난수는 서버의 CSPRNG 에서 뽑고 클라이언트에 공개하지 않는다
 * (스폰/드롭/선택지 예측 방지). 방(Room)은 이 함수만 쓴다.
 * - 보이는 난수의 시드: CSPRNG 128비트 (시드 대입 불가능)
 * - 비밀 난수(레벨업 선택지, 회복 아이템): 매번 CSPRNG 에서 직접 (관찰로 예측 불가능)
 */
export function newWorld(): World {
  return createWorld(randomFillSync(new Uint32Array(4)), cryptoRand());
}
