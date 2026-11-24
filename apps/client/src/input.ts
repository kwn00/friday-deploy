import { MoveKeys } from './move-keys';

/** 키보드(WASD/방향키) + 터치 가상 조이스틱(화면 아무 곳이나 드래그) */
export class Input {
  dx = 0;
  dy = 0;
  /** 조이스틱 UI 표시용 (CSS 픽셀 좌표) */
  stick: { ox: number; oy: number; x: number; y: number } | null = null;

  private keys = new MoveKeys();
  private pointerId: number | null = null;
  private static readonly RADIUS = 48;

  /**
   * active: 지금 키보드 이동을 받을 때인지 (판이 진행 중이고 겹친 화면이 없을 때. main.ts 가 알려준다).
   * 아닐 때는 방향키·WASD 를 그냥 두어 브라우저가 스크롤 등에 쓴다
   */
  constructor(target: HTMLElement, active: () => boolean = () => true) {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (this.keys.down(e.code, active())) {
        e.preventDefault();
        this.fromKeys();
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys.up(e.code);
      this.fromKeys();
    });
    window.addEventListener('blur', () => this.reset());

    target.addEventListener('pointerdown', (e) => {
      if (this.pointerId !== null) return;
      this.pointerId = e.pointerId;
      target.setPointerCapture(e.pointerId);
      this.stick = { ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
    });
    target.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.pointerId || !this.stick) return;
      const R = Input.RADIUS;
      let vx = e.clientX - this.stick.ox;
      let vy = e.clientY - this.stick.oy;
      const len = Math.hypot(vx, vy);
      if (len > R) {
        vx = (vx / len) * R;
        vy = (vy / len) * R;
      }
      this.stick.x = this.stick.ox + vx;
      this.stick.y = this.stick.oy + vy;
      const dead = len < 6;
      this.dx = dead ? 0 : vx / R;
      this.dy = dead ? 0 : vy / R;
    });
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== this.pointerId) return;
      this.pointerId = null;
      this.stick = null;
      this.fromKeys();
    };
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  reset(): void {
    this.keys.clear();
    this.pointerId = null;
    this.stick = null;
    this.dx = 0;
    this.dy = 0;
  }

  private fromKeys(): void {
    const { dx, dy } = this.keys.dir();
    this.dx = dx;
    this.dy = dy;
  }
}
