/**
 * 키보드 이동 입력 (WASD/방향키): 눌린 키를 모아 이동 방향을 만든다.
 * 이 파일은 화면(DOM)을 쓰지 않는다 (단위 테스트에서 검사한다). 키 이벤트를 받는 것은 input.ts 가 한다.
 */

const KEYMAP: Readonly<Record<string, readonly [number, number]>> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

export class MoveKeys {
  private held = new Set<string>();

  /**
   * 키를 눌렀다. 이동 입력으로 받았으면 true: 그때만 브라우저의 기본 동작(스크롤 등)을 막는다.
   * active: 지금 이동 입력을 받을 때인지 (판이 진행 중이고, 메뉴·선택창 같은 겹친 화면이 없을 때).
   * 아닐 때는 키를 건드리지 않는다: 방향키로 순위표나 새 소식 목록을 스크롤할 수 있게
   */
  down(code: string, active: boolean): boolean {
    if (!active || !Object.hasOwn(KEYMAP, code)) return false;
    this.held.add(code);
    return true;
  }

  /** 키를 뗐다 (받지 않았던 키여도 괜찮다) */
  up(code: string): void {
    this.held.delete(code);
  }

  clear(): void {
    this.held.clear();
  }

  /** 눌린 키로 만든 이동 방향 (길이 1, 아무것도 없거나 서로 지우면 0) */
  dir(): { dx: number; dy: number } {
    let x = 0;
    let y = 0;
    for (const k of this.held) {
      const v = KEYMAP[k];
      if (v) {
        x += v[0];
        y += v[1];
      }
    }
    x = Math.sign(x);
    y = Math.sign(y);
    const len = Math.hypot(x, y) || 1;
    return { dx: x / len, dy: y / len };
  }
}
