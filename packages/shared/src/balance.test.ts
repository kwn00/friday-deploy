/**
 * 0.4.0 밸런스 패치: 무기를 세게 하지 못하는 아이템과 약한 무기를 올린 것이 판(서버 시뮬레이션)에서 그대로 도는지.
 * 수치 표는 upgrades.test.ts 의 "우리 수치" 테스트가 본다. 여기서는 동작을 본다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DT,
  FREEZE_BEAM_WIDTH,
  PASSIVE_IDS,
  PASSIVE_SLOTS,
  PICK_ONCE,
  SUPPORT_PASSIVES,
  UPGRADES,
  WEAPON_IDS,
  WEAPON_SLOTS,
  addPlayer,
  createWorld,
  duckOffset,
  effectiveStats,
  evolutionOf,
  mightOf,
  pickOffer,
  setInput,
  step,
  supportMight,
  type Enemy,
  type Player,
  type UpgradeId,
  type World,
} from './index';

const enemy = (id: number, x: number, y: number, type: Enemy['type'] = 'merge_conflict', hp = 1e9): Enemy => ({ id, type, x, y, hp, spd: 1, frozen: 0, kbTaken: 1, resFreeze: 0, kbTime: 0, kbMult: 0, vx: 0, vy: 0, life: 0, hit: false });

/** 아무것도 저절로 생기지 않는 월드 (스폰·아이템·레벨업이 끼어들지 않게) */
function quietWorld(seed: number): { w: World; p: Player } {
  const w = createWorld(seed);
  const p = addPlayer(w, 'a');
  p.xpNext = 1e9;
  w.itemCd = 1e9;
  w.magnetCd = 1e9;
  return { w, p };
}
/** 스폰된 적은 치우고 놓아 둔 적만 남긴 채 한 틱 */
function tick(w: World, keep: Enemy[]): void {
  w.enemies = w.enemies.filter((e) => keep.includes(e));
  for (const e of keep) if (!w.enemies.includes(e) && e.hp > 0) w.enemies.push(e);
  w.wave = Math.floor((w.time + DT) / 60);
  w.spawnCd = 1e9;
  step(w, DT);
  w.enemies = w.enemies.filter((e) => keep.includes(e));
}

test('생존·편의 패시브 7종: 1단계 피해 +5%, 그 뒤 단계마다 +1% (모든 무기). 스냅샷·저주·무기를 세게 하는 패시브에는 없다', () => {
  assert.deepEqual([...SUPPORT_PASSIVES].sort(), ['coffee', 'dark_mode', 'deploy_prayer', 'npm_install', 'side_project', 'test_coverage', 'work_life']);
  assert.deepEqual([0, 1, 2, 5].map((l) => Math.round(supportMight(l) * 100)), [0, 5, 6, 9]);
  for (const id of PASSIVE_IDS) {
    const bonus = mightOf({ up: { [id]: 1 } }) - 1;
    if ((SUPPORT_PASSIVES as readonly string[]).includes(id)) assert.ok(Math.abs(bonus - 0.05) < 1e-9, `${id}: 1단계 +5%`);
    else if (id === 'stack_overflow') assert.ok(Math.abs(bonus - 0.1) < 1e-9);
    else assert.equal(bonus, 0, `${id}: 덤이 없다`);
  }
  // 6칸을 모두 최대 단계로 채우면 +54% (Stack Overflow 5단계 +50% 와 비슷)
  const six = Object.fromEntries(SUPPORT_PASSIVES.slice(0, 6).map((id) => [id, 5]));
  assert.ok(Math.abs(mightOf({ up: six }) - 1.54) < 1e-9);
  // 무기 피해에 곱해진다 (피해를 받는 무기만: git clean 은 그대로 0)
  assert.equal(effectiveStats({ up: { console_log: 1, coffee: 1 } }, 'console_log').dmg, 10.5);
  assert.equal(effectiveStats({ up: { git_clean: 1, coffee: 5 } }, 'git_clean').dmg, 0);
});

test('운영 서버 직접 수정(저주): 가진 뒤에는 레벨업 선택지와 보물상자에 나오지 않는다. 그것만 남으면 강화를 모두 마친 것으로 친다 (최대 단계는 그대로)', () => {
  assert.deepEqual(PICK_ONCE, ['prod_hotfix']);
  assert.equal(UPGRADES.prod_hotfix.max, 5, '최대 단계를 내리면 예전 기록의 아이콘이 사라진다 (ownedUpgrades)');
  const { w, p } = quietWorld(401);
  // 처음에는 나올 수 있다 (금요일 배포의 짝)
  let seen = false;
  for (let i = 0; i < 300 && !seen; i++) {
    p.up = { console_log: 1 };
    p.xp = p.xpNext = 5;
    w.gems.push({ id: w.nextId++, x: p.x, y: p.y, v: 1 });
    tick(w, []);
    seen = p.offers!.includes('prod_hotfix');
    p.offers = null;
  }
  assert.ok(seen, '가지기 전에는 선택지에 나온다');
  // 가진 뒤에는 가진 것을 먼저 넣는 굴림에도 나오지 않는다
  for (let i = 0; i < 200; i++) {
    p.up = { console_log: 1, prod_hotfix: 1 };
    p.xp = p.xpNext = 5;
    w.gems.push({ id: w.nextId++, x: p.x, y: p.y, v: 1 });
    tick(w, []);
    assert.ok(!p.offers!.includes('prod_hotfix'), `${i}: 가진 저주가 다시 나왔다`);
    p.offers = null;
  }
  // 칸을 모두 채우고 저주만 최대 단계 아래로 남긴다: 선택지 대신 체력을 가득 채운다 (강화를 모두 마쳤다)
  const weapons = WEAPON_IDS.filter((u) => !evolutionOf(u)).slice(0, WEAPON_SLOTS);
  const passives = [...PASSIVE_IDS.filter((u) => u !== 'prod_hotfix').slice(0, PASSIVE_SLOTS - 1), 'prod_hotfix' as const];
  const full = (): void => {
    p.up = {};
    for (const id of [...weapons, ...passives]) p.up[id] = UPGRADES[id].max;
    p.up.prod_hotfix = 1;
  };
  full();
  p.hp = 10;
  p.xp = p.xpNext = 5;
  w.gems.push({ id: w.nextId++, x: p.x, y: p.y, v: 1 });
  w.events.length = 0;
  tick(w, []);
  assert.equal(p.offers, null, '선택지가 뜨지 않는다');
  assert.ok(w.events.some((e) => e.type === 'refill'), '체력을 가득 채운다');
  // 보물상자도 저주를 올리지 않고 체력을 채운다
  full();
  p.hp = 10;
  w.items.push({ id: w.nextId++, kind: 'chest', x: p.x, y: p.y, ttl: Infinity, chest: [3, 0, 0, 0] });
  w.events.length = 0;
  tick(w, []);
  assert.equal(p.up.prod_hotfix, 1, '보물상자가 저주를 올리지 않는다');
  const chest = w.events.find((e) => e.type === 'chest');
  assert.ok(chest && chest.type === 'chest' && chest.items.length === 0 && chest.heal > 0, '대신 체력을 채운다');
});

test('2단계 인증: 방패가 한 대를 막으면 둘레(48)의 버그를 때리고(Stack Overflow 를 받는다) 밀쳐 낸다. 방패가 없으면 반격도 없다', () => {
  const { w, p } = quietWorld(402);
  p.up = { two_factor: 1, stack_overflow: 5 };
  tick(w, []);
  assert.equal(p.charges, 1);
  const hitter = enemy(9400, p.x + 3, p.y, 'merge_conflict');
  const near = enemy(9401, p.x - 40, p.y, 'bug');
  const far = enemy(9402, p.x - 80, p.y, 'bug');
  const all = [hitter, near, far];
  tick(w, all);
  assert.equal(p.charges, 0, '방패가 막았다');
  assert.equal(p.parry, false, '반격은 같은 틱에 끝났다');
  assert.equal(1e9 - hitter.hp, 15, '반격 피해 10 × Stack Overflow 1.5');
  assert.equal(1e9 - near.hp, 15, '둘레 48 안');
  assert.equal(far.hp, 1e9, '48 밖은 맞지 않는다');
  assert.ok(hitter.kbTime > 0 && near.kbTime > 0, '밀쳐 낸다');
  assert.ok(w.zones.some((z) => z.kind === 'blast' && z.owner === p.id && z.r === 48), '폭발로 보인다');
  // 방패가 없을 때 맞으면 반격하지 않는다
  const hp = [hitter.hp, near.hp];
  p.iframe = 0;
  for (let i = 0; i < 10; i++) {
    hitter.x = p.x + 3;
    hitter.y = p.y;
    tick(w, all);
  }
  assert.deepEqual([hitter.hp, near.hp], hp, '방패를 다 쓴 뒤에는 반격이 없다');
});

test('코드 프리즈: 광선(폭 16)에 맞은 버그는 조금 다치고 언다. 얼지 않는 적도 다친다', () => {
  assert.equal(FREEZE_BEAM_WIDTH, 16);
  const { w, p } = quietWorld(403);
  p.up = { code_freeze: 1 };
  // 처음 광선은 12시 다음 칸(1시)부터 시계 방향: 12방향 모두에 적을 둔다. 옆으로 7px 비켜 둔다 (폭 10 이면 맞지 않는 자리)
  const ring = Array.from({ length: 12 }, (_, k) => {
    const a = -Math.PI / 2 + (k * Math.PI) / 6;
    return enemy(9500 + k, p.x + Math.cos(a) * 60 - Math.sin(a) * 7, p.y + Math.sin(a) * 60 + Math.cos(a) * 7, k === 3 ? 'spaghetti' : 'bug');
  });
  for (let i = 0; i < 20 * 3; i++) {
    p.hp = 100;
    for (const e of ring) e.frozen = Math.min(e.frozen, 0.01);
    tick(w, ring);
  }
  const hurt = ring.filter((e) => e.hp < 1e9);
  assert.ok(hurt.length >= 2, `맞은 버그 ${hurt.length}마리`);
  for (const e of hurt) assert.equal((1e9 - e.hp) % 5, 0, '한 번에 5');
  // 스파게티 코드(빙결 저항 1.1)는 얼지 않지만 다친다
  const spaghetti = ring[3]!;
  for (let i = 0; i < 20 * 20 && spaghetti.hp === 1e9; i++) tick(w, ring);
  assert.ok(spaghetti.hp < 1e9, '얼지 않는 적도 다친다');
  assert.equal(spaghetti.frozen, 0);
});

test('정규표현식: 가장 가까운 버그 쪽으로 쏜다 (바라보는 쪽과 반대여도). 버그가 없으면 바라보는 쪽으로', () => {
  const { w, p } = quietWorld(404);
  p.up = { regex: 1 };
  // 오른쪽을 바라보는데 버그는 왼쪽에
  p.fx = 1;
  p.fy = 0;
  const left = enemy(9600, p.x - 100, p.y, 'bug');
  tick(w, [left]);
  const shot = w.shots.find((s) => s.kind === 'regex');
  assert.ok(shot, '쐈다');
  assert.ok(shot.vx < 0 && Math.abs(shot.vy) < 1e-9, '왼쪽으로');
  for (let i = 0; i < 20 && left.hp === 1e9; i++) tick(w, [left]);
  assert.ok(left.hp < 1e9, '맞혔다');
  // 버그가 없으면 바라보는 쪽으로 (예전처럼 쿨다운마다 쏜다)
  const { w: w2, p: p2 } = quietWorld(405);
  p2.up = { regex: 1 };
  p2.fx = 0;
  p2.fy = 1;
  tick(w2, []);
  const down = w2.shots.find((s) => s.kind === 'regex');
  assert.ok(down && down.vy > 0 && Math.abs(down.vx) < 1e-9, '바라보는 아래쪽으로');
});

test('스프린트: 홀수 번째 베기는 반대쪽을 벤다 (바라보는 쪽만 베지 않는다)', () => {
  const { w, p } = quietWorld(406);
  p.up = { sprint: 1 };
  p.face = 1;
  const front = enemy(9700, p.x + 30, p.y, 'bug');
  const back = enemy(9701, p.x - 30, p.y, 'bug');
  tick(w, [front, back]);
  assert.ok(front.hp < 1e9, '바라보는 쪽');
  assert.ok(back.hp < 1e9, '반대쪽');
  assert.ok(w.zones.some((z) => z.kind === 'slash' && z.x < p.x) && w.zones.some((z) => z.kind === 'slash' && z.x > p.x), '양쪽 베기가 보인다');
});

test('커밋 히스토리: 쿨다운은 날리기만 막는다. 날린 뒤 쿨다운 동안에도 걸으면 발자국이 남고, 쿨다운 중에 멈추면 날리지 않는다', () => {
  const { w, p } = quietWorld(407);
  p.up = { commit_history: 1 };
  const trails = (): number => w.zones.filter((z) => z.kind === 'trail' && z.owner === p.id && z.ttl > 0).length;
  setInput(w, p.id, 1, 0);
  for (let i = 0; i < 20; i++) tick(w, []);
  assert.ok(trails() >= 2, '걸으면 발자국');
  // 멈춘다: 날리고 쿨다운 6초
  setInput(w, p.id, 0, 0);
  tick(w, []);
  assert.ok(w.shots.some((s) => s.kind === 'drill'), '멈추면 날린다');
  assert.ok((p.cd.commit_history ?? 0) > 5.9);
  assert.equal(trails(), 0);
  // 쿨다운 중에 다시 걷는다: 발자국이 남는다 (예전에는 6초 동안 끊겼다)
  setInput(w, p.id, 1, 0);
  for (let i = 0; i < 20; i++) tick(w, []);
  assert.ok(trails() >= 2, `쿨다운 중에도 발자국 ${trails()}개`);
  // 쿨다운 중에 멈추면 날리지 않는다 (발자국은 땅에 남아 밟은 버그를 다치게 한다)
  w.shots = [];
  setInput(w, p.id, 0, 0);
  tick(w, []);
  assert.equal(w.shots.filter((s) => s.kind === 'drill').length, 0, '쿨다운 중에는 날리지 않는다');
  assert.ok(trails() >= 1, '발자국은 남는다');
  const bug = enemy(9800, w.zones.find((z) => z.kind === 'trail')!.x, w.zones.find((z) => z.kind === 'trail')!.y, 'bug');
  tick(w, [bug]);
  assert.ok(bug.hp < 1e9, '밟은 버그가 다친다');
  // 쿨다운이 끝난 뒤 걷다 멈추면 다시 날린다
  for (let i = 0; i < 20 * 6; i++) tick(w, []);
  setInput(w, p.id, 1, 0);
  for (let i = 0; i < 20; i++) tick(w, []);
  setInput(w, p.id, 0, 0);
  tick(w, []);
  assert.ok(w.shots.some((s) => s.kind === 'drill'), '쿨다운이 끝나면 다시 날린다');
});

test('커밋 히스토리: 한 사람의 발자국은 30 개까지. 넘으면 가장 오래된 것부터 지우고 화면에도 알린다 (함께 하기에서 영역 상한을 혼자 다 쓰지 않게)', () => {
  const { w, p } = quietWorld(412);
  p.up = { commit_history: 8, git_fork: 2, keep_alive: 5, mech_keyboard: 5, coffee: 5 };
  setInput(w, p.id, 1, 0);
  let most = 0;
  for (let i = 0; i < 20 * 5; i++) {
    tick(w, []);
    most = Math.max(most, w.zones.filter((z) => z.kind === 'trail' && z.owner === p.id && z.ttl > 0).length);
  }
  assert.equal(most, 30, '30 개에서 멈춘다 (이 빌드는 그냥 두면 80 개 넘게 쌓인다)');
  assert.ok(w.gone.length > 0, '지운 것은 화면에도 지우라고 알린다');
  const live = new Set(w.zones.map((z) => z.id));
  assert.ok(w.gone.every((g) => !live.has(g.id) || w.zones.find((z) => z.id === g.id)!.ttl <= 0), '알린 것은 서버에서도 없다');
});

test('러버덕: 둘 이상이면 하나 걸러 궤도 반경의 절반에서 돌아 몸에 붙은 적도 맞힌다 (서버와 화면이 같은 duckOffset)', () => {
  // 한 마리는 바깥 궤도 그대로
  assert.deepEqual(duckOffset(0, 0, 1, 40, 2), [40, 0]);
  const [x1, y1] = duckOffset(0, 1, 2, 40, 2);
  assert.ok(Math.abs(Math.hypot(x1, y1) - 20) < 1e-9, '두 번째 오리는 절반 궤도');
  const [x0, y0] = duckOffset(0, 0, 2, 40, 2);
  assert.ok(Math.abs(Math.hypot(x0, y0) - 40) < 1e-9, '첫 번째는 바깥 궤도');
  // 몸에 붙은 적(중심에서 12px): 오리 2마리(2단계)면 안쪽 오리가 맞힌다. 한 마리(1단계)는 못 맞힌다
  const touched = (level: number): boolean => {
    const { w, p } = quietWorld(408 + level);
    p.up = { rubber_duck: level };
    const ring = Array.from({ length: 8 }, (_, k) => enemy(9900 + k, p.x + Math.cos((k * Math.PI) / 4) * 12, p.y + Math.sin((k * Math.PI) / 4) * 12, 'bug'));
    for (let i = 0; i < 20 * 3; i++) {
      p.hp = 1e9;
      p.iframe = 1;
      ring.forEach((e, k) => {
        e.x = p.x + Math.cos((k * Math.PI) / 4) * 12;
        e.y = p.y + Math.sin((k * Math.PI) / 4) * 12;
      });
      tick(w, ring);
    }
    return ring.some((e) => e.hp < 1e9);
  };
  assert.equal(touched(1), false, '한 마리는 궤도 안쪽을 못 맞힌다');
  assert.equal(touched(2), true, '두 마리면 안쪽 오리가 맞힌다');
});

test('CDN: 스스로 겨누는 무기는 속도 배율만큼 더 멀리서 겨눈다. 화면의 가장 먼 모서리(296) 밖은 겨누지 않는다', () => {
  const fired = (up: Partial<Record<UpgradeId, number>>, dist: number): boolean => {
    const { w, p } = quietWorld(410);
    p.up = up;
    tick(w, [enemy(9950, p.x + dist, p.y, 'bug')]);
    return w.shots.length > 0;
  };
  assert.equal(fired({ console_log: 1 }, 250), false, 'CDN 없이는 200 까지');
  assert.equal(fired({ console_log: 1, cdn: 3 }, 250), true, 'CDN 3단계: 260 까지');
  assert.equal(fired({ console_log: 1, cdn: 5 }, 290), true, 'CDN 5단계: 300 이지만 296 에서 자른다');
  // 겨누는 거리는 적의 몸(버그 반경)이 걸치는지로 본다: 몸까지 296 밖인 적
  assert.equal(fired({ console_log: 1, cdn: 5 }, 315), false, '296 밖은 겨누지 않는다');
  assert.equal(fired({ ai_agent: 1, cdn: 5 }, 315), false, 'AI 에이전트(220 × 1.5 = 330)도 296 에서 자른다');
  assert.equal(fired({ ai_agent: 1, cdn: 4 }, 280), true, 'AI 에이전트 CDN 4단계: 308 → 296');
  assert.equal(fired({ logic_bomb: 1, cdn: 2 }, 230), true, '멀티스레드');
  assert.equal(fired({ logic_bomb: 1 }, 230), false);
});

test('배포 기도·다크 모드는 고르는 순간 보이는 효과가 있다 (새로고침 +1, 늘어난 최대 체력만큼 회복). 서버가 정한다', () => {
  const { w, p } = quietWorld(411);
  const rerolls = p.rerolls;
  p.hp = 50;
  p.offers = ['deploy_prayer'];
  pickOffer(w, p.id, 0);
  p.offers = ['dark_mode'];
  pickOffer(w, p.id, 0);
  assert.equal(p.rerolls, rerolls + 1);
  assert.equal(p.hp, 70);
});
