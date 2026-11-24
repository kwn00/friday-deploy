/**
 * 화면에 보이는 장면이 바뀔 때 어떤 소리를 낼지 정한다 (직전 스냅샷과 지금 스냅샷을 비교).
 * 서버가 따로 알려주는 것이 아니라 화면이 이미 받는 값만 쓴다: 서버 부담과 전송량은 그대로다.
 * 소리는 화면의 반짝임과 같은 순간에 난다 (render.ts 의 onShown 에서 부른다).
 *
 * 이 파일은 화면(DOM)과 Web Audio 를 쓰지 않는다 (단위 테스트에서 검사한다).
 */
import { ENEMIES, ENEMY_IDS, FIELD_ITEM_KINDS, STAGE_TIME, ZONE_KINDS, type Snapshot } from '@friday-deploy/shared';
import type { SfxId } from './sounds';

const WIPE = ZONE_KINDS.indexOf('wipe');

/**
 * 이 스냅샷에서 git clean 이 지운 자리인지 (x, y 는 월드 좌표).
 * git clean 은 지우는 쪽이 나오면 화면 안의 경험치·회복 아이템·필드 아이템을 지운다. 지워진 것은 내 몸 가까이에서 사라져도
 * 주운 것이 아니므로 반짝임과 소리를 내지 않는다. 그 순간 생긴 지우기 영역(wipe, aux 0 = git clean) 안에서 사라진 것을 지워진 것으로 본다.
 * (rm -rf node_modules 는 aux 1 이고 아무것도 지우지 않는다. 남기는 쪽이 나온 git clean 과 같은 틱에 주운 것도 조용해지지만,
 * 1/20초가 겹치는 드문 경우이고 주운 효과(체력·레벨업·알림)는 그대로다)
 */
export function erasedIn(next: Snapshot): (x: number, y: number) => boolean {
  const areas = next.z.filter((z) => z[1] === WIPE && z[5] === 0);
  if (areas.length === 0) return () => false;
  return (x, y) => areas.some((z) => Math.hypot(x - z[2], y - z[3]) <= z[4] + 1);
}

export interface Cue {
  id: SfxId;
  /** 같은 순간에 몇 번 일어났는지 (예: 한꺼번에 쓰러진 적의 수) */
  n: number;
}

const IS_BOSS: readonly boolean[] = ENEMY_IDS.map((id) => ENEMIES[id].boss === true);
/** 이 거리(월드 단위) 밖에서 사라진 적은 쓰러진 것이 아니라 시야 밖으로 나간 것으로 본다 (render.ts 와 같은 기준) */
const KILL_RANGE = 280;
/** 경험치·아이템이 내 몸 근처에서 사라졌으면 내가 먹은 것이다 (render.ts 의 반짝임과 같은 기준) */
const GEM_RANGE = 40;
const ITEM_RANGE = 110;
const HEAL_RANGE = 90;

/** 필드 아이템 종류 → 주웠을 때의 소리 */
const ITEM_SOUND: Record<(typeof FIELD_ITEM_KINDS)[number], SfxId> = {
  heal: 'heal',
  levelup: 'pickup',
  revive: 'backup',
  chest: 'chest',
};

export class SoundCues {
  /** 이번 판에 이미 알린 보스 (시야를 들락날락해도 경보는 한 번) */
  private bosses = new Set<number>();

  reset(): void {
    this.bosses.clear();
  }

  diff(prev: Snapshot, next: Snapshot): Cue[] {
    const out: Cue[] = [];
    const add = (id: SfxId, n = 1): void => {
      if (n > 0) out.push({ id, n });
    };
    const [vx, vy] = next.view;
    const meId = next.me.id;
    const meNow = next.p.find((p) => p[0] === meId);
    const near = (x: number, y: number, r: number): boolean => meNow !== undefined && meNow[4] === 1 && Math.hypot(x - meNow[1], y - meNow[2]) < r;
    const moved = next.tick !== prev.tick;
    const erased = erasedIn(next);

    // 공격이 맞은 적 (월드가 멈춰 같은 틱이 다시 오면 되풀이하지 않는다)
    if (moved) add('hit', next.e.reduce((n, e) => n + (e[4] ? 1 : 0), 0));

    // 쓰러진 적과 보스
    const alive = new Set(next.e.map((e) => e[0]));
    let kills = 0;
    let bossKills = 0;
    for (const e of prev.e) {
      if (alive.has(e[0]) || Math.hypot(e[2] - vx, e[3] - vy) > KILL_RANGE) continue;
      if (IS_BOSS[e[1]]) bossKills++;
      else kills++;
    }
    add('kill', kills);
    add('bossKill', bossKills);

    // 새로 나타난 보스
    let bossNew = 0;
    for (const e of next.e) {
      if (!IS_BOSS[e[1]] || this.bosses.has(e[0])) continue;
      this.bosses.add(e[0]);
      bossNew++;
    }
    add('bossAppear', bossNew);
    if (this.bosses.size > 64) for (const id of this.bosses) if (!alive.has(id)) this.bosses.delete(id);

    // 내가 먹은 경험치 (git clean 에 지워진 것은 빼고)
    const gems = new Set(next.g.map((g) => g[0]));
    add('gem', prev.g.filter((g) => !gems.has(g[0]) && near(g[1], g[2], GEM_RANGE) && !erased(g[1], g[2])).length);

    // 내가 주운 필드 아이템
    const items = new Set(next.i.map((it) => it[0]));
    for (const it of prev.i) {
      const kind = FIELD_ITEM_KINDS[it[1]];
      if (kind && !items.has(it[0]) && near(it[2], it[3], ITEM_RANGE) && !erased(it[2], it[3])) add(ITEM_SOUND[kind]);
    }
    // 적이 떨어뜨린 회복 아이템
    const heals = new Set(next.h.map((h) => h[0]));
    if (prev.h.some((h) => !heals.has(h[0]) && near(h[1], h[2], HEAL_RANGE) && !erased(h[1], h[2]))) add('heal');

    // 나: 맞음, 쓰러짐, 되살아남
    const meBefore = prev.p.find((p) => p[0] === meId);
    if (prev.me.alive && next.me.alive && next.me.hp < prev.me.hp && moved) add('hurt');
    if (prev.me.alive && !next.me.alive) add('down');
    if (meNow?.[7] && meBefore && !meBefore[7]) add('revive');

    // 동료가 쓰러짐
    const before = new Map(prev.p.map((p) => [p[0], p]));
    for (const p of next.p) if (p[0] !== meId && !p[4] && before.get(p[0])?.[4]) add('mateDown');

    // 30분: 월요일 아침
    if (prev.time < STAGE_TIME && next.time >= STAGE_TIME) add('monday');
    return out;
  }
}
