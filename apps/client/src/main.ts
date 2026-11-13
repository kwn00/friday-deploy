import { GAME_TAGLINE, GAME_TITLE, UPGRADES, sanitizeName, type GameMode, type Offer, type RunResult, type ServerMsg, type Snapshot, type UpgradeId } from '@friday-deploy/shared';
import { Input } from './input';
import { Net } from './net';
import { Renderer } from './render';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
  canvas: $<HTMLCanvasElement>('game'),
  hud: $('hud'),
  title: $('screen-title'),
  levelup: $('screen-levelup'),
  over: $('screen-over'),
  name: $<HTMLInputElement>('name-input'),
  solo: $<HTMLButtonElement>('btn-solo'),
  coop: $<HTMLButtonElement>('btn-coop'),
  retry: $<HTMLButtonElement>('btn-retry'),
  status: $('status-text'),
  offers: $('offers'),
  offerTimer: $('offer-timer'),
  result: $('result'),
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

type Phase = 'title' | 'connecting' | 'playing' | 'over';
let phase: Phase = 'title';
let mode: GameMode = 'solo';
let gotResult = false;
let offerDeadline = 0;
let loadoutKey = '';

/* 주의: 서버에서 온 문자열은 전부 textContent 로만 넣는다 (innerHTML 금지 → XSS 차단) */
function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const mmss = (sec: number): string => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

function setPhase(next: Phase): void {
  phase = next;
  el.title.classList.toggle('hidden', next !== 'title' && next !== 'connecting');
  el.over.classList.toggle('hidden', next !== 'over');
  el.hud.classList.toggle('hidden', next !== 'playing' && next !== 'over');
  if (next !== 'playing') el.levelup.classList.add('hidden');
  el.solo.disabled = el.coop.disabled = next === 'connecting';
}

function updateHud(s: Snapshot): void {
  const me = s.me;
  el.hpFill.style.width = `${Math.max(0, (me.hp / me.maxHp) * 100)}%`;
  el.hpText.textContent = `HP ${me.hp}/${me.maxHp}`;
  el.xpFill.style.width = `${Math.min(100, (me.xp / me.xpNext) * 100)}%`;
  el.lvText.textContent = `Lv.${me.level} · coverage ${Math.floor((me.xp / me.xpNext) * 100)}%`;
  el.time.textContent = mmss(s.time);
  el.kills.textContent = `🐛 ${me.kills}`;
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

function showResult(r: RunResult): void {
  gotResult = true;
  const rows: [string, string][] = [
    ['uptime', mmss(r.time)],
    ['resolved bugs', String(r.kills)],
    ['level', String(r.level)],
  ];
  el.result.replaceChildren(...rows.flatMap(([k, v]) => [node('dt', '', k), node('dd', '', v)]));
  setPhase('over');
}

function onMessage(msg: ServerMsg): void {
  switch (msg.t) {
    case 'welcome':
      renderer.reset();
      loadoutKey = '';
      setPhase('playing');
      break;
    case 'roster':
      renderer.setRoster(msg.players);
      break;
    case 'snap':
      renderer.push(msg);
      updateHud(msg);
      break;
    case 'levelup':
      showOffers(msg.offers, msg.timeout);
      break;
    case 'over':
      showResult(msg.result);
      break;
    case 'error':
      el.status.textContent = `서버 오류: ${msg.code}`;
      break;
  }
}

function onClose(reason: string): void {
  if (gotResult) return;
  if (phase === 'playing' || phase === 'connecting') {
    renderer.reset();
    setPhase('title');
    el.status.textContent = `연결이 끊겼어요 (${reason}). 아마 누가 금요일에 배포했나 봐요.`;
  }
}

const net = new Net(onMessage, onClose);

async function start(m: GameMode): Promise<void> {
  if (phase === 'connecting') return;
  mode = m;
  gotResult = false;
  el.status.textContent = '';
  const name = sanitizeName(el.name.value);
  try {
    localStorage.setItem('name', name);
  } catch {
    /* 사생활 보호 모드 등 */
  }
  setPhase('connecting');
  try {
    await net.connect(name, m);
  } catch (err) {
    setPhase('title');
    el.status.textContent = err instanceof Error ? err.message : '연결 실패';
  }
}

el.solo.addEventListener('click', () => void start('solo'));
el.coop.addEventListener('click', () => void start('coop'));
el.retry.addEventListener('click', () => void start(mode));
el.name.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void start('solo');
});
try {
  el.name.value = localStorage.getItem('name') ?? '';
} catch {
  /* 무시 */
}

// 입력 전송: 값이 바뀌었을 때 + 최대 20Hz (서버 레이트리밋보다 충분히 낮게)
let lastSent = { dx: 0, dy: 0, at: 0 };
function pumpInput(now: number): void {
  if (phase !== 'playing') return;
  const dx = Math.round(input.dx * 100) / 100;
  const dy = Math.round(input.dy * 100) / 100;
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
  if (!el.levelup.classList.contains('hidden')) {
    el.offerTimer.textContent = `(${Math.max(0, Math.ceil((offerDeadline - now) / 1000))}s)`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
