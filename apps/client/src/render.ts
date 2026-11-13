import { ENEMY_IDS, TICK_RATE, type Snapshot } from '@friday-deploy/shared';
import type { Input } from './input';
import { loadSprites, type Sprite, type SpriteSet } from './sprites';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

const SNAP_MS = 1000 / TICK_RATE;
const TILE = 32;
const GLYPHS = ['{ }', '</>', '//', ';', '=>', '0x', '[]', '&&', '()', '#!', '::', '!='];

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * 적응형 캔버스 렌더러.
 * 논리 해상도를 화면 크기에 맞춰 정수 배율로 계산하므로 어떤 기기에서도 픽셀이 뭉개지지 않는다.
 */
export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private spr: SpriteSet;
  private scale = 2;
  private w = 0;
  private h = 0;
  private prev: Snapshot | null = null;
  private curr: Snapshot | null = null;
  private currAt = 0;
  private particles: Particle[] = [];
  private names = new Map<number, string>();
  private idleCam = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private input: Input,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.spr = loadSprites();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    // 짧은 변 기준 논리 픽셀 ~200 이 보이도록 정수 배율 선택
    this.scale = Math.max(1, Math.round((Math.min(cssW, cssH) * dpr) / 200));
    // 아주 넓은 화면에서 시야가 과도하게 넓어지지 않도록 (서버 관심 영역 안에 머물게)
    while ((Math.max(cssW, cssH) * dpr) / this.scale > 560) this.scale++;
    this.w = Math.ceil((cssW * dpr) / this.scale);
    this.h = Math.ceil((cssH * dpr) / this.scale);
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx.imageSmoothingEnabled = false;
  }

  setRoster(players: { id: number; name: string }[]): void {
    this.names = new Map(players.map((p) => [p.id, p.name]));
  }

  reset(): void {
    this.prev = this.curr = null;
    this.particles = [];
  }

  push(snap: Snapshot): void {
    // 시야 안에서 사라진 적 = 처치됨 → 파편 이펙트
    if (this.curr) {
      const alive = new Set(snap.e.map((e) => e[0]));
      const me = snap.p.find((p) => p[0] === snap.me.id);
      for (const e of this.curr.e) {
        if (alive.has(e[0]) || !me) continue;
        if (Math.hypot(e[2] - me[1], e[3] - me[2]) > 280) continue;
        const boss = ENEMY_IDS[e[1]] === 'legacy_code';
        for (let i = 0; i < (boss ? 40 : 6); i++) {
          const a = Math.random() * Math.PI * 2;
          const s = 20 + Math.random() * (boss ? 90 : 50);
          this.particles.push({ x: e[2], y: e[3], vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.35 + Math.random() * 0.3, color: i % 2 ? '#f38ba8' : '#f9e2af' });
        }
      }
    }
    this.prev = this.curr;
    this.curr = snap;
    this.currAt = performance.now();
  }

  draw(now: number, dt: number): void {
    const { ctx, w, h } = this;
    const snap = this.curr;
    const alpha = snap && this.prev && !snap.paused ? Math.min(1, (now - this.currAt) / SNAP_MS) : 1;

    const lerpMap = <T extends number[]>(arr: T[] | undefined): Map<number, T> => new Map((arr ?? []).map((v) => [v[0]!, v]));
    const pe = lerpMap(this.prev?.e);
    const pp = lerpMap(this.prev?.p);
    const ps = lerpMap(this.prev?.s);
    const mix = (a: number | undefined, b: number): number => (a === undefined ? b : a + (b - a) * alpha);

    // 카메라
    let cx: number;
    let cy: number;
    if (snap) {
      const me = snap.p.find((p) => p[0] === snap.me.id);
      const pm = me && pp.get(me[0]);
      cx = me ? mix(pm?.[1], me[1]) : 0;
      cy = me ? mix(pm?.[2], me[2]) : 0;
    } else {
      this.idleCam += dt * 12;
      cx = this.idleCam;
      cy = Math.sin(this.idleCam / 40) * 30;
    }
    const ox = Math.round(w / 2 - cx);
    const oy = Math.round(h / 2 - cy);

    this.drawBackground(cx, cy, ox, oy);
    if (!snap) return;

    const blit = (s: Sprite, x: number, y: number): void => ctx.drawImage(s, Math.round(x + ox - s.width / 2), Math.round(y + oy - s.height / 2));

    for (const g of snap.g) blit(this.spr.commit, g[1], g[2] + Math.sin(now / 200 + g[0]) * 1.5);

    for (const e of snap.e) {
      const p = pe.get(e[0]);
      const id = ENEMY_IDS[e[1]];
      if (!id) continue;
      const wob = id === 'null_ptr' ? Math.sin(now / 250 + e[0]) * 2 : 0;
      blit(this.spr.enemy[id], mix(p?.[2], e[2]), mix(p?.[3], e[3]) + wob);
    }

    for (const p of snap.p) {
      const q = pp.get(p[0]);
      const x = mix(q?.[1], p[1]);
      const y = mix(q?.[2], p[2]);
      if (!p[4]) {
        blit(this.spr.grave, x, y);
        continue;
      }
      const moving = q ? Math.abs(q[1] - p[1]) + Math.abs(q[2] - p[2]) > 0.2 : false;
      const frame = moving && Math.floor(now / 140) % 2 ? 1 : 0;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(Math.round(x + ox - 5), Math.round(y + oy + 6), 10, 2);
      blit(this.spr.dev[p[3] < 0 ? 'l' : 'r'][frame], x, y);
      // 머리 위 체력바 / 이름
      const bx = Math.round(x + ox - 7);
      const by = Math.round(y + oy - 11);
      ctx.fillStyle = '#11111b';
      ctx.fillRect(bx, by, 14, 2);
      ctx.fillStyle = p[0] === snap.me.id ? '#a6e3a1' : '#89b4fa';
      ctx.fillRect(bx, by, Math.round((14 * p[5]) / 100), 2);
      if (p[0] !== snap.me.id) {
        ctx.font = '8px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#cdd6f4';
        ctx.fillText(this.names.get(p[0]) ?? '', Math.round(x + ox), by - 2);
      }
    }

    for (const d of snap.d) blit(this.spr.duck, d[0], d[1]);

    for (const s of snap.s) {
      const p = ps.get(s[0]);
      const spr = this.spr.shots[s[1] as 0 | 1 | 2];
      if (spr) blit(spr, mix(p?.[2], s[2]), mix(p?.[3], s[3]));
    }

    this.particles = this.particles.filter((p) => (p.life -= dt) > 0);
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x + ox), Math.round(p.y + oy), 2, 2);
    }

    this.drawStick();
  }

  private drawBackground(cx: number, cy: number, ox: number, oy: number): void {
    const { ctx, w, h } = this;
    ctx.fillStyle = '#1e1e2e';
    ctx.fillRect(0, 0, w, h);
    const x0 = Math.floor((cx - w / 2) / TILE) - 1;
    const y0 = Math.floor((cy - h / 2) / TILE) - 1;
    const nx = Math.ceil(w / TILE) + 2;
    const ny = Math.ceil(h / TILE) + 2;
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    for (let ty = y0; ty <= y0 + ny; ty++) {
      for (let tx = x0; tx <= x0 + nx; tx++) {
        const hsh = hash(tx, ty);
        const sx = tx * TILE + ox;
        const sy = ty * TILE + oy;
        if ((tx + ty) & 1) {
          ctx.fillStyle = '#212133';
          ctx.fillRect(sx, sy, TILE, TILE);
        }
        ctx.fillStyle = '#2a2a3d';
        ctx.fillRect(sx, sy, 1, 1);
        if (hsh % 5 === 0) {
          ctx.fillStyle = hsh % 3 === 0 ? '#3b3f5c' : '#33354d';
          ctx.fillText(GLYPHS[(hsh >>> 8) % GLYPHS.length]!, sx + 4 + ((hsh >>> 4) % 10), sy + 12 + ((hsh >>> 12) % 14));
        }
      }
    }
  }

  private drawStick(): void {
    const st = this.input.stick;
    if (!st) return;
    const { ctx } = this;
    const k = this.w / window.innerWidth;
    const ring = (x: number, y: number, r: number, color: string): void => {
      ctx.fillStyle = color;
      const px = Math.round(x * k);
      const py = Math.round(y * k);
      for (let a = 0; a < 24; a++) {
        const t = (a / 24) * Math.PI * 2;
        ctx.fillRect(px + Math.round(Math.cos(t) * r), py + Math.round(Math.sin(t) * r), 2, 2);
      }
    };
    ring(st.ox, st.oy, 48 * k, 'rgba(205,214,244,0.35)');
    ring(st.x, st.y, 14 * k, 'rgba(249,226,175,0.8)');
  }
}
