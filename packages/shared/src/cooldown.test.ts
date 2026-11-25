/**
 * 쿨다운이 틱(0.05초) 단위로 올림되지 않는다: 틱 중간에 끝난 몫을 다음 쿨다운으로 넘겨 평균 간격이 쿨다운과 같다.
 * 예전에는 쏜 틱에 쿨다운을 그대로 되돌려 실제 간격이 0.05초 단위로 올림되었고, 쿨다운 0.5초 무기에 기계식 키보드 1단계(0.46초)가 듣지 않았다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DT, addPlayer, createWorld, effectiveStats, setInput, step, type Enemy, type Player, type UpgradeId, type World } from './index';

const enemy = (id: number, x: number, y: number): Enemy => ({ id, type: 'merge_conflict', x, y, hp: 1e12, spd: 0, frozen: 0, kbTaken: 0, resFreeze: 0, kbTime: 0, kbMult: 0, vx: 0, vy: 0, life: 0, hit: false });

/** 스폰·아이템·레벨업이 끼어들지 않는 월드에 강화를 가진 한 사람 */
function setup(seed: number, up: Partial<Record<UpgradeId, number>>): { w: World; p: Player } {
  const w = createWorld(seed);
  const p = addPlayer(w, 'a');
  p.xpNext = 1e12;
  p.shield = 1e9;
  w.itemCd = 1e9;
  w.magnetCd = 1e9;
  p.up = { ...up };
  return { w, p };
}

/** 놓아 둔 적만 남긴 채 한 틱 (적은 움직이지 않는다) */
function tick(w: World, keep: Enemy[]): void {
  w.enemies = keep.filter((e) => e.hp > 0);
  w.wave = Math.floor((w.time + DT) / 60);
  w.spawnCd = 1e9;
  step(w, DT);
}

/** n 틱 동안 fired() 가 참인 틱 번호들 */
function fireTicks(w: World, n: number, keep: () => Enemy[], fired: () => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    tick(w, keep());
    if (fired()) out.push(i);
  }
  return out;
}

/** 이번 틱에 이 사람의 폭발(카나리아·부엉이·24시간 모니터링)이 생겼는지 */
const blasted = (w: World, p: Player) => (): boolean => w.zones.some((z) => z.kind === 'blast' && z.owner === p.id && z.born === w.tick);

/** 첫 번째와 마지막 사이의 평균 간격(초) */
const meanGap = (ticks: number[]): number => ((ticks.at(-1)! - ticks[0]!) / (ticks.length - 1)) * DT;

test('24시간 모니터링(쿨다운 0.5초): 기계식 키보드 1단계(0.46초)면 10초에 더 많이 터뜨린다', () => {
  const count = (kb: number): number => {
    const { w, p } = setup(201, { monitoring: 1, ...(kb ? { mech_keyboard: kb } : {}) });
    return fireTicks(w, 200, () => [], blasted(w, p)).length;
  };
  const counts = [0, 1, 2, 3, 4, 5].map(count);
  // 0.5초 → 20번, 0.46초 → 22번 (예전에는 둘 다 0.5초 간격이라 20번)
  assert.equal(counts[0], 20, `키보드 0단계 ${counts[0]}번`);
  assert.ok(counts[1]! > counts[0]!, `키보드 1단계 ${counts[1]}번 > 0단계 ${counts[0]}번`);
  for (let kb = 1; kb <= 5; kb++) assert.ok(counts[kb]! > counts[kb - 1]!, `단계마다 늘어난다: ${counts.join(', ')}`);
});

test('카나리아 8단계(쿨다운 0.5초): 키보드 1단계면 켜져 있는 4초에 한 묶음 더, 평균 주기는 지속 + 쿨다운', () => {
  const run = (kb: number): { first: number; volleys: number[] } => {
    const { w, p } = setup(202, { canary: 8, ...(kb ? { mech_keyboard: kb } : {}) });
    const volleys = fireTicks(w, 20 * 60, () => [], blasted(w, p));
    // 켜져 있는 동안의 묶음: 첫 묶음에서 4초 안
    return { first: volleys.filter((t) => t - volleys[0]! < 4 / DT).length, volleys };
  };
  const kb0 = run(0);
  const kb1 = run(1);
  assert.equal(kb0.first, 8, '0.5초마다 4초 동안 8번');
  assert.equal(kb1.first, 9, '0.46초마다 4초 동안 9번 (예전에는 0.5초 간격이라 8번)');
  // 주기의 시작(쉬고 나서 첫 묶음)끼리의 평균 간격 = 4초 + 0.46초
  const starts = (v: number[]): number[] => v.filter((t, i) => i === 0 || t - v[i - 1]! > 0.5 / DT + 1);
  const s1 = starts(kb1.volleys);
  assert.ok(s1.length >= 10, `주기 ${s1.length}개`);
  assert.ok(Math.abs(meanGap(s1) - 4.46) < 0.01, `키보드 1단계 주기 ${meanGap(s1).toFixed(3)}초`);
  assert.ok(Math.abs(meanGap(starts(kb0.volleys)) - 4.5) < 1e-6, '키보드 0단계 주기 4.5초 (그대로)');
});

test('console.log 8단계 + 기계식 키보드 1단계(0.92초): 긴 시간 평균 간격이 쿨다운과 같다', () => {
  const { w, p } = setup(203, { console_log: 8, mech_keyboard: 1 });
  const st = effectiveStats(p, 'console_log');
  assert.ok(Math.abs(st.cd - 0.92) < 1e-9);
  const target = enemy(9001, p.x + 60, p.y);
  let last = Infinity;
  const fires = fireTicks(w, 20 * 200, () => [target], () => {
    const cd = p.cd.console_log ?? 0;
    const shot = cd > last;
    last = cd;
    return shot;
  });
  // 예전에는 19틱(0.95초)마다
  assert.ok(Math.abs(meanGap(fires) - st.cd) < 0.002, `평균 간격 ${meanGap(fires).toFixed(4)}초`);
  // 한 번의 간격은 쿨다운보다 한 틱 넘게 짧거나 길지 않다
  const gaps = fires.slice(1).map((t, i) => (t - fires[i]!) * DT);
  assert.ok(gaps.every((g) => g > st.cd - DT && g < st.cd + DT), `간격 ${[...new Set(gaps.map((g) => g.toFixed(2)))].join('/')}`);
});

test('쏠 적이 없어 기다리던 무기는 기다린 시간을 넘기지 않는다: 기다리다 쏘면 다음은 온전한 쿨다운 (몰아 쏘기 없음)', () => {
  const { w, p } = setup(204, { console_log: 1, mech_keyboard: 1 });
  const st = effectiveStats(p, 'console_log');
  // 1.104초 = 22.08틱: 기다린 몫을 넘기면 22틱, 넘기지 않으면 23틱 뒤에 다음 것을 쏜다
  assert.ok(Math.abs(st.cd - 1.104) < 1e-9);
  const target = enemy(9002, p.x + 60, p.y);
  // 처음 쏜 뒤 적을 치워서 쿨다운이 끝나고도 3초 동안 기다리게 한다
  tick(w, [target]);
  assert.ok(w.shots.length > 0, '얻자마자 쏜다');
  for (let i = 0; i < 20 * 5; i++) tick(w, []);
  assert.equal(p.cd.console_log, 0, '쏠 적이 없으면 0 에 머물러 기다린다');
  w.shots = [];
  tick(w, [target]);
  assert.ok(w.shots.length > 0, '적이 오면 바로 쏜다');
  assert.equal(p.cd.console_log, st.cd, '다음 쿨다운은 온전한 쿨다운');
  let gap = 0;
  for (; gap < 40; gap++) {
    w.shots = [];
    tick(w, [target]);
    if (w.shots.length > 0) break;
  }
  assert.equal(gap + 1, 23, '다음 것은 23틱 뒤 (쿨다운보다 이르지 않다)');
});

test('러버덕: 다시 켜지는 주기((쿨다운 + 지속) × 쿨다운 배율)가 틱 단위로 올림되지 않는다', () => {
  const period = (kb: number): number => {
    const { w, p } = setup(205, { rubber_duck: 1, ...(kb ? { mech_keyboard: kb } : {}) });
    let last = Infinity;
    const on = fireTicks(w, 20 * 120, () => [], () => {
      const cd = p.cd.rubber_duck ?? 0;
      const started = cd > last;
      last = cd;
      return started;
    });
    return meanGap(on);
  };
  // 쿨다운 2.5 + 지속 3: 키보드 0단계 5.5초, 1단계 5.06초 = 101.2틱 (올림하면 5.1초).
  // 쿨다운 3 이던 0.3.x 에는 6초였고, 그 전에는 소수 오차로 121틱 = 6.05초였다
  assert.ok(Math.abs(period(0) - 5.5) < 0.002, `0단계 ${period(0)}`);
  assert.ok(Math.abs(period(1) - 5.06) < 0.002, `1단계 ${period(1)}`);
});

test('커밋 히스토리: 움직이는 동안 남기는 간격(0.3초 ÷ 이동 속도 배율)이 틱 단위로 올림되지 않는다', () => {
  const gap = (coffee: number): number => {
    const { w, p } = setup(206, { commit_history: 1, ...(coffee ? { coffee } : {}) });
    setInput(w, p.id, 1, 0);
    const trails = fireTicks(w, 20 * 60, () => [], () => w.zones.some((z) => z.kind === 'trail' && z.owner === p.id && z.born === w.tick));
    return meanGap(trails);
  };
  // 아메리카노 없이 0.3초 (예전에는 소수 오차로 7틱 = 0.35초), 1단계 0.3 / 1.1 = 0.2727초 (예전에는 6틱 = 0.3초)
  assert.ok(Math.abs(gap(0) - 0.3) < 0.002, `아메리카노 0단계 ${gap(0).toFixed(4)}초`);
  assert.ok(Math.abs(gap(1) - 0.3 / 1.1) < 0.002, `아메리카노 1단계 ${gap(1).toFixed(4)}초`);
});

test('2단계 인증은 넘기지 않는다: 다시 채운 뒤의 쿨다운은 방패를 다 쓸 때까지 멈춰 있다가 온전하게 시작한다', () => {
  // 8 × 0.92 = 7.36초 = 147.2틱: 넘기면 채운 뒤 쿨다운이 7.35초가 된다
  const { w, p } = setup(207, { two_factor: 1, mech_keyboard: 1 });
  const st = effectiveStats(p, 'two_factor');
  assert.ok(Math.abs(st.cd - 7.36) < 1e-9);
  tick(w, []);
  assert.equal(p.charges, 1, '얻자마자 채운다');
  // 방패를 다 쓴 것으로 치고 다시 찰 때까지
  p.charges = 0;
  let n = 0;
  while (p.charges === 0 && n < 400) {
    tick(w, []);
    n++;
  }
  assert.equal(n, 148, '방패를 다 쓰고 148틱 뒤에 다시 찬다');
  assert.equal(p.cd.two_factor, st.cd, '다시 채운 뒤 쿨다운은 온전한 쿨다운');
  for (let i = 0; i < 100; i++) tick(w, []);
  assert.equal(p.cd.two_factor, st.cd, '방패가 남아 있는 동안은 멈춰 있다');
});

test('방화벽: 같은 적을 다시 태우는 간격(쿨다운)도 틱 단위로 올림되지 않고, 범위 밖에서 기다린 시간은 넘기지 않는다', () => {
  const { w, p } = setup(208, { firewall: 8, mech_keyboard: 1 });
  const st = effectiveStats(p, 'firewall');
  // 1.0 × 0.92 = 0.92초 (예전에는 19틱 = 0.95초)
  assert.ok(Math.abs(st.cd - 0.92) < 1e-9);
  const target = enemy(9003, p.x + 30, p.y);
  let hp = target.hp;
  const burnt = (): boolean => {
    const hurt = target.hp < hp;
    hp = target.hp;
    return hurt;
  };
  const burns = fireTicks(w, 20 * 200, () => [target], burnt);
  assert.ok(Math.abs(meanGap(burns) - st.cd) < 0.002, `평균 간격 ${meanGap(burns).toFixed(4)}초`);
  // 범위 밖으로 3초 보냈다가 돌아오면 바로 태우고, 다음은 온전한 쿨다운 뒤 (0.92초 = 18.4틱 → 19틱)
  target.x = p.x + 500;
  for (let i = 0; i < 60; i++) tick(w, [target]);
  target.x = p.x + 30;
  hp = target.hp;
  const back = fireTicks(w, 40, () => [target], burnt);
  assert.equal(back[0], 0, '돌아오자마자 태운다');
  assert.equal(back[1]! - back[0]!, 19, '기다린 시간을 넘기지 않는다');
});

test('키보드 고양이: 0.6초(12틱)마다 방향을 바꾼다 (예전에는 소수 오차로 13틱마다)', () => {
  const { w, p } = setup(209, { keyboard_cat: 1 });
  tick(w, []);
  const cat = w.shots.find((s) => s.kind === 'cat');
  assert.ok(cat, '얻자마자 풀어 둔다');
  let dir = Math.atan2(cat.vy, cat.vx);
  const turns = fireTicks(w, 20 * 4, () => [], () => {
    const now = Math.atan2(cat.vy, cat.vx);
    const turned = now !== dir;
    dir = now;
    return turned;
  });
  const gaps = turns.slice(1).map((t, i) => t - turns[i]!);
  assert.ok(gaps.length >= 4, `${turns.length}번 바꿨다`);
  assert.deepEqual([...new Set(gaps)], [12], `간격(틱) ${gaps.join(', ')}`);
});
