import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendInvite, takeInvite, type InviteData } from './invite';

test('초대 링크: 주소에서 room 만 빼고, 다른 쿼리와 해시는 적힌 그대로 둔다', () => {
  assert.deepEqual(takeInvite('https://example.com/?room=ABCDEF'), { room: 'ABCDEF', rest: '/' });
  assert.deepEqual(takeInvite('https://example.com/play/?a=1&room=abc-def&b=%20x+y#top'), {
    room: 'abc-def',
    rest: '/play/?a=1&b=%20x+y#top',
  });
  assert.deepEqual(takeInvite('https://example.com/?room=ABCDEF#x'), { room: 'ABCDEF', rest: '/#x' });
  // 이름이 인코딩돼 있어도 room 이다 (URLSearchParams 와 같다)
  assert.deepEqual(takeInvite('https://example.com/?r%6Fom=AB%20CDEF'), { room: 'AB CDEF', rest: '/' });
  // 여러 번 있으면 첫 번째 값, 모두 뺀다
  assert.deepEqual(takeInvite('https://example.com/?room=AAAAAA&x=1&room=BBBBBB'), { room: 'AAAAAA', rest: '/?x=1' });
  // 값이 없거나 비어 있어도 room 은 뺀다 (코드 모양은 normalizeRoomCode 가 본다)
  assert.deepEqual(takeInvite('https://example.com/?room'), { room: '', rest: '/' });
  assert.deepEqual(takeInvite('https://example.com/?room=&a'), { room: '', rest: '/?a' });
  // 잘못된 % 가 있어도 죽지 않는다
  assert.deepEqual(takeInvite('https://example.com/?a=%E0%A4&room=%ZZ'), { room: '%ZZ', rest: '/?a=%E0%A4' });
});

test('초대 링크: room 이 없으면 null (주소를 바꾸지 않는다)', () => {
  assert.equal(takeInvite('https://example.com/'), null);
  assert.equal(takeInvite('https://example.com/?a=1&b=2'), null);
  assert.equal(takeInvite('https://example.com/?roomy=ABCDEF&xroom=1'), null);
  assert.equal(takeInvite('https://example.com/#room=ABCDEF'), null, '해시는 쿼리가 아니다');
  assert.equal(takeInvite('not a url'), null);
});

const DATA: InviteData = { title: 'T', text: 'x', url: 'https://example.com/?room=ABCDEF' };
/** 부른 것을 적어 두는 가짜 공유 창 / 클립보드 */
function fakes(share: 'ok' | string | null, copy: 'ok' | 'reject' | 'throw') {
  const calls: string[] = [];
  return {
    calls,
    share:
      share === null
        ? null
        : async (d: InviteData): Promise<void> => {
            calls.push(`share ${d.url}`);
            if (share !== 'ok') throw new DOMException('share failed', share);
          },
    copy: (text: string): Promise<void> => {
      calls.push(`copy ${text}`);
      // 클립보드가 없는 환경(navigator.clipboard 가 undefined)에서는 부르는 순간 TypeError 가 난다
      if (copy === 'throw') throw new TypeError("Cannot read properties of undefined (reading 'writeText')");
      return copy === 'ok' ? Promise.resolve() : Promise.reject(new DOMException('denied', 'NotAllowedError'));
    },
  };
}

test('초대 보내기: 공유 창을 닫기만 했으면(AbortError) 아무 말도 하지 않고 복사도 하지 않는다', async () => {
  const f = fakes('AbortError', 'ok');
  assert.equal(await sendInvite(DATA, f.share, f.copy), 'cancelled');
  assert.deepEqual(f.calls, [`share ${DATA.url}`]);
});

test('초대 보내기: 공유가 되면 shared, 복사는 하지 않는다', async () => {
  const f = fakes('ok', 'ok');
  assert.equal(await sendInvite(DATA, f.share, f.copy), 'shared');
  assert.deepEqual(f.calls, [`share ${DATA.url}`]);
});

test('초대 보내기: 다른 공유 오류면 클립보드 복사로 한 번 더, 그것도 안 될 때만 failed', async () => {
  for (const name of ['NotAllowedError', 'DataError', 'InvalidStateError']) {
    const ok = fakes(name, 'ok');
    assert.equal(await sendInvite(DATA, ok.share, ok.copy), 'copied', name);
    assert.deepEqual(ok.calls, [`share ${DATA.url}`, `copy ${DATA.url}`]);
    const bad = fakes(name, 'reject');
    assert.equal(await sendInvite(DATA, bad.share, bad.copy), 'failed', name);
  }
});

test('초대 보내기: 공유 창이 없으면(데스크톱) 바로 복사, 클립보드가 없으면 failed', async () => {
  const ok = fakes(null, 'ok');
  assert.equal(await sendInvite(DATA, ok.share, ok.copy), 'copied');
  assert.deepEqual(ok.calls, [`copy ${DATA.url}`]);
  const none = fakes(null, 'throw');
  assert.equal(await sendInvite(DATA, none.share, none.copy), 'failed');
});
