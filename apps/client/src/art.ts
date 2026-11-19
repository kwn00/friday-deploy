/**
 * 스프라이트 그림: 글자 격자 (글자 하나 = 픽셀 하나, 색은 PAL). '.' 은 투명하다.
 * 화면(DOM)을 쓰지 않아서 단위 테스트에서 모양을 검사할 수 있다. 캔버스로 굽는 것은 sprites.ts 가 한다.
 * 작은 것은 손으로 그렸고, 큰 보스는 도형(Pixels)으로 그린 뒤 바깥에 테두리를 두른다 (손으로 그린 것과 같은 모양새).
 */
import type { EnemyId, FieldItemKind, ShotKind } from '@friday-deploy/shared';

export const PAL: Record<string, string> = {
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
  O: '#d9773f',
  p: '#cba6f7',
  P: '#8f6fd1',
  c: '#94e2d5',
  l: '#bac2de',
  n: '#7f849c',
  m: '#585b70',
  d: '#45475a',
  t: '#d8c7a0', // 오래된 PC 베이지
  T: '#b3a07a',
  e: '#e64553', // 진한 빨강 (빨간 버그, 월요일 아침의 눈)
  E: '#8f1d33',
  z: '#24482c', // 아주 어두운 초록 (머지 지옥)
  f: '#f5c2e7', // 분홍 (멀티스레드의 실)
  u: '#74c7ec', // 서버 불빛 (모놀리스)
  j: '#b4befe', // 연보라 (버그 떼의 날개)
  q: '#9a6a43', // 나무 (보물상자)
  Q: '#5e3a24',
  x: '#1c1220', // 월요일 아침의 몸 (거의 검정)
  X: '#3d2a44',
};

/** 후드티 + 헤드폰 + 노트북을 든 개발자 (2프레임 걷기) */
export const DEV_A = [
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
export const DEV_B = [...DEV_A.slice(0, 11), '...kBBkkBBk...', '..kBBk..kBBk..', '..kkk...kkk...'];

/** 같은 그림을 글자(색)만 바꿔서 */
function recolor(rows: readonly string[], map: Record<string, string>): string[] {
  return rows.map((row) => Array.from(row, (ch) => map[ch] ?? ch).join(''));
}

/**
 * 큰 그림을 도형으로 그리는 작은 도구. 좌표는 픽셀 칸, 도형은 칸의 가운데가 안에 들면 칠한다.
 * outline() 은 칠한 곳 바로 바깥(상하좌우로 붙은 투명한 칸)을 테두리 색으로 칠한다.
 */
class Pixels {
  private g: string[][];
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.g = Array.from({ length: h }, () => Array<string>(w).fill('.'));
  }
  get(x: number, y: number): string {
    return this.g[y]?.[x] ?? '.';
  }
  set(x: number, y: number, c: string): this {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.g[y]![x] = c;
    return this;
  }
  rect(x: number, y: number, w: number, h: number, c: string): this {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c);
    return this;
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, c: string, only?: string): this {
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        if (((i + 0.5 - cx) / rx) ** 2 + ((j + 0.5 - cy) / ry) ** 2 > 1) continue;
        if (only === undefined || only.includes(this.get(i, j))) this.set(i, j, c);
      }
    }
    return this;
  }
  /** 칸을 하나씩 찍는다: 그림 글자열 그대로 (x, y) 에 겹쳐 놓는다 ('.' 은 건너뛴다) */
  stamp(x: number, y: number, rows: readonly string[]): this {
    rows.forEach((row, j) => Array.from(row).forEach((ch, i) => ch !== '.' && this.set(x + i, y + j, ch)));
    return this;
  }
  outline(c = 'k'): this {
    const edge: [number, number][] = [];
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        if (this.get(i, j) !== '.') continue;
        const near = [this.get(i - 1, j), this.get(i + 1, j), this.get(i, j - 1), this.get(i, j + 1)];
        if (near.some((n) => n !== '.' && n !== c)) edge.push([i, j]);
      }
    }
    for (const [i, j] of edge) this.set(i, j, c);
    return this;
  }
  rows(): string[] {
    return this.g.map((r) => r.join(''));
  }
}

/* ───────────── 적 ───────────── */

const BUG = ['.k......k.', '..k.kk.k..', '..kRrrRk..', '.krkrrkrk.', 'kkrrkkrrkk', '.krkrrkrk.', 'k.kRrrRk.k', '...kkkk...'];

const MERGE_CONFLICT = [
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
];

/** 왕버그: 왕관을 쓴 큰 버그 (보스) */
function bossBug(): string[] {
  const p = new Pixels(18, 15);
  p.ellipse(9, 9.5, 5.6, 4.6, 'r');
  p.ellipse(9, 9.5, 5.6, 4.6, 'R', 'r');
  p.ellipse(9, 9, 4.8, 3.8, 'r');
  p.rect(8, 6, 2, 8, 'k'); // 등껍질 가운데 줄
  p.ellipse(9, 4.8, 3.2, 2.1, 'R');
  p.stamp(7, 4, ['w.w']); // 눈
  p.stamp(7, 5, ['k.k']);
  p.stamp(5, 8, ['k......k']); // 등의 점
  p.stamp(5, 11, ['.k....k.']);
  p.stamp(6, 0, ['y.yy.y', 'yYyyYy', '.YYYY.']); // 왕관
  p.outline();
  // 다리와 더듬이 (테두리 바깥)
  p.stamp(1, 6, ['k..............k', '.k............k.']);
  p.stamp(0, 10, ['kk..............kk']);
  p.stamp(1, 13, ['.k............k.', 'k..............k']);
  return p.rows();
}

/** Off-by-one: 눈의 높이가 한 칸 어긋난 주황 상자, 배에 +1 */
const OFF_BY_ONE = [
  '..kkkkkkkk..',
  '.kooooooook.',
  'kooooooowwok',
  'koowwooowkok',
  'koowkooooook',
  'kooooooooook',
  'kookoooookok',
  'kokkkookkook',
  'kookoooookok',
  'kOoooooookOk',
  '.kOOOOOOOOk.',
  '..kkkkkkkk..',
];

/** 오타: 맞춤법 검사기의 빨간 물결 밑줄이 붙은 글자 덩어리 */
const TYPO = [
  '..kkkkkk..',
  '.kyyyyyyk.',
  'kyykyykyyk',
  'kyykyykyyk',
  'kyyyyyyyyk',
  'kYyyyyyyYk',
  '.kYYYYYYk.',
  '..kkkkkk..',
  'e...e...e.',
  '.e.e.e.e.e',
  '..e...e...',
];

/** 머지 지옥: 더 크고 어두운 Merge Conflict 에 뿔 */
function mergeHell(): string[] {
  const body = recolor(MERGE_CONFLICT, { r: 'e', R: 'E', g: 'G', G: 'z', w: 'y' });
  const p = new Pixels(16, 15);
  p.stamp(1, 3, body);
  p.stamp(2, 0, ['k..........k', 'okk......kko', '.ook....koo.', '..o......o..']);
  p.stamp(2, 0, ['o..........o']);
  return p.rows();
}

/** 기술 부채: 포스트잇(TODO)이 덕지덕지 붙은 무거운 돌덩이 */
function techDebt(): string[] {
  const p = new Pixels(22, 20);
  p.ellipse(11, 10.5, 10, 9, 'n');
  p.ellipse(11.8, 11.3, 9.2, 8.2, 'm', 'n');
  p.ellipse(10.6, 10, 8.8, 7.8, 'n');
  p.stamp(4, 4, ['yyyyy', 'yYYYy', 'yyyyy', 'yYYy.']); // 포스트잇
  p.stamp(14, 12, ['yyyy', 'YYYy', 'yyyy']);
  p.stamp(6, 9, ['kk....kk', '.ke..ek.', '.ee..ee.']); // 화난 눈
  p.stamp(8, 14, ['kkkkk', 'k...k']);
  p.stamp(15, 5, ['d.', '.d']); // 금
  p.outline();
  return p.rows();
}

/** 깨지는 테스트: 금이 간 시험관. 반은 초록(통과), 반은 빨강(실패) */
const FLAKY_TEST = [
  '...kkkkkk...',
  '...kllllk...',
  '....klwk....',
  '....klwk....',
  '...klllwk...',
  '..kllklllk..',
  '..klllklwk..',
  '.kgggkkeeek.',
  '.kgkgggekek.',
  'kgggggeeeeek',
  'kGGGGGEEEEEk',
  '.kkkkkkkkkk.',
];

/** 스파게티 코드: 엉킨 면 덩어리에 미트볼, 포크가 꽂혀 있다 (보스) */
function spaghetti(): string[] {
  const p = new Pixels(28, 26);
  p.ellipse(13.5, 15.5, 12.4, 9.6, 'y');
  // 엉킨 면 가닥 (짙은 금색 물결)
  for (let k = 0; k < 6; k++) {
    for (let x = 0; x < 28; x++) {
      const y = Math.round(8.5 + k * 2.3 + 1.4 * Math.sin(x * 0.85 + k * 2.1));
      if (p.get(x, y) === 'y') p.set(x, y, k % 2 ? 'Y' : 'O');
    }
  }
  p.ellipse(12, 8.6, 6.2, 2.4, 'e', 'yYO'); // 소스
  p.ellipse(12.5, 8.3, 4, 1.3, 'r', 'e');
  for (const [cx, cy] of [[5.5, 16.5], [21.5, 18.5], [13.5, 22]] as const) {
    p.ellipse(cx, cy, 2.2, 2, 'E');
    p.ellipse(cx - 0.4, cy - 0.4, 1.4, 1.2, 'e');
  }
  // 화난 눈과 입
  p.stamp(7, 11, ['kk.......kk', '.kkk...kkk.', '.kwwk.kwwk.', '.kwkk.kkwk.', '..kk...kk..']);
  p.stamp(10, 17, ['kkkkkk', 'k.kk.k']);
  // 포크
  p.stamp(21, 0, ['l.l.l', 'l.l.l', 'lllll', '.lnl.', '..l..', '..n..', '..l..', '..n..', '..l..']);
  p.outline();
  return p.rows();
}

/** God Class: 왕관을 쓴 거대한 클래스 다이어그램 상자. 필드와 메서드 줄이 끝없이 이어진다 (보스) */
function godClass(): string[] {
  const p = new Pixels(26, 28);
  p.stamp(9, 0, ['y..y..y.', 'yy.yy.yy', 'yYyyyyYy', 'YYYYYYYY']); // 왕관
  p.rect(1, 4, 24, 23, 'w');
  p.rect(1, 4, 24, 8, 'p');
  p.rect(1, 11, 24, 1, 'P');
  p.stamp(5, 5, ['kk..........kk', '.kkk......kkk.', '.kwwk....kwwk.', '.kwkk....kkwk.', '..kk......kk..']); // 눈
  p.stamp(10, 10, ['kkkkkk']);
  p.rect(1, 12, 24, 1, 'k');
  for (const [y, len] of [[14, 15], [16, 11], [18, 17]] as const) p.rect(3, y, len, 1, 'n').set(3, y, 'B');
  p.rect(1, 20, 24, 1, 'k');
  for (const [y, len] of [[22, 13], [24, 18]] as const) p.rect(3, y, len, 1, 'n').set(3, y, 'g');
  p.rect(1, 26, 24, 1, 'l');
  p.outline();
  return p.rows();
}

/** 모놀리스: 불빛이 줄지어 깜빡이는 거대한 검은 서버 덩어리 (보스) */
function monolith(): string[] {
  const p = new Pixels(24, 32);
  p.rect(3, 1, 18, 27, 'd');
  p.rect(3, 1, 18, 1, 'n');
  p.rect(3, 1, 1, 27, 'n');
  p.rect(19, 2, 2, 26, 'm');
  p.stamp(6, 5, ['eee.....eee', 'EEe.....eEE']); // 붉은 눈
  for (let i = 0; i < 6; i++) {
    const y = 10 + i * 3;
    p.rect(5, y + 1, 14, 1, 'm');
    p.stamp(6, y, [i % 2 ? 'u.g..uu' : 'g.u.uu.']);
  }
  p.rect(1, 28, 22, 3, 'm');
  p.rect(1, 28, 22, 1, 'n');
  p.outline();
  return p.rows();
}

/** 월요일 아침: 이빨을 드러낸 검은 자명종 (30분이 지나면 오는 사신. 한 대에 쓰러진다) */
function monday(): string[] {
  const p = new Pixels(22, 24);
  p.ellipse(5, 4.5, 3.6, 2.8, 'X'); // 종 두 개
  p.ellipse(17, 4.5, 3.6, 2.8, 'X');
  p.ellipse(4.6, 3.9, 1.6, 1, 'n', 'X');
  p.ellipse(16.6, 3.9, 1.6, 1, 'n', 'X');
  p.rect(10, 0, 2, 4, 'n'); // 망치
  p.ellipse(11, 13, 9.2, 8.8, 'x');
  p.ellipse(11, 13, 7.2, 6.8, 'X');
  p.ellipse(11, 13, 6.2, 5.8, 'x');
  p.stamp(5, 9, ['ee........ee', '.eee....eee.', '.eeEe..eEee.', '..ee....ee..']); // 화난 붉은 눈
  p.stamp(6, 15, ['eeeeeeeeee', 'ewewwwwwwe', '.e.w..w.e.', '..eeeeee..']); // 이빨
  p.rect(5, 21, 3, 2, 'X'); // 다리
  p.rect(14, 21, 3, 2, 'X');
  p.outline();
  return p.rows();
}

export const ENEMY_ART: Record<EnemyId, string[]> = {
  bug: BUG,
  bug_red: recolor(BUG, { r: 'e', R: 'E' }),
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
  off_by_one: OFF_BY_ONE,
  typo: TYPO,
  merge_conflict: MERGE_CONFLICT,
  merge_hell: mergeHell(),
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
  tech_debt: techDebt(),
  flaky_test: FLAKY_TEST,
  /** 버그 떼: 보라색 날벌레 (작고 빠르다) */
  bug_swarm: ['.k....k.', '..kkkk..', '.kpPPpk.', 'kkpkkpkk', 'jkpPPpkj', 'k.kkkk.k'],
  boss_bug: bossBug(),
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
  spaghetti: spaghetti(),
  god_class: godClass(),
  monolith: monolith(),
  monday: monday(),
};

/* ───────────── 투사체 · 소환물 ───────────── */

export const SHOT_ART: Record<ShotKind, string[]> = {
  log: ['.kkkk.', 'kwwwwk', 'kwyywk', 'kwwwwk', '.kkkk.'],
  regex: ['k..k..k', '.kpkpk.', '..kpk..', 'kpppppk', '..kpk..', '.kpkpk.', 'k..k..k'],
  ai: ['...k...', '..kck..', '.kcwck.', 'kcwwwck', '.kcwck.', '..kck..', '...k...'],
  /** 벽돌책: 빨간 표지에 제목 띠, 아래는 두꺼운 책장 */
  book: ['.kkkkkkkk.', 'kRRRRRRRRk', 'kRyyyyyyRk', 'kRRRRRRRRk', 'kwlwlwlwlk', 'kwwwwwwwwk', '.kkkkkkkk.'],
  /** 롤백: 되돌리기 화살표 (↩) */
  rollback: ['..k......', '.kgkkkk..', 'kggggggk.', '.kgkkkggk', '..k...kgk', '..kkkkggk', '..kggggk.', '..kkkkk..'],
  /** 핑퐁: 주황 탁구공 */
  ping: ['.kkkk.', 'kwwook', 'kwoook', 'koooYk', 'kooYYk', '.kkkk.'],
  /** 브로드캐스트·멀티캐스트: 작은 편지 봉투 (패킷) */
  packet: ['kkkkkkk', 'kbwwwbk', 'kwbwbwk', 'kwwbwwk', 'kkkkkkk'],
  /** 멀티스레드: 실을 끌고 가는 분홍 바늘 머리 (실은 render.ts 가 날아온 쪽으로 그린다) */
  bomb: ['.kkk.', 'kwffk', 'kfffk', 'kffek', '.kkk.'],
  /** 카나리아: 날개를 편 노란 새 (오른쪽을 본다. 왼쪽으로 날 때는 뒤집어 그린다) */
  canary: ['k.....k....', 'kYk..kYk...', '.kYkkYkkk..', '..kyyyykyk.', '..kyyyyyyok', '...kyyyyk..', '....kkkk...'],
  /** 야근 부엉이: 보라색 밤 부엉이 (앞을 본다) */
  owl: ['k.k..k.k', 'kPkkkkPk', 'kPPPPPPk', 'kyyPPyyk', 'kykPPkyk', 'kPPooPPk', 'kPppppPk', 'kPppppPk', '.kPPPPk.', '..kkkk..'],
  /** 키보드 고양이: 주황 고양이 얼굴 */
  cat: ['k......k', 'kok..kok', 'kookkook', 'kooooook', 'kgkoogkk', 'kooroook', '.kooook.', '..kkkk..'],
  /** 날아가는 커밋 (커밋 히스토리가 멈췄을 때): 가운데에 점이 있는 초록 커밋 (꼬리는 render.ts 가 그린다) */
  drill: ['..kkk..', '.kgggk.', 'kgwgggk', 'kggkggk', 'kgggGGk', '.kgGGk.', '..kkk..'],
};

/* ───────────── 그 밖의 것 ───────────── */

/** 경험치 (커밋): 색 단계마다 파랑(2 이하) · 초록(9 이하) · 빨강(그 위, 조금 크다) */
const GEM = ['..kk..', '.kggk.', 'kgwggk', 'kggGgk', '.kgGk.', '..kk..'];
export const GEM_ART: [string[], string[], string[]] = [
  recolor(GEM, { g: 'b', G: 'B' }),
  GEM,
  ['...kk...', '..keek..', '.kewrek.', 'kewweeEk', 'keeeeEEk', '.keeEEk.', '..kEEk..', '...kk...'],
];

export const MISC_ART = {
  duck: ['..kkkk...', '.kyyyyk..', '.kykyyokk', '.kyyyyook', 'kkyyyykk.', 'kyyyyyyk.', 'kyYYYyyk.', '.kkkkkk..'],
  grave: ['..kkkk..', '.kllllk.', 'kllkkllk', 'klkllklk', 'kllkkllk', 'kllllllk', 'kddddddk', 'kkkkkkkk'],
} satisfies Record<string, string[]>;

/** 회복 아이템: 야근 피자 한 조각 (적이 떨어뜨리는 것과 필드 아이템이 같은 그림) */
export const PIZZA = [
  'kkkkkkkkkkk',
  'kYYYYYYYYYk',
  'kyyyryyyyyk',
  '.kyyyyyryk.',
  '.kyryyyyyk.',
  '..kyyyryk..',
  '..kyyyyyk..',
  '...kyryk...',
  '...kyyyk...',
  '....kyk....',
  '.....k.....',
];

export const ITEM_ART: Record<FieldItemKind, string[]> = {
  heal: PIZZA,
  /** LGTM (승인 도장. 주우면 즉시 1레벨 업) */
  levelup: [
    '..kkkkkkk..',
    '.kgggggggk.',
    'kgggggggwgk',
    'kggggggwwgk',
    'kgwggggwggk',
    'kgwwggwwggk',
    'kggwwwwgggk',
    'kgggwwggggk',
    'kGgggggggGk',
    '.kGGGGGGGk.',
    '..kkkkkkk..',
  ],
  /** 백업 (디스켓. 가지고 있으면 쓰러져도 한 번 되살아난다) */
  revive: [
    'kkkkkkkkkk.',
    'kbbwwwwBbbk',
    'kbbwwwwBbbk',
    'kbbwwwwBbbk',
    'kbbbbbbbbbk',
    'kbbbbbbbbbk',
    'kbwwwwwwwbk',
    'kbwkkkkkwbk',
    'kbwwwwwwwbk',
    'kbwkkkkkwbk',
    'kkkkkkkkkkk',
  ],
  /** 보물상자 (보스가 떨어뜨린다): 금테를 두른 나무 상자와 자물쇠 */
  chest: [
    '..kkkkkkkkkk..',
    '.kqqqqqqqqqqk.',
    'kqqQqqqqqqQqqk',
    'kYYYYYkkYYYYYk',
    'kkkkkkyykkkkkk',
    'kqqqqkyYkqqqqk',
    'kqQqqkkkkqqQqk',
    'kqqqqqqqqqqqqk',
    'kqQqqqqqqqqQqk',
    'kYYYYYYYYYYYYk',
    '.kkkkkkkkkkkk.',
  ],
};
