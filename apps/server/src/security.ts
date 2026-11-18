import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

const isProd = process.env.NODE_ENV === 'production';

function loadSecret(): Buffer {
  const env = process.env.SESSION_SECRET;
  if (env && env.length >= 32) return Buffer.from(env);
  if (isProd) {
    console.error('[fatal] SESSION_SECRET (32자 이상) 이 설정되지 않았습니다. 프로덕션에서는 기동을 거부합니다.');
    process.exit(1);
  }
  return randomBytes(32); // 개발 환경: 프로세스마다 임시 시크릿
}

const SECRET = loadSecret();
const SESSION_TTL_MS = 10 * 60 * 1000;

export function sign(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('base64url');
}

/** 길이가 다르면 바로 false, 같으면 걸리는 시간이 내용에 따라 달라지지 않게 비교한다 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** 단기 세션 토큰: `sid.exp.sig`. 서버만 발급/검증 가능. */
export function issueSession(): { token: string; sid: string } {
  const sid = randomUUID();
  const body = `${sid}.${Date.now() + SESSION_TTL_MS}`;
  return { token: `${body}.${sign(body)}`, sid };
}

export function verifySession(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [sid, exp, sig] = parts as [string, string, string];
  if (!safeEqual(sign(`${sid}.${exp}`), sig)) return null;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now()) return null;
  return sid;
}

/** 토큰 버킷 레이트 리미터 */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** IP 별 레이트 리미터 (HTTP 엔드포인트용) */
export class IpLimiter {
  private buckets = new Map<string, { b: TokenBucket; seen: number }>();
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    setInterval(() => {
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [ip, v] of this.buckets) if (v.seen < cutoff) this.buckets.delete(ip);
    }, 60_000).unref();
  }
  take(ip: string): boolean {
    let v = this.buckets.get(ip);
    if (!v) {
      v = { b: new TokenBucket(this.capacity, this.refillPerSec), seen: 0 };
      this.buckets.set(ip, v);
    }
    v.seen = Date.now();
    return v.b.take();
  }
}

export interface ClientIpOptions {
  /** 엣지(CDN)가 클라이언트 IP 하나만 넣어주는 헤더들. 앞에서부터 처음으로 유효한 IP 를 쓴다. 예: cf-connecting-ip */
  headers: string[];
  /** X-Forwarded-For 를 붙이는 신뢰 프록시 홉 수. 0 이면 X-Forwarded-For 를 무시한다. */
  trustedHops: number;
}

export function parseClientIpOptions(env: NodeJS.ProcessEnv): ClientIpOptions {
  const headers = (env.CLIENT_IP_HEADER ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[a-z0-9-]+$/.test(h));
  const hops = Number.parseInt(env.TRUST_PROXY ?? '0', 10);
  return { headers, trustedHops: Number.isInteger(hops) && hops > 0 ? Math.min(hops, 10) : 0 };
}

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * 제한의 기준이 되는 키로 정리한다.
 * - IPv4-mapped IPv6(::ffff:1.2.3.4) → IPv4 (같은 클라이언트가 두 버킷으로 나뉘지 않게)
 * - IPv6 → 앞 64비트 (가입자 한 명이 보통 /64 전체를 받으므로, 주소를 바꿔 가며 제한을 피하지 못하게)
 */
function normalizeIp(raw: string | undefined): string | null {
  const ip = raw?.trim().split('%')[0]; // fe80::1%eth0 같은 zone id 제거
  if (!ip) return null;
  const kind = isIP(ip);
  if (kind === 0) return null;
  if (kind === 4) return ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  return ipv6Prefix64(ip);
}

function ipv6Prefix64(ip: string): string {
  // 끝에 IPv4 가 붙은 표기(::1.2.3.4)는 뒤 64비트에만 영향을 주므로 두 그룹으로 바꿔 자리만 맞춘다
  const addr = ip.replace(/(\d{1,3}\.){3}\d{1,3}$/, '0:0');
  const [head = '', tail] = addr.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => (Number.parseInt(g, 16) || 0).toString(16))
    .join(':')}::/64`;
}

/**
 * 레이트리밋·연결 수 제한에 쓰는 클라이언트 IP.
 *
 * X-Forwarded-For 의 맨 앞 값은 클라이언트가 마음대로 넣을 수 있다. Render 처럼 들어온 헤더 뒤에 덧붙이기만 하는
 * 프록시 뒤에서는 위조된다. 그래서 (1) 엣지가 덮어쓰는 단일 값 헤더를 먼저 보고, (2) 아니면 X-Forwarded-For 를
 * 오른쪽에서 신뢰 홉 수만큼 거슬러 올라간 값을 쓰며, (3) 둘 다 없으면 소켓 주소를 쓴다.
 * 헤더가 기대와 다를 때는 위조 가능한 값 대신 소켓 주소로 떨어진다(제한이 더 엄격해지는 쪽).
 */
export function resolveClientIp(req: IncomingMessage, opts: ClientIpOptions): { ip: string; source: 'header' | 'xff' | 'socket' } {
  for (const name of opts.headers) {
    const ip = normalizeIp(firstHeader(req, name));
    if (ip) return { ip, source: 'header' };
  }
  if (opts.trustedHops > 0) {
    const raw = req.headers['x-forwarded-for'];
    const chain = (Array.isArray(raw) ? raw.join(',') : raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const ip = normalizeIp(chain[chain.length - opts.trustedHops]);
    if (ip) return { ip, source: 'xff' };
  }
  return { ip: normalizeIp(req.socket.remoteAddress) ?? 'unknown', source: 'socket' };
}

const CLIENT_IP_OPTIONS = parseClientIpOptions(process.env);
let warnedFallback = false;

export function clientIp(req: IncomingMessage): string {
  const { ip, source } = resolveClientIp(req, CLIENT_IP_OPTIONS);
  const expected = CLIENT_IP_OPTIONS.headers.length > 0 ? 'header' : CLIENT_IP_OPTIONS.trustedHops > 0 ? 'xff' : 'socket';
  if (source !== expected && !warnedFallback) {
    warnedFallback = true;
    console.warn(
      `[warn] 설정한 클라이언트 IP 출처(${expected})를 찾지 못해 ${source} 값을 사용합니다. ` +
        'CLIENT_IP_HEADER / TRUST_PROXY 설정을 확인하세요. (이 경고는 한 번만 출력)',
    );
  }
  return ip;
}

const EXTRA_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Cross-Site WebSocket Hijacking 방지: same-origin 또는 명시적으로 허용된 Origin 만 통과 */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return !isProd; // 브라우저가 아닌 클라이언트(개발용 스크립트)는 개발 환경에서만
  if (EXTRA_ORIGINS.has(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * 요청 대상(request target)에서 경로만 안전하게 꺼낸다. 형식이 틀리면 null.
 * `new URL()` 은 `//`, `/\\`, 호스트가 잘못된 절대 형식 등에서 예외를 던진다. 요청 처리 중에 그 예외가 새면
 * 프로세스가 죽고 진행 중인 모든 방이 사라지므로, 반드시 여기서 걸러낸다.
 */
export function pathnameOf(target: string | undefined): string | null {
  try {
    return new URL(target ?? '/', 'http://localhost').pathname;
  } catch {
    return null;
  }
}

/** 요청 대상의 쿼리 값 하나를 안전하게 꺼낸다. 없거나 형식이 틀리면 null */
export function queryOf(target: string | undefined, key: string): string | null {
  try {
    return new URL(target ?? '/', 'http://localhost').searchParams.get(key);
  } catch {
    return null;
  }
}

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  // 프로덕션은 TLS 를 끝내는 프록시(Render 등) 뒤에서만 돈다는 전제. HTTP 응답에서는 브라우저가 무시한다.
  ...(isProd ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
};
