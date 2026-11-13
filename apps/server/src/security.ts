import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

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

function safeEqual(a: string, b: string): boolean {
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

export function clientIp(req: IncomingMessage): string {
  if (process.env.TRUST_PROXY === '1') {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
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

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
