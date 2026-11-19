/** 픽셀아트 스프라이트: 외부 이미지 없이 문자 그리드(art.ts) → 오프스크린 캔버스로 구워서 사용 */
import { ENEMY_IDS, FIELD_ITEM_KINDS, SHOT_KINDS, type EnemyId, type FieldItemKind, type ShotKind } from '@friday-deploy/shared';
import { DEV_A, DEV_B, ENEMY_ART, GEM_ART, ITEM_ART, MISC_ART, PAL, PIZZA, SHOT_ART } from './art';

export type Sprite = HTMLCanvasElement;

function bake(rows: readonly string[]): Sprite {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const col = PAL[row[x]!];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 1, 1);
    }
  });
  return c;
}

function flip(src: Sprite): Sprite {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d')!;
  ctx.translate(src.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(src, 0, 0);
  return c;
}

/** 같은 모양을 한 가지 색으로 칠한 복사본. alpha 가 1 이면 실루엣, 1 보다 작으면 원래 그림 위에 색을 덧입힌다 */
function tint(src: Sprite, color: string, alpha = 1): Sprite {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = 'source-atop';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

/** 피격 순간에 번쩍이는 흰색 실루엣 */
const whiten = (src: Sprite): Sprite => tint(src, '#ffffff');
/** 코드 프리즈에 얼어 있는 동안의 얼음빛 */
const freeze = (src: Sprite): Sprite => tint(src, '#89dceb', 0.6);

/** 레코드의 값마다 같은 변환 (적 종류별, 투사체 종류별 스프라이트) */
function mapSprites<K extends string>(keys: readonly K[], fn: (k: K) => Sprite): Record<K, Sprite> {
  const out = {} as Record<K, Sprite>;
  for (const k of keys) out[k] = fn(k);
  return out;
}

export interface SpriteSet {
  dev: { r: [Sprite, Sprite]; l: [Sprite, Sprite] };
  enemy: Record<EnemyId, Sprite>;
  /** 피격 순간의 흰색 실루엣 */
  enemyHit: Record<EnemyId, Sprite>;
  /** 얼어 있는 적 (얼음빛을 덧입힌 것) */
  enemyFrozen: Record<EnemyId, Sprite>;
  duck: Sprite;
  /** 경험치: 색 단계(0 파랑, 1 초록, 2 빨강)별 */
  gems: [Sprite, Sprite, Sprite];
  /** 투사체·소환물 (SHOT_KINDS 의 종류별) */
  shots: Record<ShotKind, Sprite>;
  /** 왼쪽으로 날아가는 카나리아 (좌우를 뒤집은 것) */
  canaryL: Sprite;
  grave: Sprite;
  heal: Sprite;
  /** 필드 아이템 (피자는 적이 떨어뜨리는 회복 아이템과 같은 그림) */
  items: Record<FieldItemKind, Sprite>;
}

export function loadSprites(): SpriteSet {
  const a = bake(DEV_A);
  const b = bake(DEV_B);
  const enemy = mapSprites(ENEMY_IDS, (id) => bake(ENEMY_ART[id]));
  const shots = mapSprites(SHOT_KINDS, (k) => bake(SHOT_ART[k]));
  return {
    dev: { r: [a, b], l: [flip(a), flip(b)] },
    enemy,
    enemyHit: mapSprites(ENEMY_IDS, (id) => whiten(enemy[id])),
    enemyFrozen: mapSprites(ENEMY_IDS, (id) => freeze(enemy[id])),
    duck: bake(MISC_ART.duck),
    gems: [bake(GEM_ART[0]), bake(GEM_ART[1]), bake(GEM_ART[2])],
    shots,
    canaryL: flip(shots.canary),
    grave: bake(MISC_ART.grave),
    heal: bake(PIZZA),
    items: mapSprites(FIELD_ITEM_KINDS, (k) => bake(ITEM_ART[k])),
  };
}

/** 정수 배율로 키운 복사본 (보간 없이 → 픽셀이 또렷하게 유지된다) */
export function upscale(src: Sprite, k: number): Sprite {
  const c = document.createElement('canvas');
  c.width = src.width * k;
  c.height = src.height * k;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** 스프라이트 세트 전체를 현재 화면 배율로 미리 키워 둔다. 그리는 순간에는 1:1 복사만 하면 된다. */
export function scaleSprites(set: SpriteSet, k: number): SpriteSet {
  const up = (s: Sprite): Sprite => upscale(s, k);
  return {
    dev: { r: [up(set.dev.r[0]), up(set.dev.r[1])], l: [up(set.dev.l[0]), up(set.dev.l[1])] },
    enemy: mapSprites(ENEMY_IDS, (id) => up(set.enemy[id])),
    enemyHit: mapSprites(ENEMY_IDS, (id) => up(set.enemyHit[id])),
    enemyFrozen: mapSprites(ENEMY_IDS, (id) => up(set.enemyFrozen[id])),
    duck: up(set.duck),
    gems: [up(set.gems[0]), up(set.gems[1]), up(set.gems[2])],
    shots: mapSprites(SHOT_KINDS, (kind) => up(set.shots[kind])),
    canaryL: up(set.canaryL),
    grave: up(set.grave),
    heal: up(set.heal),
    items: mapSprites(FIELD_ITEM_KINDS, (k) => up(set.items[k])),
  };
}

/** 화면(HUD, 메뉴)과 같은 글꼴 순서 (style.css 의 --font) */
const UI_FONT = "'Galmuri11', 'DungGeunMo', 'NeoDunggeunmo', ui-monospace, 'SF Mono', Menlo, Consolas, 'D2Coding', monospace";
/** 닉네임 글자 크기 (논리 픽셀) */
const LABEL_SIZE = 7;

/**
 * 머리 위 닉네임용 글자 스프라이트.
 * 다른 스프라이트처럼 저해상도로 그려서 키우지 않고, 화면 해상도로 바로 그린다 (HUD 글자와 같은 방식).
 * 한글처럼 획이 많은 글자는 8~10픽셀 격자에서 뭉개져 읽기 어렵고, 기기마다 글꼴이 달라 결과도 들쭉날쭉하기 때문이다.
 * 어두운 테두리를 둘러 적이나 배경 글자 위에서도 읽힌다.
 * 닉네임은 서버가 정리한 문자열이고 캔버스에 그리기만 하므로 마크업으로 해석될 일이 없다.
 * @param scale 논리 픽셀 하나가 차지하는 기기 픽셀 수 (돌려주는 스프라이트는 이미 그 크기다. 더 키우지 않는다)
 */
export function labelSprite(text: string, color: string, scale: number): Sprite {
  const size = LABEL_SIZE * scale;
  const edge = Math.max(2, Math.round(scale * 0.75));
  const font = `bold ${size}px ${UI_FONT}`;
  const c = document.createElement('canvas');
  const probe = c.getContext('2d')!;
  probe.font = font;
  c.width = Math.max(1, Math.ceil(probe.measureText(text).width) + edge * 2);
  c.height = Math.ceil(size * 1.25) + edge * 2;
  const ctx = c.getContext('2d')!;
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.lineWidth = edge * 2;
  ctx.strokeStyle = '#11111b';
  ctx.strokeText(text, edge, edge + size);
  ctx.fillStyle = color;
  ctx.fillText(text, edge, edge + size);
  return c;
}

/** 글자를 저해상도로 그린 스프라이트 (키우면 픽셀아트 느낌이 유지된다) */
export function textSprite(text: string, color: string): Sprite {
  const c = document.createElement('canvas');
  const probe = c.getContext('2d')!;
  probe.font = '8px monospace';
  c.width = Math.max(1, Math.ceil(probe.measureText(text).width) + 1);
  c.height = 10;
  const ctx = c.getContext('2d')!;
  ctx.font = '8px monospace';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  ctx.fillText(text, 0, 8);
  return c;
}
