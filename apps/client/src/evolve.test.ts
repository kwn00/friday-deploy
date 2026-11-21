import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVOLUTIONS, UPGRADES, UPGRADE_IDS } from '@friday-deploy/shared';
import { evolveHint, readyMaterials } from './evolve';

test('진화 안내: 재료 무기·짝 패시브·합치기마다 알맞은 문구, 이미 진화했거나 재료가 아니면 없다', () => {
  assert.equal(evolveHint('console_log', {}), '✨ 진화: 최대 단계 + 🧪 테스트 커버리지 → 🐞 디버거');
  assert.equal(evolveHint('test_coverage', { console_log: 3 }), '✨ 진화: 🖨️ console.log() 최대 단계와 함께 → 🐞 디버거');
  assert.equal(evolveHint('canary', {}), '✨ 합치기: 🦉 야근 부엉이와 둘 다 최대 단계 → 🕐 24시간 모니터링');
  assert.equal(evolveHint('night_owl', {}), '✨ 합치기: 🐤 카나리아와 둘 다 최대 단계 → 🕐 24시간 모니터링');
  assert.equal(evolveHint('multicast', {}), '✨ 합치기: 📡 브로드캐스트와 둘 다 최대 단계 → 🌊 패킷 플러딩');
  assert.equal(evolveHint('prod_hotfix', {}), '✨ 진화: 💧 핫픽스 최대 단계와 함께 → 🔥 금요일 배포');
  assert.equal(evolveHint('regex', {}), null, '진화가 없는 무기');
  assert.equal(evolveHint('coffee', {}), null, '짝이 아닌 패시브');
  assert.equal(evolveHint('test_coverage', { debugger: 1 }), null, '이미 진화했으면 알리지 않는다');
});

test('진화 안내: 짝이 있는 모든 것에 문구가 있고, 휴대폰 선택지 카드에 들어갈 만큼 짧다', () => {
  const used = new Set(EVOLUTIONS.flatMap((e) => [...e.from, ...(e.with ? [e.with] : [])]));
  for (const id of UPGRADE_IDS) {
    const hint = evolveHint(id, {});
    assert.equal(hint !== null, used.has(id), `${id}: ${hint}`);
    if (hint) assert.ok(hint.length <= 60, `${id} "${hint}" (${hint.length}자)`);
  }
  // 진화한 무기 자체는 선택지에 나오지 않으므로 안내도 없다
  for (const e of EVOLUTIONS) assert.equal(evolveHint(e.id, {}), null, UPGRADES[e.id].name);
});

test('진화 안내: 다음 보물상자에서 바뀔 재료 무기 (칸에 표시)', () => {
  assert.deepEqual([...readyMaterials({ console_log: 8 })], [], '짝 패시브가 없다');
  assert.deepEqual([...readyMaterials({ console_log: 8, test_coverage: 1 })], ['console_log']);
  assert.deepEqual([...readyMaterials({ canary: 8, night_owl: 8, ping_pong: 8 })].sort(), ['canary', 'night_owl']);
  assert.deepEqual([...readyMaterials({ debugger: 1, test_coverage: 1 })], []);
});
