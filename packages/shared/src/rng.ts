/**
 * 시뮬레이션용 난수.
 *
 * 예전에는 31비트 시드 하나로 mulberry32(상태 32비트)를 돌렸다. 스냅샷에 보이는 적 스폰 위치만으로
 * 2^31 개 시드를 전부 대입해 보면 몇 분 만에 시드가 나왔고, 그러면 앞으로의 스폰·레벨업 선택지·회복 아이템을
 * 미리 알 수 있었다. 그래서 이렇게 바꿨다.
 *
 * 1. 월드는 난수를 두 개로 나눠 쓴다: 눈에 보이는 결과(스폰 위치/종류, 재배치, AI 에이전트 조준)용과,
 *    미리 알면 이득인 결과(레벨업 선택지, 회복 아이템 드롭)용 "비밀" 난수.
 * 2. 실제 서버는 두 난수 모두 운영체제 CSPRNG 를 함수로 넘긴다 (apps/server/src/world.ts).
 *    출력에서 되짚어 갈 시드가 없으므로 플레이어가 무엇을 관찰하든 다음 값을 계산할 수 없다.
 * 3. 이 파일의 시드 기반 생성기(sfc32)는 같은 판을 다시 만들어야 하는 테스트·도구에서만 쓴다.
 *
 * 이 파일은 클라이언트도 번들하므로 node:crypto 같은 Node 전용 모듈을 쓰지 않는다.
 */

/** 시드: 32비트 정수 하나 또는 32비트 단어 4개(128비트). 테스트·도구용 (서버는 시드를 쓰지 않는다) */
export type Seed = number | Uint32Array | readonly number[];

/** [0,1) 난수 하나를 돌려주는 함수 */
export type Rand = () => number;

/**
 * splitmix32: 32비트 정수 하나를 잘 섞인 32비트 단어들로 늘린다.
 * 숫자 시드를 128비트 상태로 펼칠 때만 쓴다 (비슷한 시드 1, 2, 3 이 비슷한 상태가 되지 않게).
 */
export function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/**
 * 시드를 sfc32 상태 단어 4개로 바꾼다.
 * - 숫자: splitmix32 로 4단어를 만든다. 즉 createWorld(n) 은 createWorld(seedWords(n)) 과 완전히 같다.
 * - 단어 4개: 그대로 쓴다.
 */
export function seedWords(seed: Seed): [number, number, number, number] {
  if (typeof seed === 'number') {
    const next = splitmix32(seed);
    return [next(), next(), next(), next()];
  }
  if (seed.length !== 4) throw new RangeError('시드는 32비트 단어 4개(128비트)여야 한다');
  return [seed[0]! >>> 0, seed[1]! >>> 0, seed[2]! >>> 0, seed[3]! >>> 0];
}

/**
 * sfc32 (Chris Doty-Humphrey 의 Small Fast Chaotic, PractRand 에 포함).
 * 고른 이유:
 * - 상태 128비트(a, b, c + 카운터). 카운터 덕분에 어떤 시드도 주기가 최소 2^32 이고, 짧은 고리에 빠지지 않는다.
 * - 덧셈(2^32 를 법으로)과 xor/시프트/회전을 섞는 생성기라 통계적 품질이 좋다 (PractRand 수 TB 통과).
 * - JS 에서 32비트 연산(Math.imul 도 필요 없음)만으로 빠르다.
 * 암호학적 생성기가 아니다: 연속한 32비트 출력 5개가 있으면 c 를 2^32 가지로 가정해 나머지 상태를 역산하는 방법으로
 * 한 코어에서 몇 초 만에 상태 전체가 복원된다 (검토 중 실측). 그래서 실제 서버는 이것을 쓰지 않는다:
 * 서버의 난수는 보이는 것·비밀인 것 모두 운영체제 CSPRNG 다 (apps/server/src/world.ts).
 * 이 생성기는 같은 시드로 같은 판을 다시 만들어야 하는 곳(테스트, 밸런스 도구)에서만 쓴다.
 */
export function sfc32(seed: Seed): Rand {
  let [a, b, c, d] = seedWords(seed);
  const next = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  // 권장 초기화: 처음 몇 번은 버려서 시드 비트가 상태 전체에 퍼지게 한다
  for (let i = 0; i < 15; i++) next();
  return next;
}

/**
 * 비밀 난수를 따로 받지 못했을 때(테스트, 도구) 시드에서 유도하는 두 번째 결정론적 난수.
 * 보이는 난수와 다른 상태가 되도록 각 단어를 상수와 섞은 뒤 다시 섞는다.
 * 실제 서버는 이것을 쓰지 않는다 (서버의 난수는 둘 다 CSPRNG).
 */
export function derivedSecret(seed: Seed): Rand {
  const w = seedWords(seed);
  const mixed = w.map((x, i) => splitmix32(x ^ 0x5ec7e75e ^ Math.imul(i + 1, 0x632be5ab))());
  return sfc32(mixed);
}
