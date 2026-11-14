import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { parseClientIpOptions, pathnameOf, resolveClientIp } from './security';

function req(headers: Record<string, string | string[]>, remoteAddress = '10.0.0.9'): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

test('엣지가 넣는 단일 값 헤더를 쓰고, 클라이언트가 넣은 X-Forwarded-For 는 무시한다', () => {
  const opts = parseClientIpOptions({ CLIENT_IP_HEADER: 'cf-connecting-ip' });
  const r = resolveClientIp(req({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '1.1.1.1, 203.0.113.7, 172.16.0.1' }), opts);
  assert.deepEqual(r, { ip: '203.0.113.7', source: 'header' });
});

test('헤더 값이 IP 가 아니거나 여러 개면 위조 가능한 값 대신 소켓 주소로 떨어진다', () => {
  const opts = parseClientIpOptions({ CLIENT_IP_HEADER: 'cf-connecting-ip' });
  for (const bad of ['not-an-ip', '1.2.3.4, 5.6.7.8', '', '999.1.1.1']) {
    assert.deepEqual(resolveClientIp(req({ 'cf-connecting-ip': bad }), opts), { ip: '10.0.0.9', source: 'socket' });
  }
  assert.equal(resolveClientIp(req({}), opts).source, 'socket');
});

test('헤더를 여러 개 지정하면 앞에서부터 처음 유효한 값을 쓴다', () => {
  const opts = parseClientIpOptions({ CLIENT_IP_HEADER: 'cf-connecting-ip, true-client-ip' });
  assert.equal(resolveClientIp(req({ 'true-client-ip': '198.51.100.2' }), opts).ip, '198.51.100.2');
  assert.equal(resolveClientIp(req({ 'cf-connecting-ip': '198.51.100.1', 'true-client-ip': '198.51.100.2' }), opts).ip, '198.51.100.1');
});

test('TRUST_PROXY=n 은 X-Forwarded-For 를 오른쪽에서 n 번째 값으로 읽는다 (맨 앞 위조값 무시)', () => {
  const xff = { 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 172.16.0.1' };
  assert.equal(resolveClientIp(req(xff), parseClientIpOptions({ TRUST_PROXY: '1' })).ip, '172.16.0.1');
  assert.equal(resolveClientIp(req(xff), parseClientIpOptions({ TRUST_PROXY: '2' })).ip, '203.0.113.7');
  // 체인이 홉 수보다 짧으면 위조됐을 수 있는 값 대신 소켓 주소
  assert.deepEqual(resolveClientIp(req({ 'x-forwarded-for': '6.6.6.6' }), parseClientIpOptions({ TRUST_PROXY: '2' })), {
    ip: '10.0.0.9',
    source: 'socket',
  });
});

test('설정이 없으면 헤더를 전혀 믿지 않는다', () => {
  const opts = parseClientIpOptions({});
  const r = resolveClientIp(req({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '1.2.3.4' }), opts);
  assert.deepEqual(r, { ip: '10.0.0.9', source: 'socket' });
});

test('잘못된 설정값은 무시하고, IPv4-mapped IPv6 는 IPv4 로 합친다', () => {
  const opts = parseClientIpOptions({ CLIENT_IP_HEADER: 'bad header!, ,x_y', TRUST_PROXY: 'yes' });
  assert.deepEqual(opts, { headers: [], trustedHops: 0 });
  assert.equal(resolveClientIp(req({}, '::ffff:203.0.113.7'), opts).ip, '203.0.113.7');
  assert.equal(resolveClientIp(req({}, '::FFFF:203.0.113.7'), opts).ip, '203.0.113.7');
});

test('IPv6 는 /64 단위로 묶는다 (한 가입자가 주소를 바꿔 가며 제한을 피하지 못하게)', () => {
  const opts = parseClientIpOptions({ CLIENT_IP_HEADER: 'cf-connecting-ip' });
  const key = (ip: string): string => resolveClientIp(req({ 'cf-connecting-ip': ip }), opts).ip;
  assert.equal(key('2001:DB8::1'), '2001:db8:0:0::/64');
  // 같은 /64 안의 서로 다른 주소 → 같은 키
  assert.equal(key('2001:db8:0:0:1111:2222:3333:4444'), key('2001:db8::ffff'));
  assert.equal(key('2001:db8:aa:bb:1::1'), key('2001:db8:aa:bb:ffff:ffff:ffff:ffff'));
  // 다른 /64 → 다른 키
  assert.notEqual(key('2001:db8:aa:bb::1'), key('2001:db8:aa:bc::1'));
  assert.equal(key('::1'), '0:0:0:0::/64');
  assert.equal(key('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(key('2001:db8:1:2:3:4:1.2.3.4'), '2001:db8:1:2::/64');
  assert.equal(key('64:ff9b::1.2.3.4'), '64:ff9b:0:0::/64');
  // IPv4 는 그대로
  assert.equal(key('203.0.113.7'), '203.0.113.7');
  assert.equal(key('::ffff:203.0.113.7'), '203.0.113.7');
});

test('pathnameOf: 형식이 틀린 요청 대상은 예외 없이 null (예외가 새면 서버 프로세스가 죽는다)', () => {
  assert.equal(pathnameOf('/'), '/');
  assert.equal(pathnameOf('/ws?x=1'), '/ws');
  assert.equal(pathnameOf('/assets/a.js#frag'), '/assets/a.js');
  assert.equal(pathnameOf(undefined), '/');
  assert.equal(pathnameOf('/a//b'), '/a//b');
  // 실제로 서버를 죽였던 입력들
  for (const bad of ['//', '/\\\\', '//?a=1', 'http://a:b/', '//x:99999/', '//[', 'http://[::1/', '\\\\']) {
    assert.doesNotThrow(() => pathnameOf(bad), bad);
    assert.equal(pathnameOf(bad), null, bad);
  }
  // 그 밖의 이상한 입력도 던지지 않는다
  for (const odd of ['', '*', '%', '/%zz', '/\u0000', 'x'.repeat(10000), '/..//..', '?', '#', 'javascript:alert(1)']) {
    assert.doesNotThrow(() => pathnameOf(odd), odd);
  }
});
