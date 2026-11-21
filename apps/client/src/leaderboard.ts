import { LEADERBOARD_SIZE, UPGRADES, evolutionOf, type BoardId, type LeaderboardItem, type LeaderboardResponse } from '@friday-deploy/shared';
import { LeaderboardError, fetchLeaderboard } from './net';
import { findMine, type MyPlace } from './mine';
import { sharesOf } from './shares';

export type { MyPlace };

/**
 * 순위표 오버레이. 게임 상태와는 무관한 읽기 전용 화면이라 연결(WebSocket)이나 단계(phase)를 건드리지 않는다.
 * 주의: 서버에서 온 문자열(닉네임 등)은 전부 textContent 로만 넣는다 (innerHTML 금지 → XSS 차단).
 */

const BOARD_LABEL: Record<BoardId, string> = { solo: '혼자', coop: '함께' };
/** 같은 순위표를 짧은 시간에 반복해서 받지 않게 하는 보관 시간 (탭을 오가는 것만으로 서버 한도에 걸리지 않도록) */
const CACHE_MS = 15_000;

const mmss = (sec: number): string => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

function shortDate(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** 한 사람이 가졌던 무기·패시브를 아이콘과 단계로 늘어놓는다. 이름은 서버가 보낸 값이라 텍스트 노드로만 넣는다 */
function itemLine(items: LeaderboardItem[], who: string | null): HTMLElement {
  const line = node('span', 'row__items');
  // 진화한 무기는 단계 대신 '진화' (단계가 하나뿐이다)
  const label = items.map((it) => `${UPGRADES[it.id].name} ${evolutionOf(it.id) ? '진화' : `${it.level}단계`}`).join(', ');
  line.setAttribute('aria-label', who ? `${who}의 아이템: ${label}` : `아이템: ${label}`);
  if (who) line.append(node('small', 'row__who', who));
  for (const it of items) {
    const def = UPGRADES[it.id];
    const evolved = evolutionOf(it.id) !== undefined;
    const item = node('span', `row__item row__item--${def.kind}${evolved ? ' row__item--evolved' : ''}`);
    item.title = evolved ? `${def.name} (진화)` : `${def.name} Lv.${it.level}`;
    item.setAttribute('aria-hidden', 'true');
    item.append(node('span', 'chip__icon', def.icon), node('b', '', evolved ? '★' : String(it.level)));
    line.append(item);
  }
  return line;
}

export class Leaderboard {
  private readonly root = document.getElementById('screen-board') as HTMLElement;
  private readonly body = document.getElementById('board-body') as HTMLElement;
  private readonly note = document.getElementById('board-note') as HTMLElement;
  private readonly closeBtn = document.getElementById('btn-board-close') as HTMLButtonElement;
  private readonly tabs: Record<BoardId, HTMLButtonElement> = {
    solo: document.getElementById('tab-board-solo') as HTMLButtonElement,
    coop: document.getElementById('tab-board-coop') as HTMLButtonElement,
  };

  private board: BoardId = 'solo';
  private mine: MyPlace | null = null;
  private seq = 0;
  private abort: AbortController | null = null;
  private cache: Partial<Record<BoardId, { at: number; data: LeaderboardResponse }>> = {};
  private opener: HTMLElement | null = null;
  /** 열려 있는 동안 뒤 화면을 포커스/읽기에서 빼 둔다 (Tab 으로 뒤의 버튼에 닿지 않게) */
  private readonly behind: HTMLElement[];

  constructor(behind: HTMLElement[]) {
    this.behind = behind;
    this.closeBtn.addEventListener('click', () => this.close());
    // 배경(패널 바깥)을 눌러도 닫는다
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
    });
    for (const id of ['solo', 'coop'] as const) {
      this.tabs[id].addEventListener('click', () => this.select(id, false));
      this.tabs[id].addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const next: BoardId = id === 'solo' ? 'coop' : 'solo';
        this.select(next, false);
        this.tabs[next].focus();
      });
    }
    this.root.addEventListener('keydown', (e) => {
      // 오버레이 안에서만 Tab 을 돌린다 (뒤 화면은 inert 이지만 브라우저 주소창으로 빠지는 것도 막는다).
      // 실제로 Tab 이 멈추는 것만 센다: 선택되지 않은 탭은 tabindex=-1 이라 건너뛴다 (화살표 키로 옮긴다).
      if (e.key !== 'Tab') return;
      const items = [this.closeBtn, this.tabs.solo, this.tabs.coop, this.body, ...this.body.querySelectorAll<HTMLElement>('button')].filter(
        (item) => item.tabIndex >= 0,
      );
      const first = items[0]!;
      const lastItem = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** 방금 끝난 판의 순위를 알려 둔다. 열 때 그 줄을 강조한다. */
  setMine(place: MyPlace | null): void {
    this.mine = place;
    if (place) delete this.cache[place.board]; // 새 기록이 올라갔으니 보관해 둔 목록은 낡았다
  }

  open(board: BoardId, fresh = false): void {
    if (!this.isOpen) {
      this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.root.classList.remove('hidden');
      for (const b of this.behind) b.inert = true;
    }
    this.select(board, fresh);
    this.closeBtn.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.isOpen) return;
    this.abort?.abort();
    this.seq++;
    this.root.classList.add('hidden');
    for (const b of this.behind) b.inert = false;
    const back = this.opener;
    this.opener = null;
    // 뒤 화면이 그 사이에 사라졌다면(다른 단계로 넘어감) 포커스는 건드리지 않는다
    if (back && back.isConnected && back.offsetParent !== null) back.focus({ preventScroll: true });
  }

  private select(board: BoardId, fresh: boolean): void {
    this.board = board;
    for (const id of ['solo', 'coop'] as const) {
      const on = id === board;
      this.tabs[id].setAttribute('aria-selected', String(on));
      this.tabs[id].tabIndex = on ? 0 : -1;
      this.tabs[id].classList.toggle('tab--on', on);
    }
    void this.load(fresh);
  }

  private async load(force: boolean): Promise<void> {
    const board = this.board;
    this.abort?.abort();
    const seq = ++this.seq;
    const hit = this.cache[board];
    if (!force && hit && Date.now() - hit.at < CACHE_MS) {
      this.render(hit.data);
      return;
    }
    this.abort = new AbortController();
    this.note.classList.add('hidden');
    this.body.setAttribute('aria-busy', 'true');
    this.body.replaceChildren(node('p', 'board__msg', '불러오는 중… 서버가 잠들어 있었다면 1분쯤 걸릴 수 있어요.'));
    try {
      const data = await fetchLeaderboard(board, this.abort.signal);
      if (seq !== this.seq) return; // 그 사이 다른 탭을 눌렀거나 닫았다
      // 서버가 저장된 기록을 아직 불러오는 중이면 목록이 곧 바뀌므로 보관하지 않는다
      if (data.loading) delete this.cache[board];
      else this.cache[board] = { at: Date.now(), data };
      this.render(data);
    } catch (err) {
      if (seq !== this.seq) return;
      const msg = err instanceof LeaderboardError ? err.message : '순위표를 불러오지 못했어요.';
      const retry = node('button', 'btn board__retry', '↻ 다시 시도');
      retry.type = 'button';
      retry.addEventListener('click', () => void this.load(true));
      this.body.replaceChildren(node('p', 'board__msg board__msg--error', msg), retry);
      this.body.removeAttribute('aria-busy');
    }
  }

  private render(data: LeaderboardResponse): void {
    this.body.removeAttribute('aria-busy');
    const note = !data.persistent
      ? '기록은 서버 메모리에 있어서 서버가 다시 시작되면 사라져요.'
      : data.loading
        ? '저장된 기록을 아직 불러오지 못했어요. 잠시 뒤 다시 열면 목록과 순위가 달라질 수 있어요.'
        : '';
    this.note.classList.toggle('hidden', !note);
    this.note.textContent = note;
    if (data.entries.length === 0) {
      const empty = data.loading ? '저장된 기록을 불러오는 중이에요. 잠시 뒤 다시 열어 주세요.' : '아직 기록이 없어요. 첫 번째 배포의 주인공이 되어보세요!';
      this.body.replaceChildren(node('p', 'board__msg', empty));
      return;
    }
    const m = this.mine;
    const list = node('ol', 'rows');
    list.setAttribute('aria-label', `${BOARD_LABEL[data.board]} 순위표`);
    const mineRank = m && m.board === data.board ? findMine(data.entries, m) : -1;
    let mineRow: HTMLElement | null = null;
    let hasShares = false;
    let hasItems = false;
    for (const e of data.entries.slice(0, LEADERBOARD_SIZE)) {
      const li = node('li', 'row');
      const rank = node('span', `row__rank${e.rank <= 3 ? ` row__rank--${e.rank}` : ''}`, String(e.rank));
      // 이름은 서버가 기여도 순으로 보낸다. 기여도가 있으면 이름 옆에 함께 적는다 (문자열은 전부 텍스트 노드로만 넣는다)
      const names = node('span', 'row__names');
      const shares = sharesOf(e.killsBy, e.names.length);
      if (shares) hasShares = true;
      e.names.forEach((name, i) => {
        if (i > 0) names.append(shares ? ' · ' : ', ');
        names.append(name);
        if (shares) names.append(node('small', 'row__share', ` ${shares[i]}%`));
      });
      // 판이 끝날 때(쓰러졌으면 쓰러질 때) 가진 아이템. 이 값을 남기기 전의 기록에는 없어서 비워 둔다
      const items: HTMLElement[] = [];
      if (e.itemsBy && e.itemsBy.length === e.names.length) {
        e.itemsBy.forEach((list, i) => {
          if (list.length === 0) return;
          hasItems = true;
          items.push(itemLine(list, e.names.length > 1 ? e.names[i]! : null));
        });
      }
      const meta = node('span', 'row__meta');
      for (const t of [`⏱ ${mmss(e.time)}`, `🐛 ${e.kills}`, `Lv.${e.level}`, shortDate(e.at)]) if (t) meta.append(node('span', '', t));
      li.append(rank, names, ...items, meta);
      if (e.rank === mineRank) {
        li.classList.add('row--mine');
        names.append(node('em', '', '내 기록'));
        mineRow = li;
      }
      list.append(li);
    }
    this.body.replaceChildren(list);
    const legend = [
      hasShares ? '이름 옆 % 는 처치 기여도예요 (기여도가 큰 사람부터)' : '',
      hasItems ? '아이콘은 끝날 때 가진 무기·패시브, 숫자는 단계예요' : '',
    ].filter(Boolean);
    if (legend.length > 0) this.body.append(node('p', 'board__legend', legend.join(' · ')));
    this.body.scrollTop = 0;
    // 내 기록이 아래쪽 순위라면 보이는 곳으로 가져온다 (스크롤은 목록 안에서만)
    mineRow?.scrollIntoView({ block: 'nearest' });
  }
}
