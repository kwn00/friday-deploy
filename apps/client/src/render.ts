import {
  DT,
  ENEMIES,
  ENEMY_IDS,
  FIELD_ITEM_KINDS,
  SHOT_KINDS,
  ZONE_KINDS,
  duckOffset,
  moveSpeedOf,
  type EnemyId,
  type FieldItemKind,
  type RosterPlayer,
  type Snapshot,
  type ZoneKind,
} from '@friday-deploy/shared';
import type { Input } from './input';
import { labelSprite, loadSprites, scaleSprites, textSprite, upscale, type Sprite, type SpriteSet } from './sprites';
import { Timeline, type Sample } from './timeline';
import { Predictor } from './predict';
import { SoundCues, insideAny, wipesBetween, type Cue } from './sound-cues';
import { THEMES, type Theme } from './themes';
import { cameraPx, computeView, toScreen } from './view';
import { hiddenAt, pickEdgeTargets, placeEdge, type Box, type EdgeTarget } from './edge';

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
/** 화면 위로 내리는 것(눈 등)의 최대 개수 (큰 화면에서도 이 이상 늘리지 않는다) */
const MAX_FLAKES = 160;

/** 내리는 것 하나 (화면 좌표, 논리 픽셀) */
interface Flake {
  x: number;
  y: number;
  /** 떨어지는 속도 (논리 픽셀/초) */
  v: number;
  /** 좌우 흔들림의 위상 */
  phase: number;
  size: number;
  color: string;
}

/** 필드 아이템의 색: [받침 빛 rgb, 주웠을 때의 반짝임 두 색] */
const ITEM_FX: Record<FieldItemKind, { glow: string; spark: [string, string] }> = {
  heal: { glow: '166,227,161', spark: ['#a6e3a1', '#eff1f5'] },
  levelup: { glow: '249,226,175', spark: ['#f9e2af', '#a6e3a1'] },
  revive: { glow: '137,220,235', spark: ['#89dceb', '#eff1f5'] },
  chest: { glow: '249,226,175', spark: ['#f9e2af', '#fab387'] },
  magnet: { glow: '230,69,83', spark: ['#e64553', '#bac2de'] },
};

/** 화면 가장자리 표시의 테두리·화살표 색 (미니맵의 표시와 같은 색) */
const EDGE_COLOR: Record<FieldItemKind, string> = {
  heal: '#a6e3a1',
  levelup: '#f9e2af',
  revive: '#89dceb',
  chest: '#fab387',
  magnet: '#e64553',
};
/** 가장자리 표시: 상자 반쪽 크기, 화살표 길이, 화면 가운데(캐릭터)에서 떨어뜨릴 최소 거리 (논리 픽셀. 캐릭터와 닉네임을 덮지 않을 만큼) */
const EDGE_HALF = 9;
const EDGE_ARROW = 6;
const EDGE_MIN = 26;
/** 새로 놓인 아이템의 표시가 눈에 띄게 퍼지는 시간 (ms. 미니맵과 같다) */
const EDGE_NEW_MS = 4000;

interface EdgeItem extends EdgeTarget {
  kind: FieldItemKind;
  fading: boolean;
}

/** 경험치 색 단계(0 파랑, 1 초록, 2 빨강)의 반짝임 색 */
const GEM_COLOR = ['#89b4fa', '#a6e3a1', '#e64553'] as const;
/** 적 종류 번호 → 보스인지 (매 프레임 수백 마리를 보므로 미리 표로 만들어 둔다) */
const IS_BOSS: readonly boolean[] = ENEMY_IDS.map((id) => ENEMIES[id].boss === true);
/** 2단계 인증 방패 고리의 색: 방패 1개 파랑, 2개 초록, 3개 노랑 (뱀서 Laurel 과 같은 순서) */
const SHIELD_COLOR = ['#89b4fa', '#a6e3a1', '#f9e2af'] as const;

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
  /** 수명보다 일찍 없어질 때(날아간 커밋 발자국) 사라지는 재생 틱. 흐려지지 않고 그 순간 없어진다 */
  gone?: number;
}

/** 기억해 두는 영역 수의 상한 (서버는 한 방에 최대 200개를 둔다. 화면이 멈춰 있는 동안 쌓이지 않게) */
const MAX_LIVE_ZONES = 400;
/** 캐릭터 아래(바닥)에 그리는 영역. 나머지는 적과 캐릭터 위에 그린다 */
const GROUND: ReadonlySet<ZoneKind> = new Set<ZoneKind>(['pool', 'trail', 'fire']);
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
  /** 내 캐릭터를 입력대로 먼저 그린다 (화면 전용. predict.ts) */
  readonly predictor = new Predictor();
  /** 마지막으로 그린 장면 (미니맵 등 다른 UI 가 같은 시점을 쓰도록) */
  sample: Sample | null = null;
  /** 보이는 장면이 바뀔 때 생긴 소리 (맞음, 쓰러짐, 경험치 등). 화면의 반짝임과 같은 순간에 부른다 */
  onCue: ((cue: Cue) => void) | null = null;
  private cues = new SoundCues();

  private ctx: CanvasRenderingContext2D;
  private base: SpriteSet;
  private spr!: SpriteSet;
  private glyphs: Sprite[][] = [];
  /** 바닥 색·글자, 내리는 것, 캐릭터 그림 (themes.ts) */
  private theme: Theme = THEMES.default;
  /** 화면 위로 내리는 것 (눈 등). 화면 좌표(논리 픽셀) */
  private flakes: Flake[] = [];
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
  /** 화면 가장자리 표시가 피해 갈 HUD 자리와 표시가 들어갈 영역 (CSS 픽셀. main.ts 가 가끔 잰다) */
  private hudBoxes: Box[] = [];
  private hudBounds: Box | null = null;
  /** 필드 아이템 id → 처음 본 시각(ms). 새로 놓인 것의 가장자리 표시를 잠깐 강조한다 */
  private edgeSeen = new Map<number, number>();

  constructor(
    private canvas: HTMLCanvasElement,
    private input: Input,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.base = loadSprites(this.theme.dev);
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
      this.glyphs = this.theme.floor.glyphColors.map((color) => this.theme.floor.glyphs.map((g) => upscale(textSprite(g, color), v.scale)));
      this.nameSprites.clear();
    }
    if (this.canvas.width !== v.pxW || this.canvas.height !== v.pxH) {
      this.pxW = this.canvas.width = v.pxW;
      this.pxH = this.canvas.height = v.pxH;
    }
    this.ctx.imageSmoothingEnabled = false;
  }

  /** 테마를 바꾼다: 캐릭터 그림과 바닥 글자를 다시 굽는다 (게임 중에 불러도 된다) */
  setTheme(theme: Theme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    this.base = loadSprites(theme.dev);
    this.flakes = [];
    this.scale = 0; // 다음 resize() 가 현재 배율로 모두 다시 키운다
    this.resize();
  }

  /**
   * 화면 가장자리 표시가 피해 갈 HUD 자리 (CSS 픽셀).
   * bounds: 표시가 들어갈 영역 (노치와 HUD 의 바깥 여백을 뺀 것), boxes: 가리면 안 되는 HUD 요소들
   */
  setHud(bounds: Box | null, boxes: Box[]): void {
    this.hudBounds = bounds;
    this.hudBoxes = boxes;
  }

  /** 연결이 끊겼거나 화면을 떠난 사람(가만히 서 있다)은 이름 옆에 표시한다 */
  setRoster(players: RosterPlayer[]): void {
    this.names = new Map(players.map((p) => [p.id, p.away || p.idle ? `${p.name} 💤` : p.name]));
  }

  reset(): void {
    this.timeline.reset();
    this.predictor.reset();
    this.sample = null;
    this.shown = null;
    this.particles = [];
    this.hits.clear();
    this.zones.clear();
    this.facingLeft.clear();
    this.edgeSeen.clear();
    this.cues.reset();
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
    // 일찍 없어진 영역 (멈췄을 때 날아간 커밋 발자국): 이 스냅샷이 화면에 나오기 시작할 때 지운다 (날아가는 커밋이 그때 나타난다)
    for (const id of snap.zr) {
      const z = this.zones.get(id);
      if (z) z.gone = Math.min(z.gone ?? Infinity, snap.tick - 1);
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
    // git clean 이 지운 자리: 거기서 사라진 경험치·아이템은 주운 것이 아니다 (반짝이거나 소리 내지 않는다. 지우기 고리가 대신 보인다).
    // 받는 대로 기억해 둔 영역에서 찾는다: 영역을 실은 스냅샷이 화면에 나오지 않고 지나가도 놓치지 않게
    const erased = insideAny(wipesBetween(this.zones.values(), prev.tick, next.tick));
    if (this.onCue) for (const cue of this.cues.diff(prev, next, erased)) this.onCue(cue);
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
      const boss = IS_BOSS[e[1]!] === true;
      this.burst(e[2]!, e[3]!, boss ? 40 : 6, boss ? 90 : 50, ['#f38ba8', '#f9e2af']);
    }
    // 경험치가 플레이어에게 빨려 들어가 사라진 자리에 작은 반짝임 (시야 밖으로 나간 것은 제외: 닿을 만큼 가까웠던 것만)
    if (!this.calm) {
      const gems = this.indexOf(next).g;
      for (const g of prev.g) {
        if (gems.has(g[0]) || erased(g[1], g[2])) continue;
        if (next.p.some((p) => p[4] && Math.hypot(g[1] - p[1], g[2] - p[2]) < 40)) this.burst(g[1], g[2], 2, 30, [GEM_COLOR[g[3]] ?? GEM_COLOR[0], '#eff1f5'], 1, 0.12);
      }
    }
    // 필드 아이템: 누군가 주워서 사라진 자리에 반짝임 (수명이 다해 사라진 것, git clean 에 지워진 것은 조용히 없어진다)
    const items = new Set(next.i.map((it) => it[0]));
    for (const it of prev.i) {
      const kind = FIELD_ITEM_KINDS[it[1]];
      if (!kind || items.has(it[0]) || (kind !== 'chest' && erased(it[2], it[3])) || !next.p.some((p) => p[4] && Math.hypot(it[2] - p[1], it[3] - p[2]) < 110)) continue;
      // 보물상자는 크게 터진다
      const [n, speed] = kind === 'heal' ? [14, 40] : kind === 'chest' ? [44, 100] : [24, 70];
      this.burst(it[2], it[3], n, speed, ITEM_FX[kind].spark, kind === 'heal' ? 2 : 3);
    }
    // 방금 되살아난 사람: 주변으로 퍼지는 반짝임 (무적 표시가 켜지는 순간)
    const before = this.indexOf(prev).p;
    for (const p of next.p) {
      if (p[7] && !before.get(p[0])?.[7]) this.burst(p[1], p[2], this.calm ? 10 : 36, 130, ITEM_FX.revive.spark, 3, 0.3);
    }
    const heals = new Set(next.h.map((h) => h[0]));
    for (const h of prev.h) {
      // 시야 밖으로 나간 것이 아니라 누군가 먹어서 사라진 경우만
      if (!heals.has(h[0]) && !erased(h[1], h[2]) && next.p.some((p) => Math.hypot(h[1] - p[1], h[2] - p[2]) < 90)) this.burst(h[1], h[2], 14, 40, ['#a6e3a1', '#eff1f5']);
    }
  }

  /** dt: 화면 효과에 쓰는 시간(초, 상한이 있다). real: 실제로 흐른 시간(초). 내 캐릭터 예측은 실제 시간을 따라간다 */
  draw(now: number, dt: number, real = dt): void {
    const { ctx, pxW, pxH } = this;
    const S = this.scale;
    const sample = (this.sample = this.timeline.advance(dt * 1000));
    const hx = pxW >> 1;
    const hy = pxH >> 1;

    if (!sample) {
      this.idleCam += dt * 12;
      const iy = Math.sin(this.idleCam / 40) * 30;
      this.drawBackground(this.idleCam, iy);
      this.drawWeather(this.idleCam, iy, dt);
      return;
    }
    const { prev, curr, alpha } = sample;
    if (this.shown && this.shown !== curr) this.onShown(this.shown, curr, now);
    this.shown = curr;

    const was = this.indexOf(prev);
    const mix = (a: number | undefined, b: number): number => (a === undefined ? b : a + (b - a) * alpha);

    // 카메라 = 살아 있으면 내 캐릭터 위치, 관전 중이면 서버가 계산한 관전 시점.
    // 살아 있는 동안에는 보간된 과거 위치가 아니라, 서버의 가장 최근 위치에 아직 반영되지 않은 내 입력을 더한 자리를 쓴다
    // (누르자마자 움직인다). 다른 것들은 모두 서버가 보낸 대로 그린다.
    const newest = this.timeline.newest ?? curr;
    const mine = prev.me.alive && curr.me.alive && newest.me.alive;
    const base = mine ? { x: newest.view[0], y: newest.view[1], ack: newest.ack, ackTicks: newest.ackTicks, ackPhase: newest.ackPhase, speed: moveSpeedOf(newest.me) } : null;
    const [cx, cy] = this.predictor.place(base, mix(prev.view[0], curr.view[0]), mix(prev.view[1], curr.view[1]), real, newest.paused);
    /** 플레이어의 그릴 위치: 나는 예측한 자리, 다른 사람은 두 스냅샷 사이 */
    const spot = (p: Row, q: Row | undefined): [number, number] => (mine && p[0] === curr.me.id ? [cx, cy] : [mix(q?.[1], p[1]!), mix(q?.[2], p[2]!)]);
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
      const [ax, ay] = spot(p, was.p.get(p[0]));
      this.drawAura(sx(ax), sy(ay), p[10] * S, now);
    }

    // 경험치: 끌려오는 동안 서버가 위치를 옮기므로 다른 것들처럼 두 스냅샷 사이를 보간한다. 색은 담긴 양의 단계 (파랑 < 초록 < 빨강)
    for (const g of curr.g) {
      const q = was.g.get(g[0]);
      blit(this.spr.gems[Math.min(2, Math.max(0, g[3]))]!, mix(q?.[1], g[1]), mix(q?.[2], g[2]) + Math.sin(now / 200 + g[0]) * 1.5);
    }

    // 필드 아이템 (화면 안에 들어온 것만 보인다. 멀리 있는 것은 화면 가장자리의 표시와 미니맵이 알려준다)
    for (const it of curr.i) {
      const kind = FIELD_ITEM_KINDS[it[1]];
      if (!kind) continue;
      // 곧 사라질 것은 깜빡인다 (동작 줄이기 설정에서는 흐리게만)
      if (it[4] && !this.calm && Math.floor(now / 160) % 2 === 0) continue;
      const bob = this.calm ? 0 : Math.sin(now / 260 + it[0]) * 2;
      const pulse = this.calm ? 0.35 : 0.3 + 0.2 * Math.sin(now / 180 + it[0]);
      // 보물상자: 금빛이 번지고 빛줄기가 솟는다 (보스가 남긴 것. 사라지지 않으니 찾아가서 닿으면 열린다)
      if (kind === 'chest') this.drawChestGlow(sx(it[2]), sy(it[3]), S, now, it[0]);
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

    /** 적 한 마리를 그릴 자리와 그림 (보간, 흔들림, 피격 번쩍임과 밀려남) */
    const enemySpot = (e: Snapshot['e'][number], id: EnemyId): [number, number, Sprite] => {
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
      return [ex, ey, sprite];
    };
    // 보스는 졸개 위에 그린다 (가려지지 않게). 그 밑에는 그림자와 보라 고리, 월요일 아침은 붉게 일렁이는 빛을 먼저 깐다
    const bosses: [EnemyId, number, number, Sprite, number][] = [];
    for (const e of curr.e) {
      const id = ENEMY_IDS[e[1]];
      if (!id || !IS_BOSS[e[1]]) continue;
      const [ex, ey, sprite] = enemySpot(e, id);
      bosses.push([id, ex, ey, sprite, e[0]]);
      this.drawBossGround(id, sx(ex), sy(ey), sprite.height, ex, ey, now);
    }
    for (const e of curr.e) {
      const id = ENEMY_IDS[e[1]];
      if (!id || IS_BOSS[e[1]]) continue;
      const [ex, ey, sprite] = enemySpot(e, id);
      // 깨지는 테스트: 가끔 흐려졌다 돌아온다 (됐다 안 됐다 하는 테스트)
      if (id === 'flaky_test' && !this.calm && hash(e[0], Math.floor(now / 300)) % 6 === 0) ctx.globalAlpha = 0.35;
      blit(sprite, ex, ey);
      ctx.globalAlpha = 1;
    }
    // 보스 머리 위 체력바: 서버가 보낸 남은 비율 (두 스냅샷 사이를 이어서 부드럽게 줄어든다)
    const hpNow = new Map(curr.b);
    const hpWas = new Map(prev.b);
    for (const [, ex, ey, sprite, bid] of bosses) {
      blit(sprite, ex, ey);
      const pct = hpNow.get(bid);
      if (pct !== undefined) this.drawBossHp(sx(ex), sy(ey) - (sprite.height >> 1), sprite.width, mix(hpWas.get(bid), pct) / 100);
    }

    // 러버덕은 서버가 위치를 보내지 않는다. 보간된 주인 위치와 보간된 서버 시간으로 직접 계산하므로
    // 다른 것들과 같은 프레임률로 매끄럽게 돈다. (판정은 서버가 같은 식으로 한다)
    const duckTime = sample.tick * DT;

    // 닉네임은 캐릭터를 다 그린 뒤에 그린다 (가까이 붙어 있을 때 옆 사람 캐릭터에 이름이 가려지지 않게)
    const labels: NameLabel[] = [];
    for (const p of curr.p) {
      const q = was.p.get(p[0]);
      const [x, y] = spot(p, q);
      const px = sx(x);
      const py = sy(y);
      if (!p[4]) {
        blit(this.spr.grave, x, y);
        labels.push({ id: p[0], color: NAME_COLOR.down, px, bottom: py - 5 * S });
        continue;
      }
      // 내 캐릭터는 걷는 그림과 바라보는 쪽도 입력을 바로 따라간다
      const ahead = mine && p[0] === curr.me.id && this.predictor.active;
      const moving = ahead ? this.predictor.moving : q ? Math.abs(q[1]! - p[1]) + Math.abs(q[2]! - p[2]) > 0.2 : false;
      const face = (ahead && this.predictor.facing) || p[3];
      const frame = moving && Math.floor(now / 140) % 2 ? 1 : 0;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(px - 5 * S, py + 6 * S, 10 * S, 2 * S);
      // 피해를 받지 않는 동안에는 깜빡인다: 되살아난 직후(p[7])는 느리게, 맞은 직후(p[12])는 빠르게.
      // 동작 줄이기 설정에서는 반투명으로만
      if (p[7]) ctx.globalAlpha = this.calm ? 0.6 : Math.floor(now / 90) % 2 ? 0.35 : 0.9;
      else if (p[12]) ctx.globalAlpha = this.calm ? 0.6 : Math.floor(now / 50) % 2 ? 0.2 : 1;
      const body = this.spr.dev[face < 0 ? 'l' : 'r'][frame];
      blit(body, x, y);
      ctx.globalAlpha = 1;
      // 2단계 인증: 남은 방패 수만큼 색이 바뀌는 고리 (1 파랑, 2 초록, 3 노랑)
      if (p[11] > 0) this.drawShield(px, py, S, p[11], now);
      // 머리 위 체력바 / 이름
      // 그림 꼭대기에서 4픽셀 위 (테마의 모자처럼 그림이 위로 솟으면 그만큼 올라간다. 기본 그림은 11픽셀 위)
      const bx = px - 7 * S;
      const by = sy(y) - (body.height >> 1) - 4 * S;
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
      const x = mix(p?.[2], s[2]);
      const y = mix(p?.[3], s[3]);
      // 날아가는 커밋과 멀티스레드의 실: 날아온 쪽으로 꼬리를 그린다 (방향은 직전 위치에서)
      if ((kind === 'drill' || kind === 'bomb') && p) this.drawTail(kind, sx(x), sy(y), s[2] - p[2]!, s[3] - p[3]!, S);
      if (kind === 'canary' && p) {
        // 나는 쪽을 바라본다 (좌우로 거의 안 움직일 때는 바라보던 쪽 그대로)
        const dx = s[2] - p[2]!;
        if (Math.abs(dx) > 0.05) this.facingLeft.set(s[0], dx < 0);
        if (this.facingLeft.get(s[0])) spr = this.spr.canaryL;
      }
      blit(spr, x, y);
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

    this.drawWeather(cx, cy, dt);
    this.drawEdgeItems(curr.i, sx, sy, now);
    this.drawStick();
  }

  /**
   * 화면 밖(또는 HUD 에 가려진) 필드 아이템과 보물상자를 화면 가장자리에 표시한다: 아이템 그림을 담은 상자와 그쪽을 가리키는 화살표.
   * 화면 가운데에서 아이템 쪽으로 가다가 화면 끝이나 HUD 에 닿기 직전에 놓는다 (edge.ts). 보물상자는 가까운 3개까지.
   * 새로 놓인 것은 4초 동안 테두리가 퍼지고, 곧 사라질 것은 깜빡인다 (동작 줄이기 설정에서는 고정된 테두리, 흐리게).
   * 서버가 이미 보내 준 것(필드 아이템은 거리와 상관없이, 보물상자는 미니맵 범위의 두 배 안)만 쓴다.
   */
  private drawEdgeItems(items: Snapshot['i'], sx: (x: number) => number, sy: (y: number) => number, now: number): void {
    const { ctx, pxW, pxH } = this;
    const S = this.scale;
    // HUD 의 자리는 CSS 픽셀로 온다. 캔버스는 기기 픽셀 (조이스틱과 같은 비율)
    const k = pxW / Math.max(1, window.innerWidth);
    const dev = (b: Box): Box => ({ x0: b.x0 * k, y0: b.y0 * k, x1: b.x1 * k, y1: b.y1 * k });
    const hud = this.hudBoxes.map(dev);
    const hb = this.hudBounds && this.hudBounds.x1 > this.hudBounds.x0 && this.hudBounds.y1 > this.hudBounds.y0 ? dev(this.hudBounds) : null;
    const bounds: Box = hb ?? { x0: 0, y0: 0, x1: pxW, y1: pxH };
    const cx = pxW >> 1;
    const cy = pxH >> 1;

    const present = new Set<number>();
    const hidden: EdgeItem[] = [];
    for (const it of items) {
      const kind = FIELD_ITEM_KINDS[it[1]];
      if (!kind) continue;
      present.add(it[0]);
      if (!this.edgeSeen.has(it[0])) this.edgeSeen.set(it[0], now);
      const x = sx(it[2]);
      const y = sy(it[3]);
      if (hiddenAt(x, y, pxW, pxH, hud)) hidden.push({ id: it[0], x, y, kind, fading: it[4] === 1 });
    }
    for (const id of this.edgeSeen.keys()) if (!present.has(id)) this.edgeSeen.delete(id);
    if (hidden.length === 0) return;

    const half = EDGE_HALF * S;
    const arrow = EDGE_ARROW * S;
    // 화면 끝·HUD 에서 띄울 거리: 화살표 끝(어두운 테두리 포함)과, 아이템 쪽으로 들썩이는 거리(2칸)까지 들어가게
    const r = half + arrow + 3 * S;
    const min = EDGE_MIN * S;
    const targets = pickEdgeTargets(hidden, (t) => t.kind === 'chest', cx, cy);
    // 몰려 있으면 방향을 조금씩 돌려 겹치지 않게 놓는다 (상자 바깥 테두리끼리 한 칸 띄운다)
    const spots = placeEdge(targets, cx, cy, bounds, hud, r, min, half * 2 + 3 * S);

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      // 곧 사라질 것은 깜빡인다 (미니맵과 같은 박자)
      if (t.fading && !this.calm && Math.floor(now / 250) % 2 === 0) continue;
      // 화살표는 표시 자리에서 아이템 쪽을 가리킨다 (겹치지 않게 비켜 놓았어도 아이템을 가리키도록)
      const [ox, oy] = spots[i]!;
      const len = Math.hypot(t.x - ox, t.y - oy) || 1;
      const ux = (t.x - ox) / len;
      const uy = (t.y - oy) / len;
      // 아이템 쪽으로 살짝 들썩인다 ("이쪽")
      const nudge = this.calm ? 0 : (0.5 + 0.5 * Math.sin(now / 180)) * 2 * S;
      const x = Math.round(ox + ux * nudge);
      const y = Math.round(oy + uy * nudge);
      const color = EDGE_COLOR[t.kind];
      if (t.fading && this.calm) ctx.globalAlpha = 0.5;

      // 화살표: 상자 가장자리에서 아이템 쪽으로 (어두운 테두리를 먼저)
      const out = half / Math.max(Math.abs(ux), Math.abs(uy));
      const px = -uy;
      const py = ux;
      const tri = (back: number, tip: number, w: number, fill: string): void => {
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.moveTo(x + ux * tip, y + uy * tip);
        ctx.lineTo(x + ux * back + px * w, y + uy * back + py * w);
        ctx.lineTo(x + ux * back - px * w, y + uy * back - py * w);
        ctx.closePath();
        ctx.fill();
      };
      tri(out - S, out + arrow + S, 4 * S + S, '#11111b');
      tri(out, out + arrow, 4 * S, color);

      // 상자: 어두운 바탕, 아이템 색 테두리, 가운데에 아이템 그림
      ctx.fillStyle = '#11111b';
      ctx.fillRect(x - half - S, y - half - S, half * 2 + 2 * S, half * 2 + 2 * S);
      ctx.fillStyle = color;
      ctx.fillRect(x - half, y - half, half * 2, half * 2);
      ctx.fillStyle = 'rgba(17,17,27,0.88)';
      ctx.fillRect(x - half + S, y - half + S, half * 2 - 2 * S, half * 2 - 2 * S);
      const sp = this.spr.items[t.kind];
      ctx.drawImage(sp, x - (sp.width >> 1), y - (sp.height >> 1));

      // 새로 놓인 것: 테두리가 퍼져 나간다
      const age = now - (this.edgeSeen.get(t.id) ?? now);
      if (age < EDGE_NEW_MS) {
        const grow = this.calm ? 3 * S : Math.round(S + ((age % 1000) / 1000) * 6 * S);
        ctx.strokeStyle = color;
        ctx.lineWidth = S;
        ctx.strokeRect(x - half - grow + S / 2, y - half - grow + S / 2, half * 2 + grow * 2 - S, half * 2 + grow * 2 - S);
      }
      ctx.globalAlpha = 1;
    }
  }

  /**
   * 화면 위로 내리는 것 (눈 등). 게임과 상관없는 장식이라 화면 좌표로만 다룬다.
   * 카메라가 움직이면 절반만큼 따라 밀려서(시차) 멀리 있는 것처럼 보인다. "동작 줄이기"가 켜져 있으면 그리지 않는다.
   */
  private drawWeather(camX: number, camY: number, dt: number): void {
    const w = this.theme.weather;
    if (!w || this.calm) return;
    const { ctx, pxW, pxH } = this;
    const S = this.scale;
    const W = pxW / S;
    const H = pxH / S;
    const want = Math.min(MAX_FLAKES, Math.round(((W * H) / 10000) * w.density));
    while (this.flakes.length < want) {
      this.flakes.push({
        x: Math.random() * W,
        y: Math.random() * H,
        v: w.speed[0] + Math.random() * (w.speed[1] - w.speed[0]),
        phase: Math.random() * Math.PI * 2,
        size: Math.random() < 0.25 ? 2 : 1,
        color: w.colors[Math.floor(Math.random() * w.colors.length)]!,
      });
    }
    if (this.flakes.length > want) this.flakes.length = want;
    const step = Math.min(dt, 0.1);
    const mod = (a: number, m: number): number => ((a % m) + m) % m;
    for (const f of this.flakes) {
      f.y = mod(f.y + f.v * step, H);
      f.phase += step * 1.3;
      const x = mod(f.x + Math.sin(f.phase) * w.sway - camX * 0.5, W);
      const y = mod(f.y - camY * 0.5, H);
      ctx.fillStyle = f.color;
      ctx.fillRect(Math.round(x * S), Math.round(y * S), f.size * S, f.size * S);
    }
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
      if (z.to <= c.t || (z.gone !== undefined && z.gone <= c.t)) {
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
      case 'fire': {
        // 금요일 배포: 주황 불바다. 처음에 웅덩이처럼 퍼지고, 안에서 불티 세 개가 위로 날린다 (동작 줄이기 설정에서는 가만히)
        const tail = this.zoneFade(z, c.t);
        const r = calm ? R : R * Math.min(1, 0.6 + (0.4 * age) / POOL_GROW);
        ctx.globalAlpha = 0.26 * tail;
        ctx.fillStyle = '#fab387';
        this.circle(X, Y, r);
        ctx.fill();
        ctx.globalAlpha = 0.7 * tail;
        ctx.strokeStyle = '#f38ba8';
        ctx.lineWidth = S;
        ctx.stroke();
        ctx.globalAlpha = 0.85 * tail;
        for (let i = 0; i < 3; i++) {
          const a = z.id * 1.7 + i * 2.1;
          const rise = calm ? 0.5 : (c.now / 700 + i * 0.33 + z.id * 0.29) % 1;
          ctx.fillStyle = i === 1 ? '#f9e2af' : '#fab387';
          ctx.fillRect(X + Math.round(Math.cos(a) * r * 0.5), Y + Math.round((0.4 - rise * 0.9) * r), c.S, c.S);
        }
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
        // git clean: 주인에게서 퍼져 나가는 얇은 흰·보라 고리 (화면 전체를 번쩍이지 않는다). rm -rf node_modules(aux 1)는 초록
        const r = calm ? R : R * (0.15 + 0.85 * (1 - (1 - p) * (1 - p)));
        ctx.globalAlpha = (calm ? 0.45 : 0.85) * fade;
        ctx.strokeStyle = '#eff1f5';
        ctx.lineWidth = 3 * S;
        this.circle(X, Y, r);
        ctx.stroke();
        ctx.globalAlpha *= 0.7;
        ctx.strokeStyle = z.aux === 1 ? '#a6e3a1' : '#cba6f7';
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

  /**
   * 2단계 인증: 캐릭터를 감싸는 고리와 작은 반짝임 (px, py 는 캐릭터 가운데, 기기 픽셀).
   * 색이 남은 방패 수를 알려준다 (1 파랑, 2 초록, 3 노랑). 아주 천천히 숨 쉬듯 (깜빡이지 않는다)
   */
  private drawShield(px: number, py: number, S: number, charges: number, now: number): void {
    const { ctx } = this;
    const color = SHIELD_COLOR[Math.min(SHIELD_COLOR.length, charges) - 1] ?? SHIELD_COLOR[0];
    const r = (11 + (this.calm ? 0 : Math.sin(now / 400) * 0.5)) * S;
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = color;
    this.circle(px, py, r);
    ctx.fill();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = color;
    ctx.lineWidth = S;
    ctx.stroke();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#eff1f5';
    ctx.fillRect(Math.round(px - r * 0.55), Math.round(py - r * 0.6), 2 * S, S);
    ctx.fillRect(Math.round(px - r * 0.65), Math.round(py - r * 0.6) + S, S, S);
    ctx.globalAlpha = 1;
  }

  /**
   * 보스 밑에 까는 것 (X, Y 는 보스 가운데, 기기 픽셀. h 는 그림의 높이, 기기 픽셀).
   * 보통 보스: 발밑의 그림자와 보라 고리 (미니맵의 보스 표시와 같은 색).
   * 월요일 아침: 붉게 일렁이는 빛과 흩날리는 불티 (검은 몸이 어두운 바닥에서도 바로 보이게. 닿으면 끝이다)
   */
  private drawBossGround(id: EnemyId, X: number, Y: number, h: number, wx: number, wy: number, now: number): void {
    const { ctx } = this;
    const S = this.scale;
    const r = ENEMIES[id].r;
    if (id === 'monday') {
      const pulse = this.calm ? 0.5 : 0.5 + 0.5 * Math.sin(now / 140);
      ctx.fillStyle = '#e64553';
      ctx.globalAlpha = 0.12 + 0.1 * pulse;
      this.circle(X, Y, (r * 2.6 + 3 * pulse) * S);
      ctx.fill();
      ctx.globalAlpha = 0.2 + 0.12 * pulse;
      this.circle(X, Y, r * 1.6 * S);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (!this.calm && this.particles.length < MAX_PARTICLES) {
        const a = Math.random() * Math.PI * 2;
        this.particles.push({ x: wx + Math.cos(a) * r, y: wy + Math.sin(a) * r, vx: Math.cos(a) * 12, vy: -25 - Math.random() * 20, life: 0.3 + Math.random() * 0.3, color: Math.random() < 0.5 ? '#e64553' : '#fab387', size: 1 });
      }
      return;
    }
    const footY = Y + (h >> 1) - S;
    ctx.beginPath();
    ctx.ellipse(X, footY, r * 1.1 * S, r * 0.4 * S, 0, 0, Math.PI * 2);
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#11111b';
    ctx.fill();
    ctx.globalAlpha = this.calm ? 0.6 : 0.5 + 0.25 * Math.sin(now / 300);
    ctx.strokeStyle = '#cba6f7';
    ctx.lineWidth = S;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** 보물상자: 금빛이 번지는 원과 위로 솟는 빛줄기, 떠오르는 반짝이 (X, Y 는 상자 가운데, 기기 픽셀) */
  private drawChestGlow(X: number, Y: number, S: number, now: number, seed: number): void {
    const { ctx } = this;
    const pulse = this.calm ? 0.5 : 0.5 + 0.5 * Math.sin(now / 240 + seed);
    ctx.fillStyle = '#f9e2af';
    ctx.globalAlpha = 0.1 + 0.08 * pulse;
    this.circle(X, Y, (17 + 2 * pulse) * S);
    ctx.fill();
    ctx.globalAlpha = 0.14 + 0.1 * pulse;
    this.circle(X, Y, 11 * S);
    ctx.fill();
    // 빛줄기: 멀리서도 상자가 있는 곳을 알 수 있게
    ctx.globalAlpha = 0.16 + 0.12 * pulse;
    ctx.fillRect(X - 3 * S, Y - 40 * S, 6 * S, 36 * S);
    ctx.globalAlpha = 0.3 + 0.2 * pulse;
    ctx.fillRect(X - S, Y - 40 * S, 2 * S, 36 * S);
    if (!this.calm) {
      for (let i = 0; i < 3; i++) {
        const t = (now / 900 + i / 3 + seed * 0.37) % 1;
        const a = seed * 1.7 + i * 2.1;
        const gx = Math.round(X + Math.cos(a) * 10 * S);
        const gy = Math.round(Y - 4 * S - t * 20 * S);
        ctx.globalAlpha = 0.9 * (1 - t);
        ctx.fillRect(gx - S, gy, 3 * S, S);
        ctx.fillRect(gx, gy - S, S, 3 * S);
      }
    }
    ctx.globalAlpha = 1;
  }

  /**
   * 날아가는 것의 꼬리 (X, Y 는 머리, 기기 픽셀. dx, dy 는 한 틱 동안 움직인 거리, 월드 단위).
   * 날아가는 커밋(drill): 초록 줄 (git 그래프의 선처럼). 멀티스레드(bomb): 바늘이 끌고 가는 가는 분홍 실
   */
  private drawTail(kind: 'drill' | 'bomb', X: number, Y: number, dx: number, dy: number, S: number): void {
    const len = Math.hypot(dx, dy);
    if (len < 0.5) return;
    const { ctx } = this;
    const L = (kind === 'drill' ? 12 : 16) * S;
    const tx = X - (dx / len) * L;
    const ty = Y - (dy / len) * L;
    ctx.beginPath();
    ctx.moveTo(X, Y);
    ctx.lineTo(tx, ty);
    if (kind === 'drill') {
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = '#a6e3a1';
      ctx.lineWidth = 2 * S;
    } else {
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = '#f38ba8';
      ctx.lineWidth = S;
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawBackground(cx: number, cy: number): void {
    const { ctx, pxW, pxH } = this;
    const S = this.scale;
    const camX = cameraPx(cx, S);
    const camY = cameraPx(cy, S);
    const hx = pxW >> 1;
    const hy = pxH >> 1;
    const floor = this.theme.floor;
    ctx.fillStyle = floor.base;
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
          ctx.fillStyle = floor.tile;
          ctx.fillRect(px, py, size, size);
        }
        ctx.fillStyle = floor.dot;
        ctx.fillRect(px, py, S, S);
        const hsh = hash(tx, ty);
        if (hsh % 5 === 0) {
          const glyph = this.glyphs[hsh % 3 === 0 ? 0 : 1]![(hsh >>> 8) % floor.glyphs.length]!;
          ctx.drawImage(glyph, px + (4 + ((hsh >>> 4) % 10)) * S, py + (4 + ((hsh >>> 12) % 14)) * S);
        }
      }
    }
  }

  /**
   * 보스 체력바: 그림 위 가운데에 (기기 픽셀). 폭은 그림 폭과 같고(최소 20 논리 픽셀), 높이는 3 논리 픽셀.
   * 어두운 테두리 안에 남은 만큼 빨강, 줄어든 자리는 어두운 빨강으로 남긴다
   */
  private drawBossHp(cx: number, top: number, spriteW: number, ratio: number): void {
    const { ctx } = this;
    const S = this.scale;
    const w = Math.max(20 * S, spriteW);
    const h = 3 * S;
    const x = Math.round(cx - w / 2);
    const y = Math.round(top - h - 3 * S);
    ctx.fillStyle = '#11111b';
    ctx.fillRect(x - S, y - S, w + 2 * S, h + 2 * S);
    ctx.fillStyle = '#5c1a2b';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#e64553';
    ctx.fillRect(x, y, Math.max(S, Math.round(w * Math.max(0, Math.min(1, ratio)))), h);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(x, y, Math.max(S, Math.round(w * Math.max(0, Math.min(1, ratio)))), S);
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
