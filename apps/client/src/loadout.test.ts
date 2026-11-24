import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DT,
  EVOLUTIONS,
  PASSIVE_IDS,
  PLAYER_BASE_HP,
  PLAYER_BASE_PICKUP,
  UPGRADES,
  UPGRADE_IDS,
  WEAPON_IDS,
  SPRINT_BONUS_PER_LEVEL,
  addPlayer,
  amountBonusOf,
  areaMultOf,
  armorOf,
  cooldownMultOf,
  createWorld,
  curseOf,
  durationMultOf,
  effectiveStats,
  extraOfferChanceOf,
  growthOf,
  healAmountOf,
  luckOf,
  maxHpOf,
  mightOf,
  moveSpeedOf,
  pickupOf,
  recoveryOf,
  speedMultOf,
  step,
  upgradeText,
  weaponStats,
  type UpgradeId,
  type WeaponDef,
} from '@friday-deploy/shared';
import { duckCycleOf, effectText, loadoutOf, type LoadoutItem } from './loadout';

type Levels = Partial<Record<UpgradeId, number>>;

/** 가진 것 하나의 줄 */
function itemOf(up: Levels, id: UpgradeId, revives = 0): LoadoutItem {
  const all = loadoutOf(up, revives).groups.flatMap((g) => g.items);
  const it = all.find((x) => x.id === id);
  assert.ok(it, `${id} 가 목록에 없다`);
  return it;
}
/** 지금 효과를 "이름 값" 글로 */
const nowText = (up: Levels, id: UpgradeId, revives = 0): string[] => itemOf(up, id, revives).now.map(effectText);
/** 이름이 label 인 효과의 값 */
function value(up: Levels, id: UpgradeId, label: string): string | undefined {
  return itemOf(up, id).now.find((e) => e.label === label)?.value;
}
/** "+30%", "×2.49", "-2", "1.01초" 의 숫자 */
const numberIn = (v: string | undefined): number => {
  const m = /-?\d+(?:\.\d+)?/.exec(v ?? '');
  assert.ok(m, `숫자가 없다: ${v}`);
  return Number(m[0]);
};

test('가진 아이템: 패시브의 지금 효과는 그 패시브 단계까지 합친 것 (요청의 예와 같다)', () => {
  assert.deepEqual(nowText({ coffee: 3 }, 'coffee'), ['이동 속도 +30%']);
  assert.deepEqual(nowText({ mech_keyboard: 2 }, 'mech_keyboard'), ['쿨다운 -16%']);
  assert.deepEqual(nowText({ npm_install: 3 }, 'npm_install'), ['끌어당기는 범위 ×2.49'], '곱해지는 것은 곱으로');
  assert.deepEqual(nowText({ dark_mode: 3 }, 'dark_mode'), ['최대 체력 ×1.73'], '곱해지는 것은 곱으로');
  assert.deepEqual(nowText({ test_coverage: 2 }, 'test_coverage'), ['한 대 맞을 때 피해 -2']);
  assert.deepEqual(nowText({ work_life: 3 }, 'work_life'), ['1초에 체력 +0.6', '회복 아이템 30 → 48']);
  assert.deepEqual(nowText({ deploy_prayer: 3 }, 'deploy_prayer'), ['운 +30%', '선택지 4개 나올 확률 23%']);
  assert.deepEqual(nowText({ git_fork: 2 }, 'git_fork'), ['개수 +2']);
  assert.deepEqual(nowText({ stack_overflow: 5 }, 'stack_overflow'), ['피해량 +50%']);
  assert.deepEqual(nowText({ snapshot: 1 }, 'snapshot', 2), ['남은 부활(백업 포함) 2번']);
});

test('가진 아이템: 패시브의 지금 효과가 모든 단계에서 서버 시뮬레이션의 함수 값과 같다 (반올림만 다르다)', () => {
  const none = { up: {} };
  for (const [id, label, f, kind] of [
    ['coffee', '이동 속도', moveSpeedOf, 'pct'],
    ['mech_keyboard', '쿨다운', cooldownMultOf, 'pct'],
    ['npm_install', '끌어당기는 범위', pickupOf, 'times'],
    ['dark_mode', '최대 체력', maxHpOf, 'times'],
    ['deploy_prayer', '운', luckOf, 'pct'],
    ['dual_monitor', '공격 범위', areaMultOf, 'pct'],
    ['cdn', '속도', speedMultOf, 'pct'],
    ['keep_alive', '지속 시간', durationMultOf, 'pct'],
    ['side_project', '얻는 경험치', growthOf, 'pct'],
    ['prod_hotfix', '버그 체력·속도·수·빈도', curseOf, 'pct'],
    ['stack_overflow', '피해량', mightOf, 'pct'],
  ] as const) {
    for (let level = 1; level <= UPGRADES[id].max; level++) {
      const only = { up: { [id]: level } };
      const ratio = f(only) / f(none);
      const shown = numberIn(value({ [id]: level }, id, label));
      if (kind === 'times') assert.ok(Math.abs(shown - ratio) <= 0.005, `${id} ${level}: ×${shown} ≠ ${ratio}`);
      else assert.ok(Math.abs(shown - (ratio - 1) * 100) <= 0.5, `${id} ${level}: ${shown}% ≠ ${(ratio - 1) * 100}`);
    }
  }
  // 곱해지는 것: 마지막 단계의 값이 그대로 곱이다 (더하기로 계산하면 이 값이 나오지 않는다)
  assert.equal(value({ npm_install: 5 }, 'npm_install', '끌어당기는 범위'), `×${Math.round((pickupOf({ up: { npm_install: 5 } }) / PLAYER_BASE_PICKUP) * 100) / 100}`);
  assert.equal(value({ dark_mode: 5 }, 'dark_mode', '최대 체력'), `×${Math.round((maxHpOf({ up: { dark_mode: 5 } }) / PLAYER_BASE_HP) * 100) / 100}`);
  for (let level = 1; level <= UPGRADES.work_life.max; level++) {
    const only = { up: { work_life: level } };
    assert.ok(Math.abs(numberIn(value({ work_life: level }, 'work_life', '1초에 체력')) - recoveryOf(only)) < 1e-9);
    assert.equal(value({ work_life: level }, 'work_life', '회복 아이템'), `${healAmountOf(none)} → ${Math.round(healAmountOf(only) * 100) / 100}`);
  }
  // 더해지는 것: 테스트 커버리지(한 대 맞을 때 피해를 덜 받는다), git fork(개수)
  for (const [id, label, f, sign] of [
    ['test_coverage', '한 대 맞을 때 피해', armorOf, -1],
    ['git_fork', '개수', amountBonusOf, 1],
  ] as const) {
    for (let level = 1; level <= UPGRADES[id].max; level++) {
      const added = f({ up: { [id]: level } }) - f(none);
      assert.ok(added !== 0, `${id} ${level}: 효과가 없다`);
      assert.ok(Math.abs(numberIn(value({ [id]: level }, id, label)) - sign * added) < 1e-9, `${id} ${level}`);
    }
  }
  for (let level = 1; level <= UPGRADES.deploy_prayer.max; level++) {
    const chance = extraOfferChanceOf({ up: { deploy_prayer: level } }) * 100;
    assert.ok(Math.abs(numberIn(value({ deploy_prayer: level }, 'deploy_prayer', '선택지 4개 나올 확률')) - chance) <= 0.5, `${level}`);
  }
  // 스냅샷은 stats.ts 의 함수가 아니라 서버가 보낸 남은 부활 수를 그대로 보여 준다 (단계와 상관없이)
  for (let level = 1; level <= UPGRADES.snapshot.max; level++) {
    for (const revives of [0, 1, 3]) assert.deepEqual(nowText({ snapshot: level }, 'snapshot', revives), [`남은 부활(백업 포함) ${revives}번`]);
  }
  // 패시브의 효과는 그 패시브 하나만의 것이다: 다른 패시브가 있어도 바뀌지 않는다
  assert.deepEqual(nowText({ coffee: 2, mech_keyboard: 5, dark_mode: 5 }, 'coffee'), nowText({ coffee: 2 }, 'coffee'));
});

test('가진 아이템: 무기의 지금 수치는 패시브까지 적용한 effectiveStats 그대로다', () => {
  const up: Levels = { console_log: 1, stack_overflow: 2 };
  assert.equal(effectiveStats({ up }, 'console_log').dmg, 12);
  assert.equal(value(up, 'console_log', '피해'), '12', 'Stack Overflow 2 → 피해 ×1.2');
  assert.equal(value({ console_log: 1 }, 'console_log', '피해'), '10');
  // 기계식 키보드 → 쿨다운
  const cd = effectiveStats({ up: { console_log: 3, mech_keyboard: 2 } }, 'console_log').cd;
  assert.equal(value({ console_log: 3, mech_keyboard: 2 }, 'console_log', '쿨다운'), `${Math.round(cd * 100) / 100}초`);
  assert.equal(value({ console_log: 3, mech_keyboard: 2 }, 'console_log', '쿨다운'), '0.84초');
  // git fork → 개수. 개수를 받지 않는 무기(방화벽, 무한 스크롤)는 늘지 않고 줄도 없다
  assert.equal(value({ console_log: 1, git_fork: 2 }, 'console_log', '개수'), '3');
  assert.equal(value({ firewall: 1, git_fork: 2 }, 'firewall', '개수'), undefined);
  assert.equal(value({ infinite_scroll: 1, git_fork: 2 }, 'infinite_scroll', '개수'), undefined);
  // 2단계 인증은 개수(방패)·지속(무적)을 패시브로 받지 않지만, 이름을 붙인 그 값은 보여 준다
  assert.equal(value({ two_factor: 1, git_fork: 2, keep_alive: 5 }, 'two_factor', '방패'), '1');
  assert.equal(value({ two_factor: 7 }, 'two_factor', '방패'), String(effectiveStats({ up: { two_factor: 7 } }, 'two_factor').amount));
  assert.equal(value({ two_factor: 1, keep_alive: 5 }, 'two_factor', '무적'), '0.24초');
  assert.equal(value({ two_factor: 1 }, 'two_factor', '피해'), undefined, '피해가 0 인 무기');
  // 듀얼 모니터 → 범위 (1단계·패시브 없음 대비). 범위를 받지 않는 무기(코드 프리즈)는 줄이 없다
  assert.equal(value({ console_log: 1 }, 'console_log', '범위'), undefined, '늘지 않았으면 없다');
  assert.equal(value({ console_log: 1, dual_monitor: 2 }, 'console_log', '범위'), '+20%');
  assert.equal(value({ hot_reload: 3 }, 'hot_reload', '범위'), '+100%', '단계로 늘어난 범위');
  assert.equal(value({ code_freeze: 1, dual_monitor: 5 }, 'code_freeze', '범위'), undefined);
  // keep-alive → 지속. 지속을 받지 않는 무기(console.log)는 줄이 없다
  assert.equal(value({ hotfix: 1, keep_alive: 2 }, 'hotfix', '지속'), '2.4초');
  assert.equal(value({ console_log: 1, keep_alive: 2 }, 'console_log', '지속'), undefined);
  // 관통 999 는 무한, 0 이면 줄이 없다
  assert.equal(value({ rollback: 1 }, 'rollback', '관통'), '무한');
  assert.equal(value({ brick_book: 1 }, 'brick_book', '관통'), '2');
  assert.equal(value({ console_log: 1 }, 'console_log', '관통'), undefined);
  // 이름을 바꿔 부르는 확률 (git clean: 운이 곱해진다). 늘 걸리는 확률(rm -rf node_modules)은 없다
  assert.equal(value({ git_clean: 1, deploy_prayer: 5 }, 'git_clean', '아이템과 경험치를 남길 확률'), '15%');
  assert.equal(value({ rm_rf: 1, deploy_prayer: 5 }, 'rm_rf', '확률'), undefined);
  // 치명타: 확률에 운이 곱해진다
  assert.equal(value({ sprint: 1 }, 'sprint', '치명타'), '5% ×2');
  assert.equal(value({ sprint: 1, deploy_prayer: 3 }, 'sprint', '치명타'), '6.5% ×2');

  // 스프린트: 걸으면 더해지는 피해의 상한 (단계 × 5). 지속은 베는 모습에만 쓰여 줄이 없다
  assert.equal(value({ sprint: 1 }, 'sprint', '걸으면 피해'), `최대 +${SPRINT_BONUS_PER_LEVEL}`);
  assert.equal(value({ sprint: 8, stack_overflow: 5 }, 'sprint', '걸으면 피해'), '최대 +40', 'Stack Overflow 는 붙지 않는다');
  assert.equal(value({ sprint: 1, keep_alive: 5 }, 'sprint', '지속'), undefined);
  assert.equal(value({ console_log: 1 }, 'console_log', '걸으면 피해'), undefined);

  // 모든 무기 · 여러 패시브 조합에서 모든 줄의 값이 effectiveStats 와 같다
  for (const passives of [
    {},
    { stack_overflow: 3, mech_keyboard: 5 },
    { stack_overflow: 5, mech_keyboard: 2, git_fork: 2 },
    { dual_monitor: 3, cdn: 4, keep_alive: 2, deploy_prayer: 4 },
    Object.fromEntries(PASSIVE_IDS.map((id) => [id, UPGRADES[id].max])),
  ] as Levels[]) {
    for (const id of WEAPON_IDS) {
      const def = UPGRADES[id] as WeaponDef;
      for (let level = 1; level <= def.max; level++) {
        const all = { ...passives, [id]: level };
        const s = effectiveStats({ up: all }, id);
        const dmg = value(all, id, def.labels?.dmg ?? '피해');
        if (dmg !== undefined) assert.ok(Math.abs(numberIn(dmg) - s.dmg) <= 0.05 + 1e-9, `${id} ${level}: 피해 ${dmg} ≠ ${s.dmg}`);
        else assert.ok(s.dmg === 0 || def.ignores?.includes('might'), `${id}: 피해 줄이 없다`);
        // 러버덕은 쿨다운을 그대로 쓰지 않아 쿨다운 줄이 없다 (아래 러버덕 테스트가 지속·쉬는 시간을 판과 비교한다)
        if (id === 'rubber_duck') assert.equal(value(all, id, '쿨다운'), undefined, `${id} ${level}: 쿨다운 줄`);
        else assert.ok(Math.abs(numberIn(value(all, id, def.labels?.cd ?? '쿨다운')) - s.cd) <= 0.005 + 1e-9, `${id} ${level}: 쿨다운`);
        const at = `${id} ${level} ${JSON.stringify(passives)}`;
        /** 무기가 받지 않는 패시브의 능력치는 이름을 따로 붙였을 때만 보인다 */
        const shown = (k: 'amount' | 'area' | 'speed' | 'dur', kind: 'amount' | 'area' | 'speed' | 'dur'): boolean =>
          !def.ignores?.includes(kind) || def.labels?.[k] !== undefined;
        // 개수
        const amount = value(all, id, def.labels?.amount ?? '개수');
        if (shown('amount', 'amount') && s.amount > 0) assert.equal(numberIn(amount), s.amount, `${at}: 개수`);
        else assert.equal(amount, undefined, `${at}: 개수 줄`);
        // 범위 · 속도: 그 무기 1단계 · 패시브 없음 대비, 늘지 않았으면 줄이 없다
        const first = weaponStats(id, 1);
        for (const [k, label] of [
          ['area', '범위'],
          ['speed', '속도'],
        ] as const) {
          const v = value(all, id, def.labels?.[k] ?? label);
          const d = first[k] > 0 ? (s[k] / first[k] - 1) * 100 : 0;
          if (shown(k, k) && first[k] > 0 && Math.abs(d) >= 0.05) assert.ok(Math.abs(numberIn(v) - d) <= 0.5 + 1e-9, `${at}: ${label} ${v} ≠ ${d}%`);
          else assert.equal(v, undefined, `${at}: ${label} 줄`);
        }
        // 지속 (러버덕은 위 테스트가 따로 본다)
        if (id !== 'rubber_duck') {
          const dur = value(all, id, def.labels?.dur ?? '지속');
          if (shown('dur', 'dur') && s.dur > 0) assert.ok(Math.abs(numberIn(dur) - s.dur) <= 0.005 + 1e-9, `${at}: 지속 ${dur} ≠ ${s.dur}`);
          else assert.equal(dur, undefined, `${at}: 지속 줄`);
        }
        // 관통 (999 는 무한)
        const pierce = value(all, id, def.labels?.pierce ?? '관통');
        if (s.pierce >= 999) assert.equal(pierce, '무한', `${at}: 관통`);
        else if (s.pierce > 0) assert.equal(numberIn(pierce), s.pierce, `${at}: 관통`);
        else assert.equal(pierce, undefined, `${at}: 관통 줄`);
        // 확률 (운 반영, 100% 에서 자른다). 늘 걸리는 확률은 줄이 없다
        const chance = value(all, id, def.labels?.chance ?? '확률');
        if (s.chance > 0 && def.base.chance < 1) assert.ok(Math.abs(numberIn(chance) - Math.min(1, s.chance) * 100) <= 0.5 + 1e-9, `${at}: 확률 ${chance}`);
        else assert.equal(chance, undefined, `${at}: 확률 줄`);
      }
    }
  }
});

test('가진 아이템: 러버덕은 쿨다운 대신 지속과 쉬는 시간 (다시 나오는 주기 = (쿨다운 + 지속) × 쿨다운 배율)', () => {
  assert.deepEqual(nowText({ rubber_duck: 1 }, 'rubber_duck'), ['피해 10', '개수 1', '지속 3초', '쉬는 시간 3초']);
  // 기계식 키보드는 주기를 줄인다: (3 + 3) × 0.92 = 5.52초 → 3초 돌고 2.52초 쉰다 (쿨다운 3 × 0.92 = 2.76초가 아니다)
  assert.equal(value({ rubber_duck: 1, mech_keyboard: 1 }, 'rubber_duck', '쉬는 시간'), '2.52초');
  assert.equal(value({ rubber_duck: 1, mech_keyboard: 5 }, 'rubber_duck', '쉬는 시간'), '0.6초');
  // keep-alive 는 도는 시간만 늘린다 (주기는 그대로 6초)
  assert.equal(value({ rubber_duck: 1, keep_alive: 5 }, 'rubber_duck', '지속'), '4.5초');
  assert.equal(value({ rubber_duck: 1, keep_alive: 5 }, 'rubber_duck', '쉬는 시간'), '1.5초');
  // 둘 다 최대면 주기 3.6초 < 도는 시간 4.5초: 쉬지 않는다
  assert.equal(value({ rubber_duck: 1, mech_keyboard: 5, keep_alive: 5 }, 'rubber_duck', '쉬는 시간'), '없음 (계속 돌아요)');
  assert.deepEqual(duckCycleOf({ rubber_duck: 8 }), { on: 4, period: 7 }, '8단계: 지속 3 + 0.5 + 0.5');
});

/** 실제 판에서 잰 러버덕: 도는 구간·쉬는 구간의 평균 길이와 다시 나오는 평균 주기 (초). 첫 구간과 마지막 구간은 잘렸을 수 있어 뺀다 */
function measureDuck(up: Levels, seconds: number): { on: number[]; rest: number[]; period: number; cycles: number } {
  const w = createWorld(311);
  const p = addPlayer(w, 'a');
  // 스폰·아이템·레벨업이 끼어들지 않게 (cooldown.test.ts 와 같은 차림)
  p.xpNext = 1e12;
  p.shield = 1e9;
  w.itemCd = 1e9;
  p.up = { ...up };
  const states: boolean[] = [];
  const starts: number[] = [];
  let last = Infinity;
  for (let i = 0; i < seconds / DT; i++) {
    w.enemies = [];
    w.wave = Math.floor((w.time + DT) / 60);
    w.spawnCd = 1e9;
    step(w, DT);
    // 오리가 도는지는 시뮬레이션의 duckOn 그대로 (duckState 도 이것으로 정한다)
    states.push(p.duckOn > 0);
    // 다시 켜진 틱: 주기 타이머가 다시 채워졌다
    const cd = p.cd.rubber_duck ?? 0;
    if (cd > last) starts.push(i);
    last = cd;
  }
  const runs: { on: boolean; len: number }[] = [];
  for (const s of states) {
    const r = runs.at(-1);
    if (r && r.on === s) r.len++;
    else runs.push({ on: s, len: 1 });
  }
  const inner = runs.slice(1, -1);
  return {
    on: inner.filter((r) => r.on).map((r) => r.len * DT),
    rest: inner.filter((r) => !r.on).map((r) => r.len * DT),
    period: ((starts.at(-1)! - starts[0]!) / (starts.length - 1)) * DT,
    cycles: starts.length - 1,
  };
}

test('가진 아이템: 러버덕의 지속·쉬는 시간이 실제 판(runDucks)에서 잰 것과 같다', () => {
  const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
  for (const passives of [
    {},
    { mech_keyboard: 1 },
    { mech_keyboard: 3 },
    { mech_keyboard: 5 },
    { keep_alive: 2 },
    { keep_alive: 5 },
    { mech_keyboard: 2, keep_alive: 3 },
    { mech_keyboard: 5, keep_alive: 5 },
  ] as Levels[]) {
    for (let level = 1; level <= UPGRADES.rubber_duck.max; level++) {
      const up = { ...passives, rubber_duck: level };
      const at = `${JSON.stringify(up)}`;
      const { on, period } = duckCycleOf(up);
      const m = measureDuck(up, 80);
      // 다시 나오는 주기는 틱 단위로 올림되지 않는다 (cooldown.test.ts): 넘친 몫을 넘기므로 처음과 마지막 사이가
      // 주기 × 횟수와 한 틱 안쪽으로 같다 (평균은 한 틱 ÷ 횟수 안쪽)
      assert.ok(m.cycles >= 10, `${at}: 주기 ${m.cycles}번`);
      assert.ok(Math.abs(m.period - period) <= DT / m.cycles + 1e-9, `${at}: 주기 ${m.period} ≠ ${period}`);
      const shownOn = numberIn(value(up, 'rubber_duck', '지속'));
      assert.ok(Math.abs(shownOn - on) <= 0.005 + 1e-9, `${at}: 지속 ${shownOn} ≠ ${on}`);
      const rest = value(up, 'rubber_duck', '쉬는 시간');
      if (m.rest.length === 0) {
        // 한 번 켜진 뒤로 한 틱도 쉬지 않았다
        assert.equal(rest, '없음 (계속 돌아요)', `${at}: 판에서는 쉬지 않는다`);
        assert.equal(m.on.length, 0, `${at}: 도는 구간이 끊기지 않는다`);
        continue;
      }
      assert.ok(m.rest.length >= 5, `${at}: 쉬는 구간 ${m.rest.length}개`);
      // 한 번의 도는·쉬는 구간은 틱(0.05초) 단위로 재므로 한 틱까지 어긋날 수 있다
      assert.ok(Math.abs(mean(m.on) - shownOn) <= DT + 0.005, `${at}: 판의 지속 ${mean(m.on)} ≠ 화면 ${shownOn}`);
      assert.ok(Math.abs(mean(m.rest) - numberIn(rest)) <= DT + 0.005, `${at}: 판의 쉬는 시간 ${mean(m.rest)} ≠ 화면 ${rest}`);
    }
  }
});

test('가진 아이템: 단계 표시, 다음 단계, 최대 단계, 진화', () => {
  const it = itemOf({ console_log: 3 }, 'console_log');
  assert.equal(it.tag, 'Lv.3/8');
  assert.equal(it.badge, null);
  assert.deepEqual(it.next, { tag: '다음 Lv.4', text: upgradeText('console_log', 4) }, '레벨업 카드와 같은 문구');
  assert.equal(it.desc, UPGRADES.console_log.desc);
  assert.equal(it.kind, 'weapon');

  // 최대 단계: "최대" 표시가 있고 다음 단계 줄이 없다
  const max = itemOf({ console_log: 8 }, 'console_log');
  assert.equal(max.tag, 'Lv.8/8');
  assert.equal(max.badge, '최대');
  assert.equal(max.next, null);
  assert.equal(itemOf({ git_fork: 2 }, 'git_fork').next, null, '패시브 최대 단계');
  assert.deepEqual(itemOf({ coffee: 1 }, 'coffee').next, { tag: '다음 Lv.2', text: '이동 속도 +10%' });

  // 진화 준비: 최대 단계 + 짝 패시브 → 노란 표시와 안내
  const ready = itemOf({ console_log: 8, test_coverage: 1 }, 'console_log');
  assert.equal(ready.ready, true);
  assert.equal(ready.evo[0]?.tone, 'ready');
  assert.match(ready.evo[0]!.text, /보물상자/);
  assert.deepEqual(ready.evo[1], { tone: 'hint', text: '✨ 진화: 최대 단계 + 🧪 테스트 커버리지 → 🐞 디버거' });
  assert.equal(itemOf({ console_log: 8 }, 'console_log').ready, false, '짝 패시브가 없다');
  assert.equal(itemOf({ console_log: 7, test_coverage: 1 }, 'console_log').ready, false, '최대 단계가 아니다');
  // 짝 패시브 쪽은 짝 안내만 (보물상자 표시는 바뀔 무기에)
  const pair = itemOf({ console_log: 8, test_coverage: 1 }, 'test_coverage');
  assert.equal(pair.ready, false);
  assert.deepEqual(pair.evo, [{ tone: 'hint', text: '✨ 진화: 🖨️ console.log() 최대 단계와 함께 → 🐞 디버거' }]);
  // 합치기: 둘 다 최대면 둘 다 표시
  const merge = loadoutOf({ canary: 8, night_owl: 8 }, 0).groups[0].items;
  assert.deepEqual(merge.map((x) => x.ready), [true, true]);
  assert.equal(itemOf({ regex: 3 }, 'regex').evo.length, 0, '진화가 없는 무기');

  // 진화한 무기: 단계 대신 ★, 재료, 다음 단계 없음
  const evolved = itemOf({ debugger: 1, test_coverage: 2 }, 'debugger');
  assert.equal(evolved.tag, '★ 진화');
  assert.equal(evolved.evolved, true);
  assert.equal(evolved.badge, null);
  assert.equal(evolved.next, null);
  assert.deepEqual(evolved.evo, [{ tone: 'from', text: '재료: 🖨️ console.log() + 🧪 테스트 커버리지' }]);
  assert.deepEqual(itemOf({ monitoring: 1 }, 'monitoring').evo, [{ tone: 'from', text: '재료: 🐤 카나리아 + 🦉 야근 부엉이' }]);
  // 진화한 뒤에는 짝 패시브에 안내가 없다
  assert.deepEqual(itemOf({ debugger: 1, test_coverage: 2 }, 'test_coverage').evo, []);
  for (const e of EVOLUTIONS) {
    const x = itemOf({ [e.id]: 1 }, e.id);
    assert.equal(x.tag, '★ 진화', e.id);
    assert.equal(x.evo[0]?.tone, 'from', e.id);
  }
});

test('가진 아이템: 무기 묶음 먼저, 각각 게임 화면의 칩과 같은 순서 (UPGRADE_IDS), 백업 수', () => {
  const up: Levels = { snapshot: 1, coffee: 2, rollback: 1, console_log: 4, dark_mode: 1, ping_pong: 2 };
  const lo = loadoutOf(up, 2);
  assert.deepEqual(
    lo.groups.map((g) => g.kind),
    ['weapon', 'passive'],
  );
  assert.deepEqual(
    lo.groups[0].items.map((x) => x.id),
    ['console_log', 'rollback', 'ping_pong'],
  );
  assert.deepEqual(
    lo.groups[1].items.map((x) => x.id),
    ['coffee', 'dark_mode', 'snapshot'],
  );
  const order = lo.groups.flatMap((g) => g.items.map((x) => UPGRADE_IDS.indexOf(x.id)));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(lo.groups[0].title, '무기 3/6');
  assert.equal(lo.groups[1].title, '패시브 3/6');
  assert.equal(lo.revives, '💾 되살아날 수 있는 횟수 2번 (백업·스냅샷)');
  assert.equal(loadoutOf(up, 0).revives, null, '부활이 없으면 줄이 없다 (게임 화면의 칩과 같다)');
  // 단계 0 이하·모르는 값은 가진 것이 아니다
  assert.deepEqual(
    loadoutOf({ console_log: 0, coffee: -1 }, 0).groups.map((g) => g.items.length),
    [0, 0],
  );
});

test('가진 아이템: 아무것도 없을 때의 문구', () => {
  const lo = loadoutOf({}, 0);
  assert.deepEqual(
    lo.groups.map((g) => [g.title, g.items.length, g.empty]),
    [
      ['무기 0/6', 0, '아직 가진 무기가 없어요.'],
      ['패시브 0/6', 0, '아직 가진 패시브가 없어요. 레벨업할 때 고를 수 있어요.'],
    ],
  );
  assert.equal(lo.revives, null);
});

test('가진 아이템: 모든 아이템 × 모든 단계에서 문구에 NaN·undefined·Infinity 가 없다', () => {
  const bad = /NaN|undefined|Infinity|null|\[object/;
  const allPassivesMax: Levels = Object.fromEntries(PASSIVE_IDS.map((id) => [id, UPGRADES[id].max]));
  for (const extra of [{}, allPassivesMax] as Levels[]) {
    for (const id of UPGRADE_IDS) {
      for (let level = 1; level <= UPGRADES[id].max; level++) {
        const up = { ...extra, [id]: level };
        const lo = loadoutOf(up, 3);
        const texts = [
          lo.revives ?? '',
          ...lo.groups.flatMap((g) => [
            g.title,
            g.empty,
            ...g.items.flatMap((x) => [x.icon, x.name, x.tag, x.badge ?? '', x.desc, ...x.now.map(effectText), x.next?.tag ?? '', x.next?.text ?? '', ...x.evo.map((e) => e.text)]),
          ]),
        ];
        for (const t of texts) assert.doesNotMatch(t, bad, `${id} ${level}: "${t}"`);
        const it = lo.groups.flatMap((g) => g.items).find((x) => x.id === id)!;
        assert.ok(it.now.length > 0, `${id} ${level}: 지금 효과가 하나도 없다`);
        // 확률은 100% 를 넘지 않는다 (운이 커도)
        for (const e of it.now) for (const m of e.value.matchAll(/([\d.]+)%/g)) if (!e.value.startsWith('+')) assert.ok(Number(m[1]) <= 100, `${id}: ${effectText(e)}`);
      }
    }
  }
});
