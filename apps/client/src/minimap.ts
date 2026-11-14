import { ENEMY_IDS, VIEW_RADIUS, type Snapshot } from '@friday-deploy/shared';

/**
 * 미니맵. 서버가 이미 보내준 정보(내 주변 VIEW_RADIUS 안 + 같은 방 플레이어)만 그린다.
 * 화면 밖에서 다가오는 적, 떨어진 회복 아이템, 멀어진 동료의 방향을 알려주는 용도.
 * 크기와 위치는 CSS 브레이크포인트가 정하고, 여기서는 그 크기에 맞춰 그리기만 한다.
 */
export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private px = 0;
  private lastSnap: Snapshot | null = null;
  private lastAt = 0;

  constructor(private el: HTMLCanvasElement) {
    this.ctx = el.getContext('2d')!;
  }

  draw(snap: Snapshot, view: { w: number; h: number }, now: number): void {
    const css = this.el.clientWidth;
    if (css === 0) return; // 숨겨져 있음
    // 스냅샷은 초당 20번 바뀐다. 그보다 자주 그릴 필요가 없다 (회복 아이템 깜빡임 때문에 가만히 있어도 가끔은 다시 그린다)
    if (snap === this.lastSnap && now - this.lastAt < 120) return;
    this.lastSnap = snap;
    this.lastAt = now;

    const px = Math.round(css * Math.min(window.devicePixelRatio || 1, 3));
    if (px !== this.px) this.px = this.el.width = this.el.height = px;
    const { ctx } = this;
    const c = px / 2;
    const k = px / (VIEW_RADIUS * 2);
    const u = Math.max(2, Math.round(px / 46)); // 점 하나의 기본 크기
    // 중심 = 화면의 중심 (내 캐릭터 또는 관전 시점)
    const [vx, vy] = snap.view;
    const mx = (x: number): number => Math.round(c + (x - vx) * k);
    const my = (y: number): number => Math.round(c + (y - vy) * k);
    const dot = (x: number, y: number, size: number, color: string): void => {
      ctx.fillStyle = color;
      ctx.fillRect(x - (size >> 1), y - (size >> 1), size, size);
    };

    ctx.clearRect(0, 0, px, px);
    ctx.fillStyle = 'rgba(17,17,27,0.62)';
    ctx.fillRect(0, 0, px, px);

    // 지금 화면에 보이는 범위
    ctx.strokeStyle = 'rgba(205,214,244,0.28)';
    ctx.lineWidth = Math.max(1, u >> 1);
    ctx.strokeRect(Math.round(c - (view.w / 2) * k) + 0.5, Math.round(c - (view.h / 2) * k) + 0.5, Math.round(view.w * k), Math.round(view.h * k));

    for (const g of snap.g) dot(mx(g[1]), my(g[2]), Math.max(1, u >> 1), 'rgba(166,227,161,0.45)');

    for (const e of snap.e) {
      if (ENEMY_IDS[e[1]] === 'legacy_code') {
        dot(mx(e[2]), my(e[3]), u * 3 + 2, '#11111b');
        dot(mx(e[2]), my(e[3]), u * 3, '#cba6f7');
      } else {
        dot(mx(e[2]), my(e[3]), u, '#f38ba8');
      }
    }

    // 회복 아이템: 십자 모양으로 깜빡인다
    if (Math.floor(now / 350) % 3 !== 0) {
      for (const h of snap.h) {
        const x = mx(h[1]);
        const y = my(h[2]);
        ctx.fillStyle = '#11111b';
        ctx.fillRect(x - u * 2 - 1, y - (u >> 1) - 1, u * 4 + 2, u + 2);
        ctx.fillRect(x - (u >> 1) - 1, y - u * 2 - 1, u + 2, u * 4 + 2);
        ctx.fillStyle = '#a6e3a1';
        ctx.fillRect(x - u * 2, y - (u >> 1), u * 4, u);
        ctx.fillRect(x - (u >> 1), y - u * 2, u, u * 4);
      }
    }

    // 동료: 범위를 벗어나면 가장자리에 붙여서 방향을 알려준다
    const edge = u * 2;
    for (const p of snap.p) {
      // 살아 있는 나는 가운데 점으로 그린다. 쓰러진 뒤에는 내 묘비도 다른 묘비처럼 표시한다 (관전 시점이 묘비를 떠나므로)
      if (p[0] === snap.me.id && p[4]) continue;
      const x = Math.min(px - edge, Math.max(edge, mx(p[1])));
      const y = Math.min(px - edge, Math.max(edge, my(p[2])));
      dot(x, y, u * 2 + 2, '#11111b');
      dot(x, y, u * 2, p[4] ? '#89b4fa' : '#6c7086');
    }

    dot(c | 0, c | 0, u * 2 + 2, '#11111b');
    dot(c | 0, c | 0, u * 2, '#eff1f5');
  }
}
