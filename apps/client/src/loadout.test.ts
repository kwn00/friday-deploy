import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EVOLUTIONS,
  PASSIVE_IDS,
  PLAYER_BASE_HP,
  PLAYER_BASE_PICKUP,
  UPGRADES,
  UPGRADE_IDS,
  WEAPON_IDS,
  cooldownMultOf,
  effectiveStats,
  extraOfferChanceOf,
  healAmountOf,
  luckOf,
  maxHpOf,
  moveSpeedOf,
  pickupOf,
  recoveryOf,
  upgradeText,
  type UpgradeId,
  type WeaponDef,
} from '@friday-deploy/shared';
import { effectText, loadoutOf, type LoadoutItem } from './loadout';

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
  for (let level = 1; level <= UPGRADES.deploy_prayer.max; level++) {
    const chance = extraOfferChanceOf({ up: { deploy_prayer: level } }) * 100;
    assert.ok(Math.abs(numberIn(value({ deploy_prayer: level }, 'deploy_prayer', '선택지 4개 나올 확률')) - chance) <= 0.5, `${level}`);
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

  // 모든 무기 · 여러 패시브 조합에서 피해 · 쿨다운 값이 effectiveStats 와 같다
  for (const passives of [{}, { stack_overflow: 3, mech_keyboard: 5 }, { stack_overflow: 5, mech_keyboard: 2, git_fork: 2 }] as Levels[]) {
    for (const id of WEAPON_IDS) {
      const def = UPGRADES[id] as WeaponDef;
      for (let level = 1; level <= def.max; level++) {
        const all = { ...passives, [id]: level };
        const s = effectiveStats({ up: all }, id);
        const dmg = value(all, id, def.labels?.dmg ?? '피해');
        if (dmg !== undefined) assert.ok(Math.abs(numberIn(dmg) - s.dmg) <= 0.05 + 1e-9, `${id} ${level}: 피해 ${dmg} ≠ ${s.dmg}`);
        else assert.ok(s.dmg === 0 || def.ignores?.includes('might'), `${id}: 피해 줄이 없다`);
        assert.ok(Math.abs(numberIn(value(all, id, def.labels?.cd ?? '쿨다운')) - s.cd) <= 0.005 + 1e-9, `${id} ${level}: 쿨다운`);
      }
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
