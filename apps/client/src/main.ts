import {
  APP_VERSION,
  FIELD_ITEMS,
  FIELD_ITEM_KINDS,
  GAME_TAGLINE,
  GAME_TITLE,
  LEADERBOARD_MIN_SECONDS,
  LEADERBOARD_SIZE,
  MAX_PAUSE_SECONDS,
  RELEASES,
  ROOM_CODE_LEN,
  UPGRADES,
  normalizeRoomCode,
  sanitizeName,
  unseenReleases,
  type BoardId,
  type FieldItemKind,
  type GameMode,
  type Offer,
  type RosterPlayer,
  type RunResult,
  type ServerMsg,
  type Snapshot,
  type UnrankedReason,
  type UpgradeId,
} from '@friday-deploy/shared';
import { Input } from './input';
import { Leaderboard } from './leaderboard';
import { ReleaseNotes } from './notes';
import { Minimap } from './minimap';
import { CLOSE_TIMEOUT, ConnectError, Net } from './net';
import { Renderer } from './render';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
  canvas: $<HTMLCanvasElement>('game'),
  hud: $('hud'),
  title: $('screen-title'),
  lobby: $('screen-lobby'),
  levelup: $('screen-levelup'),
  pause: $('screen-pause'),
  over: $('screen-over'),
  name: $<HTMLInputElement>('name-input'),
  code: $<HTMLInputElement>('code-input'),
  solo: $<HTMLButtonElement>('btn-solo'),
  create: $<HTMLButtonElement>('btn-create'),
  join: $<HTMLButtonElement>('btn-join'),
  retry: $<HTMLButtonElement>('btn-retry'),
  home: $<HTMLButtonElement>('btn-home'),
  status: $('status-text'),
  lobbyCode: $('lobby-code'),
  lobbyPlayers: $('lobby-players'),
  lobbyStatus: $('lobby-status'),
  invite: $<HTMLButtonElement>('btn-invite'),
  start: $<HTMLButtonElement>('btn-start'),
  leave: $<HTMLButtonElement>('btn-leave'),
  pauseBtn: $<HTMLButtonElement>('btn-pause'),
  pauseTitle: $('pause-title'),
  pauseSub: $('pause-sub'),
  pauseCode: $('pause-code'),
  resume: $<HTMLButtonElement>('btn-resume'),
  minimapBtn: $<HTMLButtonElement>('btn-minimap'),
  quit: $<HTMLButtonElement>('btn-quit'),
  minimap: $<HTMLCanvasElement>('minimap'),
  reconnect: $('screen-reconnect'),
  reconnectSub: $('reconnect-sub'),
  reconnectQuit: $<HTMLButtonElement>('btn-reconnect-quit'),
  levelupScreen: $('screen-levelup'),
  spectate: $('spectate-text'),
  toast: $('toast-text'),
  version: $('btn-version'),
  offers: $('offers'),
  offerTimer: $('offer-timer'),
  result: $('result'),
  place: $('result-place'),
  resultHint: $('result-hint'),
  resultBoard: $<HTMLButtonElement>('btn-result-board'),
  boardBtn: $<HTMLButtonElement>('btn-board'),
  hpFill: $('hp-fill'),
  hpText: $('hp-text'),
  xpFill: $('xp-fill'),
  lvText: $('lv-text'),
  time: $('time-text'),
  kills: $('kill-text'),
  loadout: $('loadout'),
};

document.title = GAME_TITLE;
$('title-text').textContent = GAME_TITLE;
$('tagline-text').textContent = GAME_TAGLINE;

const input = new Input(el.canvas);
const renderer = new Renderer(el.canvas, input);
const minimap = new Minimap(el.minimap);
// 순위표가 열려 있는 동안 뒤 화면은 포커스를 받지 않는다
const board = new Leaderboard([el.title, el.over, el.lobby]);
const notes = new ReleaseNotes([el.title, el.over, el.lobby]);

type Phase = 'title' | 'connecting' | 'lobby' | 'playing' | 'over';
let phase: Phase = 'title';
let mode: GameMode = 'solo';
let roomCode = '';
let myId = -1;
let hostId = -1;
let roster: RosterPlayer[] = [];
let gotResult = false;
let lastError = '';
let menuOpen = false;
/** 서버가 확인해 준 솔로 일시정지가 시작된 시각 (선택 제한 시간 표시를 그만큼 미루는 데 쓴다) */
let pausedSince = 0;
let offerDeadline = 0;
let loadoutKey = '';
/** 방금 끝난 판이 오른 순위표 (결과 화면의 "순위표 보기" 버튼이 이 순위표를 연다) */
let resultBoard: BoardId | null = null;

/** 이 탭에서만 유지되는 저장소 (새로고침해도 남고, 탭을 닫으면 사라진다) */
const tab = {
  get(key: string): string | null {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      /* 사생활 보호 모드 등: 새로고침 뒤 이어하기만 안 된다 */
    }
  },
  remove(key: string): void {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* 위와 같다 */
    }
  },
};

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null; // 사생활 보호 모드 등
    }
  },
  /** 저장에 성공했는지 돌려준다 (사생활 보호 모드 등에서는 실패할 수 있다) */
  set(key: string, value: string): boolean {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
};

/* 주의: 서버에서 온 문자열은 전부 textContent 로만 넣는다 (innerHTML 금지 → XSS 차단) */
function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const mmss = (sec: number): string => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

const ERRORS: Record<string, string> = {
  room_not_found: '그 코드의 방이 없어요. 코드를 다시 확인해주세요.',
  room_full: '방이 가득 찼거나 이미 끝난 방이에요.',
  server_full: '서버가 가득 찼어요. 잠시 후 다시 시도해주세요.',
  version_mismatch: '새 버전이 배포됐어요. 새로고침 해주세요.',
  bad_session: '세션이 만료됐어요. 다시 시도해주세요.',
  lobby_idle: '대기실이 오래 비어 있어서 닫혔어요.',
  idle: '오랫동안 입력이 없어서 연결이 끊겼어요.',
  replaced: '다른 창에서 이 게임을 이어서 하고 있어요.',
};

/** 타이틀 화면 아래의 안내 줄. 화면이 낮아 가려져 있으면 보이는 곳으로 스크롤한다. info: 오류가 아닌 진행 안내 */
function setStatus(text: string, info = false): void {
  el.status.textContent = text;
  el.status.classList.toggle('status--info', info);
  if (text) el.status.scrollIntoView({ block: 'nearest' });
}

function setPhase(next: Phase): void {
  phase = next;
  // 순위표는 타이틀과 결과 화면에서만 연다. 판이 시작되거나 대기실로 넘어가면(페어에서 방장이 시작한 경우 등) 닫는다.
  if (next !== 'title' && next !== 'over') board.close();
  if (next !== 'title') notes.close();
  el.title.classList.toggle('hidden', next !== 'title' && next !== 'connecting');
  el.lobby.classList.toggle('hidden', next !== 'lobby');
  el.over.classList.toggle('hidden', next !== 'over');
  el.hud.classList.toggle('hidden', next !== 'playing' && next !== 'over');
  if (next !== 'playing') {
    // 판이 끝나거나 나가면 떠 있던 아이템 알림도 치운다
    window.clearTimeout(toastTimer);
    el.toast.classList.add('hidden');
    el.levelup.classList.add('hidden');
    hideMenu();
    // 일시정지한 채로 판을 떠나면 "재개" 알림이 오지 않는다. 남겨 두면 다음 판의 선택 시간 표시가 틀어진다.
    pausedSince = 0;
  }
  el.solo.disabled = el.create.disabled = el.join.disabled = next === 'connecting';
}

/* ───────────── HUD ───────────── */

function updateHud(s: Snapshot): void {
  const me = s.me;
  el.hpFill.style.width = `${Math.max(0, (me.hp / me.maxHp) * 100)}%`;
  el.hpText.textContent = `HP ${me.hp}/${me.maxHp}`;
  el.xpFill.style.width = `${Math.min(100, (me.xp / me.xpNext) * 100)}%`;
  el.lvText.textContent = `Lv.${me.level} · coverage ${Math.floor((me.xp / me.xpNext) * 100)}%`;
  el.time.textContent = mmss(s.time);
  el.kills.textContent = `🐛 ${me.kills}`;
  // 페어에서 쓰러졌거나(또는 누군가 쓰러진 뒤에 들어와서) 이번 판을 관전 중일 때
  el.spectate.classList.toggle('hidden', me.alive || mode !== 'coop' || phase !== 'playing');
  // 관전 안내와 아이템 알림은 같은 자리에 뜬다. 관전 중에는 알림을 치운다 (쓰러진 사람은 아이템을 주울 수도 없다)
  if (!me.alive) el.toast.classList.add('hidden');
  const key = `${JSON.stringify(me.up)}|${me.revives}`;
  if (key !== loadoutKey) {
    loadoutKey = key;
    const chips = (Object.entries(me.up) as [UpgradeId, number][]).map(([id, lv]) => {
      const chip = node('span', 'chip', `${UPGRADES[id].icon} `);
      chip.append(node('b', '', String(lv)));
      chip.title = UPGRADES[id].name;
      return chip;
    });
    // 가지고 있는 백업(부활): 강화들 뒤에 눈에 띄게
    if (me.revives > 0) {
      const chip = node('span', 'chip chip--revive', `${FIELD_ITEMS.revive.icon} `);
      chip.append(node('b', '', String(me.revives)));
      chip.title = `${FIELD_ITEMS.revive.name}: ${FIELD_ITEMS.revive.desc}`;
      chips.push(chip);
    }
    el.loadout.replaceChildren(...chips);
  }
  noticeItems(s);
}

/* ───────────── 아이템 알림 ───────────── */

let toastTimer = 0;
function toast(text: string): void {
  el.toast.textContent = text;
  el.toast.classList.remove('hidden');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.toast.classList.add('hidden'), 3200);
}

/** 이번 판에서 이미 알린 필드 아이템들, 그리고 직전의 내 백업 수 (새 판이 시작되면 비운다) */
const knownItems = new Set<number>();
let lastRevives = 0;
function resetItemNotices(): void {
  knownItems.clear();
  lastRevives = 0;
  window.clearTimeout(toastTimer);
  el.toast.classList.add('hidden');
}

/** 새로 놓인 필드 아이템, 백업을 주웠을 때와 썼을 때를 짧게 알려준다 (어디 있는지는 미니맵이 보여준다) */
function noticeItems(s: Snapshot): void {
  const me = s.me;
  if (me.revives > lastRevives) toast(`${FIELD_ITEMS.revive.icon} 백업 확보! 쓰러져도 한 번 되살아나요`);
  else if (me.revives < lastRevives && me.alive) toast(`${FIELD_ITEMS.revive.icon} 백업으로 되살아났어요!`);
  lastRevives = me.revives;

  let fresh: FieldItemKind | null = null;
  for (const it of s.i) {
    if (knownItems.has(it[0])) continue;
    knownItems.add(it[0]);
    const kind = FIELD_ITEM_KINDS[it[1]];
    // 한꺼번에 여럿이면 가장 드문 것을 알린다
    if (kind && (fresh === null || FIELD_ITEMS[kind].weight < FIELD_ITEMS[fresh].weight)) fresh = kind;
  }
  if (knownItems.size > 64) for (const id of knownItems) if (!s.i.some((it) => it[0] === id)) knownItems.delete(id);
  // 미니맵을 꺼 둔 사람에게 "미니맵을 보세요"라고 하면 헷갈린다: 켜면 보인다고 알려준다
  if (fresh && me.alive && phase === 'playing') toast(`${FIELD_ITEMS[fresh].icon} ${ITEM_DROPPED[fresh]} · ${minimapOn ? '미니맵을 보세요' : '미니맵을 켜면 위치가 보여요'}`);
}

/** 아이템이 놓였을 때의 문구 (이름마다 조사가 달라서 통째로 적는다) */
const ITEM_DROPPED: Record<FieldItemKind, string> = {
  heal: '야근 피자가 떨어졌어요',
  levelup: 'LGTM 이 떨어졌어요',
  revive: '백업이 떨어졌어요!',
};

let minimapOn = store.get('minimap') !== '0';
function applyMinimap(): void {
  el.minimap.classList.toggle('hidden', !minimapOn);
  el.minimapBtn.textContent = minimapOn ? '🗺 미니맵 끄기' : '🗺 미니맵 켜기';
}
function toggleMinimap(): void {
  minimapOn = !minimapOn;
  store.set('minimap', minimapOn ? '1' : '0');
  applyMinimap();
}
applyMinimap();

/* ───────────── 레벨업 ───────────── */

function showOffers(offers: Offer[], timeout: number): void {
  input.reset();
  offerDeadline = performance.now() + timeout * 1000;
  el.offers.replaceChildren(
    ...offers.map((o, i) => {
      const def = UPGRADES[o.id];
      const btn = node('button', 'offer');
      btn.type = 'button';
      const name = node('span', 'offer__name', def.name);
      name.append(node('em', '', o.level === 1 ? 'NEW' : `Lv.${o.level}`));
      btn.append(node('span', 'offer__icon', def.icon), name, node('span', 'offer__desc', def.desc));
      btn.addEventListener('click', () => {
        net.sendPick(i);
        el.levelup.classList.add('hidden');
      });
      return btn;
    }),
  );
  el.levelup.classList.remove('hidden');
}

/* ───────────── 일시정지 / 메뉴 ─────────────
 * 솔로: 서버에 일시정지를 요청해 월드가 실제로 멈춘다.
 * 페어: 메뉴만 열리고 게임은 계속된다 (한 사람이 다른 사람의 게임을 멈출 수 없다). */

function hideMenu(): void {
  menuOpen = false;
  el.pause.classList.add('hidden');
}

/** 메뉴 화면만 연다 (서버에 일시정지를 요청하지 않는다) */
function showMenu(): void {
  if (phase !== 'playing' || menuOpen) return;
  menuOpen = true;
  input.reset();
  const solo = mode === 'solo';
  el.pauseTitle.textContent = solo ? '⏸ git stash' : '☰ 메뉴';
  el.pauseSub.textContent = solo
    ? `게임을 멈췄어요. 최대 ${Math.round(MAX_PAUSE_SECONDS / 60)}분까지 멈춰 둘 수 있어요.`
    : '페어 모드에서는 게임이 멈추지 않아요. 버그들은 기다려주지 않습니다.';
  el.pause.classList.toggle('screen--live', !solo);
  el.pauseCode.classList.toggle('hidden', solo);
  el.pauseCode.textContent = solo ? '' : `방 코드 ${roomCode}`;
  el.pause.classList.remove('hidden');
  el.resume.focus({ preventScroll: true });
}

function openMenu(): void {
  if (phase !== 'playing' || menuOpen) return;
  showMenu();
  if (mode === 'solo') net.sendPause(true);
}

function closeMenu(): void {
  if (!menuOpen) return;
  hideMenu();
  if (mode === 'solo') net.sendPause(false);
}

/** 스스로 나간다: 서버가 자리를 바로 비우고, 이어받기 열쇠도 버린다 */
function quitToTitle(): void {
  stopReconnect();
  forgetSeat();
  net.leave();
  renderer.reset();
  setPhase('title');
}

/* ───────────── 대기실 ───────────── */

function inviteUrl(): string {
  return `${location.origin}${location.pathname}?room=${roomCode}`;
}

function renderLobby(): void {
  el.lobbyCode.textContent = roomCode;
  el.lobbyPlayers.replaceChildren(
    ...roster.map((p) => {
      const li = node('li', p.away ? 'players__item players__item--away' : 'players__item', p.name);
      if (p.id === hostId) li.append(node('em', '', '방장'));
      if (p.id === myId) li.append(node('em', 'me', '나'));
      if (p.away) li.append(node('em', 'away', '연결 끊김'));
      return li;
    }),
  );
  const host = myId === hostId;
  const anyAway = roster.some((p) => p.away);
  el.start.classList.toggle('hidden', !host);
  el.lobbyStatus.textContent = host
    ? anyAway
      ? '연결이 끊긴 사람이 있어요. 조금 기다리면 돌아올 수 있어요. 지금 시작하면 그 사람은 빼고 시작해요.'
      : roster.length < 2
        ? '혼자 시작해도 돼요. 나중에 들어온 사람도 같은 코드로 합류할 수 있어요.'
        : '모두 모였으면 시작하세요.'
    : '방장이 시작하기를 기다리는 중…';
}

async function invite(): Promise<void> {
  const url = inviteUrl();
  try {
    if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ title: GAME_TITLE, text: `${GAME_TITLE} 같이 하자! 방 코드 ${roomCode}`, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    el.lobbyStatus.textContent = '초대 링크를 복사했어요.';
  } catch {
    // 공유를 취소했거나 클립보드를 쓸 수 없는 환경: 코드를 직접 알려주면 된다
    el.lobbyStatus.textContent = `링크를 복사하지 못했어요. 코드 ${roomCode} 를 직접 알려주세요.`;
  }
}

/* ───────────── 결과 ───────────── */

function showResult(r: RunResult, place?: { board: BoardId; rank: number }, unranked?: UnrankedReason): void {
  gotResult = true;
  // 혼자 하는 판은 끝나면 방도 닫힌다: 이어받을 자리가 없다
  if (mode === 'solo') forgetSeat();
  const rows: [string, string][] = [
    ['uptime', mmss(r.time)],
    ['resolved bugs', String(r.kills)],
    ['level', String(r.level)],
  ];
  el.result.replaceChildren(...rows.flatMap(([k, v]) => [node('dt', '', k), node('dd', '', v)]));
  el.retry.textContent = mode === 'coop' ? '↻ 한 판 더 (대기실로)' : '↻ git revert && retry';
  showPlace(r, place, unranked);
  setPhase('over');
}

/** 결과 화면의 순위 안내. 서버가 준 값이라도 모양을 확인하고 textContent 로만 넣는다. */
function showPlace(r: RunResult, place?: { board: BoardId; rank: number }, unranked?: UnrankedReason): void {
  const ok = place && (place.board === 'solo' || place.board === 'coop') && Number.isInteger(place.rank) && place.rank >= 1 && place.rank <= LEADERBOARD_SIZE;
  resultBoard = ok ? place.board : null;
  el.place.classList.toggle('hidden', !ok);
  el.resultBoard.classList.toggle('hidden', !ok);
  // 순위가 없을 때는 서버가 알려준 이유를 그대로 보여준다. 이유를 모르면 아무 말도 하지 않는다 (틀린 안내보다 낫다).
  const hint = !ok && typeof unranked === 'string' && Object.hasOwn(UNRANKED_HINT, unranked) ? UNRANKED_HINT[unranked] : '';
  el.resultHint.classList.toggle('hidden', !hint);
  el.resultHint.textContent = hint;
  if (ok) {
    el.place.textContent = `🏆 ${place.board === 'solo' ? '솔로' : '함께'} 순위표 ${place.rank}위`;
    board.setMine({ board: place.board, rank: place.rank, name: r.name, time: r.time, kills: r.kills, level: r.level });
  } else {
    board.setMine(null);
  }
}

const UNRANKED_HINT: Record<UnrankedReason, string> = {
  watched: '이번 판은 관전만 했어요. 다음 판부터 함께 해요.',
  short: `순위표에는 ${LEADERBOARD_MIN_SECONDS}초 이상 버틴 판부터 기록돼요.`,
  late: '도중에 합류한 판이라 순위표에는 이름이 오르지 않아요.',
  outside: `아쉽게도 순위표 ${LEADERBOARD_SIZE}위 안에는 들지 못했어요.`,
  pending: '서버가 저장된 기록을 불러오는 중이라 순위를 아직 알 수 없어요. 잠시 뒤 순위표에서 확인해 주세요.',
};

/* ───────────── 서버 메시지 ───────────── */

function onMessage(msg: ServerMsg): void {
  switch (msg.t) {
    case 'welcome': {
      // 새 판(또는 같은 방의 다음 판, 또는 끊겼던 자리로 돌아옴). 결과 화면을 보고 있는 중이면 화면은 그대로 둔다.
      const sameRun = msg.resumed === true && msg.id === myId;
      if (reconnecting) {
        resumedAt = performance.now();
        stopReconnect();
      }
      rejoining = false;
      renderer.reset();
      myId = msg.id;
      mode = msg.mode;
      roomCode = msg.code;
      loadoutKey = '';
      // 하던 판으로 돌아온 것이면, 이미 알린 아이템을 새로 떨어진 것처럼 다시 알리지 않는다
      if (!sameRun) resetItemNotices();
      if (msg.resumed === true) {
        // 끊겨 있던 동안의 화면 상태(선택창, 메뉴)는 믿을 수 없다. 서버가 지금 상태를 바로 이어서 알려준다
        el.levelup.classList.add('hidden');
        hideMenu();
        pausedSince = 0;
      }
      rememberSeat(msg.key, msg.mode, msg.code);
      break;
    }
    case 'roster': {
      const before = new Map(roster.map((p) => [p.id, p]));
      roster = msg.players;
      hostId = msg.host;
      renderer.setRoster(msg.players);
      renderLobby();
      // 동료의 연결이 끊겼을 때와 돌아왔을 때 알려준다 (잠깐 화면을 떠난 것은 이름표의 표시로 충분하다)
      if (phase === 'playing' && msg.started) {
        for (const p of msg.players) {
          const was = before.get(p.id);
          if (p.id === myId || !was) continue;
          if (p.away && !was.away) toast(`🔌 ${p.name} 님의 연결이 끊겼어요`);
          else if (!p.away && was.away) toast(`👋 ${p.name} 님이 돌아왔어요`);
        }
      }
      if (msg.started) {
        if (phase !== 'playing') {
          gotResult = false;
          setPhase('playing');
        }
      } else if (phase === 'connecting' || phase === 'playing') {
        // playing 인데 시작 전이라면: 자리를 비운 사이에 판이 끝났고 그 결과는 이미 봤다
        setPhase('lobby');
      }
      break;
    }
    case 'snap':
      renderer.push(msg);
      updateHud(msg);
      touchSeat();
      break;
    case 'levelup':
      showOffers(msg.offers, msg.timeout);
      break;
    case 'pause':
      if (msg.on) {
        pausedSince = performance.now();
        // 내가 멈춘 것이 아니라 서버가 멈춰 둔 것이면(연결이 끊겼다 돌아왔거나, 한동안 입력이 없었다) 메뉴를 열어 알려준다
        const byServer = !menuOpen && mode === 'solo' && phase === 'playing';
        if (byServer) showMenu();
        const minutes = Math.max(1, Math.ceil(msg.max / 60));
        el.pauseSub.textContent = byServer
          ? `자리를 비운 사이에 게임을 멈춰 뒀어요. ${minutes}분이 지나면 자동으로 다시 시작돼요.`
          : `게임을 멈췄어요. ${minutes}분이 지나면 자동으로 다시 시작돼요.`;
      } else {
        const wasPaused = pausedSince > 0;
        // 멈춰 있던 시간만큼 선택 제한 시간 표시도 미룬다
        if (wasPaused) offerDeadline += performance.now() - pausedSince;
        pausedSince = 0;
        if (menuOpen && mode === 'solo') {
          if (wasPaused) {
            hideMenu(); // 서버가 스스로 재개했다 (시간 초과)
          } else {
            // 서버가 일시정지를 받아주지 않았다 (이번 판의 일시정지 시간을 다 씀): 메뉴는 그대로 쓰되 사실대로 알린다
            el.pauseTitle.textContent = '☰ 메뉴';
            el.pauseSub.textContent = '이번 판의 일시정지 시간을 모두 썼어요. 게임은 계속 진행돼요.';
            el.pause.classList.add('screen--live');
          }
        }
      }
      break;
    case 'over': {
      // 끊겼다 돌아오면 서버가 지난 결과를 한 번 더 준다 (받지 못했을 수 있어서). 이미 본 판이면 넘어간다
      const run = Number.isInteger(msg.result?.run) ? msg.result.run : 0;
      if (seat) {
        if (run <= seat.seenRun) break;
        seat.seenRun = run;
        saveSeat();
      }
      // 혼자 하던 판이 자리를 비운 사이에 끝났다면, 이어받는 대신 결과만 온다
      if (reconnecting) stopReconnect();
      showResult(msg.result, msg.place, msg.unranked);
      break;
    }
    case 'error':
      lastError = msg.code;
      break;
  }
}

function onClose(reason: string, code: number): void {
  const err = lastError;
  lastError = '';
  if (reconnecting) return onResumeClosed(err);
  // 혼자 하는 판이 끝났다: 결과 화면은 그대로 둔다 (다시 하기를 누르면 새로 연결)
  if (gotResult && phase === 'over' && mode === 'solo') return forgetSeat();
  if (phase === 'title') return;
  // 서버가 내보낸 것이 아니라 통신이 끊긴 것이면 서버가 자리를 지키고 있다: 다시 붙는다.
  // (다시 붙자마자 또 끊기는 일이 거듭되면 그만둔다)
  if (seat && !err && resumable(code)) {
    flaps = performance.now() - resumedAt < 5000 ? flaps + 1 : 0;
    if (flaps < 3) return beginReconnect();
  }
  // 하던 방으로 다시 들어가려다 실패했을 때: 치지도 않은 코드를 확인하라고 하지 않는다
  const gone = rejoining && (err === 'room_not_found' || err === 'room_full');
  rejoining = false;
  forgetSeat();
  if (gotResult && phase === 'over') return; // 결과 화면은 그대로 둔다
  renderer.reset();
  setPhase('title');
  setStatus(gone ? '하던 방이 사라졌어요. 새 방을 만들어 주세요.' : (ERRORS[err] ?? ERRORS[reason] ?? `연결이 끊겼어요 (${reason}). 아마 누가 금요일에 배포했나 봐요.`));
}

const net = new Net(onMessage, onClose);

/* ───────────── 끊긴 연결 다시 붙기 ─────────────
 * 서버는 통신이 끊긴 사람의 자리를 잠시 지켜 둔다. 서버가 welcome 에 실어 준 열쇠를 내면 같은 캐릭터로 돌아간다.
 * 열쇠는 "어느 자리인지"만 가리킨다. 체력이나 위치 같은 상태는 서버에만 있고, 여기서 보내는 것은 없다. */

interface Seat {
  key: string;
  mode: GameMode;
  code: string;
  /** 이미 결과 화면을 본 판 번호 (서버가 결과를 다시 줄 때 걸러 낸다) */
  seenRun: number;
  /** 마지막으로 연결이 살아 있던 시각 */
  at: number;
}
const SEAT_STORE = 'seat';
/** 이보다 오래 연결이 없었던 자리는 서버에도 남아 있지 않다 (가장 오래 지켜 주는 것이 일시정지 한 번의 길이다) */
const SEAT_STALE_MS = (MAX_PAUSE_SECONDS + 300) * 1000;
/** 화면이 보이는 채로 이만큼 애써도 서버에 닿지 않으면 그만둔다 */
const GIVE_UP_MS = 150_000;

let seat: Seat | null = null;
let reconnecting = false;
/** 시도 하나가 진행 중 (한 번에 하나만 한다) */
let attempting = false;
let retryTimer = 0;
let retryDelay = 500;
let retrySince = 0;
let hintTimer = 0;
let overlayTimer = 0;
let resumedAt = 0;
let flaps = 0;
/** 자리가 없어져서, 하던 방에 코드로 다시 들어가는 중 */
let rejoining = false;

/** 통신이 끊긴 것으로 볼 닫힘 코드. 서버가 이유를 대고 내보낸 것(1000, 1008, 4xxx)은 다시 붙지 않는다 */
function resumable(code: number): boolean {
  return code === CLOSE_TIMEOUT || code === 1001 || code === 1005 || code === 1006 || (code >= 1011 && code <= 1015);
}

function saveSeat(): void {
  if (!seat) return;
  seat.at = Date.now();
  tab.set(SEAT_STORE, JSON.stringify(seat));
}

/** 연결이 살아 있다는 표시를 가끔 새로 남긴다 (새로고침했을 때, 너무 오래된 자리인지 가리는 데 쓴다) */
function touchSeat(): void {
  if (seat && Date.now() - seat.at > 20_000) saveSeat();
}

function forgetSeat(): void {
  seat = null;
  tab.remove(SEAT_STORE);
}

function rememberSeat(key: unknown, m: GameMode, code: string): void {
  if (typeof key !== 'string' || key.length < 16 || key.length > 64) return;
  seat = { key, mode: m, code, seenRun: seat?.key === key ? seat.seenRun : 0, at: 0 };
  saveSeat();
}

function loadSeat(): Seat | null {
  try {
    const o = JSON.parse(tab.get(SEAT_STORE) ?? 'null') as Partial<Seat> | null;
    if (!o || typeof o.key !== 'string' || o.key.length < 16 || o.key.length > 64) return null;
    if (o.mode !== 'solo' && o.mode !== 'coop') return null;
    if (typeof o.at !== 'number' || !(Date.now() - o.at < SEAT_STALE_MS)) return null;
    const code = o.mode === 'coop' ? normalizeRoomCode(o.code) : '';
    if (code === null) return null;
    return { key: o.key, mode: o.mode, code, seenRun: typeof o.seenRun === 'number' && Number.isInteger(o.seenRun) ? o.seenRun : 0, at: o.at };
  } catch {
    return null;
  }
}

/** 다시 연결하는 동안 뒤 화면은 누르거나 포커스할 수 없다 */
const behindReconnect = [el.title, el.lobby, el.levelupScreen, el.pause, el.over, el.hud];

function showReconnect(on: boolean): void {
  window.clearTimeout(hintTimer);
  el.reconnect.classList.toggle('hidden', !on);
  // 순위표와 새 소식은 닫을 때 뒤 화면을 다시 풀어 주므로, 먼저 닫고 나서 막는다
  if (on) {
    board.close();
    notes.close();
  }
  for (const b of behindReconnect) b.inert = on;
  if (!on) return;
  el.reconnectSub.textContent = '연결이 끊겼어요. 다시 연결하는 중이에요…';
  // 오래 걸리면 왜 그런지 알려준다
  hintTimer = window.setTimeout(() => {
    el.reconnectSub.textContent = '다시 연결하는 중이에요… 인터넷이 불안정하거나 서버가 깨어나는 중일 수 있어요. 1분쯤 걸리기도 해요.';
  }, 8000);
  el.reconnectQuit.focus({ preventScroll: true });
}

function beginReconnect(): void {
  if (reconnecting || !seat) return;
  reconnecting = true;
  attempting = false;
  retryDelay = 500;
  retrySince = performance.now();
  input.reset();
  // 금방 다시 붙는 경우가 많다. 그때 안내가 번쩍였다 사라지지 않게 조금 있다가 띄운다
  window.clearTimeout(overlayTimer);
  overlayTimer = window.setTimeout(() => showReconnect(true), 400);
  void tryResume();
}

/** 다시 붙기를 멈춘다 (붙었거나, 그만뒀거나). 화면만 정리하고 연결과 자리는 건드리지 않는다 */
function stopReconnect(): void {
  reconnecting = false;
  attempting = false;
  window.clearTimeout(retryTimer);
  window.clearTimeout(overlayTimer);
  showReconnect(false);
}

async function tryResume(): Promise<void> {
  window.clearTimeout(retryTimer);
  // 화면이 가려져 있는 동안에는 시도하지 않는다. 돌아오면 바로 다시 시도한다
  if (!reconnecting || !seat || attempting || document.hidden) return;
  attempting = true;
  try {
    await net.resume(seat.key);
    // 연결이 열렸고 resume 을 보냈다. 받아들여지면 welcome 이, 아니면 error 와 닫힘이 온다 (그때까지 이 시도는 진행 중이다)
  } catch (err) {
    if (err instanceof ConnectError && err.kind === 'cancelled') return;
    attempting = false;
    // 요청이 너무 많다고 하면 넉넉히 쉰다 (같은 공유기를 쓰는 친구들과 한도를 나눠 쓴다)
    retryLater(err instanceof ConnectError && err.kind === 'rate' ? 3000 : 0);
  }
}

function retryLater(minWait = 0): void {
  if (!reconnecting) return;
  if (performance.now() - retrySince > GIVE_UP_MS) return giveUp('다시 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시작해 주세요.');
  const wait = Math.max(minWait, retryDelay);
  retryDelay = Math.min(5000, retryDelay * 2);
  retryTimer = window.setTimeout(() => void tryResume(), wait);
}

/** 다시 붙으려던 연결이 닫혔다. err: 서버가 닫기 전에 알려준 이유 (없으면 통신 문제) */
function onResumeClosed(err: string): void {
  attempting = false;
  if (err === 'resume_failed') return seatGone();
  if (err === 'version_mismatch') return giveUp(ERRORS.version_mismatch!);
  retryLater(err ? 1000 : 0);
}

/** 다시 붙지 못했다. 결과 화면을 보던 중이면 그대로 두고, 아니면 타이틀로 돌아가 이유를 알린다 */
function giveUp(text: string): void {
  // 새로고침 직후에 조용히 이어 보려던 것이면(connecting) 아무 말 없이 타이틀을 보여준다
  const quiet = phase === 'connecting';
  stopReconnect();
  forgetSeat();
  net.close();
  if (gotResult && phase === 'over') return;
  renderer.reset();
  setPhase('title');
  if (!quiet) setStatus(text);
}

/** 서버가 그 자리는 이제 없다고 했다: 너무 오래 비웠거나, 서버가 새로 시작됐거나, 방이 닫혔다 */
function seatGone(): void {
  const was = seat;
  const quiet = phase === 'connecting';
  giveUp('자리를 너무 오래 비웠거나 서버가 새로 시작돼서, 하던 판을 이어갈 수 없어요.');
  // 함께 하던 방이면 코드로 다시 들어가 본다: 판이 진행 중이면 이번 판은 구경하고, 대기실이면 그대로 함께 한다
  if (quiet || phase !== 'title' || was?.mode !== 'coop' || !was.code) return;
  rejoining = true;
  void start('coop', was.code);
}

async function start(m: GameMode, room?: string): Promise<void> {
  if (phase === 'connecting') return;
  // 새로 시작한다: 하던 자리가 있었다면 비운다
  stopReconnect();
  forgetSeat();
  net.leave();
  mode = m;
  gotResult = false;
  lastError = '';
  const name = sanitizeName(el.name.value);
  store.set('name', name);
  setPhase('connecting');
  // 무료 서버는 한동안 접속이 없으면 잠든다. 깨어나는 동안 아무 반응이 없어 보이지 않게 알려준다.
  setStatus('연결 중… 서버가 잠들어 있었다면 1분쯤 걸릴 수 있어요.', true);
  try {
    await net.connect(name, m, room);
    // 여기까지 오면 연결됐다. 방을 못 찾는 등의 거절은 이 뒤에 서버 메시지로 오고, 그때 다시 안내한다.
    setStatus('', true);
  } catch (err) {
    // 그 사이에 나갔거나 다른 시도가 시작됐다: 화면은 이미 그쪽이 정했다
    if (err instanceof ConnectError && err.kind === 'cancelled') return;
    rejoining = false;
    setPhase('title');
    setStatus(err instanceof Error ? err.message : '연결 실패');
  }
}

/** 입력란에는 코드만이 아니라 초대 링크 전체를 붙여넣을 수도 있다 */
function readCode(raw: string): string | null {
  const fromLink = /[?&]room=([^&#\s]+)/i.exec(raw)?.[1];
  return normalizeRoomCode(fromLink ?? raw);
}

function joinByCode(): void {
  const code = readCode(el.code.value);
  if (!code) {
    setStatus(`방 코드는 ${ROOM_CODE_LEN}자리예요.`);
    el.code.focus({ preventScroll: true });
    return;
  }
  void start('coop', code);
}

el.solo.addEventListener('click', () => void start('solo'));
el.create.addEventListener('click', () => void start('coop'));
el.join.addEventListener('click', joinByCode);
el.code.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinByCode();
});
// 초대 링크를 통째로 붙여넣으면 코드만 남긴다
el.code.addEventListener('input', () => {
  if (el.code.value.length <= ROOM_CODE_LEN) return;
  const code = readCode(el.code.value);
  if (code) el.code.value = code;
});
el.name.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.code.value.trim() ? joinByCode() : void start('solo');
});
el.retry.addEventListener('click', () => {
  if (mode === 'solo') return void start('solo');
  // 페어: 방이 살아 있으면 같은 방 대기실로, 닫혔으면 새 방을 만든다
  if (net.connected) {
    renderLobby();
    setPhase('lobby');
  } else {
    void start('coop');
  }
});
el.home.addEventListener('click', quitToTitle);
el.boardBtn.addEventListener('click', () => board.open('solo'));
el.resultBoard.addEventListener('click', () => board.open(resultBoard ?? 'solo', true));
el.invite.addEventListener('click', () => void invite());
el.start.addEventListener('click', () => net.sendStart());
el.leave.addEventListener('click', quitToTitle);
el.pauseBtn.addEventListener('click', openMenu);
// 레벨업 선택창이 떠 있는 동안에는 화면의 Ⅱ 버튼이 가려지므로, 선택창 안에도 같은 버튼을 둔다
$('btn-levelup-menu').addEventListener('click', openMenu);
el.resume.addEventListener('click', closeMenu);
el.minimapBtn.addEventListener('click', toggleMinimap);
el.quit.addEventListener('click', quitToTitle);
el.reconnectQuit.addEventListener('click', quitToTitle);

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.repeat) return;
  // 다시 연결하는 동안에는 단축키를 받지 않는다 (뒤 화면을 건드리지 않는다)
  if (reconnecting) return;
  // 새 소식이 열려 있으면 Esc 는 그것만 닫는다
  if (notes.isOpen) {
    if (e.code === 'Escape') {
      e.preventDefault();
      notes.close();
    }
    return;
  }
  // 순위표가 열려 있으면 Esc 는 순위표만 닫는다 (메뉴/게임 단축키는 건드리지 않는다)
  if (board.isOpen) {
    if (e.code === 'Escape') {
      e.preventDefault();
      board.close();
    }
    return;
  }
  if (e.code === 'Escape' || e.code === 'KeyP') {
    if (phase !== 'playing') return;
    e.preventDefault();
    if (menuOpen) closeMenu();
    else openMenu();
  } else if (e.code === 'KeyM' && phase === 'playing') {
    toggleMinimap();
  }
});

/** 화면으로 돌아왔거나 네트워크가 돌아왔다: 연결이 살아 있는지 바로 확인하고, 다시 붙는 중이었으면 바로 시도한다 */
function onBack(): void {
  if (document.hidden) return;
  if (reconnecting) {
    // 화면을 떠나 있던 시간은 "애쓴 시간"으로 세지 않는다
    retrySince = performance.now();
    retryDelay = 500;
    void tryResume();
  } else {
    net.poke();
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return onBack();
  saveSeat();
  if (phase !== 'playing') return;
  // 화면을 떠나면(전화, 앱 전환 등) 캐릭터를 세운다. 화면이 가려진 동안에는 입력을 보낼 수 없어서,
  // 그대로 두면 누르고 있던 방향으로 계속 달린다
  input.reset();
  if (net.sendInput(0, 0)) lastSent = { dx: 0, dy: 0, at: performance.now() };
  // 솔로에서는 알아서 멈춘다
  if (mode === 'solo') openMenu();
});
// 뒤로 가기 캐시에서 되살아난 페이지: 연결은 이미 끊겨 있다
window.addEventListener('pageshow', (e) => {
  if (e.persisted) onBack();
});
window.addEventListener('pagehide', saveSeat);
window.addEventListener('online', onBack);

el.name.value = store.get('name') ?? '';

// 버전 표기와 새 소식. 이 버전을 처음 보는 브라우저에는 한 번 자동으로 띄우고, 같은 버전으로 다시 오면 띄우지 않는다.
// "봤다"는 표시를 먼저 남기고 띄운다: 저장할 수 없는 브라우저(사생활 보호 모드 등)에서 올 때마다 뜨는 일이 없게.
el.version.textContent = `v${APP_VERSION}`;
el.version.setAttribute('aria-label', `버전 ${APP_VERSION} · 새 소식 보기`);
el.version.addEventListener('click', () => notes.open(RELEASES.slice(0, 3)));
const unseen = unseenReleases(store.get('seenVersion'));
if (unseen.length > 0 && store.set('seenVersion', APP_VERSION)) notes.open(unseen);

// 초대 링크(?room=CODE)로 들어온 경우: 코드를 채워 두고 닉네임만 넣으면 되게 한다
const invited = normalizeRoomCode(new URLSearchParams(location.search).get('room'));
if (invited) {
  el.code.value = invited;
  setStatus(`초대받은 방 ${invited} — 닉네임을 넣고 참가를 누르세요.`, true);
}

// 새로고침했거나 휴대폰 브라우저가 탭을 다시 불러온 경우: 하던 자리가 남아 있으면 이어서 한다.
// 다른 방의 초대 링크로 들어온 것이면 그 방이 먼저다. 새 버전의 새 소식이 떠 있으면(= 서버가 새로 시작됐다) 시도하지 않는다.
const saved = loadSeat();
if (saved && !notes.isOpen && (!invited || invited === saved.code)) {
  seat = saved;
  mode = saved.mode;
  roomCode = saved.code;
  setPhase('connecting');
  beginReconnect();
} else {
  forgetSeat();
}

// 입력 전송: 값이 바뀌었을 때 + 최대 20Hz (서버 레이트리밋보다 충분히 낮게). 1초에 한 번은 변화가 없어도 보낸다(연결 유지).
let lastSent = { dx: 0, dy: 0, at: 0 };
function pumpInput(now: number): void {
  if (phase !== 'playing') return;
  // 메뉴가 열려 있는 동안에는 캐릭터를 움직이지 않는다
  const dx = menuOpen ? 0 : Math.round(input.dx * 100) / 100;
  const dy = menuOpen ? 0 : Math.round(input.dy * 100) / 100;
  const changed = dx !== lastSent.dx || dy !== lastSent.dy;
  if ((changed && now - lastSent.at >= 50) || now - lastSent.at >= 1000) {
    // 통신이 막혀 있는 동안에는 보내지지 않는다. 그때는 다음 프레임에 최신 값으로 다시 시도한다
    if (net.sendInput(dx, dy)) lastSent = { dx, dy, at: now };
  }
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  pumpInput(now);
  renderer.draw(now, dt);
  if (minimapOn && phase === 'playing' && renderer.sample) minimap.draw(renderer.sample.curr, renderer.viewSize, now);
  if (!el.levelup.classList.contains('hidden')) {
    const left = pausedSince > 0 ? offerDeadline - pausedSince : offerDeadline - now;
    // 시간이 끝나면 서버가 첫 번째 것을 대신 고르고 게임을 이어 간다. 선택창을 남겨 두면 화면과 조작을 가린다.
    if (left <= 0) el.levelup.classList.add('hidden');
    else el.offerTimer.textContent = `(${Math.ceil(left / 1000)}s)`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
