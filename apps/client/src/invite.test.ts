import assert from 'node:assert/strict';
import { test } from 'node:test';
import { takeInvite } from './invite';

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
