/** 픽셀아트 스프라이트: 외부 이미지 없이 문자 그리드 → 오프스크린 캔버스로 구워서 사용 */
import type { EnemyId } from '@friday-deploy/shared';

const PAL: Record<string, string> = {
  k: '#11111b', // 외곽선
  w: '#eff1f5',
  s: '#f5c9a6', // 피부
  h: '#5c4033', // 머리
  b: '#89b4fa',
  B: '#5a7fd6',
  r: '#f38ba8',
  R: '#c9516f',
  g: '#a6e3a1',
  G: '#3b7a4a',
  y: '#f9e2af',
  Y: '#d9a441',
  o: '#fab387',
  p: '#cba6f7',
  P: '#8f6fd1',
  c: '#94e2d5',
  l: '#bac2de',
  d: '#45475a',
  t: '#d8c7a0', // 오래된 PC 베이지
  T: '#b3a07a',
};

export type Sprite = HTMLCanvasElement;

function bake(rows: string[]): Sprite {
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

/** 후드티 + 헤드폰 + 노트북을 든 개발자 (2프레임 걷기) */
const DEV_A = [
  '....kkkkkk....',
  '...khhhhhhk...',
  '..kdhhhhhhdk..',
  '..kdssssssdk..',
  '..kdskssksdk..',
  '...kssssssk...',
  '..kkbssssbkk..',
  '.kbbbbbbbbbbk.',
  '.kbbkllllkbbk.',
  '.ksbklgglkbsk.',
  '..kkkllllkkk..',
  '...kBBkkBBk...',
  '...kBBk.kBBk..',
  '...kkk..kkk...',
];
const DEV_B = [...DEV_A.slice(0, 11), '...kBBkkBBk...', '..kBBk..kBBk..', '..kkk...kkk...'];

const SPR = {
  bug: [
    '.k......k.',
    '..k.kk.k..',
    '..kRrrRk..',
    '.krkrrkrk.',
    'kkrrkkrrkk',
    '.krkrrkrk.',
    'k.kRrrRk.k',
    '...kkkk...',
  ],
  null_ptr: [
    '..kkkkkk..',
    '.kwwwwwwk.',
    'kwwwwwwwwk',
    'kwkkwwkkwk',
    'kwkkwwkkwk',
    'kwwwwwwwwk',
    'kwwwkkwwwk',
    'klwwwwwwlk',
    'klwlwwlwlk',
    'kl.klk.klk',
    '.k..k...k.',
  ],
  merge_conflict: [
    '...kkkkkkkk...',
    '..krrrrggggk..',
    '.krrrrrgggggk.',
    'krrwwrrggwwggk',
    'krrwkrrggkwggk',
    'krrrrrrggggggk',
    'krrkrrkkggkggk',
    'kRrrkkrggkkgGk',
    'kRRrrrrggggGGk',
    '.kRRrrrgggGGk.',
    '..kRRRRGGGGk..',
    '...kkkkkkkk...',
  ],
  mem_leak: [
    '.....kk.....',
    '....kbbk....',
    '...kbbbbk...',
    '..kbwbbbbk..',
    '.kbwbbbbbbk.',
    'kbbbbbbbbbbk',
    'kbbkbbbbkbbk',
    'kbbkbbbbkbbk',
    'kBbbbkkbbbBk',
    '.kBBbbbbBBk.',
    '..kkkkkkkk..',
  ],
  legacy_code: [
    '..kkkkkkkkkkkkkkkkkk..',
    '.kttttttttttttttttttk.',
    'kttkkkkkkkkkkkkkkkkttk',
    'kttkGGGGGGGGGGGGGGkttk',
    'kttkGgggGGGGGGgggGkttk',
    'kttkGGGggGGGGggGGGkttk',
    'kttkGGkkkGGGGkkkGGkttk',
    'kttkGGkgkGGGGkgkGGkttk',
    'kttkGGGGGGGGGGGGGGkttk',
    'kttkGGGkkkkkkkkGGGkttk',
    'kttkGGkGGGGGGGGkGGkttk',
    'kttkGGGGGGGGGGGGGGkttk',
    'kttkkkkkkkkkkkkkkkkttk',
    'kTtttttttttttttrttyTTk',
    '.kTTTTTTTTTTTTTTTTTTk.',
    '..kkkkkkttttttkkkkkk..',
    '....kkkkTTTTTTkkkk....',
    '...kttttttttttttttk...',
    '...kkkkkkkkkkkkkkkk...',
  ],
  duck: ['..kkkk...', '.kyyyyk..', '.kykyyokk', '.kyyyyook', 'kkyyyykk.', 'kyyyyyyk.', 'kyYYYyyk.', '.kkkkkk..'],
  commit: ['..kk..', '.kggk.', 'kgwggk', 'kggGgk', '.kgGk.', '..kk..'],
  log: ['.kkkk.', 'kwwwwk', 'kwyywk', 'kwwwwk', '.kkkk.'],
  regex: ['k..k..k', '.kpkpk.', '..kpk..', 'kpppppk', '..kpk..', '.kpkpk.', 'k..k..k'],
  ai: ['...k...', '..kck..', '.kcwck.', 'kcwwwck', '.kcwck.', '..kck..', '...k...'],
  grave: ['..kkkk..', '.kllllk.', 'kllkkllk', 'klkllklk', 'kllkkllk', 'kllllllk', 'kddddddk', 'kkkkkkkk'],
} satisfies Record<string, string[]>;

export interface SpriteSet {
  dev: { r: [Sprite, Sprite]; l: [Sprite, Sprite] };
  enemy: Record<EnemyId, Sprite>;
  duck: Sprite;
  commit: Sprite;
  shots: [Sprite, Sprite, Sprite];
  grave: Sprite;
}

export function loadSprites(): SpriteSet {
  const a = bake(DEV_A);
  const b = bake(DEV_B);
  return {
    dev: { r: [a, b], l: [flip(a), flip(b)] },
    enemy: {
      bug: bake(SPR.bug),
      null_ptr: bake(SPR.null_ptr),
      merge_conflict: bake(SPR.merge_conflict),
      mem_leak: bake(SPR.mem_leak),
      legacy_code: bake(SPR.legacy_code),
    },
    duck: bake(SPR.duck),
    commit: bake(SPR.commit),
    shots: [bake(SPR.log), bake(SPR.regex), bake(SPR.ai)],
    grave: bake(SPR.grave),
  };
}
