import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, type ReadStream } from 'node:fs';
import http, { type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, mock, test } from 'node:test';
import { sendFile } from './static';

// 보내는 도중에 끊기게 하려면 커널 소켓 버퍼(루프백에서는 수 MB)보다 커야 한다
const BIG = 32 * 1024 * 1024;
let dir = '';
let bigFile = '';
let smallFile = '';
let server: http.Server;
let port = 0;
/** 요청마다 sendFile 이 돌려준 읽기 스트림 (닫혔는지 본다) */
const streams: ReadStream[] = [];
/** 요청을 받을 때 sendFile 을 부르기 전에 할 일 (테스트마다 바꾼다) */
let beforeSend: (res: ServerResponse) => void = () => {};

/** 이 프로세스가 열어 둔 fd 수 (리눅스에서만 셀 수 있다) */
const openFds = (): number | null => {
  try {
    return readdirSync('/proc/self/fd').length;
  } catch {
    return null;
  }
};
const closed = (s: ReadStream, ms = 3000): Promise<void> =>
  s.closed
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`읽기 스트림이 ${ms}ms 안에 닫히지 않았다 (파일이 열린 채 남는다)`)), ms);
        s.once('close', () => (clearTimeout(t), resolve()));
      });
const nextStream = async (count: number): Promise<ReadStream> => {
  for (let i = 0; i < 200 && streams.length < count; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(streams.length >= count, 'sendFile 이 불리지 않았다');
  return streams[count - 1]!;
};
/** 응답의 첫 조각을 받자마자 끊는다 */
const getAndAbort = (file: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = http.get({ port, host: '127.0.0.1', path: `/${encodeURIComponent(file)}`, agent: false }, (res) => {
      res.once('data', () => {
        req.destroy();
        resolve(res.statusCode ?? 0);
      });
    });
    req.on('error', (err: NodeJS.ErrnoException) => (err.code === 'ECONNRESET' ? undefined : reject(err)));
  });
const getAll = (file: string): Promise<{ status: number; body: Buffer; type: string | undefined }> =>
  new Promise((resolve, reject) => {
    http
      .get({ port, host: '127.0.0.1', path: `/${encodeURIComponent(file)}`, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), type: res.headers['content-type'] }));
      })
      .on('error', reject);
  });
const settle = async (base: number | null): Promise<number | null> => {
  if (base === null) return null;
  // 클라이언트 쪽 소켓도 같은 프로세스에 있으므로, 서로 닫히는 데 잠깐 걸린다
  for (let i = 0; i < 100; i++) {
    const n = openFds()!;
    if (n <= base) return n;
    await new Promise((r) => setTimeout(r, 20));
  }
  return openFds();
};

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'friday-static-'));
  bigFile = path.join(dir, 'big.js');
  smallFile = path.join(dir, 'small.css');
  writeFileSync(bigFile, Buffer.alloc(BIG, 'a'));
  writeFileSync(smallFile, 'body{}');
  server = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(req.url!.slice(1)));
    beforeSend(res);
    streams.push(
      sendFile(res, file, { 'Content-Type': 'text/plain' }, (status) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: status }));
      }),
    );
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('정적 파일: 끝까지 받으면 내용 그대로, 머리는 파일을 연 뒤에 보낸다', { timeout: 10_000 }, async () => {
  const got = await getAll('small.css');
  assert.equal(got.status, 200);
  assert.equal(got.type, 'text/plain');
  assert.equal(got.body.toString(), 'body{}');
  await closed(streams.at(-1)!);
});

test('정적 파일: 받는 도중에 끊으면 읽던 파일을 닫는다 (fd 가 남지 않는다)', { timeout: 10_000 }, async () => {
  const base = openFds();
  const count = streams.length;
  assert.equal(await getAndAbort('big.js'), 200);
  const src = await nextStream(count + 1);
  await closed(src);
  assert.ok(src.bytesRead < BIG, `끝까지 읽기 전에 끊겼어야 한다 (${src.bytesRead}/${BIG})`);

  // 여러 번 끊겨도 열린 파일이 쌓이지 않는다
  for (let i = 0; i < 30; i++) await getAndAbort('big.js');
  await Promise.all(streams.slice(count).map((s) => closed(s)));
  const now = await settle(base);
  if (base !== null) assert.ok(now! <= base, `fd 수가 처음(${base})으로 돌아와야 한다: ${now}`);
});

test('정적 파일: 열지 못하면 머리를 보내기 전이므로 404/500 으로 답하고, 프로세스는 죽지 않는다', { timeout: 10_000 }, async () => {
  const errors = mock.method(console, 'error', () => {});
  try {
    const missing = await getAll('no-such-file.js');
    assert.deepEqual([missing.status, missing.type], [404, 'application/json']);
    // 이름이 너무 길다(ENAMETOOLONG): 없는 파일과 다른 오류 (열린 파일이 너무 많을 때의 EMFILE 도 이쪽이다)
    const bad = await getAll('x'.repeat(300));
    assert.deepEqual([bad.status, bad.type], [500, 'application/json']);
    // 서버는 계속 답한다
    assert.equal((await getAll('small.css')).status, 200);
  } finally {
    errors.mock.restore();
  }
});

test('정적 파일: 파일이 열리기 전에 상대가 끊어도 열린 파일이 남지 않는다', { timeout: 10_000 }, async () => {
  const base = openFds();
  const count = streams.length;
  beforeSend = (res) => res.destroy();
  try {
    await new Promise<void>((resolve) => {
      http.get({ port, host: '127.0.0.1', path: '/big.js', agent: false }).on('error', () => resolve()).on('close', () => resolve());
    });
    const src = await nextStream(count + 1);
    await closed(src);
    assert.equal(src.bytesRead, 0, '읽지 않고 닫는다');
  } finally {
    beforeSend = () => {};
  }
  const now = await settle(base);
  if (base !== null) assert.ok(now! <= base, `fd 수가 처음(${base})으로 돌아와야 한다: ${now}`);
});
