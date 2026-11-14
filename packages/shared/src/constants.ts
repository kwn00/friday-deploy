/** 게임 이름은 여기 한 곳에서만 관리한다. */
export const GAME_TITLE = 'FRIDAY DEPLOY';
export const GAME_TAGLINE = '금요일 저녁 배포에서 살아남기';

export const PROTOCOL_VERSION = 2;

export const TICK_RATE = 20; // 서버 시뮬레이션 Hz
export const DT = 1 / TICK_RATE;

export const MAX_PLAYERS_PER_ROOM = 4;
export const NAME_MAX_LEN = 12;

/** 페어 방 코드. 헷갈리는 글자(I, O, 0, 1)를 뺀 32자 × 6자리 = 약 10억 가지 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LEN = 6;

/** 솔로 일시정지 한 번의 최대 길이(초). 넘으면 서버가 자동으로 재개한다. */
export const MAX_PAUSE_SECONDS = 600;

/** 서버가 각 플레이어에게 보내주는 관심 영역 반경 (그 밖의 정보는 아예 전송하지 않는다) */
export const VIEW_RADIUS = 420;

export const PLAYER_RADIUS = 6;
export const PLAYER_BASE_SPEED = 70;
export const PLAYER_BASE_HP = 100;
export const PLAYER_BASE_PICKUP = 36;

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
