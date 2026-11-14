/** 게임 이름은 여기 한 곳에서만 관리한다. */
export const GAME_TITLE = 'FRIDAY DEPLOY';
export const GAME_TAGLINE = '금요일 저녁 배포에서 살아남기';

export const PROTOCOL_VERSION = 4;

export const TICK_RATE = 20; // 서버 시뮬레이션 Hz
export const DT = 1 / TICK_RATE;

export const MAX_PLAYERS_PER_ROOM = 4;
export const NAME_MAX_LEN = 12;

/** 페어 방 코드. 헷갈리는 글자(I, O, 0, 1)를 뺀 32자 × 6자리 = 약 10억 가지 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LEN = 6;

/**
 * 리더보드 시즌. 난이도가 달라지는 변경(무기·적·아이템 수치 등)을 하면 올린다.
 * 서로 다른 규칙에서 나온 기록이 한 순위표에 섞이지 않게 하기 위한 것이다.
 */
export const LEADERBOARD_SEASON = 1;
/** 순위표에 보여주는 기록 수 */
export const LEADERBOARD_SIZE = 50;
/** 이보다 짧게 끝난 판은 기록하지 않는다 (시작하자마자 끝난 판으로 순위표가 채워지지 않게) */
export const LEADERBOARD_MIN_SECONDS = 30;

/** 솔로 일시정지 한 번의 최대 길이(초). 넘으면 서버가 자동으로 재개한다. */
export const MAX_PAUSE_SECONDS = 600;

/** 서버가 각 플레이어에게 보내주는 관심 영역 반경 (그 밖의 정보는 아예 전송하지 않는다) */
export const VIEW_RADIUS = 420;

export const PLAYER_RADIUS = 6;
export const PLAYER_BASE_SPEED = 70;
export const PLAYER_BASE_HP = 100;
export const PLAYER_BASE_PICKUP = 36;

/**
 * 관전(페어 방에서 쓰러졌거나, 관전으로 합류한 경우): 입력으로 시점만 움직인다. 월드에는 아무 영향이 없다.
 * 살아 있는 캐릭터(최고 98px/s)보다 빨라서 동료를 따라다닐 수 있다.
 */
export const SPECTATOR_SPEED = 160;
/** 관전 시점은 가장 가까운 살아 있는 동료에게서 이 거리보다 멀어질 수 없다 (길을 잃지 않게, 먼 곳을 정찰하는 용도로 쓰지 못하게) */
export const SPECTATOR_LEASH = 360;
/** 그 거리를 넘었을 때(동료가 멀리서 쓰러진 경우 등) 시점을 끌어오는 속도 (px/s). 한 번에 튀지 않고 빠르게 미끄러져 온다 */
export const SPECTATOR_PULL = 900;

/**
 * 경험치(커밋)는 획득 범위 안에 들어오면 그 플레이어에게 끌려가고, 닿으면 획득된다.
 * 처음 속도는 가장 빠른 플레이어(커피 5단계 = 98px/s)보다 빨라서, 한번 끌리기 시작하면 달아나도 반드시 따라잡는다.
 */
export const GEM_PULL_SPEED = 120;
/** 끌려오는 동안의 가속 (px/s²): 처음엔 천천히, 가까워질수록 빨려 들어오는 느낌 */
export const GEM_PULL_ACCEL = 900;
export const GEM_PULL_MAX = 360;
/** 이 거리 안에 들어오면 닿은 것으로 본다 (px) */
export const GEM_CONTACT = 6;

export const MAX_UPGRADE_LEVEL = 5;
export const OFFER_COUNT = 3;
/** 레벨업 선택 제한 시간(초). 넘기면 서버가 첫 번째 선택지를 자동 선택한다. */
export const OFFER_TIMEOUT = 20;

export const MAX_ENEMIES_BASE = 140;
export const MAX_ENEMIES_PER_EXTRA_PLAYER = 40;
export const MAX_GEMS = 300;
export const MAX_SHOTS = 200;

/** 러버덕 공전 반경 / 각속도(rad/s). 서버 판정과 클라이언트 그리기가 같은 값을 쓴다. */
export const DUCK_ORBIT_RADIUS = 36;
export const DUCK_ORBIT_SPEED = 2.6;

/**
 * 회복 아이템(야근 피자): 처치 시 낮은 확률로 떨어지고, 한 번 떨어지면 한동안 다시 떨어지지 않는다.
 * 수치는 봇 실험으로 골랐다: 원을 그리며 걷기만 하는 봇의 생존 시간 중앙값이 138초 → 190초로 늘어나는 정도.
 * (처음 시도한 5% / 14초 / 25% 는 764초가 되어 게임이 너무 쉬워졌다)
 */
export const HEAL_DROP_CHANCE = 0.03;
export const HEAL_DROP_COOLDOWN = 25;
/** 최대 체력 대비 회복량 */
export const HEAL_FRACTION = 0.2;
export const MAX_HEALS = 4;
