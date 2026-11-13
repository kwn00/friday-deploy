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
const wss = new WebSocketServer({ noServer: true, maxPayload: 512, perMessageDeflate: false });

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
