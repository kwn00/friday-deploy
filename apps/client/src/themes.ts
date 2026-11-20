/**
 * 테마별 내용: 화면(CSS) 색, 바닥, 내리는 것(눈 등), 캐릭터 그림, 타이틀 문구, 배경음악.
 * 어떤 테마를 쓸지는 @friday-deploy/shared 의 ACTIVE_THEME 이 정한다 (packages/shared/src/theme.ts).
 *
 * 새 테마 추가하기 (봄, 할로윈 등):
 *   1. shared 의 THEME_IDS 에 이름을 넣는다
 *   2. 아래 THEMES 에 같은 이름으로 한 벌을 만든다 (DEFAULT 를 펼쳐 놓고 바꿀 것만 덮어쓰면 된다)
 *      음악을 바꾸려면 sounds.ts 에 곡을 적고 music 에 넣는다
 *   타입 검사와 themes.test.ts 가 빠진 값, 잘못된 그림을 알려 준다.
 *
 * 이 파일은 화면(DOM)을 쓰지 않는다 (단위 테스트에서 검사한다). 화면에 입히는 것은 apply-theme.ts 가 한다.
 */
import { GAME_TAGLINE, THEME_IDS, type ThemeId } from '@friday-deploy/shared';
import { DEV_A, DEV_B } from './art';
import { CHRISTMAS_MUSIC, type MusicId, type Track } from './sounds';

/**
 * 화면(HUD, 메뉴)에 쓰는 색. 키 이름이 곧 CSS 변수 이름이다 (`bg` → `--bg`).
 * `-rgb` 로 끝나는 것은 투명도를 바꿔 가며 쓰는 색이라 `r, g, b` 숫자로 적는다 (`rgba(var(--shade-rgb), 0.8)`).
 * 기본 테마의 값은 style.css 의 :root 와 같아야 한다 (스크립트가 뜨기 전 첫 화면. 테스트가 확인한다).
 */
export interface UiColors {
  bg: string;
  'bg-2': string;
  panel: string;
  line: string;
  text: string;
  muted: string;
  green: string;
  red: string;
  yellow: string;
  blue: string;
  purple: string;
  orange: string;
  cyan: string;
  /** 경험치 막대 */
  xp: string;
  /** 순위표에서 내 기록 줄의 바탕 */
  mine: string;
  /** 버튼 바탕 */
  'btn-rgb': string;
  /** 화면을 덮는 어두운 막 */
  'shade-rgb': string;
  /** HUD 의 반투명 바탕 */
  'glass-rgb': string;
}
export type UiToken = keyof UiColors;

/** 화면 위로 내리는 것 (눈, 꽃잎, 낙엽 등). 화면에만 그리고 게임에는 영향이 없다 */
export interface Weather {
  /** 화면 넓이 1만 논리 픽셀당 개수 */
  density: number;
  colors: readonly string[];
  /** 떨어지는 속도 (논리 픽셀/초) 범위 */
  speed: readonly [number, number];
  /** 좌우로 흔들리는 폭 (논리 픽셀) */
  sway: number;
}

export interface Theme {
  id: ThemeId;
  /** 사람이 읽는 이름 (나중에 관리자 화면에서 보여줄 것) */
  label: string;
  /** 타이틀 화면 제목 아래 문구 */
  tagline: string;
  ui: UiColors;
  /** 게임 바닥 (캔버스) */
  floor: {
    base: string;
    /** 바둑판 무늬의 어두운 칸 */
    tile: string;
    /** 칸 모서리 점 */
    dot: string;
    /** 바닥에 흩어진 글자의 색 두 가지 */
    glyphColors: readonly [string, string];
    glyphs: readonly string[];
  };
  weather: Weather | null;
  /** 캐릭터 그림 (2프레임 걷기). art.ts 의 글자 격자와 같은 크기여야 한다 */
  dev: readonly [readonly string[], readonly string[]];
  /** 바꿀 배경음악 (없는 것은 기본 곡. sounds.ts) */
  music: Partial<Record<MusicId, Track>>;
}

const DEFAULT: Theme = {
  id: 'default',
  label: '기본',
  tagline: GAME_TAGLINE,
  ui: {
    bg: '#1e1e2e',
    'bg-2': '#181825',
    panel: '#313244',
    line: '#11111b',
    text: '#cdd6f4',
    muted: '#9399b2',
    green: '#a6e3a1',
    red: '#f38ba8',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    purple: '#cba6f7',
    orange: '#fab387',
    cyan: '#89dceb',
    xp: '#4c9a5a',
    mine: '#2b3a33',
    'btn-rgb': '69, 71, 90',
    'shade-rgb': '17, 17, 27',
    'glass-rgb': '24, 24, 37',
  },
  floor: {
    base: '#1e1e2e',
    tile: '#212133',
    dot: '#2a2a3d',
    glyphColors: ['#3b3f5c', '#33354d'],
    glyphs: ['{ }', '</>', '//', ';', '=>', '0x', '[]', '&&', '()', '#!', '::', '!='],
  },
  weather: null,
  dev: [DEV_A, DEV_B],
  music: {},
};

/** 산타 모자: 캐릭터 그림의 머리(위 세 줄)만 바꾼다. 몸은 그대로라 보이는 크기 = 맞는 크기가 유지된다 */
const SANTA_HAT = [
  '....kkkkkkk.k.', //
  '...krrRrrrrkwk',
  '..kwwwwwwwwkk.',
];
const withHat = (rows: readonly string[]): string[] => [...SANTA_HAT, ...rows.slice(SANTA_HAT.length)];

const CHRISTMAS: Theme = {
  ...DEFAULT,
  id: 'christmas',
  label: '크리스마스',
  tagline: '크리스마스 이브 배포에서 살아남기',
  ui: {
    ...DEFAULT.ui,
    bg: '#14232a',
    'bg-2': '#0f1b20',
    panel: '#1f3a35',
    line: '#081012',
    text: '#eef3ea',
    muted: '#a3b8ad',
    green: '#8fd694',
    red: '#f06b78',
    yellow: '#f7d774',
    blue: '#a3cdf2',
    purple: '#d6b8f2',
    orange: '#f5ab72',
    cyan: '#c4ecf7',
    xp: '#3f8f55',
    mine: '#2c4433',
    'btn-rgb': '46, 76, 68',
    'shade-rgb': '8, 16, 18',
    'glass-rgb': '15, 27, 32',
  },
  floor: {
    base: '#14232a',
    tile: '#172930',
    dot: '#24404a',
    glyphColors: ['#2f4f5a', '#27434d'],
    glyphs: ['*', '+', '{*}', '.*.', 'Ho', '</>', '[]', '=>', '<3', '#!', '::', '()'],
  },
  weather: {
    density: 2.4,
    colors: ['#ffffff', '#dfeef5', '#c4ecf7'],
    speed: [10, 26],
    sway: 6,
  },
  dev: [withHat(DEV_A), withHat(DEV_B)],
  music: CHRISTMAS_MUSIC,
};

export const THEMES: Record<ThemeId, Theme> = {
  default: DEFAULT,
  christmas: CHRISTMAS,
};

/** 모든 테마 (THEME_IDS 순서) */
export const ALL_THEMES: readonly Theme[] = THEME_IDS.map((id) => THEMES[id]);
