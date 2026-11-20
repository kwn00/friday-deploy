/**
 * 효과음과 배경음악의 "악보". 소리 파일 없이 브라우저가 그 자리에서 만든다 (audio.ts 가 연주한다).
 * 파일을 받지 않으니 전송량이 늘지 않고, 서버는 아무것도 하지 않는다.
 *
 * 이 파일은 화면(DOM)과 Web Audio 를 쓰지 않는다 (단위 테스트에서 검사한다).
 *
 * 효과음 고치기: SFX 의 음(Tone)을 바꾼다. 주파수(Hz), 길이(초), 크기(0~1).
 * 음악 고치기: Track 의 악보 문자열을 바꾼다. 아래 "악보 적는 법" 참고.
 */

/** 소리의 모양. noise 는 쉬익 하는 잡음 (f 는 잡음을 거르는 주파수) */
export type Wave = 'square' | 'triangle' | 'sine' | 'sawtooth' | 'noise';

export interface Tone {
  wave: Wave;
  /** 시작 주파수 (Hz) */
  f: number;
  /** 끝 주파수: 있으면 길이 동안 미끄러진다 */
  to?: number;
  /** 시작을 늦추는 시간 (초) */
  at?: number;
  /** 길이 (초) */
  dur: number;
  /** 크기 (0~1) */
  vol: number;
}

export interface Sfx {
  tones: readonly Tone[];
  /** 같은 소리를 다시 내기까지 최소 간격 (ms). 적이 한꺼번에 쓰러져도 소리가 뭉개지지 않게 */
  gap: number;
  /** 같은 소리가 동시에 몇 개까지 울릴 수 있는지 */
  voices: number;
}

/** 음 이름 → 주파수. 'A4' = 440Hz, 'C#5', 'Bb3' 처럼 쓴다 */
export function noteHz(name: string): number {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`음 이름이 이상하다: ${name}`);
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1] as 'C'];
  const midi = (Number(m[3]) + 1) * 12 + base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return 440 * 2 ** ((midi - 69) / 12);
}

/** 짧은 음 여러 개를 차례로 (아르페지오). step: 음 사이 간격(초) */
function seq(wave: Wave, notes: readonly string[], step: number, vol: number, last = step): Tone[] {
  return notes.map((n, i) => ({ wave, f: noteHz(n), at: i * step, dur: i === notes.length - 1 ? last : step * 1.1, vol }));
}

const SFX_DEFS = {
  /** 공격이 적에게 맞음 (한 프레임에 여럿이어도 한 번) */
  hit: { tones: [{ wave: 'noise', f: 2600, dur: 0.035, vol: 0.08 }], gap: 90, voices: 2 },
  /** 적이 쓰러짐 */
  kill: { tones: [{ wave: 'square', f: 560, to: 170, dur: 0.07, vol: 0.13 }], gap: 45, voices: 4 },
  /** 보스가 쓰러짐 */
  bossKill: {
    tones: [
      { wave: 'noise', f: 700, dur: 0.6, vol: 0.5 },
      { wave: 'square', f: 320, to: 50, dur: 0.6, vol: 0.25 },
      ...seq('triangle', ['C5', 'E5', 'G5', 'C6'], 0.08, 0.3, 0.3).map((t) => ({ ...t, at: (t.at ?? 0) + 0.35 })),
    ],
    gap: 400,
    voices: 1,
  },
  /** 보스가 나타남 (경보) */
  bossAppear: {
    tones: [
      { wave: 'square', f: 440, dur: 0.14, vol: 0.2 },
      { wave: 'square', f: 330, at: 0.17, dur: 0.14, vol: 0.2 },
      { wave: 'square', f: 440, at: 0.34, dur: 0.14, vol: 0.2 },
      { wave: 'square', f: 330, at: 0.51, dur: 0.22, vol: 0.2 },
    ],
    gap: 3000,
    voices: 1,
  },
  /** 경험치를 먹음 (연달아 먹으면 audio.ts 가 음을 조금씩 올린다) */
  gem: { tones: [{ wave: 'sine', f: 880, to: 1320, dur: 0.05, vol: 0.1 }], gap: 35, voices: 3 },
  /** 내가 맞음 */
  hurt: {
    tones: [
      { wave: 'sawtooth', f: 240, to: 90, dur: 0.12, vol: 0.22 },
      { wave: 'noise', f: 900, dur: 0.08, vol: 0.18 },
    ],
    gap: 160,
    voices: 1,
  },
  /** 회복 (야근 피자) */
  heal: { tones: seq('triangle', ['C5', 'E5', 'G5'], 0.06, 0.25, 0.15), gap: 200, voices: 1 },
  /** 필드 아이템을 주움 */
  pickup: { tones: seq('square', ['E5', 'B5'], 0.06, 0.15, 0.1), gap: 120, voices: 1 },
  /** 백업(부활 아이템)을 주움 */
  backup: { tones: seq('sine', ['G5', 'B5', 'D6', 'G6'], 0.05, 0.22, 0.25), gap: 300, voices: 1 },
  /** 보물상자를 엶 */
  chest: {
    tones: [{ wave: 'noise', f: 400, dur: 0.12, vol: 0.35 }, ...seq('triangle', ['C5', 'E5', 'G5', 'C6', 'E6', 'G6'], 0.07, 0.28, 0.4).map((t) => ({ ...t, at: (t.at ?? 0) + 0.1 }))],
    gap: 500,
    voices: 1,
  },
  /** 레벨업 (PR Merged!) */
  levelup: { tones: seq('square', ['C5', 'E5', 'G5', 'C6'], 0.07, 0.17, 0.3), gap: 300, voices: 1 },
  /** 강화를 고름 */
  pick: { tones: [{ wave: 'square', f: 990, to: 1480, dur: 0.06, vol: 0.14 }], gap: 80, voices: 1 },
  /** 버튼을 누름 */
  click: { tones: [{ wave: 'square', f: 1200, dur: 0.025, vol: 0.06 }], gap: 40, voices: 1 },
  /** 판이 시작됨 */
  start: { tones: seq('square', ['G4', 'C5', 'E5', 'G5'], 0.08, 0.15, 0.25), gap: 500, voices: 1 },
  /** 되살아남 */
  revive: {
    tones: [
      { wave: 'sine', f: 300, to: 1200, dur: 0.4, vol: 0.25 },
      { wave: 'triangle', f: 600, to: 2400, at: 0.05, dur: 0.35, vol: 0.12 },
    ],
    gap: 500,
    voices: 1,
  },
  /** 내가 쓰러짐 */
  down: {
    tones: [
      { wave: 'sawtooth', f: 420, to: 55, dur: 0.8, vol: 0.25 },
      { wave: 'noise', f: 600, dur: 0.4, vol: 0.2 },
    ],
    gap: 800,
    voices: 1,
  },
  /** 동료가 쓰러짐 */
  mateDown: { tones: [{ wave: 'triangle', f: 330, to: 165, dur: 0.3, vol: 0.2 }], gap: 300, voices: 1 },
  /** 판이 끝남 (Segmentation fault) */
  over: {
    tones: [
      ...seq('square', ['A5', 'A4', 'E5', 'A3', 'A2'], 0.06, 0.16, 0.1),
      { wave: 'noise', f: 1200, at: 0.32, dur: 0.35, vol: 0.25 },
    ],
    gap: 1000,
    voices: 1,
  },
  /** 30분: 월요일 아침이 옴 */
  monday: {
    tones: [
      { wave: 'square', f: 196, dur: 0.25, vol: 0.22 },
      { wave: 'square', f: 196, at: 0.35, dur: 0.25, vol: 0.22 },
      { wave: 'square', f: 147, at: 0.7, dur: 0.6, vol: 0.22 },
    ],
    gap: 3000,
    voices: 1,
  },
} as const satisfies Record<string, Sfx>;
export type SfxId = keyof typeof SFX_DEFS;
export const SFX: Record<SfxId, Sfx> = SFX_DEFS;

/* ───────────── 배경음악 ─────────────
 * 악보 적는 법: 칸 하나 = 16분음표 하나. 칸은 빈칸으로 나눈다.
 *   'A4'   그 음을 한 칸
 *   'A4:4' 그 음을 네 칸 (4분음표)
 *   '-:2'  두 칸 쉼
 *   드럼은 음 이름 대신 k(킥) s(스네어) h(하이햇) j(방울) 를 쓴다.
 * 한 곡의 lead · bass · drums 는 길이(칸 수)가 같아야 하고, 16칸(한 마디)의 배수여야 한다 (테스트가 확인한다).
 */

export type LeadVoice = 'square' | 'triangle' | 'sine' | 'bell';
export const DRUMS = ['k', 's', 'h', 'j'] as const;
export type Drum = (typeof DRUMS)[number];

export interface Track {
  bpm: number;
  lead: string;
  bass: string;
  drums: string;
  leadVoice: LeadVoice;
  leadVol: number;
  bassVol: number;
  drumVol: number;
}

/** 악보의 한 음: 몇 번째 칸에서 시작해 몇 칸 동안 */
export interface NoteEvent {
  step: number;
  len: number;
  /** 음 이름 또는 드럼 글자 */
  note: string;
}

/** 악보 문자열 → 음 목록 (쉼은 빠진다). 총 칸 수도 함께 */
export function parsePattern(src: string): { events: NoteEvent[]; steps: number } {
  const events: NoteEvent[] = [];
  let step = 0;
  for (const token of src.trim().split(/\s+/)) {
    const [note, n] = token.split(':') as [string, string | undefined];
    const len = n === undefined ? 1 : Number(n);
    if (!Number.isInteger(len) || len < 1) throw new Error(`길이가 이상하다: ${token}`);
    if (note !== '-') events.push({ step, len, note });
    step += len;
  }
  return { events, steps: step };
}

/** 베이스: 한 마디 동안 낮은 음과 한 옥타브 위를 8분음표로 번갈아 */
const pump = (lo: string, hi: string): string => `${lo}:2 ${hi}:2 `.repeat(4);
/** 베이스: 한 마디 동안 근음과 5도를 4분음표로 */
const bounce = (root: string, fifth: string): string => `${root}:4 ${fifth}:4 `.repeat(2);
/** 리드: 한 마디 동안 화음을 8분음표로 오르내리기 */
const arp = (a: string, b: string, c: string): string => `${a}:2 ${b}:2 ${c}:2 ${b}:2 `.repeat(2);

/** 타이틀·대기실: 느긋하게 */
const TITLE: Track = {
  bpm: 92,
  lead: [arp('A4', 'C5', 'E5'), arp('F4', 'A4', 'C5'), arp('C4', 'E4', 'G4'), arp('B3', 'D4', 'G4')].join(' '),
  bass: 'A2:16 F2:16 C3:16 G2:16',
  drums: 'k:4 -:4 h:4 -:4 '.repeat(4),
  leadVoice: 'triangle',
  leadVol: 0.1,
  bassVol: 0.16,
  drumVol: 0.5,
};

/** 게임 중: 빠르고 긴장감 있게 (A 단조, 8마디) */
const GAME: Track = {
  bpm: 132,
  lead: [
    'A4:2 C5:2 E5:2 A5:4 G5:2 E5:2 C5:2',
    'F5:4 E5:2 C5:2 A4:4 C5:4',
    'G4:2 C5:2 E5:2 G5:4 E5:2 D5:2 C5:2',
    'D5:6 B4:2 G4:4 -:4',
    'E5:2 E5:2 -:2 E5:2 D5:2 C5:2 D5:2 E5:2',
    'F5:2 A5:2 G5:2 F5:2 E5:4 C5:4',
    'D5:2 D5:2 -:2 D5:2 E5:2 D5:2 B4:2 G4:2',
    'G#4:4 B4:4 E5:6 -:2',
  ].join(' '),
  bass: [pump('A2', 'A3'), pump('F2', 'F3'), pump('C3', 'C4'), pump('G2', 'G3'), pump('A2', 'A3'), pump('F2', 'F3'), pump('G2', 'G3'), pump('E2', 'E3')].join(' '),
  drums: 'k:2 h:2 s:2 h:2 k:2 k:2 s:2 h:2 '.repeat(8),
  leadVoice: 'square',
  leadVol: 0.07,
  bassVol: 0.14,
  drumVol: 0.6,
};

/** 크리스마스 타이틀: 징글벨 후렴 (저작권이 끝난 곡, G 장조) */
const JINGLE_A = ['B4:4 B4:4 B4:8', 'B4:4 B4:4 B4:8', 'B4:4 D5:4 G4:6 A4:2', 'B4:16'];
const JINGLE_B1 = ['C5:4 C5:4 C5:6 C5:2', 'C5:4 B4:4 B4:4 B4:2 B4:2', 'B4:4 A4:4 A4:4 B4:4', 'A4:8 D5:8'];
const JINGLE_B2 = ['C5:4 C5:4 C5:6 C5:2', 'C5:4 B4:4 B4:4 B4:2 B4:2', 'D5:4 D5:4 C5:4 A4:4', 'G4:16'];
const CHRISTMAS_TITLE: Track = {
  bpm: 120,
  lead: [...JINGLE_A, ...JINGLE_B1, ...JINGLE_A, ...JINGLE_B2].join(' '),
  bass: [
    ...['G2', 'G2', 'G2', 'G2'].map((r) => bounce(r, 'D3')),
    bounce('C3', 'G3'),
    bounce('G2', 'D3'),
    bounce('A2', 'E3'),
    bounce('D3', 'A3'),
    ...['G2', 'G2', 'G2', 'G2'].map((r) => bounce(r, 'D3')),
    bounce('C3', 'G3'),
    bounce('G2', 'D3'),
    bounce('D3', 'A3'),
    bounce('G2', 'D3'),
  ].join(' '),
  drums: 'k:4 j:4 s:4 j:4 '.repeat(16),
  leadVoice: 'bell',
  leadVol: 0.16,
  bassVol: 0.14,
  drumVol: 0.5,
};

/** 크리스마스 게임 중: 같은 곡을 방울 소리로 */
const CHRISTMAS_GAME: Track = { ...GAME, leadVoice: 'bell', leadVol: 0.12, drums: GAME.drums.replace(/h/g, 'j') };

export const MUSIC_IDS = ['title', 'game'] as const;
export type MusicId = (typeof MUSIC_IDS)[number];

/** 기본 음악. 테마가 바꿀 수 있다 (themes.ts 의 music) */
export const MUSIC: Record<MusicId, Track> = { title: TITLE, game: GAME };
export const CHRISTMAS_MUSIC: Partial<Record<MusicId, Track>> = { title: CHRISTMAS_TITLE, game: CHRISTMAS_GAME };
