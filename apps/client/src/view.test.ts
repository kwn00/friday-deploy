import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cameraPx, computeView, toScreen } from './view';

test('view: 카메라가 따라가는 대상은 좌표와 화면 크기에 상관없이 항상 같은 픽셀에 찍힌다 (떨림 없음)', () => {
  for (const scale of [1, 2, 3, 4, 5, 6, 7]) {
    for (const pxW of [1170, 1171, 1320, 1323, 1920]) {
      const half = pxW >> 1;
      for (let i = 0; i < 4000; i++) {
        const x = -500 + i * 0.01337; // 논리 픽셀의 온갖 소수 위치
        assert.equal(toScreen(x, cameraPx(x, scale), half, scale), half);
      }
    }
  }
});

test('view: (회귀) 예전 방식은 캔버스 폭이 홀수일 때 캐릭터가 한 논리 픽셀씩 왔다 갔다 했다', () => {
  // 예전 코드: ox = round(w/2 - cx); 화면 x = round(cx + ox - 스프라이트 반폭)
  const old = (cx: number, w: number): number => Math.round(cx + Math.round(w / 2 - cx) - 7);
  const seen = new Set<number>();
  for (let i = 0; i < 400; i++) seen.add(old(10 + i * 0.013, 195)); // 195 = 아이폰 세로 논리 폭
  assert.equal(seen.size, 2, '버그 재현: 두 위치를 오간다');
});

test('view: 멈춰 있는 두 물체 사이의 화면 간격은 카메라가 움직여도 변하지 않는다', () => {
  const scale = 6;
  const half = 585;
  for (let i = 0; i < 2000; i++) {
    const cam = cameraPx(100 + i * 0.0173, scale);
    assert.equal(toScreen(140.3, cam, half, scale) - toScreen(96.7, cam, half, scale), Math.round(140.3 * scale) - Math.round(96.7 * scale));
  }
});

test('view: 한 프레임의 이동량이 고르다 (예전에는 6~7 기기 픽셀 단위로 0 또는 한 칸씩 튀었다)', () => {
  const scale = 6;
  const speed = 70; // 논리 px/s
  const steps: number[] = [];
  const oldSteps: number[] = [];
  let prev = cameraPx(0, scale);
  let prevOld = Math.round(0) * scale;
  for (let f = 1; f <= 600; f++) {
    const x = (speed * f) / 60;
    const now = cameraPx(x, scale);
    steps.push(now - prev);
    prev = now;
    const nowOld = Math.round(x) * scale; // 논리 픽셀 단위 반올림
    oldSteps.push(nowOld - prevOld);
    prevOld = nowOld;
  }
  const spread = (a: number[]): number => Math.max(...a) - Math.min(...a);
  assert.ok(spread(steps) <= 1, `새 방식: 프레임당 이동량 차이 ${spread(steps)}px`);
  assert.ok(spread(oldSteps) >= scale, `예전 방식: ${spread(oldSteps)}px`);
});

test('view: 기기별 배율', () => {
  const logical = (cssW: number, cssH: number, dpr: number, fine: boolean): [number, number, number] => {
    const v = computeView(cssW, cssH, dpr, fine);
    return [v.scale, Math.round(v.pxW / v.scale), Math.round(v.pxH / v.scale)];
  };
  // 폰은 예전과 같은 크기를 유지한다
  assert.deepEqual(logical(390, 844, 3, false), [6, 195, 422]);
  assert.deepEqual(logical(844, 390, 3, false), [6, 422, 195]);
  // 데스크톱은 더 넓게 본다 (예전: 1080p 에서 배율 5 → 384×216)
  assert.deepEqual(logical(1920, 1080, 1, true), [4, 480, 270]);
  assert.deepEqual(logical(1280, 800, 1, true), [3, 427, 267]);
  assert.deepEqual(logical(2560, 1440, 1, true), [5, 512, 288]);
  // 작은 데스크톱 창에서도 캐릭터가 너무 작아지지 않는다 (배율 1 이 되지 않게)
  assert.equal(computeView(480, 320, 1, true).scale, 2);
  assert.equal(computeView(560, 400, 1, true).scale, 2);
  assert.equal(computeView(800, 600, 1, true).scale, 2);
  // 어떤 화면에서도 모서리가 적 생성 거리(300) 안쪽에 있다: 적이 생기는 순간이 보이지 않는다
  for (const [w, h, d, f] of [
    [390, 844, 3, false], [844, 390, 3, false], [440, 956, 3, false], [768, 1024, 2, false], [1024, 768, 2, false],
    [360, 800, 2.625, false], [1280, 800, 1, true], [1366, 768, 1, true], [1920, 1080, 1, true], [2560, 1440, 1, true],
    [3840, 2160, 1, true], [1512, 982, 2, true], [800, 600, 1, true], [3440, 1440, 1, true], [320, 480, 1, false],
  ] as [number, number, number, boolean][]) {
    const v = computeView(w, h, d, f);
    assert.ok(Number.isInteger(v.scale) && v.scale >= 1);
    assert.ok(Math.hypot(v.pxW, v.pxH) / v.scale / 2 < 300, `${w}x${h}@${d}: 모서리까지 ${Math.hypot(v.pxW, v.pxH) / v.scale / 2}`);
  }
});
