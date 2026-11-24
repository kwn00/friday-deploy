import { existsSync, statSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { APP_VERSION, PROTOCOL_VERSION, parseClientMsg, type ServerMsg } from '@friday-deploy/shared';
import { RoomManager, type Conn, type Room } from './room';
import { LEADERBOARD_SEASON, type LeaderboardResponse, type UpgradeStatsResponse } from '@friday-deploy/shared';
import { Leaderboard, MemoryStore, type LeaderboardStore } from './leaderboard';
import { UpgradeStats, type StatsKind } from './stats';
import { IpLimiter, SECURITY_HEADERS, TokenBucket, clientIp, issueSession, originAllowed, pathnameOf, queryOf, verifySession } from './security';
import { sendFile } from './static';

const PORT = Number(process.env.PORT ?? 8787);
const CLIENT_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');

const MAX_CONNS_TOTAL = 800;
const MAX_CONNS_PER_IP = 6;
/**
 * 한 주소가 연결 없이 지켜 둘 수 있는 자리 수. 끊긴 자리는 연결 수 제한에 잡히지 않으므로 따로 센다
 * (세지 않으면 방을 만들고 끊기를 되풀이해, 연결 6개 제한을 넘는 수의 방을 붙잡아 둘 수 있다).
 * 넘치면 그 주소가 지켜 둔 자리 중 가장 오래된 것부터 비운다.
 */
const MAX_HELD_PER_IP = 6;
const HELLO_TIMEOUT_MS = 5000;
const MAX_VIOLATIONS = 5;

/**
 * 리더보드 저장소. DATABASE_URL 이 있으면 PostgreSQL 에 저장하고, 없으면 메모리에만 둔다
 * (메모리 기록은 서버가 다시 시작되면 사라진다). 저장소 문제로 게임 서버가 뜨지 못하는 일은 없게 한다.
 */
async function openStore(): Promise<LeaderboardStore> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return new MemoryStore();
  try {
    const { createPostgresStore } = await import('./store-postgres');
    return await createPostgresStore(url, { currentSeason: LEADERBOARD_SEASON });
  } catch (err) {
    console.error('[leaderboard] DATABASE_URL 로 저장소를 열지 못했습니다. 이번 실행에서는 메모리에만 기록합니다.', err);
    return new MemoryStore();
  }
}

const store = await openStore();
const leaderboard = new Leaderboard(store, LEADERBOARD_SEASON);
void leaderboard.init();
// 아이템 통계: 리더보드와 같은 저장소의 다른 표에 쌓는다 (stats.ts)
const stats = new UpgradeStats(store, LEADERBOARD_SEASON);
void stats.init();

const rooms = new RoomManager((report) => {
  const rank = leaderboard.record(report);
  stats.record(report);
  return rank;
});
const sessionLimiter = new IpLimiter(10, 0.5);
/** 정적 파일 요청. 정상 방문은 한 번에 4~5개. 같은 주소에서 반복 요청으로 전송량 한도를 태우는 것을 늦춘다. */
const staticLimiter = new IpLimiter(120, 4);
const connsPerIp = new Map<string, number>();
const bump = (map: Map<string, number>, ip: string, by: 1 | -1): void => {
  const n = (map.get(ip) ?? 0) + by;
  if (n <= 0) map.delete(ip);
  else map.set(ip, n);
};
/** 주소별로, 연결 없이 지켜 두고 있는 자리들 (먼저 끊긴 것부터). 값은 그 자리를 비우는 함수다 */
const heldByIp = new Map<string, Set<() => void>>();
const heldCount = (ip: string): number => heldByIp.get(ip)?.size ?? 0;
/** 이 주소가 지켜 둔 자리 중 가장 오래된 것을 비운다. 비울 것이 없으면 false */
function evictOldestHeld(ip: string): boolean {
  const evict = heldByIp.get(ip)?.values().next().value;
  if (!evict) return false;
  evict(); // 자리가 비워지면서 목록에서도 빠진다 (아래 close 처리의 onFree)
  return true;
}
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

/**
 * 쿼리의 시즌. 없으면 지금 시즌, 숫자가 아니면 undefined (잘못된 요청).
 * 있는 시즌인지는 따로 확인한다 (없는 시즌으로 저장소를 두드리지 않게)
 */
function seasonOf(target: string | undefined): number | undefined {
  const raw = queryOf(target, 'season');
  if (raw === null) return LEADERBOARD_SEASON;
  return /^\d{1,6}$/.test(raw) ? Number(raw) : undefined;
}

/** 읽기 전용 공개 API 의 응답 머리 (다른 사이트에서도 읽을 수 있다. 오류 응답에도 붙여야 다른 사이트가 상태를 볼 수 있다) */
const PUBLIC_API = { 'Access-Control-Allow-Origin': '*' };
const isPublicApi = (pathname: string): boolean => pathname === '/api/leaderboard' || pathname === '/api/stats/upgrades';
const unavailable = (res: ServerResponse): void => json(res, 503, { error: 'unavailable' }, { ...PUBLIC_API, 'Retry-After': '30' });

/** 비동기로 답하는 공개 API: 저장소 오류 등으로 실패하면 503 (프로세스는 죽지 않는다) */
function answer(res: ServerResponse, work: () => Promise<void>): void {
  Promise.resolve()
    .then(work)
    .catch((err) => {
      console.error('[error] api', err instanceof Error ? err.message : err);
      if (!res.headersSent) unavailable(res);
      else res.destroy();
    });
}

/**
 * 지난 시즌을 물을 때: 있는 시즌이면 확인된 시즌 목록을 돌려준다. 없는 시즌이면 404, 시즌 목록을 읽지 못하면 503 을
 * 여기서 보내고 null 을 돌려준다 (호출한 쪽은 null 이면 더 답하지 않는다).
 * 지금 시즌은 이것을 거치지 않는다 (DB 를 기다리지 않고 바로 답한다).
 */
async function pastSeasonsOrReply(res: ServerResponse, season: number): Promise<number[] | null> {
  const seasons = await leaderboard.seasons();
  if (!seasons) {
    unavailable(res);
    return null;
  }
  if (!seasons.includes(season)) {
    json(res, 404, { error: 'unknown_season', seasons }, PUBLIC_API);
    return null;
  }
  return seasons;
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
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    return void res.end();
  }
  // 받는 도중에 끊겨도 읽던 파일을 닫고, 파일을 열지 못해도(열린 파일이 너무 많음 등) 프로세스가 죽지 않게 한다 (static.ts)
  sendFile(res, file, headers, (status) => json(res, status, { error: status === 404 ? 'not_found' : 'internal' }));
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const pathname = pathnameOf(req.url);
  if (pathname === null) return json(res, 400, { error: 'bad_request' });
  // version: 지금 떠 있는 서버가 어느 버전인지 (배포가 끝났는지 확인하는 용도)
  if (pathname === '/healthz') return json(res, 200, { ok: true, rooms: rooms.count, version: APP_VERSION });
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
  if (!staticLimiter.take(clientIp(req))) return json(res, 429, { error: 'rate_limited' }, { 'Retry-After': '10', ...(isPublicApi(pathname) ? PUBLIC_API : {}) });
  if (pathname === '/api/leaderboard') {
    // 읽기 전용 공개 정보. 지금 시즌은 메모리의 순위표를 그대로 돌려준다: DB 를 기다리지 않는다 (느리거나 죽어 있어도 바로 답한다).
    // 지난 시즌(season=N)은 저장소에서 한 번 읽어 잠시 들고 있는다.
    const board = queryOf(req.url, 'board') === 'coop' ? 'coop' : 'solo';
    const season = seasonOf(req.url);
    if (season === undefined) return json(res, 400, { error: 'bad_season' }, PUBLIC_API);
    const body = (seasons: number[], entries: LeaderboardResponse['entries']): LeaderboardResponse => ({
      board,
      season,
      current: leaderboard.season,
      seasons,
      persistent: leaderboard.persistent,
      loading: season === leaderboard.season && !leaderboard.ready,
      entries,
    });
    if (season === leaderboard.season) return json(res, 200, body(leaderboard.knownSeasons(), leaderboard.top(board)), PUBLIC_API);
    return answer(res, async () => {
      const seasons = await pastSeasonsOrReply(res, season);
      if (seasons) json(res, 200, body(seasons, await leaderboard.view(board, season)), PUBLIC_API);
    });
  }
  if (pathname === '/api/stats/upgrades') {
    // 아이템 통계 (누구나 볼 수 있다. 합계뿐이라 개인 정보가 없다). 지금 시즌은 메모리의 합계라 DB 를 읽지 않는다.
    const season = seasonOf(req.url);
    if (season === undefined) return json(res, 400, { error: 'bad_season' }, PUBLIC_API);
    const rawKind = queryOf(req.url, 'kind');
    if (rawKind !== null && rawKind !== 'weapon' && rawKind !== 'passive') return json(res, 400, { error: 'bad_kind' }, PUBLIC_API);
    const kind: StatsKind = rawKind;
    // 게임 버전 (x.y.z). 없으면 시즌 전체
    const version = queryOf(req.url, 'version');
    if (version !== null && !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version)) return json(res, 400, { error: 'bad_version' }, PUBLIC_API);
    return answer(res, async () => {
      // 지금 시즌은 DB 를 기다리지 않는다 (아는 시즌 목록으로 답한다)
      const seasons = season === leaderboard.season ? leaderboard.knownSeasons() : await pastSeasonsOrReply(res, season);
      if (!seasons) return;
      const out = await stats.response(season, version, kind, seasons, leaderboard);
      if ('notReady' in out) return unavailable(res);
      if ('unknownVersion' in out) return json(res, 404, { error: 'unknown_version', versions: out.unknownVersion }, PUBLIC_API);
      const body: UpgradeStatsResponse = out;
      // 1분 동안은 브라우저가 다시 묻지 않아도 된다 (통계는 천천히 바뀐다). 아직 다 불러오지 못한 응답은 담아 두지 않게 한다
      json(res, 200, body, { ...PUBLIC_API, 'Cache-Control': body.loading ? 'no-store' : 'public, max-age=60' });
    });
  }
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
  bump(connsPerIp, ip, 1);
  const bucket = new TokenBucket(60, 40); // 정상 클라이언트는 초당 ~20개
  let room: Room | null = null;
  let conn: Conn | null = null;
  let violations = 0;
  let alive = true;
  /** 스스로 나갔거나 서버가 끊기로 한 연결: 닫힐 때 자리를 지켜 두지 않는다 */
  let leaving = false;

  const send = (msg: ServerMsg): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  /**
   * 연결을 끊는다. close 프레임만 보내면 상대가 응답할 때까지(최대 30초) 소켓이 살아 있어서,
   * 응답하지 않는 클라이언트는 쫓겨난 뒤에도 자리를 차지한다. 그래서 잠시 뒤 강제로 닫는다.
   */
  const drop = (code: number, reason: string): void => {
    // 서버가 끊는 연결(규칙 위반, 오류 등)은 자리를 지켜 주지 않는다. 지켜 주는 것은 통신이 끊긴 경우뿐이다.
    // 닫히기를 기다리지 않고 지금 비운다: 닫히는 사이에 같은 열쇠로 이어받아 쫓겨난 자리를 되찾을 수 없다
    leaving = true;
    if (room && conn && conn.ws === ws) room.leave(conn);
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
      // 인증 전에는 hello (새로 들어오기) 또는 resume (끊긴 자리 이어받기) 만 허용
      if (msg.t !== 'hello' && msg.t !== 'resume') return violation('hello_required');
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
      if (msg.t === 'resume') {
        // 틀린 열쇠도 세션 토큰 하나를 쓴다: 대입은 세션 발급 제한(IP 당 초당 0.5개)에 묶인다
        const seat = rooms.resume(msg.key, ws);
        if (!seat) {
          // 혼자 하던 판이 그 사이에 끝났다면 결과만 전해 주고 끝낸다 (판이 끝났을 때와 같은 닫힘)
          const over = rooms.resultFor(msg.key);
          if (over) {
            send(over);
            return drop(1000, 'over');
          }
          send({ t: 'error', code: 'resume_failed' });
          return drop(4006, 'resume_failed');
        }
        clearTimeout(helloTimer);
        room = seat.room;
        conn = seat.conn;
        return;
      }
      // 한 주소가 가질 수 있는 자리는 연결과 지켜 둔 자리를 합쳐서 센다 (연결을 끊어 두는 것으로 한도보다 많은 방을
      // 붙잡아 둘 수 없다). 넘치면 새로 들어오는 쪽을 막지 않고, 그 주소가 지켜 둔 자리 중 가장 오래된 것부터 비운다
      while ((connsPerIp.get(ip) ?? 0) + heldCount(ip) > MAX_CONNS_PER_IP && evictOldestHeld(ip));
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
      case 'leave':
        // 스스로 나간다: 자리를 바로 비운다
        drop(1000, 'left');
        break;
      case 'input':
        if (!room.onInput(conn, msg.seq, msg.dx, msg.dy)) violation('bad_seq');
        break;
      case 'pick':
        if (!room.onPick(conn, msg.choice)) violation('bad_pick');
        break;
      case 'reroll':
        room.onReroll(conn);
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
      case 'resume':
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
    bump(connsPerIp, ip, -1);
    if (!room || !conn) return;
    // 통신이 끊긴 것이면 자리를 잠시 지켜 둔다 (돌아오면 이어서 한다)
    const r = room;
    const c = conn;
    const evict = (): void => r.leave(c);
    const freed = (): void => {
      const set = heldByIp.get(ip);
      if (set?.delete(evict) && set.size === 0) heldByIp.delete(ip);
    };
    // 자리를 지키지 않는 닫힘(스스로 나감, 서버가 끊음, 다른 연결이 이어받음, 끝난 방)은 여기서 끝난다
    if (!room.disconnect(conn, ws, !leaving, freed)) return;
    // 이 주소가 지켜 둔 자리가 이미 많으면 가장 오래된 것부터 비운다 (방금 끊긴 쪽이 돌아올 가능성이 더 높다)
    while (heldCount(ip) >= MAX_HELD_PER_IP && evictOldestHeld(ip));
    let set = heldByIp.get(ip);
    if (!set) heldByIp.set(ip, (set = new Set()));
    set.add(evict);
  });
  ws.on('error', () => ws.terminate());
}

// 배포·재시작 때 아직 저장하지 못한 기록을 마저 쓰고 끝낸다 (최대 3초)
// (이 신호가 서버까지 오려면 node 가 직접 떠 있어야 한다: render.yaml 의 startCommand 참고)
process.once('SIGTERM', () => {
  const at = Date.now();
  console.log('[server] SIGTERM: 남은 기록을 저장하고 끝냅니다');
  setTimeout(() => process.exit(0), 3000).unref();
  // 리더보드 기록과 통계를 함께 마저 쓰고(기록이 통계를 기다리지 않게), 그다음에 같은 저장소를 한 번 닫는다
  void Promise.allSettled([leaderboard.flushAll(2400), stats.close(2400)])
    .then(() => leaderboard.close(0))
    .finally(() => {
      console.log(`[server] 종료 (${Date.now() - at}ms)`);
      process.exit(0);
    });
});

server.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}  (ws: /ws, env: ${process.env.NODE_ENV ?? 'development'})`);
});
