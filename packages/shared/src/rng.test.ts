import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DT, addPlayer, buildSnapshot, createWorld, derivedSecret, pickOffer, seedWords, setInput, sfc32, step, type Rand, type UpgradeId, type World } from './index';

test('rng: sfc32 는 [0,1) 범위이고, 시드가 조금만 달라도 첫 출력부터 갈라진다', () => {
  const r = sfc32([1, 2, 3, 4]);
  for (let i = 0; i < 200_000; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1, String(v));
  }
  // 숫자 시드 1 과 2, 단어 하나의 비트 하나만 다른 128비트 시드
  for (const [x, y] of [
    [1, 2],
    [
      [0, 0, 0, 0],
      [0, 0, 0, 1],
    ],
    [
      [0xdeadbeef, 1, 2, 3],
      [0xdeadbeef, 1, 2, 3 ^ 0x80000000],
    ],
  ] as const) {
    const a = sfc32(x);
    const b = sfc32(y);
    for (let i = 0; i < 8; i++) assert.notEqual(a(), b(), `${JSON.stringify(x)} vs ${JSON.stringify(y)} #${i}`);
  }
});

test('rng: 고르게 나온다 (16칸 카이제곱, 평균, 비트별 균형의 가벼운 확인)', () => {
  const r = sfc32(12345);
  const N = 160_000;
  const bins = new Array<number>(16).fill(0);
  const ones = new Array<number>(32).fill(0);
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const v = r();
    sum += v;
    bins[Math.floor(v * 16)]!++;
    const u = Math.floor(v * 4294967296);
    for (let b = 0; b < 32; b++) ones[b]! += (u >>> b) & 1;
  }
  const exp = N / 16;
  const chi = bins.reduce((s, n) => s + (n - exp) ** 2 / exp, 0);
  assert.ok(chi < 37.7, `카이제곱 ${chi.toFixed(1)} (자유도 15, p=0.001 기준 37.7)`);
  assert.ok(Math.abs(sum / N - 0.5) < 0.005, `평균 ${sum / N}`);
  // 각 비트가 1 일 비율이 0.5 ± 5σ (σ = 0.5/√N ≈ 0.00125)
  for (let b = 0; b < 32; b++) assert.ok(Math.abs(ones[b]! / N - 0.5) < 0.00625, `비트 ${b}: ${ones[b]! / N}`);
});

test('rng: 숫자 시드는 splitmix32 로 펼친 128비트 시드와 완전히 같다 (createWorld(n) ≡ createWorld(seedWords(n)))', () => {
  // 설계: 숫자 시드는 "짧게 쓴 128비트 시드"일 뿐 다른 생성기가 아니다.
  // 그래서 테스트가 숫자로 재현한 장면을 서버와 같은 경로(단어 4개)로 그대로 다시 만들 수 있다.
  const words = seedWords(7);
  assert.equal(words.length, 4);
  assert.ok(words.every((w) => Number.isInteger(w) && w >= 0 && w < 2 ** 32));
  const a = sfc32(7);
  const b = sfc32(Uint32Array.from(words));
  for (let i = 0; i < 1000; i++) assert.equal(a(), b());
  const s1 = derivedSecret(7);
  const s2 = derivedSecret(words);
  for (let i = 0; i < 100; i++) assert.equal(s1(), s2());
  // 월드 전체로도 같다
  assert.deepEqual(record(createWorld(7), 2000).snaps, record(createWorld(words), 2000).snaps);
  // 비밀 난수는 보이는 난수와 다른 수열이다
  const v = sfc32(7);
  const s = derivedSecret(7);
  let same = 0;
  for (let i = 0; i < 100; i++) if (v() === s()) same++;
  assert.equal(same, 0);
  assert.throws(() => sfc32([1, 2, 3]), RangeError);
});

/** 원 그리며 걷는 봇으로 월드를 돌리며 매 틱 보이는 것과 레벨업 선택지를 기록한다 */
function record(w: World, ticks: number, opts: { skipOffers?: boolean } = {}) {
  const p = addPlayer(w, 'bot');
  let visibleCalls = 0;
  const rng = w.rng;
  w.rng = () => {
    visibleCalls++;
    return rng();
  };
  const snaps: string[] = [];
  const spawns: string[] = [];
  const calls: number[] = [];
  const offers: UpgradeId[][] = [];
  let heals = 0;
  const seenHeal = new Set<number>();
  for (let i = 0; i < ticks; i++) {
    if (p.offers) {
      offers.push([...p.offers]);
      // skipOffers: 선택지를 기록만 하고 고르지 않는다. 고른 업그레이드가 무기를 바꾸면 처치 수와 적 수가 달라져
      // 보이는 쪽도 당연히 달라지므로, "비밀 난수가 보이는 난수에 새지 않는다"만 따로 보려면 선택의 효과를 뺀다.
      if (opts.skipOffers) {
        p.offers = null;
        p.offerTimer = 0;
      } else pickOffer(w, p.id, i % 3);
    }
    setInput(w, p.id, Math.cos(i / 40), Math.sin(i / 40));
    // 죽지 않게. 체력이 가득 이상이면 회복 아이템을 줍지 않으므로, 회복 드롭 차이도 보이는 쪽에 영향이 없다
    p.hp = 1e9;
    step(w, DT);
    // 적은 id 를 빼고 비교한다: 회복 아이템도 nextId 를 쓰므로 드롭 차이로 id 만은 달라질 수 있다
    spawns.push(w.enemies.map((e) => `${e.type}@${e.x},${e.y}`).join(';'));
    calls.push(visibleCalls);
    snaps.push(JSON.stringify(buildSnapshot(w, p.id)));
    for (const h of w.heals) if (!seenHeal.has(h.id)) (seenHeal.add(h.id), heals++);
  }
  return { snaps, spawns, calls, offers, heals };
}

const secretFrom = (seed: number): Rand => sfc32([seed, 0x51, 0x52, 0x53]);

test('rng: 시드가 같고 비밀 난수만 다르면 적 스폰은 틱마다 똑같고, 레벨업 선택지는 다르다', () => {
  const seed = Uint32Array.from([0x1234, 0x5678, 0x9abc, 0xdef0]);
  const a = record(createWorld(seed, secretFrom(1)), 20 * 300, { skipOffers: true });
  const b = record(createWorld(seed, secretFrom(2)), 20 * 300, { skipOffers: true });
  assert.ok(a.offers.length >= 5, `레벨업 ${a.offers.length}번`);
  assert.equal(a.offers.length, b.offers.length);
  for (let t = 0; t < a.spawns.length; t++) {
    assert.equal(a.calls[t], b.calls[t], `틱 ${t}: 보이는 난수 소비 횟수`);
    assert.equal(a.spawns[t], b.spawns[t], `틱 ${t}: 적 위치/종류`);
  }
  assert.ok(a.spawns.at(-1)!.length > 0);
  assert.notDeepEqual(a.offers, b.offers, '비밀 난수가 다르면 선택지가 다르다');
  const differing = a.offers.filter((o, i) => o.join() !== b.offers[i]!.join()).length;
  assert.ok(differing >= a.offers.length / 2, `${differing}/${a.offers.length} 번 다름`);
});

test('rng: 시드와 비밀 난수가 같으면 월드 전체가 재현된다', () => {
  const seed = [9, 8, 7, 6] as const;
  const a = record(createWorld(seed, secretFrom(5)), 20 * 120);
  const b = record(createWorld(seed, secretFrom(5)), 20 * 120);
  assert.deepEqual(a.snaps, b.snaps);
  assert.deepEqual(a.offers, b.offers);
  assert.ok(a.offers.length > 0);
  // 비밀 난수를 주지 않은 경우(시드에서 유도)도 재현된다
  assert.deepEqual(record(createWorld(seed), 20 * 60).snaps, record(createWorld(seed), 20 * 60).snaps);
});
