import type { ReleaseNote } from '@friday-deploy/shared';

/**
 * 릴리즈노트("새 소식") 오버레이. 타이틀 화면 위에 겹쳐 뜨는 읽기 전용 화면이라 게임 상태는 건드리지 않는다.
 * 내용은 코드에 들어 있는 고정 문자열이지만, 다른 화면과 같은 규칙으로 textContent 로만 넣는다.
 */

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** 2026-11-14 → 2026.11.14 */
const dotted = (date: string): string => date.replaceAll('-', '.');

export class ReleaseNotes {
  private readonly root = document.getElementById('screen-notes') as HTMLElement;
  private readonly body = document.getElementById('notes-body') as HTMLElement;
  private readonly closeBtn = document.getElementById('btn-notes-close') as HTMLButtonElement;
  private readonly okBtn = document.getElementById('btn-notes-ok') as HTMLButtonElement;
  private opener: HTMLElement | null = null;

  /** behind: 열려 있는 동안 포커스/읽기에서 빼 둘 뒤 화면들 */
  constructor(private readonly behind: HTMLElement[]) {
    this.closeBtn.addEventListener('click', () => this.close());
    this.okBtn.addEventListener('click', () => this.close());
    // 배경(패널 바깥)을 눌러도 닫는다
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
    });
    this.root.addEventListener('keydown', (e) => {
      // 오버레이 안에서만 Tab 을 돌린다
      if (e.key !== 'Tab') return;
      const items = [this.closeBtn, this.body, this.okBtn].filter((item) => item.tabIndex >= 0);
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** notes: 보여줄 버전들 (최신순) */
  open(notes: readonly ReleaseNote[]): void {
    if (notes.length === 0) return;
    this.body.replaceChildren(
      ...notes.map((note) => {
        const article = node('article', 'note');
        const head = node('header', 'note__head');
        head.append(node('span', 'note__version', `v${note.version}`), node('time', 'note__date', dotted(note.date)));
        const list = node('ul', 'note__items');
        for (const item of note.items) list.append(node('li', '', item));
        article.append(head, node('h3', 'note__title', note.title), list);
        return article;
      }),
    );
    if (!this.isOpen) {
      this.opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      this.root.classList.remove('hidden');
      for (const b of this.behind) b.inert = true;
    }
    this.body.scrollTop = 0;
    this.okBtn.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.classList.add('hidden');
    for (const b of this.behind) b.inert = false;
    const back = this.opener;
    this.opener = null;
    // 뒤 화면이 그 사이에 사라졌다면 포커스는 건드리지 않는다.
    // (보이는지는 getClientRects 로 판단한다: 버전 표기처럼 position: fixed 인 요소는 offsetParent 가 항상 null 이다)
    if (back && back.isConnected && back.getClientRects().length > 0) back.focus({ preventScroll: true });
  }
}
