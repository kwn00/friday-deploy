import {
  GAME_TAGLINE,
  GAME_TITLE,
  LEADERBOARD_MIN_SECONDS,
  LEADERBOARD_SIZE,
  MAX_PAUSE_SECONDS,
  ROOM_CODE_LEN,
  UPGRADES,
  normalizeRoomCode,
  sanitizeName,
  type BoardId,
  type GameMode,
  type Offer,
  type RunResult,
  type ServerMsg,
  type Snapshot,
  type UnrankedReason,
  type UpgradeId,
} from '@friday-deploy/shared';
import { Input } from './input';
import { Leaderboard } from './leaderboard';
import { Minimap } from './minimap';
import { Net } from './net';
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
  spectate: $('spectate-text'),
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

type Phase = 'title' | 'connecting' | 'lobby' | 'playing' | 'over';
let phase: Phase = 'title';
let mode: GameMode = 'solo';
let roomCode = '';
let myId = -1;
let hostId = -1;
let roster: { id: number; name: string }[] = [];
let gotResult = false;
let lastError = '';
let menuOpen = false;
/** 서버가 확인해 준 솔로 일시정지가 시작된 시각 (선택 제한 시간 표시를 그만큼 미루는 데 쓴다) */
let pausedSince = 0;
let offerDeadline = 0;
let loadoutKey = '';
/** 방금 끝난 판이 오른 순위표 (결과 화면의 "순위표 보기" 버튼이 이 순위표를 연다) */
let resultBoard: BoardId | null = null;

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null; // 사생활 보호 모드 등
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* 무시 */
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
  el.title.classList.toggle('hidden', next !== 'title' && next !== 'connecting');
  el.lobby.classList.toggle('hidden', next !== 'lobby');
  el.over.classList.toggle('hidden', next !== 'over');
  el.hud.classList.toggle('hidden', next !== 'playing' && next !== 'over');
  if (next !== 'playing') {
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
  const key = JSON.stringify(me.up);
  if (key !== loadoutKey) {
    loadoutKey = key;
    el.loadout.replaceChildren(
      ...(Object.entries(me.up) as [UpgradeId, number][]).map(([id, lv]) => {
        const chip = node('span', 'chip', `${UPGRADES[id].icon} `);
        chip.append(node('b', '', String(lv)));
        chip.title = UPGRADES[id].name;
        return chip;
      }),
    );
  }
}

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

function openMenu(): void {
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
  if (solo) net.sendPause(true);
  el.resume.focus({ preventScroll: true });
}

function closeMenu(): void {
  if (!menuOpen) return;
  hideMenu();
  if (mode === 'solo') net.sendPause(false);
}

function quitToTitle(): void {
  net.close();
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
      const li = node('li', 'players__item', p.name);
      if (p.id === hostId) li.append(node('em', '', '방장'));
      if (p.id === myId) li.append(node('em', 'me', '나'));
      return li;
    }),
  );
  const host = myId === hostId;
  el.start.classList.toggle('hidden', !host);
  el.lobbyStatus.textContent = host
    ? roster.length < 2
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
    case 'welcome':
      // 새 판(또는 같은 방의 다음 판). 결과 화면을 보고 있는 중이면 화면은 그대로 둔다.
      renderer.reset();
      myId = msg.id;
      mode = msg.mode;
      roomCode = msg.code;
      loadoutKey = '';
      break;
    case 'roster':
      roster = msg.players;
      hostId = msg.host;
      renderer.setRoster(msg.players);
      renderLobby();
      if (msg.started) {
        if (phase !== 'playing') {
          gotResult = false;
          setPhase('playing');
        }
      } else if (phase === 'connecting') {
        setPhase('lobby');
      }
      break;
    case 'snap':
      renderer.push(msg);
      updateHud(msg);
      break;
    case 'levelup':
      showOffers(msg.offers, msg.timeout);
      break;
    case 'pause':
      if (msg.on) {
        pausedSince = performance.now();
        el.pauseSub.textContent = `게임을 멈췄어요. ${Math.max(1, Math.ceil(msg.max / 60))}분이 지나면 자동으로 다시 시작돼요.`;
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
    case 'over':
      showResult(msg.result, msg.place, msg.unranked);
      break;
    case 'error':
      lastError = msg.code;
      break;
  }
}

function onClose(reason: string): void {
  const why = ERRORS[lastError] ?? ERRORS[reason];
  lastError = '';
  if (gotResult && phase === 'over') return; // 결과 화면은 그대로 둔다 (다시 하기를 누르면 새로 연결)
  if (phase === 'title') return;
  renderer.reset();
  setPhase('title');
  setStatus(why ?? `연결이 끊겼어요 (${reason}). 아마 누가 금요일에 배포했나 봐요.`);
}

const net = new Net(onMessage, onClose);

async function start(m: GameMode, room?: string): Promise<void> {
  if (phase === 'connecting') return;
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

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.repeat) return;
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

// 탭을 떠나면(전화, 앱 전환 등) 솔로에서는 알아서 멈춘다
document.addEventListener('visibilitychange', () => {
  if (document.hidden && phase === 'playing' && mode === 'solo') openMenu();
});

el.name.value = store.get('name') ?? '';

// 초대 링크(?room=CODE)로 들어온 경우: 코드를 채워 두고 닉네임만 넣으면 되게 한다
const invited = normalizeRoomCode(new URLSearchParams(location.search).get('room'));
if (invited) {
  el.code.value = invited;
  setStatus(`초대받은 방 ${invited} — 닉네임을 넣고 참가를 누르세요.`, true);
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
    net.sendInput(dx, dy);
    lastSent = { dx, dy, at: now };
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
