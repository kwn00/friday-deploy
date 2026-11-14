import { createReadStream, existsSync, statSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { PROTOCOL_VERSION, parseClientMsg, type ServerMsg } from '@friday-deploy/shared';
import { RoomManager, type Conn, type Room } from './room';
import { IpLimiter, SECURITY_HEADERS, TokenBucket, clientIp, issueSession, originAllowed, verifySession } from './security';

const PORT = Number(process.env.PORT ?? 8787);
const CLIENT_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');

const MAX_CONNS_TOTAL = 800;
const MAX_CONNS_PER_IP = 6;
const HELLO_TIMEOUT_MS = 5000;
const MAX_VIOLATIONS = 5;

const rooms = new RoomManager();
const sessionLimiter = new IpLimiter(10, 0.5);
const connsPerIp = new Map<string, number>();
/** 하나의 세션 토큰은 동시에 한 연결에서만, 그리고 한 번만 사용 가능 */
const usedSessions = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [sid, at] of usedSessions) if (at < cutoff) usedSessions.delete(sid);
}, 60_000).unref();

/* ───────────── HTTP ───────────── */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return json(res, 400, { error: 'bad_request' });
  }
  if (rel.includes('\0')) return json(res, 400, { error: 'bad_request' });
  let file = path.join(CLIENT_DIST, path.normalize(rel));
  // 경로 탈출(path traversal) 방지
  if (file !== CLIENT_DIST && !file.startsWith(CLIENT_DIST + path.sep)) return json(res, 403, { error: 'forbidden' });
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(CLIENT_DIST, 'index.html');
  if (!existsSync(file)) return json(res, 404, { error: 'client_not_built' });
  const ext = path.extname(file);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/healthz') return json(res, 200, { ok: true, rooms: rooms.count });
  if (url.pathname === '/api/session') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
    if (!originAllowed(req)) return json(res, 403, { error: 'forbidden_origin' });
    // 허용된 Origin 에만 CORS 응답 (클라이언트가 Vercel 등 다른 도메인에 있을 때). 쿠키는 쓰지 않으므로 credentials 불필요.
    const cors: Record<string, string> = req.headers.origin ? { 'Access-Control-Allow-Origin': req.headers.origin, Vary: 'Origin' } : {};
    if (!sessionLimiter.take(clientIp(req))) return json(res, 429, { error: 'rate_limited' }, cors);
    req.resume(); // 본문은 읽지 않는다
    return json(res, 200, { token: issueSession().token, v: PROTOCOL_VERSION }, cors);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' });
  serveStatic(req, res, url.pathname);
});
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;

/* ───────────── WebSocket ───────────── */

// maxPayload: 정상 클라이언트 메시지는 100바이트 미만. 큰 프레임은 프로토콜 레벨에서 끊는다.
// ws 는 압축된 프레임도 "압축을 푼 크기"로 maxPayload 를 검사하므로 압축 폭탄은 1009 로 끊긴다.
//
// permessage-deflate: 스냅샷 스트림을 약 30% 크기로 줄인다(10분 솔로 41.4MB → 12.5MB, 실측).
// 호스팅 전송량 한도가 비용을 결정하므로 켠다. 연결당 압축 메모리는 기본값(약 256KB) 대신
// 창 13비트로 약 160KB 에 묶는다 (압축률 차이는 1.5%p). 서버→클라이언트 방향에는 비밀값과 공격자가
// 반복해서 넣을 수 있는 값이 같은 컨텍스트에서 섞이지 않아 CRIME 류 압축 오라클은 성립하지 않는다.
// clientMaxWindowBits 는 숫자로 지정하지 않는다: ws 는 그 파라미터를 제안하지 않는 브라우저(Firefox 등)의
// 핸드셰이크를 400 으로 거부한다.
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 512,
  perMessageDeflate: {
    serverMaxWindowBits: 13,
    zlibDeflateOptions: { level: 1, memLevel: 8 },
    threshold: 256,
  },
});

function reject(socket: import('node:stream').Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/ws') return reject(socket, '404 Not Found');
  if (!originAllowed(req)) return reject(socket, '403 Forbidden');
  const ip = clientIp(req);
  if (wss.clients.size >= MAX_CONNS_TOTAL || (connsPerIp.get(ip) ?? 0) >= MAX_CONNS_PER_IP) {
    return reject(socket, '429 Too Many Requests');
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip));
});

function onConnection(ws: WebSocket, ip: string): void {
  connsPerIp.set(ip, (connsPerIp.get(ip) ?? 0) + 1);
  const bucket = new TokenBucket(60, 40); // 정상 클라이언트는 초당 ~20개
  let room: Room | null = null;
  let conn: Conn | null = null;
  let violations = 0;
  let alive = true;

  const send = (msg: ServerMsg): void => ws.send(JSON.stringify(msg));
  const violation = (code: string): void => {
    if (++violations >= MAX_VIOLATIONS) ws.close(1008, code);
  };

  const helloTimer = setTimeout(() => ws.close(4001, 'hello_timeout'), HELLO_TIMEOUT_MS);
  const heartbeat = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 15_000);
  ws.on('pong', () => (alive = true));

  ws.on('message', (data, isBinary) => {
    if (isBinary) return ws.close(1003, 'binary_not_supported');
    if (!bucket.take()) return ws.close(1008, 'rate_limited');
    const msg = parseClientMsg(data.toString());
    if (!msg) return violation('bad_message');

    if (!conn || !room) {
      // 인증 전에는 hello 만 허용
      if (msg.t !== 'hello') return violation('hello_required');
      if (msg.v !== PROTOCOL_VERSION) {
        send({ t: 'error', code: 'version_mismatch' });
        return ws.close(4002, 'version_mismatch');
      }
      const sid = verifySession(msg.token);
      if (!sid || usedSessions.has(sid)) {
        send({ t: 'error', code: 'bad_session' });
        return ws.close(4003, 'bad_session');
      }
      const found = rooms.find(msg.mode);
      if (!found) {
        send({ t: 'error', code: 'server_full' });
        return ws.close(4004, 'server_full');
      }
      usedSessions.set(sid, Date.now());
      clearTimeout(helloTimer);
      room = found;
      conn = room.join(ws, sid, msg.name);
      return;
    }

    switch (msg.t) {
      case 'input':
        if (!room.onInput(conn, msg.seq, msg.dx, msg.dy)) violation('bad_seq');
        break;
      case 'pick':
        if (!room.onPick(conn, msg.choice)) violation('bad_pick');
        break;
      case 'ping':
        send({ t: 'pong', ts: msg.ts });
        break;
      case 'hello':
        violation('duplicate_hello');
        break;
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    clearInterval(heartbeat);
    const n = (connsPerIp.get(ip) ?? 1) - 1;
    if (n <= 0) connsPerIp.delete(ip);
    else connsPerIp.set(ip, n);
    if (room && conn) room.leave(conn);
  });
  ws.on('error', () => ws.terminate());
}

server.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}  (ws: /ws, env: ${process.env.NODE_ENV ?? 'development'})`);
});
