/**
 * style.css 의 몇 가지 자리 계산을 확인한다 (실제 화면 확인은 Playwright 로 한다. 이것은 숫자를 바꿀 때 놓치지 않게 하는 것).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const CSS = readFileSync(new URL('./style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** 맨 위(top-level) 또는 head 로 시작하는 @media 블록 안의 규칙들: 선택자 → 선언들 (같은 선택자가 여럿이면 뒤의 것이 덮는다) */
function rules(head?: string): Map<string, Record<string, string>> {
  let body = CSS;
  if (head) {
    const start = CSS.indexOf(`${head} {`);
    assert.ok(start >= 0, `style.css 에 ${head} 가 없다`);
    let depth = 0;
    let end = start;
    for (let i = CSS.indexOf('{', start); i < CSS.length; i++) {
      if (CSS[i] === '{') depth++;
      else if (CSS[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    body = CSS.slice(CSS.indexOf('{', start) + 1, end);
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
