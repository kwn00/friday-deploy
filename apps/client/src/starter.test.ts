import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_STARTER, STARTER_WEAPONS, UPGRADES } from '@friday-deploy/shared';
import { evolveHint } from './evolve';
import { STARTER_STORE, readStarter, rosterStarter, starterLine, starterOptions, starterTip } from './starter';

/** 화면에서 차지하는 폭의 어림 (한글 2칸, 이모지 2칸, 나머지 1칸) */
const cells = (s: string): number => Array.from(s.replace(/️/g, '')).reduce((n, ch) => n + (/[\p{Script=Hangul}\p{Extended_Pictographic}]/u.test(ch) ? 2 : 1), 0);

test('시작 무기 고르기: 후보마다 번호·아이콘·이름·짧은 설명이 있고, 통신 번호 순서다', () => {
  const opts = starterOptions();
  assert.deepEqual(
    opts.map((o) => [o.id, o.index]),
    STARTER_WEAPONS.map((id, i) => [id, i]),
  );
  for (const o of opts) {
    assert.equal(o.icon, UPGRADES[o.id].icon);
    assert.equal(o.name, UPGRADES[o.id].name);
    assert.equal(o.desc, UPGRADES[o.id].desc, '자세한 설명은 선택지 카드와 같은 문구');
    assert.ok(o.blurb.length > 0, `${o.id} 짧은 설명`);
    assert.equal(o.evolve, evolveHint(o.id, {}), '진화 안내는 레벨업 카드와 같은 규칙');
    const tip = starterTip(o).split('\n');
    assert.deepEqual(tip, [o.name, o.desc, ...(o.evolve ? [o.evolve] : [])], '마우스를 올렸을 때: 이름, 설명, (있으면) 진화');
  }
});

test('시작 무기 고르기: 고른 무기의 한 줄은 320px 화면에서도 한 줄이다 (Playwright 로 잰 가장 긴 줄의 폭 이하)', () => {
  // "🖨️ console.log() · 가장 가까운 버그를 쏜다" 가 320px 세로 화면에서 한 줄로 들어가는 것을 브라우저로 확인했다 (42칸)
  for (const id of STARTER_WEAPONS) {
    const line = starterLine(id);
    assert.ok(line.startsWith(`${UPGRADES[id].icon} ${UPGRADES[id].name} · `), line);
    assert.ok(cells(line) <= 42, `${line}: ${cells(line)}칸`);
  }
});

test('시작 무기 고르기: 브라우저가 기억한 값은 지금 후보일 때만 쓰고, 아니면 기본 무기 (예전 후보·손으로 고친 값·저장 못 하는 브라우저)', () => {
  assert.equal(STARTER_STORE, 'starter');
  for (const id of STARTER_WEAPONS) assert.equal(readStarter(id), id);
  for (const bad of [null, undefined, '', 'hotfix', 'debugger', 'coffee', '1', 'Rollback', ' rollback']) assert.equal(readStarter(bad), DEFAULT_STARTER, String(bad));
});

test('시작 무기 고르기: 대기실 사람 목록의 무기는 서버가 보낸 값이라도 지금 후보일 때만 아이콘으로 쓴다', () => {
  assert.deepEqual(rosterStarter('rollback'), { id: 'rollback', icon: UPGRADES.rollback.icon, name: UPGRADES.rollback.name });
  for (const bad of [undefined, null, 1, 'hotfix', 'friday_deploy', '<img src=x onerror=alert(1)>', { id: 'rollback' }]) assert.equal(rosterStarter(bad), null, String(bad));
});
