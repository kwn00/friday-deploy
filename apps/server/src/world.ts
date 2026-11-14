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
 * 새 판의 월드를 만든다. 방(Room)은 이 함수만 쓴다.
 * 난수는 전부 운영체제 CSPRNG 에서 바로 뽑는다. 출력에서 되짚어 갈 시드가 없으므로,
 * 화면에 보이는 결과(스폰 위치 등)를 아무리 모아도 다음 결과를 계산할 수 없다.
 * - 보이는 난수(스폰, 재배치, 합류 위치, AI 에이전트 조준)와 비밀 난수(레벨업 선택지, 회복 아이템)는 버퍼도 따로 쓴다.
 * - 판마다, 방마다 새로 만든다 (서로 이어지는 값이 없다).
 */
export function newWorld(): World {
  return createWorld({ rng: cryptoRand(), secret: cryptoRand() });
}
