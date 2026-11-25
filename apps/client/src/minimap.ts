import { ENEMIES, ENEMY_IDS, FIELD_ITEM_KINDS, VIEW_RADIUS, type Snapshot } from '@friday-deploy/shared';

/** 경험치 점의 색: 색 단계(0 파랑, 1 초록, 2 빨강)별 */
const GEM_DOT = ['rgba(137,180,250,0.45)', 'rgba(166,227,161,0.45)', 'rgba(230,69,83,0.8)'] as const;
/** 적 종류 번호 → 보스인지 */
const IS_BOSS: readonly boolean[] = ENEMY_IDS.map((id) => ENEMIES[id].boss === true);
const MONDAY = ENEMY_IDS.indexOf('monday');

/**
 * 미니맵. 서버가 이미 보내준 정보(내 주변 VIEW_RADIUS 안 + 같은 방 플레이어)만 그린다.
 * 화면 밖에서 다가오는 적, 떨어진 회복 아이템, 멀어진 동료의 방향을 알려주는 용도.
 * 필드 아이템(피자·LGTM·백업·보물상자)은 서버가 거리와 상관없이 보내 준다. 범위 밖이면 가장자리에 붙여 방향을 알려주고,
 * 새로 놓인 것은 몇 초 동안 테두리가 퍼지며 눈에 띄게 한다.
 * 크기와 위치는 CSS 브레이크포인트가 정하고, 여기서는 그 크기에 맞춰 그리기만 한다.
 */
export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private px = 0;
  private lastSnap: Snapshot | null = null;
  private lastAt = 0;
  /** 필드 아이템 id → 처음 본 시각(ms). 새로 놓인 것을 잠깐 강조하는 데 쓴다 */
  private firstSeen = new Map<number, number>();
  private calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

    for (const g of snap.g) dot(mx(g[1]), my(g[2]), Math.max(1, u >> 1), GEM_DOT[g[3]] ?? GEM_DOT[0]);

    // 적: 졸개는 작은 분홍 점, 보스는 큰 보라 네모. 월요일 아침은 붉은 네모가 깜빡이며 퍼지는 테두리를 두른다 (닿으면 끝이다)
    const bosses: [number, number, boolean][] = [];
    for (const e of snap.e) {
      if (IS_BOSS[e[1]]) bosses.push([mx(e[2]), my(e[3]), e[1] === MONDAY]);
      else dot(mx(e[2]), my(e[3]), u, '#f38ba8');
    }
    for (const [x, y, monday] of bosses) {
      if (monday) {
        const grow = this.calm ? u * 3 : u * 2 + ((now % 600) / 600) * u * 4;
        ctx.strokeStyle = '#e64553';
        ctx.lineWidth = Math.max(1, u >> 1);
        ctx.strokeRect(Math.round(x - grow) + 0.5, Math.round(y - grow) + 0.5, Math.round(grow * 2), Math.round(grow * 2));
        dot(x, y, u * 3 + 2, '#11111b');
        dot(x, y, u * 3, Math.floor(now / 200) % 2 && !this.calm ? '#11111b' : '#e64553');
        dot(x, y, u, '#e64553');
      } else {
        dot(x, y, u * 3 + 2, '#11111b');
        dot(x, y, u * 3, '#cba6f7');
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

    const edge = u * 2;

    // 필드 아이템: 거리와 상관없이 표시한다. 범위를 벗어나면 가장자리에 붙여 방향을 알려준다.
    const present = new Set<number>();
    for (const it of snap.i) {
      const kind = FIELD_ITEM_KINDS[it[1]];
      if (!kind) continue;
      present.add(it[0]);
      let born = this.firstSeen.get(it[0]);
      if (born === undefined) this.firstSeen.set(it[0], (born = now));
      const age = now - born;
      // 곧 사라질 것은 깜빡인다
      if (it[4] && !this.calm && Math.floor(now / 250) % 2 === 0) continue;
      const pad = u * 3;
      const x = Math.min(px - pad, Math.max(pad, mx(it[2])));
      const y = Math.min(px - pad, Math.max(pad, my(it[3])));
      // 새로 놓인 것: 4초 동안 테두리가 퍼져 나간다 (동작 줄이기 설정에서는 고정된 테두리)
      if (age < 4000) {
        const grow = this.calm ? u * 4 : u * 3 + ((age % 1000) / 1000) * u * 5;
        ctx.strokeStyle = kind === 'revive' ? '#89dceb' : kind === 'levelup' ? '#f9e2af' : kind === 'chest' ? '#fab387' : kind === 'magnet' ? '#e64553' : '#a6e3a1';
        ctx.lineWidth = Math.max(1, u >> 1);
        ctx.strokeRect(Math.round(x - grow) + 0.5, Math.round(y - grow) + 0.5, Math.round(grow * 2), Math.round(grow * 2));
      }
      if (kind === 'heal') {
        // 피자: 초록 십자 (적이 떨어뜨린 회복 아이템과 같은 모양)
        ctx.fillStyle = '#11111b';
        ctx.fillRect(x - u * 2 - 1, y - (u >> 1) - 1, u * 4 + 2, u + 2);
        ctx.fillRect(x - (u >> 1) - 1, y - u * 2 - 1, u + 2, u * 4 + 2);
        ctx.fillStyle = '#a6e3a1';
        ctx.fillRect(x - u * 2, y - (u >> 1), u * 4, u);
        ctx.fillRect(x - (u >> 1), y - u * 2, u, u * 4);
      } else if (kind === 'levelup') {
        // LGTM: 노란 마름모
        this.diamond(x, y, u + 1, '#11111b');
        this.diamond(x, y, u, '#f9e2af');
      } else if (kind === 'chest') {
        // 보물상자: 갈색 상자에 금테와 자물쇠 (사라지지 않는다. 범위 밖이면 가장자리에서 방향을 알려준다)
        const top = y - Math.round(u * 1.5);
        ctx.fillStyle = '#11111b';
        ctx.fillRect(x - u * 2 - 1, top - 1, u * 4 + 2, u * 3 + 2);
        ctx.fillStyle = '#9a6a43';
        ctx.fillRect(x - u * 2, top, u * 4, u * 3);
        ctx.fillStyle = '#f9e2af';
        ctx.fillRect(x - u * 2, top + u, u * 4, Math.max(1, u >> 1));
        ctx.fillRect(x - (u >> 1), top + u, u, u);
      } else if (kind === 'magnet') {
        // 자석: 진한 빨간 말굽 (아래가 열린 U 자, 두 끝은 흰색). 적의 작은 분홍 점과 모양·색으로 구별된다
        const top = y - Math.round(u * 1.5);
        ctx.fillStyle = '#11111b';
        ctx.fillRect(x - u * 2 - 1, top - 1, u * 4 + 2, u + 2);
        ctx.fillRect(x - u * 2 - 1, top - 1, u + 2, u * 3 + 2);
        ctx.fillRect(x + u - 1, top - 1, u + 2, u * 3 + 2);
        ctx.fillStyle = '#e64553';
        ctx.fillRect(x - u * 2, top, u * 4, u);
        ctx.fillRect(x - u * 2, top, u, u * 2);
        ctx.fillRect(x + u, top, u, u * 2);
        ctx.fillStyle = '#eff1f5';
        ctx.fillRect(x - u * 2, top + u * 2, u, u);
        ctx.fillRect(x + u, top + u * 2, u, u);
      } else {
        // 백업: 하늘색 네모 (가장 드물다. 조금 크게)
        dot(x, y, u * 4 + 2, '#11111b');
        dot(x, y, u * 4, '#89dceb');
        dot(x, y, u * 2, '#eff1f5');
      }
    }
    for (const id of this.firstSeen.keys()) if (!present.has(id)) this.firstSeen.delete(id);

    // 동료: 범위를 벗어나면 가장자리에 붙여서 방향을 알려준다
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

  /** 픽셀 느낌의 마름모: 가운데 줄이 가장 넓고 위아래로 한 칸씩 줄어든다 (s = 한 칸의 크기) */
  private diamond(x: number, y: number, s: number, color: string): void {
    this.ctx.fillStyle = color;
    for (let k = -2; k <= 2; k++) {
      const w = (5 - 2 * Math.abs(k)) * s;
      this.ctx.fillRect(Math.round(x - w / 2), Math.round(y + k * s - s / 2), w, s);
    }
  }
}
