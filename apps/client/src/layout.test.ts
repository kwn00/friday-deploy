/**
 * style.css 의 몇 가지 자리 계산을 확인한다 (실제 화면 확인은 Playwright 로 한다. 이것은 숫자를 바꿀 때 놓치지 않게 하는 것).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const CSS = readFileSync(new URL('./style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * 맨 위(top-level) 또는 head 로 시작하는 @media 블록들 안의 규칙들: 선택자 → 선언들
 * (같은 head 의 블록이 여럿이면 모두 합친다. 같은 선택자가 여럿이면 뒤의 것이 덮는다)
 */
function rules(head?: string): Map<string, Record<string, string>> {
  let body = CSS;
  if (head) {
    const blocks: string[] = [];
    for (let start = CSS.indexOf(`${head} {`); start >= 0; start = CSS.indexOf(`${head} {`, start + 1)) {
      let depth = 0;
      let end = start;
      for (let i = CSS.indexOf('{', start); i < CSS.length; i++) {
        if (CSS[i] === '{') depth++;
        else if (CSS[i] === '}' && --depth === 0) {
          end = i;
          break;
        }
      }
      blocks.push(CSS.slice(CSS.indexOf('{', start) + 1, end));
    }
    assert.ok(blocks.length > 0, `style.css 에 ${head} 가 없다`);
    body = blocks.join('\n');
  } else {
    // 맨 위 규칙만: @media 블록을 지운다
    body = body.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  }
  const out = new Map<string, Record<string, string>>();
  for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls: Record<string, string> = {};
    for (const d of m[2]!.split(';')) {
      const i = d.indexOf(':');
      if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
    for (const sel of m[1]!.split(',').map((s) => s.trim())) out.set(sel, { ...out.get(sel), ...decls });
  }
  return out;
}

const px = (v: string | undefined, what: string): number => {
  const m = /^(-?[\d.]+)px$/.exec(v ?? '');
  assert.ok(m, `${what}: px 값이 아니다 (${v})`);
  return Number(m[1]);
};

const LOW_LANDSCAPE = '@media (orientation: landscape) and (max-height: 480px)';
/** 닉네임과 시작 무기를 나란히 두는 가로 화면: 가로 폰과 높이 720 이하의 태블릿·노트북 창 (1024×552, 1280×600, 1366×657 등) */
const SIDE_BY_SIDE = '@media (orientation: landscape) and (max-height: 720px)';
const SHORT_PORTRAIT = '@media (orientation: portrait) and (max-height: 540px)';

test('화면: 낮은 가로 화면 타이틀에서 구석 버튼(버전·소리)의 누르는 높이가 방 코드 칸·참가 버튼에 닿지 않는다', () => {
  const top = rules();
  const low = rules(LOW_LANDSCAPE);
  // 구석 버튼은 패널 안쪽 아래 구석에 붙는다 (max-height: 540px). 그 높이만큼 참가 줄 아래에 자리가 있어야 한다:
  // 안내 한 줄의 위 여백 + 안내 한 줄 높이 + 상태줄 위 여백(빈 상태줄은 높이 0) + 패널 아래 여백
  const corner = px(top.get('.version')?.['min-height'], '.version min-height');
  assert.ok(corner >= 44, '구석 버튼은 손가락 크기(44px) 이상');
  const hintLine = px(top.get('.hint')?.['font-size'], '.hint font-size') * Number(top.get('body')?.['line-height']);
  const below =
    px(low.get('.hint')?.['margin-top'], '.hint margin-top') +
    hintLine +
    px(low.get('.panel--title .status')?.['margin-top'], '.panel--title .status margin-top') +
    px(low.get('.panel--title')?.['padding-bottom'], '.panel--title padding-bottom');
  assert.ok(below >= corner + 2, `참가 줄 아래 ${below}px < 구석 버튼 ${corner}px + 2`);
});

test('화면: 낮은 가로 화면 결과 화면은 보이는 버튼(2~3개)을 모두 한 줄에 놓는다 (두 줄이면 "처음으로"가 화면 밖)', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const over = html.slice(html.indexOf('id="screen-over"'), html.indexOf('</section>', html.indexOf('id="screen-over"')));
  assert.match(over, /class="panel panel--over"/, '결과 화면 패널에 panel--over');
  for (const id of ['btn-retry', 'btn-result-board', 'btn-home']) assert.ok(over.includes(`id="${id}"`), id);
  const low = rules(LOW_LANDSCAPE).get('.panel--over .buttons');
  assert.ok(low, '.panel--over .buttons 규칙이 없다');
  // 칸 수를 정하지 않고(none) 보이는 버튼 수만큼 칸을 만든다: 순위에 오르지 않아 2개일 때 빈 칸이 생기지 않게
  assert.equal(low['grid-template-columns'], 'none');
  assert.equal(low['grid-auto-flow'], 'column');
  assert.equal(low['grid-auto-columns'], 'minmax(0, 1fr)');
});

test('화면: 메뉴의 계속하기는 가진 아이템 목록보다 앞에 있고, 목록만 따로 스크롤된다 (Tab 으로 고를 수 있다)', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const pause = html.slice(html.indexOf('id="screen-pause"'), html.indexOf('id="screen-over"'));
  assert.match(pause, /class="panel panel--menu panel--pause"/);
  const at = (id: string): number => {
    const i = pause.indexOf(`id="${id}"`);
    assert.ok(i >= 0, id);
    return i;
  };
  // 목록이 길어도 계속하기가 밀려 내려가지 않게 목록보다 앞에 둔다 (세로 화면은 위에서 아래로 이 순서)
  for (const id of ['pause-items', 'btn-minimap', 'btn-sfx', 'btn-music', 'btn-quit']) assert.ok(at('btn-resume') < at(id), id);
  assert.match(pause, /id="pause-items"[^>]*tabindex="0"/, '목록은 키보드로 스크롤할 수 있게 Tab 이 멈춘다');

  const top = rules();
  assert.equal(top.get('.panel.panel--pause')?.['max-height'], '100%', '패널이 화면 높이를 넘지 않는다');
  assert.equal(top.get('.pause__body')?.['min-height'], '0');
  assert.equal(top.get('.items')?.['overflow-y'], 'auto');
  assert.equal(top.get('.items')?.['min-height'], '0');
  // 버튼은 어느 배치에서도 손가락 크기(44px) 이상
  for (const [where, r] of [
    ['세로', top],
    ['넓은 화면', rules('@media (min-width: 768px)')],
    ['낮은 가로', rules(LOW_LANDSCAPE)],
  ] as const) {
    assert.ok(px(r.get('.pause__tools .btn')?.['min-height'], `${where} .pause__tools .btn`) >= 44, where);
  }
});

test('화면: 시작 무기는 타이틀의 닉네임 아래와 대기실에 네이티브 radio 묶음(fieldset·legend)으로 있다', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const title = html.slice(html.indexOf('id="screen-title"'), html.indexOf('id="screen-lobby"'));
  const at = (id: string): number => {
    const i = title.indexOf(`id="${id}"`);
    assert.ok(i >= 0, id);
    return i;
  };
  // 닉네임 칸 아래, 시작 버튼 위
  assert.ok(at('name-input') < at('starter-title') && at('starter-title') < at('btn-solo'));
  assert.match(title, /<fieldset id="starter-title" class="starter">\s*<legend class="starter__legend">/);
  const lobby = html.slice(html.indexOf('id="screen-lobby"'), html.indexOf('id="screen-levelup"'));
  assert.match(lobby, /<fieldset id="starter-lobby" class="starter starter--lobby">\s*<legend class="starter__legend">/);
  assert.ok(lobby.indexOf('id="starter-lobby"') < lobby.indexOf('id="btn-start"'), '시작 버튼보다 위');
});

test('화면: 시작 무기 타일은 어느 배치에서도 손가락 크기(44px) 이상이고, 320px 에서 넘치지 않게 네 칸이 줄어든다', () => {
  const top = rules();
  // fieldset 은 기본으로 내용보다 좁아지지 않는다: min-width 0 이어야 320px 패널 안에 들어간다
  assert.equal(top.get('.starter')?.['min-width'], '0');
  assert.equal(top.get('.starter__tiles')?.['grid-template-columns'], 'repeat(4, minmax(0, 1fr))');
  assert.equal(top.get('.starter__tile')?.['min-width'], '0');
  assert.ok(px(top.get('.starter__tile')?.['min-height'], '.starter__tile min-height') >= 44);
  for (const head of ['@media (min-width: 480px)', LOW_LANDSCAPE]) {
    const mh = rules(head).get('.starter__tile')?.['min-height'];
    if (mh) assert.ok(px(mh, `${head} .starter__tile`) >= 44, head);
  }
  // radio 는 숨기지 않고(display:none 이면 방향키·화면 낭독기가 못 쓴다) 투명하게 타일 전체를 덮는다
  const radio = top.get('.starter__radio')!;
  assert.deepEqual([radio.position, radio.inset, radio.opacity], ['absolute', '0', '0']);
  assert.notEqual(radio.display, 'none');
});

test('화면: 낮은 가로 화면(높이 720 이하)에서는 닉네임과 시작 무기, 초대 링크와 내 시작 무기를 나란히 둔다 (세로 공간을 늘리지 않게)', () => {
  const low = rules(SIDE_BY_SIDE);
  assert.equal(low.get('.setup')?.display, 'grid');
  assert.equal(low.get('.setup')?.['grid-template-columns'], 'minmax(0, 2fr) minmax(0, 3fr)');
  assert.equal(low.get('.setup .field')?.['margin-bottom'], '0');
  assert.equal(low.get('.setup .starter')?.['margin-bottom'], '0');
  assert.equal(low.get('.lobby__top')?.display, 'grid');
  assert.equal(low.get('.lobby__top')?.['grid-template-columns'], 'minmax(0, 1fr) minmax(0, 1fr)');
  assert.equal(low.get('.lobby__top .buttons')?.['grid-template-columns'], '1fr', '초대 버튼은 제 칸을 다 쓴다');
  // 나란히 둔 줄의 높이가 닉네임 칸과 같다: 설명은 타일 위(닉네임 이름표와 같은 줄), "시작 무기" 이름표는 타일 왼쪽, 타일 높이 = 입력칸
  const desc = low.get('.setup .starter__desc')!;
  assert.equal(desc.order, '-1', '설명은 타일 위');
  // 설명은 늘 한 줄: 무기에 따라 두 줄로 꺾여 아래 버튼이 오르내리지 않게
  assert.deepEqual([desc['white-space'], desc.overflow, desc['text-overflow']], ['nowrap', 'hidden', 'ellipsis']);
  assert.equal(low.get('.setup .starter__tile')?.['min-height'], 'calc(40px + var(--px) * 2)', '입력칸(글자 24 + 여백 16 + 테두리)과 같은 높이');
  assert.ok(px(rules().get(':root')?.['--px'], '--px') >= 2, '타일이 44px 이상');
  const shared = rules('@media (orientation: portrait) and (max-height: 600px), (orientation: landscape) and (max-height: 720px)');
  assert.equal(shared.get('.panel--title .starter')?.display, 'grid');
  assert.equal(shared.get('.panel--title .starter__label')?.display, 'block');
  assert.equal(shared.get('.panel--title .starter__legend')?.position, 'absolute', 'legend 는 화면 낭독기만 읽는다');
  // 폭 560 아래(480×320 등)는 시작 무기 쪽을 더 넓혀 가장 긴 설명도 한 줄에 다 보이게
  assert.equal(rules('@media (orientation: landscape) and (max-width: 559px)').get('.setup')?.['grid-template-columns'], 'minmax(0, 1fr) minmax(0, 2fr)');
  // 폭 768 아래의 높이 481~720 창은 패널을 가로 폰처럼 넓힌다 (420 이면 설명이 들어가지 않는다)
  const narrow = rules('@media (orientation: landscape) and (max-height: 720px) and (max-width: 767px)');
  assert.equal(narrow.get('.panel--title')?.['max-width'], '620px');
  assert.equal(narrow.get('.panel--lobby')?.['max-width'], '620px');
});

test('화면: 짧은 세로 화면(높이 540 이하)에서 빈 상태줄이 접혀도 구석 버튼(버전·소리)의 누르는 높이가 안내 줄에 닿지 않는다', () => {
  const top = rules();
  const short = rules(SHORT_PORTRAIT);
  const corner = px(top.get('.version')?.['min-height'], '.version min-height');
  assert.equal(short.get('.panel--title .status')?.['min-height'], '0', '빈 상태줄은 높이를 차지하지 않는다');
  const below = px(top.get('.status')?.margin?.split(' ')[0], '.status margin-top') + px(short.get('.panel--title')?.['padding-bottom'], '.panel--title padding-bottom');
  assert.ok(below >= corner, `안내 줄 아래 ${below}px < 구석 버튼 ${corner}px`);
  // 큰 버튼은 줄여도 손가락 크기(44px) 이상
  const portrait = rules('@media (orientation: portrait) and (max-height: 600px)');
  for (const sel of ['.panel--title .btn', '.panel--title .join input', '.panel--lobby .btn']) assert.ok(px(portrait.get(sel)?.['min-height'], sel) >= 44, sel);
});
