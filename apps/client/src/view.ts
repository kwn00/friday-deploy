/**
 * 화면 배율과 좌표 변환 (DOM 에 의존하지 않는 순수 함수 → 테스트 가능).
 *
 * 캔버스는 기기 픽셀 해상도로 만들고, 스프라이트는 정수 배율로 미리 키워서 그린다.
 * 위치는 "논리 픽셀"이 아니라 "기기 픽셀" 단위로 맞춘다. 논리 픽셀 단위로 반올림하면 배율이 6~7배인 폰에서
 * 한 번에 6~7 기기 픽셀씩 튀어서, 움직일 때 캐릭터와 배경이 떨려 보인다.
 */

export interface ViewSpec {
  /** 캔버스 크기 (기기 픽셀) */
  pxW: number;
  pxH: number;
  /** 논리 픽셀 1개 = 기기 픽셀 scale 개 (정수) */
  scale: number;
}

/** 적은 플레이어에게서 300 이상 떨어진 곳에 생긴다. 화면 모서리까지의 거리가 이보다 작아야 생기는 순간이 보이지 않는다. */
const MAX_HALF_DIAGONAL = 296;
/** 터치 기기에서 긴 변에 보이는 논리 픽셀 상한 */
const TOUCH_MAX_LONG = 560;

/**
 * @param cssW,cssH 뷰포트 크기 (CSS 픽셀)
 * @param dpr devicePixelRatio
 * @param finePointer 마우스/키보드 환경(데스크톱)인지
 */
export function computeView(cssW: number, cssH: number, dpr: number, finePointer: boolean): ViewSpec {
  const d = Math.min(Math.max(dpr || 1, 1), 3);
  const pxW = Math.max(1, Math.round(cssW * d));
  const pxH = Math.max(1, Math.round(cssH * d));
  const short = Math.min(pxW, pxH);
  const long = Math.max(pxW, pxH);
  // 화면 모서리가 적 생성 거리 안쪽에 들어오는 가장 작은 정수 배율 = 가장 넓게 볼 수 있는 배율
  const widest = Math.max(1, Math.ceil(Math.hypot(pxW, pxH) / (2 * MAX_HALF_DIAGONAL)));
  let scale: number;
  if (finePointer) {
    // 데스크톱: 화면이 크고 눈에서 멀지 않으므로 가능한 한 넓게 본다.
    // 다만 아주 작은 창에서 배율 1 (캐릭터 14px)까지 내려가지는 않게 한다.
    scale = Math.max(widest, Math.min(2, Math.round(short / 200)));
  } else {
    // 터치: 손가락으로 조작하므로 캐릭터가 충분히 커야 한다. 짧은 변에 폰은 약 200, 태블릿은 약 250 논리 픽셀
    const target = Math.min(cssW, cssH) < 500 ? 200 : 250;
    scale = Math.max(1, Math.round(short / target));
    while (long / scale > TOUCH_MAX_LONG) scale++;
    scale = Math.max(scale, widest);
  }
  return { pxW, pxH, scale };
}

/** 카메라 중심(월드 좌표)을 기기 픽셀 격자에 맞춘 값 */
export function cameraPx(center: number, scale: number): number {
  return Math.round(center * scale);
}

/**
 * 월드 좌표 → 캔버스 좌표(기기 픽셀).
 * 카메라와 대상을 "같은 방식으로 각각 반올림한 뒤 빼기" 때문에, 카메라가 따라가는 대상(내 캐릭터)은
 * 좌표가 얼마든 항상 정확히 화면 중앙(half)에 찍힌다. 멈춰 있는 물체끼리의 간격도 프레임마다 변하지 않는다.
 */
export function toScreen(world: number, camPx: number, half: number, scale: number): number {
  return Math.round(world * scale) - camPx + half;
}
