import { DT, ENEMY_IDS, FIELD_ITEM_KINDS, duckOffset, type FieldItemKind, type Snapshot } from '@friday-deploy/shared';
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

  setRoster(players: { id: number; name: string }[]): void {
    this.names = new Map(players.map((p) => [p.id, p.name]));
  }

  reset(): void {
    this.timeline.reset();
    this.sample = null;
    this.shown = null;
    this.particles = [];
    this.hits.clear();
  }

  push(snap: Snapshot): void {
    this.timeline.push(snap, performance.now());
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
      const wob = id === 'null_ptr' ? Math.sin(now / 250 + e[0]) * 2 : 0;
      let ex = mix(p?.[2], e[2]);
      let ey = mix(p?.[3], e[3]) + wob;
      let sprite = this.spr.enemy[id];
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
      // 머리 위 체력바 / 이름
      const bx = px - 7 * S;
      const by = py - 11 * S;
      ctx.fillStyle = '#11111b';
      ctx.fillRect(bx, by, 14 * S, 2 * S);
      ctx.fillStyle = p[0] === curr.me.id ? '#a6e3a1' : '#89b4fa';
      ctx.fillRect(bx, by, Math.round((14 * S * p[5]) / 100), 2 * S);
      labels.push({ id: p[0], color: p[0] === curr.me.id ? NAME_COLOR.me : NAME_COLOR.mate, px, bottom: by });
      for (let i = 0; i < p[6]; i++) {
        const [ox, oy] = duckOffset(duckTime, i, p[6]);
        blit(this.spr.duck, x + ox, y + oy);
      }
    }

    for (const s of curr.s) {
      const spr = this.spr.shots[s[1] as 0 | 1 | 2];
      if (!spr) continue;
      const p = was.s.get(s[0]);
      blit(spr, mix(p?.[2], s[2]), mix(p?.[3], s[3]));
    }

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
