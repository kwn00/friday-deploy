/** 게임 이름은 여기 한 곳에서만 관리한다. */
export const GAME_TITLE = 'FRIDAY DEPLOY';
export const GAME_TAGLINE = '금요일 저녁 배포에서 살아남기';

export const PROTOCOL_VERSION = 10;

export const TICK_RATE = 20; // 서버 시뮬레이션 Hz
export const DT = 1 / TICK_RATE;

export const MAX_PLAYERS_PER_ROOM = 4;
export const NAME_MAX_LEN = 12;

/** 페어 방 코드. 헷갈리는 글자(I, O, 0, 1)를 뺀 32자 × 6자리 = 약 10억 가지 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LEN = 6;

/**
 * 리더보드 시즌 = 게임 버전(x.y.z)의 메이저(x). 순위표와 아이템 통계를 시즌별로 나눈다.
 * 서로 다른 규칙에서 나온 기록이 한 순위표에 섞이지 않게 하기 위한 것이다.
 * 시즌을 바꾸는 것은 메이저 버전을 올리는 것이고, 그러면 지난 시즌 기록은 기본 순위표에서 빠진다 (지우지는 않는다).
 * 사용자가 분명하게 승인했을 때만 바꾼다 (CLAUDE.md). 버전과 어긋나지 않는지 releases.test.ts 가 확인한다.
 */
export const LEADERBOARD_SEASON = 0;
/** 순위표에 보여주는 기록 수 */
export const LEADERBOARD_SIZE = 50;
/** 이보다 짧게 끝난 판은 기록하지 않는다 (시작하자마자 끝난 판으로 순위표가 채워지지 않게) */
export const LEADERBOARD_MIN_SECONDS = 30;

/** 솔로 일시정지 한 번의 최대 길이(초). 넘으면 서버가 자동으로 재개한다. */
export const MAX_PAUSE_SECONDS = 600;

/**
 * 연결이 끊긴 사람의 자리를 지켜 두는 시간(초). 이 안에 돌아오면 하던 그대로 이어서 한다.
 * 혼자 하는 판은 월드를 멈춰 두므로 일시정지가 끝날 때까지(최대 MAX_PAUSE_SECONDS) 더 기다린다.
 */
export const SEAT_HOLD_SECONDS = 120;
/**
 * 클라이언트가 연결이 살아 있는지 확인하려고 ping 을 보내는 간격(ms).
 * 서버는 이보다 넉넉한 시간(STALL) 동안 아무것도 오지 않으면 그 연결이 멈춘 것으로 본다.
 */
export const PING_INTERVAL_MS = 2000;

/** 서버가 각 플레이어에게 보내주는 관심 영역 반경 (그 밖의 정보는 아예 전송하지 않는다) */
export const VIEW_RADIUS = 420;
/**
 * 일반 적과 경험치는 이 반경 안의 것만 보낸다 (화면의 가장 먼 모서리 296px 바로 바깥까지). 적은 300 마리,
 * 경험치는 400 개까지 쌓이므로 전송량을 줄이려고 미니맵용 넓은 반경(VIEW_RADIUS)은 보스와 회복 아이템 등에만 쓴다.
 */
export const ENEMY_VIEW_RADIUS = 304;

export const PLAYER_RADIUS = 6;
export const PLAYER_BASE_SPEED = 70;
export const PLAYER_BASE_HP = 100;
export const PLAYER_BASE_PICKUP = 36;

/**
 * 관전(페어 방에서 쓰러졌거나, 관전으로 합류한 경우): 입력으로 시점만 움직인다. 월드에는 아무 영향이 없다.
 * 살아 있는 캐릭터(최고 105px/s)보다 빨라서 동료를 따라다닐 수 있다.
 */
export const SPECTATOR_SPEED = 160;
/** 관전 시점은 가장 가까운 살아 있는 동료에게서 이 거리보다 멀어질 수 없다 (길을 잃지 않게, 먼 곳을 정찰하는 용도로 쓰지 못하게) */
export const SPECTATOR_LEASH = 360;
/** 그 거리를 넘었을 때(동료가 멀리서 쓰러진 경우 등) 시점을 끌어오는 속도 (px/s). 한 번에 튀지 않고 빠르게 미끄러져 온다 */
export const SPECTATOR_PULL = 900;

/**
 * 경험치(커밋)는 획득 범위 안에 들어오면 그 플레이어에게 끌려가고, 닿으면 획득된다.
 * 처음 속도는 가장 빠른 플레이어(아이스 아메리카노 5단계 = 105px/s)보다 빨라서, 한번 끌리기 시작하면 달아나도 반드시 따라잡는다.
 */
export const GEM_PULL_SPEED = 120;
/** 끌려오는 동안의 가속 (px/s²): 처음엔 천천히, 가까워질수록 빨려 들어오는 느낌 */
export const GEM_PULL_ACCEL = 900;
export const GEM_PULL_MAX = 360;
/** 이 거리 안에 들어오면 닿은 것으로 본다 (px) */
export const GEM_CONTACT = 6;

/** 레벨업 선택지 수 (배포 기도로 가끔 하나 더) */
export const OFFER_COUNT = 3;
/** 레벨업 선택 제한 시간(초). 넘기면 서버가 첫 번째 선택지를 자동 선택한다. */
export const OFFER_TIMEOUT = 20;

/**
 * 적 수의 상한 (뱀서): 살아 있는 적이 300 이상이면 주기적인 스폰을 멈추고, 보스·이벤트는 500 까지만 나온다.
 * 사람 수와 상관없이 같다 (무료 서버의 CPU). 함께 하면 웨이브의 최소 수와 한 번에 나오는 수만 늘어난다.
 */
export const MAX_ENEMIES_REGULAR = 300;
export const MAX_ENEMIES_ALL = 500;
/** 땅에 있을 수 있는 경험치 수 (뱀서 400). 넘으면 새 경험치는 빨간 경험치 하나에 모인다 */
export const MAX_GEMS = 400;
/** 땅에 남아 있을 수 있는 보물상자 수 (넘으면 가장 오래된 것이 사라진다) */
export const MAX_CHESTS = 20;
/** 한 대 맞은 뒤, 레벨업을 고른 뒤, 상자를 연 뒤 무적인 시간(초) (뱀서 Invulnerability Time 240ms) */
export const INVULN_SECONDS = 0.24;
/** 투사체·소환물(고양이) 수의 상한. 넘으면 새로 쏘지 않는다 (서버 CPU 와 전송량을 묶어 둔다) */
export const MAX_SHOTS = 320;
/** 피해를 주는 바닥 영역(웅덩이, 발자국) 수의 상한 */
export const MAX_ZONES = 200;
/** 보이기만 하는 짧은 영역(베기, 번개, 폭발 등) 수의 상한. 피해는 생길 때 이미 줬다 */
export const MAX_FLASHES = 200;

/**
 * 회복 아이템(야근 피자): 처치 시 낮은 확률로 떨어지고, 한 번 떨어지면 한동안 다시 떨어지지 않는다.
 * 수치는 봇 실험으로 골랐다: 원을 그리며 걷기만 하는 봇의 생존 시간 중앙값이 138초 → 190초로 늘어나는 정도.
 * (처음 시도한 5% / 14초 / 25% 는 764초가 되어 게임이 너무 쉬워졌다)
 */
export const HEAL_DROP_CHANCE = 0.03;
export const HEAL_DROP_COOLDOWN = 25;
export const MAX_HEALS = 4;

/**
 * 필드 아이템: 적을 잡지 않아도 시간에 따라 맵에 저절로 놓이는 아이템 (종류와 비중은 content.ts 의 FIELD_ITEMS).
 * 아주 조금만 나온다: 평균 FIELD_ITEM_INTERVAL 초에 하나.
 * 처음에는 75초로 잡았는데, 봇으로 재 보니 아이템을 찾아다니는 플레이의 생존 시간이 중앙값 +27%(상위 25% 는 +47%)
 * 늘어서 110초로 늦췄다 (같은 측정에서 약 +8%). 간격을 줄이려면 다시 재 볼 것.
 */
export const FIELD_ITEM_INTERVAL = 110;
/** 실제 간격은 평균의 (1 - 이 값) ~ (1 + 이 값) 배 사이에서 무작위 (언제 나올지 맞힐 수 없게) */
export const FIELD_ITEM_JITTER = 0.4;
/** 맵에 동시에 있을 수 있는 개수. 가득 차 있으면 그 차례는 건너뛴다 */
export const MAX_FIELD_ITEMS = 3;
/** 줍지 않으면 사라지기까지의 시간(초) */
export const FIELD_ITEM_TTL = 90;
/** 사라지기 전 이 시간(초) 동안은 곧 사라진다는 표시가 붙는다 (화면에서 깜빡인다) */
export const FIELD_ITEM_FADE = 10;
/** 살아 있는 플레이어 한 명에게서 이 거리 범위에 놓인다 (화면 밖. 기본 속도로 걸어서 7~11초) */
export const FIELD_ITEM_MIN_DIST = 500;
export const FIELD_ITEM_MAX_DIST = 800;

/** 부활(백업): 한 번에 가질 수 있는 개수 */
export const MAX_REVIVES = 1;
/** 되살아날 때의 체력 (최대 체력 대비) */
export const REVIVE_HP_FRACTION = 0.5;
/** 되살아난 직후 피해를 받지 않는 시간(초) */
export const REVIVE_SHIELD_SECONDS = 2;
/** 되살아나는 순간 이 반경 안의 적을 반경 밖으로 밀어낸다 (둘러싸인 채 바로 다시 쓰러지지 않게) */
export const REVIVE_BLAST_RADIUS = 90;
