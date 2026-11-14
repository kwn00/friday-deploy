import { createReadStream, existsSync, statSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { PROTOCOL_VERSION, parseClientMsg, type ServerMsg } from '@friday-deploy/shared';
import { RoomManager, type Conn, type Room } from './room';
import { IpLimiter, SECURITY_HEADERS, TokenBucket, clientIp, issueSession, originAllowed, pathnameOf, verifySession } from './security';

const PORT = Number(process.env.PORT ?? 8787);
const CLIENT_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');

const MAX_CONNS_TOTAL = 800;
const MAX_CONNS_PER_IP = 6;
const HELLO_TIMEOUT_MS = 5000;
const MAX_VIOLATIONS = 5;

const rooms = new RoomManager();
const sessionLimiter = new IpLimiter(10, 0.5);
/** 정적 파일 요청. 정상 방문은 한 번에 4~5개. 같은 주소에서 반복 요청으로 전송량 한도를 태우는 것을 늦춘다. */
const staticLimiter = new IpLimiter(120, 4);
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

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const pathname = pathnameOf(req.url);
  if (pathname === null) return json(res, 400, { error: 'bad_request' });
  if (pathname === '/healthz') return json(res, 200, { ok: true, rooms: rooms.count });
  if (pathname === '/api/session') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
    if (!originAllowed(req)) return json(res, 403, { error: 'forbidden_origin' });
    // 허용된 Origin 에만 CORS 응답 (클라이언트가 Vercel 등 다른 도메인에 있을 때). 쿠키는 쓰지 않으므로 credentials 불필요.
    const cors: Record<string, string> = req.headers.origin ? { 'Access-Control-Allow-Origin': req.headers.origin, Vary: 'Origin' } : {};
    if (!sessionLimiter.take(clientIp(req))) return json(res, 429, { error: 'rate_limited' }, cors);
    req.resume(); // 본문은 읽지 않는다
    return json(res, 200, { token: issueSession().token, v: PROTOCOL_VERSION }, cors);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' });
  if (!staticLimiter.take(clientIp(req))) return json(res, 429, { error: 'rate_limited' }, { 'Retry-After': '10' });
  serveStatic(req, res, pathname);
}

// 요청 하나의 처리 중에 난 예외가 프로세스를 죽이지 않게 한다 (프로세스가 죽으면 모든 방이 함께 사라진다)
const server = http.createServer((req, res) => {
  try {
    handleRequest(req, res);
  } catch (err) {
    console.error('[error] request handler', err);
    if (res.headersSent) res.destroy();
    else json(res, 500, { error: 'internal' });
  }
});
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
// 프록시(Render 등)는 앱과의 연결을 열어 두고 재사용한다. Node 기본값(5초)이면 프록시가 이미 닫힌 연결로
// 요청을 보내 가끔 502 가 난다. 프록시의 유휴 시간보다 길게 잡는다.
server.keepAliveTimeout = 120_000;

/* ───────────── WebSocket ───────────── */

// maxPayload: 정상 클라이언트 메시지는 100바이트 미만. 큰 프레임은 프로토콜 레벨에서 끊는다.
// ws 는 압축된 프레임도 "압축을 푼 크기"로 maxPayload 를 검사하므로 압축 폭탄은 1009 로 끊긴다.
//
// permessage-deflate 는 기본으로 끈다. 켜면 모든 프레임이 양방향으로 zlib 을 거치는데, CPU 가 약한 서버
// (Render 무료: 0.1 CPU)에서는 평범한 접속 36개만으로 처리가 밀려 하트비트가 전원을 끊는 것이 실측으로 확인됐다
// (끄면 72개에서도 지연만 늘어난다). 전송량은 압축 대신 스냅샷 이진 인코딩(shared/codec.ts)으로 줄인다.
// CPU 여유가 있는 서버에서만 WS_COMPRESS=1 로 켠다. clientMaxWindowBits 는 숫자로 지정하지 않는다:
// ws 는 그 파라미터를 제안하지 않는 브라우저(Firefox 등)의 핸드셰이크를 400 으로 거부한다.
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 512,
  perMessageDeflate: process.env.WS_COMPRESS === '1' ? { serverMaxWindowBits: 13, zlibDeflateOptions: { level: 1, memLevel: 8 } } : false,
});

function reject(socket: import('node:stream').Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  try {
    if (pathnameOf(req.url) !== '/ws') return reject(socket, '404 Not Found');
    if (!originAllowed(req)) return reject(socket, '403 Forbidden');
    const ip = clientIp(req);
    if (wss.clients.size >= MAX_CONNS_TOTAL || (connsPerIp.get(ip) ?? 0) >= MAX_CONNS_PER_IP) {
      return reject(socket, '429 Too Many Requests');
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip));
  } catch (err) {
    console.error('[error] upgrade handler', err);
    socket.destroy();
  }
});

function onConnection(ws: WebSocket, ip: string): void {
  connsPerIp.set(ip, (connsPerIp.get(ip) ?? 0) + 1);
  const bucket = new TokenBucket(60, 40); // 정상 클라이언트는 초당 ~20개
  let room: Room | null = null;
  let conn: Conn | null = null;
  let violations = 0;
  let alive = true;

  const send = (msg: ServerMsg): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  /**
   * 연결을 끊는다. close 프레임만 보내면 상대가 응답할 때까지(최대 30초) 소켓이 살아 있어서,
   * 응답하지 않는 클라이언트는 쫓겨난 뒤에도 자리를 차지한다. 그래서 잠시 뒤 강제로 닫는다.
   */
  const drop = (code: number, reason: string): void => {
    if (ws.readyState !== ws.OPEN) return;
    ws.close(code, reason);
    setTimeout(() => ws.terminate(), 1000).unref();
  };
  const violation = (code: string): void => {
    if (++violations >= MAX_VIOLATIONS) drop(1008, code);
  };

  const helloTimer = setTimeout(() => drop(4001, 'hello_timeout'), HELLO_TIMEOUT_MS);
  const heartbeat = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 15_000);
  ws.on('pong', () => (alive = true));

  const onMessage = (data: RawData, isBinary: boolean): void => {
    // 서버가 이미 끊기로 한 연결에서 뒤늦게 온 메시지는 처리하지 않는다
    if (ws.readyState !== ws.OPEN) return;
    if (isBinary) return drop(1003, 'binary_not_supported');
    if (!bucket.take()) return drop(1008, 'rate_limited');
    const msg = parseClientMsg(data.toString());
    if (!msg) return violation('bad_message');

    if (!conn || !room) {
      // 인증 전에는 hello 만 허용
      if (msg.t !== 'hello') return violation('hello_required');
      if (msg.v !== PROTOCOL_VERSION) {
        send({ t: 'error', code: 'version_mismatch' });
        return drop(4002, 'version_mismatch');
      }
      const sid = verifySession(msg.token);
      if (!sid || usedSessions.has(sid)) {
        send({ t: 'error', code: 'bad_session' });
        return drop(4003, 'bad_session');
      }
      // 토큰은 방을 찾기 전에 소모한다. 방 코드를 틀려도 토큰 하나를 쓰게 되므로,
      // 코드를 마구 대입해 남의 방을 찾으려는 시도는 세션 발급 레이트리밋(IP 당 초당 0.5개)에 묶인다.
      usedSessions.set(sid, Date.now());
      let found: Room | null;
      if (msg.mode === 'coop' && msg.room !== undefined) {
        const target = rooms.find(msg.room);
        if (!target || !target.joinable) {
          const code = target ? 'room_full' : 'room_not_found';
          send({ t: 'error', code });
          return drop(4005, code);
        }
        found = target;
      } else {
        found = rooms.create(msg.mode);
      }
      if (!found) {
        send({ t: 'error', code: 'server_full' });
        return drop(4004, 'server_full');
      }
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
      case 'start':
        room.onStart(conn);
        break;
      case 'pause':
        room.onPause(conn, msg.on);
        break;
      case 'ping':
        send({ t: 'pong', ts: msg.ts });
        break;
      case 'hello':
        violation('duplicate_hello');
        break;
    }
  };

  ws.on('message', (data, isBinary) => {
    try {
      onMessage(data, isBinary);
    } catch (err) {
      // 메시지 하나의 처리 중에 난 예외로 서버 전체가 죽지 않게, 그 연결만 끊는다
      console.error('[error] message handler', err);
      drop(1011, 'internal');
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
