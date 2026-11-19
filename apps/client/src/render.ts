import {
  DT,
  ENEMY_IDS,
  FIELD_ITEM_KINDS,
  SHOT_KINDS,
  ZONE_KINDS,
  duckOffset,
  type FieldItemKind,
  type RosterPlayer,
  type Snapshot,
  type ZoneKind,
} from '@friday-deploy/shared';
import type { Input } from './input';
import { labelSprite, loadSprites, scaleSprites, textSprite, upscale, type Sprite, type SpriteSet } from './sprites';
import { Timeline, type Sample } from './timeline';
import { cameraPx, computeView, toScreen } from './view';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  /** 한 변의 크기 (논리 픽셀) */
  size: number;
}

/** 피격 이펙트 길이(ms): 앞부분은 흰색으로 번쩍이고, 전체 동안 살짝 밀려났다 돌아온다 */
const HIT_MS = 150;
const HIT_FLASH_MS = 70;
/** 밀려나는 거리 (논리 픽셀). 화면 표현일 뿐이고 서버의 적 위치는 바뀌지 않는다 */
const HIT_RECOIL = 4;
const MAX_PARTICLES = 500;

/** 필드 아이템의 색: [받침 빛 rgb, 주웠을 때의 반짝임 두 색] */
const ITEM_FX: Record<FieldItemKind, { glow: string; spark: [string, string] }> = {
  heal: { glow: '166,227,161', spark: ['#a6e3a1', '#eff1f5'] },
  levelup: { glow: '249,226,175', spark: ['#f9e2af', '#a6e3a1'] },
  revive: { glow: '137,220,235', spark: ['#89dceb', '#eff1f5'] },
};

/** 머리 위 닉네임 색: 나 / 동료 / 쓰러진 사람 */
const NAME_COLOR = { me: '#a6e3a1', mate: '#cdd6f4', down: '#7f849c' } as const;

/** 이번 프레임에 그릴 닉네임 하나 (캐릭터를 모두 그린 뒤에 한꺼번에 그린다) */
interface NameLabel {
  id: number;
  color: string;
  /** 가운데 x, 글자 아래쪽 y (기기 픽셀) */
  px: number;
  bottom: number;
}

/**
 * 화면에 남아 있는 공격 영역. 서버는 영역을 연결마다 한 번만, 남는 틱 수와 함께 보내므로(전송량을 아끼려고)
 * 여기서 기억해 두고 그 시간 동안 그린다. 보통은 생긴 틱의 스냅샷에 오고, 건너뛴 스냅샷이 있었거나 다시 붙은 연결이면
 * 다음 스냅샷에 그때 남은 시간으로 온다. 영역은 움직이지 않는다.
 */
interface LiveZone {
  id: number;
  kind: ZoneKind;
  x: number;
  y: number;
  size: number;
  aux: number;
  /** 보이기 시작하는 재생 틱 (그 스냅샷이 화면에 나오기 시작하는 때 = 직전 틱) */
  from: number;
  /** 사라지는 재생 틱 */
  to: number;
}

/** 기억해 두는 영역 수의 상한 (서버는 한 방에 최대 200개를 둔다. 화면이 멈춰 있는 동안 쌓이지 않게) */
const MAX_LIVE_ZONES = 400;
/** 캐릭터 아래(바닥)에 그리는 영역. 나머지는 적과 캐릭터 위에 그린다 */
const GROUND: ReadonlySet<ZoneKind> = new Set<ZoneKind>(['pool', 'trail']);
/** 오래 남는 영역이 사라지기 전에 흐려지는 시간 (틱) */
const ZONE_FADE = 6;
/** 웅덩이가 처음에 퍼지는 시간 (틱) */
const POOL_GROW = 3;

type Row = number[];
interface Index {
  e: Map<number, Row>;
  p: Map<number, Row>;
  s: Map<number, Row>;
  g: Map<number, Row>;
}

const TILE = 32;
const GLYPHS = ['{ }', '</>', '//', ';', '=>', '0x', '[]', '&&', '()', '#!', '::', '!='];
const GLYPH_COLORS = ['#3b3f5c', '#33354d'];

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return (h ^ (h >>> 16)) >>> 0;
}

const byId = (rows: Row[]): Map<number, Row> => new Map(rows.map((r) => [r[0]!, r]));

/** 영역을 그릴 때 필요한 이번 프레임의 값들 */
interface ZoneCtx {
  /** 지금 보이는 재생 틱 (소수) */
  t: number;
  now: number;
  /** 논리 픽셀 하나 = 기기 픽셀 S 개 */
  S: number;
  sx: (x: number) => number;
  sy: (y: number) => number;
  /** 화면 중심과 화면 반쪽 크기 (월드 단위) */
  cx: number;
  cy: number;
  viewW: number;
  viewH: number;
}

/** 영역이 화면에 걸칠 수 있는 가장 먼 거리 (월드 단위, 중심에서) */
function zoneReach(z: LiveZone): number {
  return z.kind === 'band' ? Math.max(z.size / 2, z.aux * 2) : z.size;
}

/**
 * 적응형 캔버스 렌더러.
 * 캔버스는 기기 픽셀 해상도, 스프라이트는 정수 배율로 미리 키워 둔 것을 쓴다. 픽셀은 또렷하게 유지되면서
 * 움직임은 기기 픽셀 단위로 부드럽다. 무엇을 언제 보여줄지는 Timeline(서버 틱 기준 재생 버퍼)이 정한다.
 */
export class Renderer {
  readonly timeline = new Timeline();
  /** 마지막으로 그린 장면 (미니맵 등 다른 UI 가 같은 시점을 쓰도록) */
  sample: Sample | null = null;

  private ctx: CanvasRenderingContext2D;
  private base: SpriteSet;
  private spr!: SpriteSet;
  private glyphs: Sprite[][] = [];
  private nameSprites = new Map<string, Sprite>();
  private scale = 0;
  private pxW = 1;
  private pxH = 1;
  private index = new WeakMap<Snapshot, Index>();
  private shown: Snapshot | null = null;
  private particles: Particle[] = [];
  /** 적 id → 맞은 시각(ms). 피격 이펙트 진행 중인 적들 */
  private hits = new Map<number, number>();
  private calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private names = new Map<number, string>();
  private idleCam = 0;
  /** 관전 중일 때 유령이 바라보는 방향 (마지막으로 움직인 좌우) */
  private ghostFace: 'l' | 'r' = 'r';
  /** 화면에 남아 있는 공격 영역 (id → 영역). 삽입 순서 = 생긴 순서 */
  private zones = new Map<number, LiveZone>();
  /** 카나리아가 왼쪽으로 날고 있는지 (id → 왼쪽). 멈칫할 때 좌우가 떨리지 않게 마지막 방향을 기억한다 */
  private facingLeft = new Map<number, boolean>();

  constructor(
    private canvas: HTMLCanvasElement,
    private input: Input,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.base = loadSprites();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
  }

  /** 화면에 보이는 영역의 크기 (논리 픽셀 = 월드 단위) */
  get viewSize(): { w: number; h: number } {
    return { w: this.pxW / this.scale, h: this.pxH / this.scale };
  }

  resize(): void {
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const v = computeView(window.innerWidth, window.innerHeight, window.devicePixelRatio, fine);
    if (v.scale !== this.scale) {
      this.scale = v.scale;
      this.spr = scaleSprites(this.base, v.scale);
      this.glyphs = GLYPH_COLORS.map((color) => GLYPHS.map((g) => upscale(textSprite(g, color), v.scale)));
      this.nameSprites.clear();
    }
    if (this.canvas.width !== v.pxW || this.canvas.height !== v.pxH) {
      this.pxW = this.canvas.width = v.pxW;
      this.pxH = this.canvas.height = v.pxH;
    }
    this.ctx.imageSmoothingEnabled = false;
  }

  /** 연결이 끊겼거나 화면을 떠난 사람(가만히 서 있다)은 이름 옆에 표시한다 */
  setRoster(players: RosterPlayer[]): void {
    this.names = new Map(players.map((p) => [p.id, p.away || p.idle ? `${p.name} 💤` : p.name]));
  }

  reset(): void {
    this.timeline.reset();
    this.sample = null;
    this.shown = null;
    this.particles = [];
    this.hits.clear();
    this.zones.clear();
    this.facingLeft.clear();
  }

  push(snap: Snapshot): void {
    const newest = this.timeline.newest;
    // 틱이 거꾸로 가면 새 판이다 (재생 버퍼도 처음부터 다시 쌓는다): 지난 판의 영역은 버린다
    if (newest && snap.tick < newest.tick) this.zones.clear();
    this.timeline.push(snap, performance.now());
    this.rememberZones(snap);
  }

  /**
   * 새로 받은 공격 영역을 기억한다. 받은 순간이 아니라 재생 시간축(틱)에 맞춰 보이고 사라진다:
   * 그 스냅샷이 화면에 나오기 시작할 때(직전 틱을 지나면) 보이고, 남는 틱 수가 지나면 사라진다.
   * 같은 영역이 두 번 와도(서버가 바뀌거나 겹쳐 보내도) id 로 한 번만 넣는다.
   */
  private rememberZones(snap: Snapshot): void {
    for (const z of snap.z) {
      const kind = ZONE_KINDS[z[1]];
      if (!kind || this.zones.has(z[0])) continue;
      this.zones.set(z[0], { id: z[0], kind, x: z[2], y: z[3], size: z[4], aux: z[5], from: snap.tick - 1, to: snap.tick + z[6] + 1 });
    }
    // 화면이 그려지지 않는 동안(탭이 가려짐 등)에도 끝없이 쌓이지 않게: 재생 버퍼보다 오래된 것, 그래도 많으면 오래된 것부터 버린다
    if (this.zones.size > MAX_LIVE_ZONES) {
      for (const [id, z] of this.zones) if (z.to < snap.tick - 40) this.zones.delete(id);
      for (const id of this.zones.keys()) {
        if (this.zones.size <= MAX_LIVE_ZONES) break;
        this.zones.delete(id);
      }
    }
  }

  private indexOf(snap: Snapshot): Index {
    let ix = this.index.get(snap);
    if (!ix) {
      ix = { e: byId(snap.e), p: byId(snap.p), s: byId(snap.s), g: byId(snap.g) };
      this.index.set(snap, ix);
    }
    return ix;
  }

  private nameSprite(name: string, color: string): Sprite {
    const key = `${color} ${name}`;
    let s = this.nameSprites.get(key);
    if (!s) {
      if (this.nameSprites.size > 32) this.nameSprites.clear();
      s = labelSprite(name, color, this.scale);
      this.nameSprites.set(key, s);
    }
    return s;
  }

  /** 머리 위 닉네임: 가운데 정렬, bottom(기기 픽셀) 바로 위에 그린다 */
  private drawName(label: NameLabel): void {
    const name = this.names.get(label.id);
    if (!name) return;
    const ns = this.nameSprite(name, label.color);
    this.ctx.drawImage(ns, label.px - (ns.width >> 1), label.bottom - ns.height);
  }

  private burst(x: number, y: number, n: number, speed: number, colors: [string, string], size = 2, life = 0.35): void {
    if (this.particles.length > MAX_PARTICLES) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 20 + Math.random() * speed;
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: life + Math.random() * life, color: colors[i % 2]!, size });
    }
  }

  /** 화면에 보이는 스냅샷이 바뀌는 순간, 사라진 것들에 이펙트를 붙인다 (보이는 시점과 이펙트 시점을 맞춘다) */
  private onShown(prev: Snapshot, next: Snapshot, now: number): void {
    // 화면의 중심 (내 캐릭터 또는 관전 시점)
    const [vx, vy] = next.view;
    // 방금 맞은 적: 번쩍임 + 밀려남 + 작은 불꽃. 월드가 멈춰 같은 틱이 다시 올 때는 되풀이하지 않는다.
    if (next.tick !== prev.tick) {
      for (const e of next.e) {
        if (!e[4]) continue;
        this.hits.set(e[0], now);
        if (!this.calm) this.burst(e[2], e[3], 3, 45, ['#ffffff', '#f9e2af'], 1, 0.1);
      }
      if (this.hits.size > 256) for (const [id, at] of this.hits) if (now - at > HIT_MS) this.hits.delete(id);
    }
    const alive = this.indexOf(next).e;
    for (const e of prev.e) {
      if (alive.has(e[0]) || Math.hypot(e[2]! - vx, e[3]! - vy) > 280) continue;
      const boss = ENEMY_IDS[e[1]!] === 'legacy_code';
      this.burst(e[2]!, e[3]!, boss ? 40 : 6, boss ? 90 : 50, ['#f38ba8', '#f9e2af']);
    }
    // 경험치가 플레이어에게 빨려 들어가 사라진 자리에 작은 반짝임 (시야 밖으로 나간 것은 제외: 닿을 만큼 가까웠던 것만)
    if (!this.calm) {
      const gems = this.indexOf(next).g;
      for (const g of prev.g) {
        if (gems.has(g[0])) continue;
        if (next.p.some((p) => p[4] && Math.hypot(g[1] - p[1], g[2] - p[2]) < 40)) this.burst(g[1], g[2], 2, 30, ['#a6e3a1', '#eff1f5'], 1, 0.12);
      }
    }
    // 필드 아이템: 누군가 주워서 사라진 자리에 반짝임 (수명이 다해 사라진 것은 조용히 없어진다)
    const items = new Set(next.i.map((it) => it[0]));
    for (const it of prev.i) {
      const kind = FIELD_ITEM_KINDS[it[1]];
      if (!kind || items.has(it[0]) || !next.p.some((p) => p[4] && Math.hypot(it[2] - p[1], it[3] - p[2]) < 110)) continue;
      this.burst(it[2], it[3], kind === 'heal' ? 14 : 24, kind === 'heal' ? 40 : 70, ITEM_FX[kind].spark, kind === 'heal' ? 2 : 3);
    }
    // 방금 되살아난 사람: 주변으로 퍼지는 반짝임 (무적 표시가 켜지는 순간)
    const before = this.indexOf(prev).p;
    for (const p of next.p) {
      if (p[7] && !before.get(p[0])?.[7]) this.burst(p[1], p[2], this.calm ? 10 : 36, 130, ITEM_FX.revive.spark, 3, 0.3);
    }
    const heals = new Set(next.h.map((h) => h[0]));
    for (const h of prev.h) {
      // 시야 밖으로 나간 것이 아니라 누군가 먹어서 사라진 경우만
      if (!heals.has(h[0]) && next.p.some((p) => Math.hypot(h[1] - p[1], h[2] - p[2]) < 90)) this.burst(h[1], h[2], 14, 40, ['#a6e3a1', '#eff1f5']);
    }
  }

  draw(now: number, dt: number): void {
    const { ctx, pxW, pxH } = this;
    const S = this.scale;
    const sample = (this.sample = this.timeline.advance(dt * 1000));
    const hx = pxW >> 1;
    const hy = pxH >> 1;

    if (!sample) {
      this.idleCam += dt * 12;
      this.drawBackground(this.idleCam, Math.sin(this.idleCam / 40) * 30);
      return;
    }
    const { prev, curr, alpha } = sample;
    if (this.shown && this.shown !== curr) this.onShown(this.shown, curr, now);
    this.shown = curr;

    const was = this.indexOf(prev);
    const mix = (a: number | undefined, b: number): number => (a === undefined ? b : a + (b - a) * alpha);

    // 카메라 = 보간된 시점 (살아 있으면 내 캐릭터 위치, 관전 중이면 서버가 계산한 관전 시점)
    const cx = mix(prev.view[0], curr.view[0]);
    const cy = mix(prev.view[1], curr.view[1]);
    const camX = cameraPx(cx, S);
    const camY = cameraPx(cy, S);
    const sx = (x: number): number => toScreen(x, camX, hx, S);
    const sy = (y: number): number => toScreen(y, camY, hy, S);
    const blit = (s: Sprite, x: number, y: number): void => ctx.drawImage(s, sx(x) - (s.width >> 1), sy(y) - (s.height >> 1));

    this.drawBackground(cx, cy);

    // 화면에 보이는 월드 범위 (영역이 화면 밖이면 그리지 않는다)
    const viewW = pxW / S / 2;
    const viewH = pxH / S / 2;
    const zoneCtx: ZoneCtx = { t: sample.tick, now, S, sx, sy, cx, cy, viewW, viewH };
    // 바닥에 고이는 것들(핫픽스 웅덩이, 커밋 발자국)은 경험치·적·캐릭터 아래에
    this.drawZones(zoneCtx, true);

    // 방화벽: 주인 둘레의 따뜻한 고리 (캐릭터 아래)
    for (const p of curr.p) {
      if (!p[4] || !p[10]) continue;
      const q = was.p.get(p[0]);
      this.drawAura(sx(mix(q?.[1], p[1])), sy(mix(q?.[2], p[2])), p[10] * S, now);
    }

    // 경험치: 끌려오는 동안 서버가 위치를 옮기므로 다른 것들처럼 두 스냅샷 사이를 보간한다
    for (const g of curr.g) {
      const q = was.g.get(g[0]);
      blit(this.spr.commit, mix(q?.[1], g[1]), mix(q?.[2], g[2]) + Math.sin(now / 200 + g[0]) * 1.5);
    }

    // 필드 아이템 (화면 안에 들어온 것만 보인다. 멀리 있는 것은 미니맵이 알려준다)
    for (const it of curr.i) {
      const kind = FIELD_ITEM_KINDS[it[1]];
      if (!kind) continue;
      // 곧 사라질 것은 깜빡인다 (동작 줄이기 설정에서는 흐리게만)
      if (it[4] && !this.calm && Math.floor(now / 160) % 2 === 0) continue;
      const bob = this.calm ? 0 : Math.sin(now / 260 + it[0]) * 2;
      const pulse = this.calm ? 0.35 : 0.3 + 0.2 * Math.sin(now / 180 + it[0]);
      ctx.fillStyle = `rgba(${ITEM_FX[kind].glow},${pulse})`;
      ctx.fillRect(sx(it[2]) - 8 * S, sy(it[3]) + 6 * S, 16 * S, 2 * S);
      if (it[4] && this.calm) ctx.globalAlpha = 0.5;
      blit(this.spr.items[kind], it[2], it[3] + bob);
      ctx.globalAlpha = 1;
    }

    for (const h of curr.h) {
      const bob = Math.sin(now / 260 + h[0]) * 2;
      // 눈에 띄도록 은은하게 깜빡이는 받침
      ctx.fillStyle = `rgba(166,227,161,${0.25 + 0.2 * Math.sin(now / 180)})`;
      ctx.fillRect(sx(h[1]) - 7 * S, sy(h[2]) + 5 * S, 14 * S, 2 * S);
      blit(this.spr.heal, h[1], h[2] + bob);
    }

    for (const e of curr.e) {
      const id = ENEMY_IDS[e[1]];
      if (!id) continue;
      const p = was.e.get(e[0]);
      // 얼어 있으면 흔들리지도 않는다
      const frozen = e[5] === 1;
      const wob = id === 'null_ptr' && !frozen ? Math.sin(now / 250 + e[0]) * 2 : 0;
      let ex = mix(p?.[2], e[2]);
      let ey = mix(p?.[3], e[3]) + wob;
      let sprite = frozen ? this.spr.enemyFrozen[id] : this.spr.enemy[id];
      const hitAt = this.hits.get(e[0]);
      if (hitAt !== undefined) {
        const age = now - hitAt;
        if (age >= HIT_MS) {
          this.hits.delete(e[0]);
        } else {
          if (age < HIT_FLASH_MS) sprite = this.spr.enemyHit[id];
          if (!this.calm) {
            // 가장 가까운 플레이어의 반대쪽으로 튕겼다가 돌아온다 (공격은 모두 플레이어에게서 나온다)
            let ax = cx;
            let ay = cy;
            let best = Infinity;
            for (const q of curr.p) {
              const d = (q[1] - ex) ** 2 + (q[2] - ey) ** 2;
              if (q[4] && d < best) {
                best = d;
                ax = q[1];
                ay = q[2];
              }
            }
            const len = Math.hypot(ex - ax, ey - ay) || 1;
            const k = HIT_RECOIL * (1 - age / HIT_MS) ** 2;
            ex += ((ex - ax) / len) * k;
            ey += ((ey - ay) / len) * k;
          }
        }
      }
      blit(sprite, ex, ey);
    }

    // 러버덕은 서버가 위치를 보내지 않는다. 보간된 주인 위치와 보간된 서버 시간으로 직접 계산하므로
    // 다른 것들과 같은 프레임률로 매끄럽게 돈다. (판정은 서버가 같은 식으로 한다)
    const duckTime = sample.tick * DT;

    // 닉네임은 캐릭터를 다 그린 뒤에 그린다 (가까이 붙어 있을 때 옆 사람 캐릭터에 이름이 가려지지 않게)
    const labels: NameLabel[] = [];
    for (const p of curr.p) {
      const q = was.p.get(p[0]);
      const x = mix(q?.[1], p[1]);
      const y = mix(q?.[2], p[2]);
      const px = sx(x);
      const py = sy(y);
      if (!p[4]) {
        blit(this.spr.grave, x, y);
        labels.push({ id: p[0], color: NAME_COLOR.down, px, bottom: py - 5 * S });
        continue;
      }
      const moving = q ? Math.abs(q[1]! - p[1]) + Math.abs(q[2]! - p[2]) > 0.2 : false;
      const frame = moving && Math.floor(now / 140) % 2 ? 1 : 0;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(px - 5 * S, py + 6 * S, 10 * S, 2 * S);
      // 방금 되살아나 피해를 받지 않는 동안에는 깜빡인다 (동작 줄이기 설정에서는 반투명으로만)
      if (p[7]) ctx.globalAlpha = this.calm ? 0.6 : Math.floor(now / 90) % 2 ? 0.35 : 0.9;
      blit(this.spr.dev[p[3] < 0 ? 'l' : 'r'][frame], x, y);
      ctx.globalAlpha = 1;
      // 2단계 인증: 피해를 받지 않는 동안 둘러싸는 옅은 방울
      if (p[11]) this.drawGuard(px, py, S, now);
      // 머리 위 체력바 / 이름
      const bx = px - 7 * S;
      const by = py - 11 * S;
      ctx.fillStyle = '#11111b';
      ctx.fillRect(bx, by, 14 * S, 2 * S);
      ctx.fillStyle = p[0] === curr.me.id ? '#a6e3a1' : '#89b4fa';
      ctx.fillRect(bx, by, Math.round((14 * S * p[5]) / 100), 2 * S);
      labels.push({ id: p[0], color: p[0] === curr.me.id ? NAME_COLOR.me : NAME_COLOR.mate, px, bottom: by });
      // 러버덕은 잠깐씩 돌고 쉰다 (쉬는 동안 p[6] = 0). 반경·각속도는 서버가 판정에 쓰는 값 그대로 온다
      for (let i = 0; i < p[6]; i++) {
        const [ox, oy] = duckOffset(duckTime, i, p[6], p[8], p[9] / 10);
        blit(this.spr.duck, x + ox, y + oy);
      }
    }

    for (const s of curr.s) {
      const kind = SHOT_KINDS[s[1]];
      if (!kind) continue;
      const p = was.s.get(s[0]);
      let spr = this.spr.shots[kind];
      if (kind === 'canary' && p) {
        // 나는 쪽을 바라본다 (좌우로 거의 안 움직일 때는 바라보던 쪽 그대로)
        const dx = s[2] - p[2]!;
        if (Math.abs(dx) > 0.05) this.facingLeft.set(s[0], dx < 0);
        if (this.facingLeft.get(s[0])) spr = this.spr.canaryL;
      }
      blit(spr, mix(p?.[2], s[2]), mix(p?.[3], s[3]));
    }
    if (this.facingLeft.size > 32) this.facingLeft.clear();

    // 베기·번개·폭발·광선·지우기는 적과 캐릭터 위에
    this.drawZones(zoneCtx, false);

    // 관전 중인 나: 시점 자리에 반투명한 유령으로 그린다 (내 화면에만 보인다. 다른 사람에게는 보내지 않는다)
    if (!curr.me.alive) {
      const drift = curr.view[0] - prev.view[0];
      if (Math.abs(drift) > 0.05) this.ghostFace = drift < 0 ? 'l' : 'r';
      const moving = Math.abs(drift) + Math.abs(curr.view[1] - prev.view[1]) > 0.2;
      ctx.globalAlpha = 0.45;
      blit(this.spr.dev[this.ghostFace][moving && Math.floor(now / 140) % 2 ? 1 : 0], cx, cy + (this.calm ? 0 : Math.sin(now / 320) * 1.5));
      ctx.globalAlpha = 1;
    }

    // 내 이름을 맨 위에 (동료와 겹칠 때 내 이름이 읽히도록 마지막에 그린다)
    for (const label of labels) if (label.id !== curr.me.id) this.drawName(label);
    for (const label of labels) if (label.id === curr.me.id) this.drawName(label);

    if (this.particles.length > 0) {
      this.particles = this.particles.filter((p) => (p.life -= dt) > 0);
      for (const p of this.particles) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        ctx.fillStyle = p.color;
        ctx.fillRect(sx(p.x), sy(p.y), p.size * S, p.size * S);
      }
    }

    this.drawStick();
  }

  /**
   * 공격 영역을 그린다. ground 가 true 면 바닥에 남는 것(웅덩이, 커밋 발자국), false 면 나머지(베기, 번개, 폭발, 광선, 지우기, 세로 띠).
   * 휴대폰에서 영역이 150개쯤 있어도 부드럽도록 사각형·원·선만 쓴다 (그라디언트·그림자 없음).
   * 동작 줄이기 설정(calm)에서는 커지거나 쓸고 지나가는 움직임 없이 옅게 나타났다 흐려지기만 한다.
   */
  private drawZones(c: ZoneCtx, ground: boolean): void {
    const { ctx } = this;
    let prevTrail: LiveZone | null = null;
    // 다 퍼졌고 아직 흐려지기 전인 웅덩이들은 한 경로로 모아 한 번에 칠한다 (겹친 곳을 두 번 칠하지 않고, 칠하는 횟수도 준다)
    let pools: Path2D | null = null;
    const steady: LiveZone[] = [];
    for (const z of this.zones.values()) {
      if (z.to <= c.t) {
        // 시간이 다 된 것은 버린다 (바닥 그리기가 매 프레임 먼저 돈다)
        if (ground) this.zones.delete(z.id);
        continue;
      }
      if (GROUND.has(z.kind) !== ground || z.from > c.t) continue;
      const reach = zoneReach(z);
      if (Math.abs(z.x - c.cx) > c.viewW + reach || Math.abs(z.y - c.cy) > c.viewH + reach) continue;
      if (z.kind === 'trail') {
        // 커밋 발자국은 가까운 앞 발자국과 선으로 잇는다 (git 그래프처럼). 멀면(다른 사람의 것, 멈췄다 다시 걸음) 잇지 않는다
        if (prevTrail && Math.abs(prevTrail.x - z.x) + Math.abs(prevTrail.y - z.y) < 56) {
          ctx.globalAlpha = 0.35 * this.zoneFade(prevTrail, c.t);
          ctx.strokeStyle = '#a6e3a1';
          ctx.lineWidth = c.S;
          ctx.beginPath();
          ctx.moveTo(c.sx(prevTrail.x), c.sy(prevTrail.y));
          ctx.lineTo(c.sx(z.x), c.sy(z.y));
          ctx.stroke();
        }
        prevTrail = z;
      }
      if (z.kind === 'pool' && this.poolSteady(z, c.t)) {
        const X = c.sx(z.x);
        const Y = c.sy(z.y);
        const R = z.size * c.S;
        pools ??= new Path2D();
        pools.moveTo(X + R, Y);
        pools.arc(X, Y, R, 0, Math.PI * 2);
        steady.push(z);
        continue;
      }
      this.drawZone(z, c);
    }
    if (pools) {
      ctx.globalAlpha = 0.24;
      ctx.fillStyle = '#74c7ec';
      ctx.fill(pools);
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = '#89dceb';
      ctx.lineWidth = c.S;
      ctx.stroke(pools);
      for (const z of steady) this.drawBubbles(z, c, c.sx(z.x), c.sy(z.y), z.size * c.S, 1);
    }
    ctx.globalAlpha = 1;
  }

  /** 웅덩이가 다 퍼졌고 아직 흐려지기 전인지 (그동안은 모양과 색이 변하지 않는다) */
  private poolSteady(z: LiveZone, t: number): boolean {
    return (this.calm || t - z.from >= POOL_GROW) && this.zoneFade(z, t) >= 1;
  }

  /** 웅덩이 안에서 천천히 떠오르는 작은 거품 두 개 (동작 줄이기 설정에서는 가만히) */
  private drawBubbles(z: LiveZone, c: ZoneCtx, X: number, Y: number, r: number, tail: number): void {
    const { ctx } = this;
    ctx.globalAlpha = 0.7 * tail;
    ctx.fillStyle = '#eff1f5';
    for (let i = 0; i < 2; i++) {
      const a = z.id * 2.4 + i * 2.6;
      const rise = this.calm ? 0.5 : (c.now / 900 + i * 0.5 + z.id * 0.37) % 1;
      ctx.fillRect(X + Math.round(Math.cos(a) * r * 0.45), Y + Math.round((0.35 - rise * 0.7) * r), c.S, c.S);
    }
  }

  /** 오래 남는 영역이 끝나기 전에 흐려지는 정도 (1 → 0) */
  private zoneFade(z: LiveZone, t: number): number {
    return Math.max(0, Math.min(1, (z.to - t) / Math.min(ZONE_FADE, z.to - z.from)));
  }

  private circle(x: number, y: number, r: number): void {
    this.ctx.beginPath();
    this.ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
  }

  private drawZone(z: LiveZone, c: ZoneCtx): void {
    const { ctx, calm } = this;
    const { S } = c;
    const age = Math.max(0, c.t - z.from);
    /** 0 → 1: 생겨서 사라질 때까지 */
    const p = Math.min(1, age / (z.to - z.from));
    /** 짧은 것(베기·번개·폭발·광선·지우기·띠)은 처음부터 끝까지 흐려진다 */
    const fade = 1 - p;
    const X = c.sx(z.x);
    const Y = c.sy(z.y);
    const R = z.size * S;
    switch (z.kind) {
      case 'pool': {
        // 핫픽스 웅덩이: 옅은 하늘색. 처음에 퍼지듯 커지고, 안에서 작은 거품이 올라온다
        // (다 퍼진 뒤에는 drawZones 가 모아서 한 번에 그린다. 여기는 퍼지는 중이거나 흐려지는 중인 것)
        const tail = this.zoneFade(z, c.t);
        const r = calm ? R : R * Math.min(1, 0.6 + (0.4 * age) / POOL_GROW);
        ctx.globalAlpha = 0.24 * tail;
        ctx.fillStyle = '#74c7ec';
        this.circle(X, Y, r);
        ctx.fill();
        ctx.globalAlpha = 0.6 * tail;
        ctx.strokeStyle = '#89dceb';
        ctx.lineWidth = S;
        ctx.stroke();
        this.drawBubbles(z, c, X, Y, r, tail);
        break;
      }
      case 'trail': {
        // 커밋 발자국: 속이 빈 작은 초록 고리 (경험치처럼 보이지 않게 납작하고 옅게).
        // 한 사람이 걸으면 수십 개가 깔리므로 넓은 원은 칠하지 않는다 (휴대폰에서 그리기 비용이 크다)
        const tail = this.zoneFade(z, c.t);
        ctx.globalAlpha = 0.75 * tail;
        ctx.strokeStyle = '#a6e3a1';
        ctx.lineWidth = S;
        this.circle(X, Y, 2.5 * S);
        ctx.stroke();
        break;
      }
      case 'slash': {
        // 베기: 방향으로 뻗는 흰 초승달. 직사각형 판정의 가운데가 (x, y) 다
        const a = (z.aux / 256) * Math.PI * 2;
        const L = R / 2;
        const T = R * 0.42;
        ctx.setTransform(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), X, Y);
        ctx.beginPath();
        ctx.moveTo(-L, T * 0.25);
        ctx.quadraticCurveTo(0, -T * 0.95, L, T * 0.25);
        ctx.quadraticCurveTo(0, -T * 0.15, -L, T * 0.25);
        ctx.closePath();
        ctx.globalAlpha = (calm ? 0.4 : 0.7) * (1 - p * p);
        ctx.fillStyle = '#eff1f5';
        ctx.fill();
        ctx.globalAlpha *= 0.8;
        ctx.strokeStyle = '#f9e2af';
        ctx.lineWidth = S;
        ctx.stroke();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        break;
      }
      case 'bolt': {
        // 번개: 위에서 내리꽂는 노란 지그재그 + 맞은 자리의 둥근 빛. 모양은 id 로 정해서 프레임마다 바뀌지 않는다
        // (여러 개가 겹치면 진해지므로 속은 옅게, 테두리로 맞은 범위를 보여준다)
        ctx.globalAlpha = (calm ? 0.1 : 0.18) * fade;
        ctx.fillStyle = '#f9e2af';
        this.circle(X, Y, R);
        ctx.fill();
        ctx.globalAlpha = (calm ? 0.3 : 0.5) * fade;
        ctx.strokeStyle = '#f9e2af';
        ctx.lineWidth = S;
        ctx.stroke();
        const h = hash(z.id, 7);
        const top = 80 * S;
        ctx.beginPath();
        ctx.moveTo(X + (((h & 15) - 7) * S), Y - top);
        for (let i = 1; i <= 4; i++) {
          const off = i === 4 ? 0 : (((h >>> (i * 5)) % 13) - 6) * S;
          ctx.lineTo(X + off, Y - top + (top * i) / 4);
        }
        ctx.globalAlpha = (calm ? 0.5 : 1) * fade;
        ctx.strokeStyle = '#f9e2af';
        ctx.lineWidth = 3 * S;
        ctx.lineJoin = 'miter';
        ctx.stroke();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = S;
        ctx.stroke();
        break;
      }
      case 'wipe': {
        // git clean: 주인에게서 퍼져 나가는 얇은 흰·보라 고리 (화면 전체를 번쩍이지 않는다)
        const r = calm ? R : R * (0.15 + 0.85 * (1 - (1 - p) * (1 - p)));
        ctx.globalAlpha = (calm ? 0.45 : 0.85) * fade;
        ctx.strokeStyle = '#eff1f5';
        ctx.lineWidth = 3 * S;
        this.circle(X, Y, r);
        ctx.stroke();
        ctx.globalAlpha *= 0.7;
        ctx.strokeStyle = '#cba6f7';
        ctx.lineWidth = 2 * S;
        this.circle(X, Y, r * 0.9);
        ctx.stroke();
        break;
      }
      case 'blast': {
        // 폭발: 주황 원 + 노란 속. 순간 커졌다가 흐려진다
        const r = calm ? R : R * (0.55 + 0.45 * Math.min(1, p * 2.5));
        ctx.globalAlpha = (calm ? 0.2 : 0.32) * fade;
        ctx.fillStyle = '#fab387';
        this.circle(X, Y, r);
        ctx.fill();
        ctx.globalAlpha = (calm ? 0.4 : 0.8) * fade;
        ctx.strokeStyle = '#fab387';
        ctx.lineWidth = S;
        ctx.stroke();
        ctx.globalAlpha = (calm ? 0.25 : 0.5) * fade;
        ctx.fillStyle = '#f9e2af';
        this.circle(X, Y, r * 0.5);
        ctx.fill();
        break;
      }
      case 'band': {
        // 무한 스크롤: 보라색 세로 띠. 밝은 줄이 위에서 아래로 쓸고 지나간다
        const W = R;
        const H = z.aux * 4 * S;
        const left = X - W / 2;
        const top = Y - H / 2;
        ctx.globalAlpha = (calm ? 0.14 : 0.2) * fade;
        ctx.fillStyle = '#cba6f7';
        ctx.fillRect(left, top, W, H);
        ctx.globalAlpha = (calm ? 0.4 : 0.7) * fade;
        ctx.fillRect(left, top, S, H);
        ctx.fillRect(left + W - S, top, S, H);
        if (!calm) {
          ctx.globalAlpha = 0.8 * fade;
          ctx.fillStyle = '#eff1f5';
          ctx.fillRect(left, top + Math.round(H * p) - S, W, 2 * S);
        }
        break;
      }
      case 'beam': {
        // 코드 프리즈: 주인에게서 뻗는 얼음빛 광선 (판정 폭 10px)
        const a = (z.aux / 256) * Math.PI * 2;
        ctx.setTransform(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), X, Y);
        ctx.globalAlpha = (calm ? 0.2 : 0.35) * fade;
        ctx.fillStyle = '#89dceb';
        ctx.fillRect(0, -5 * S, R, 10 * S);
        ctx.globalAlpha = (calm ? 0.55 : 0.9) * fade;
        ctx.fillStyle = '#eff1f5';
        ctx.fillRect(0, -S, R, 2 * S);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        break;
      }
    }
  }

  /**
   * 방화벽: 주인 둘레의 옅은 주황 고리와 천천히 도는 점들 (R 은 기기 픽셀).
   * 원 안을 칠하지 않는다: 반경이 화면의 절반 가까이 되면 휴대폰에서 그리는 비용이 크다
   */
  private drawAura(X: number, Y: number, R: number, now: number): void {
    const { ctx } = this;
    const S = this.scale;
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = '#fab387';
    ctx.lineWidth = 3 * S;
    this.circle(X, Y, R);
    ctx.stroke();
    const n = Math.max(12, Math.min(48, Math.round((Math.PI * 2 * R) / (8 * S))));
    const spin = this.calm ? 0 : now / 1600;
    const d = Math.max(2, Math.round(S * 1.5));
    ctx.globalAlpha = 0.55;
    for (let i = 0; i < n; i++) {
      const a = spin + (i / n) * Math.PI * 2;
      ctx.fillStyle = i % 2 ? '#fab387' : '#f38ba8';
      ctx.fillRect(Math.round(X + Math.cos(a) * R - d / 2), Math.round(Y + Math.sin(a) * R - d / 2), d, d);
    }
    ctx.globalAlpha = 1;
  }

  /** 2단계 인증: 캐릭터를 감싸는 옅은 파란 방울과 작은 반짝임 (px, py 는 캐릭터 가운데, 기기 픽셀) */
  private drawGuard(px: number, py: number, S: number, now: number): void {
    const { ctx } = this;
    // 아주 천천히 숨 쉬듯 (깜빡이지 않는다). 동작 줄이기 설정에서는 그대로
    const r = (10 + (this.calm ? 0 : Math.sin(now / 400) * 0.5)) * S;
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#89b4fa';
    this.circle(px, py, r);
    ctx.fill();
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = '#b4befe';
    ctx.lineWidth = S;
    ctx.stroke();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#eff1f5';
    ctx.fillRect(Math.round(px - r * 0.55), Math.round(py - r * 0.6), 2 * S, S);
    ctx.fillRect(Math.round(px - r * 0.65), Math.round(py - r * 0.6) + S, S, S);
    ctx.globalAlpha = 1;
  }

  private drawBackground(cx: number, cy: number): void {
    const { ctx, pxW, pxH } = this;
    const S = this.scale;
    const camX = cameraPx(cx, S);
    const camY = cameraPx(cy, S);
    const hx = pxW >> 1;
    const hy = pxH >> 1;
    ctx.fillStyle = '#1e1e2e';
    ctx.fillRect(0, 0, pxW, pxH);
    const size = TILE * S;
    const x0 = Math.floor((camX - hx) / size);
    const y0 = Math.floor((camY - hy) / size);
    const x1 = Math.floor((camX - hx + pxW) / size);
    const y1 = Math.floor((camY - hy + pxH) / size);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const px = tx * size - camX + hx;
        const py = ty * size - camY + hy;
        if ((tx + ty) & 1) {
          ctx.fillStyle = '#212133';
          ctx.fillRect(px, py, size, size);
        }
        ctx.fillStyle = '#2a2a3d';
        ctx.fillRect(px, py, S, S);
        const hsh = hash(tx, ty);
        if (hsh % 5 === 0) {
          const glyph = this.glyphs[hsh % 3 === 0 ? 0 : 1]![(hsh >>> 8) % GLYPHS.length]!;
          ctx.drawImage(glyph, px + (4 + ((hsh >>> 4) % 10)) * S, py + (4 + ((hsh >>> 12) % 14)) * S);
        }
      }
    }
  }

  private drawStick(): void {
    const st = this.input.stick;
    if (!st) return;
    const { ctx } = this;
    const k = this.pxW / window.innerWidth;
    const dot = Math.max(2, Math.round(this.scale * 0.6));
    const ring = (x: number, y: number, r: number, color: string): void => {
      ctx.fillStyle = color;
      const px = Math.round(x * k);
      const py = Math.round(y * k);
      for (let a = 0; a < 24; a++) {
        const t = (a / 24) * Math.PI * 2;
        ctx.fillRect(px + Math.round(Math.cos(t) * r), py + Math.round(Math.sin(t) * r), dot, dot);
      }
    };
    ring(st.ox, st.oy, 48 * k, 'rgba(205,214,244,0.35)');
    ring(st.x, st.y, 14 * k, 'rgba(249,226,175,0.8)');
  }
}
