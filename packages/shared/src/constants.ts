/** 게임 이름은 여기 한 곳에서만 관리한다. */
export const GAME_TITLE = 'FRIDAY DEPLOY';
export const GAME_TAGLINE = '금요일 저녁 배포에서 살아남기';

export const PROTOCOL_VERSION = 1;

export const TICK_RATE = 20; // 서버 시뮬레이션 Hz
export const DT = 1 / TICK_RATE;

export const MAX_PLAYERS_PER_ROOM = 4;
export const NAME_MAX_LEN = 12;

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
