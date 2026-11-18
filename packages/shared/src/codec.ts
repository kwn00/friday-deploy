/**
 * 스냅샷 이진 인코딩.
 *
 * 스냅샷은 초당 20번, 플레이어마다 따로 나간다. JSON 으로는 15분 한 판에 60MB 가 넘어 무료 호스트의 전송량 한도를
 * 금방 쓴다. zlib 압축(permessage-deflate)은 크기는 줄이지만 CPU 를 많이 써서 약한 서버에서는 접속 몇십 개로
 * 전체가 멈춘다. 그래서 처음부터 작게 보낸다: 좌표는 내 위치 기준 1/16 픽셀 정수, id 는 앞 항목과의 차이.
 * JSON 대비 약 1/3 크기이고 만드는 비용은 JSON.stringify 보다 싸다.
 *
 * 서버 → 클라이언트 전용이다. 클라이언트가 보내는 메시지는 여전히 엄격히 검증하는 JSON 텍스트뿐이다.
 */
import { DT } from './constants';
import { ENEMY_IDS, FIELD_ITEM_KINDS, UPGRADE_IDS, ZONE_KINDS, type UpgradeId } from './content';
import type { Snapshot } from './protocol';

const VERSION = 4;
/** 상대 좌표 정밀도: 1/16 픽셀. i16 범위는 ±2047 픽셀로 관심 영역 반경(420)보다 충분히 넓다. */
const Q = 16;

class Writer {
  private buf = new Uint8Array(4096);
  private view = new DataView(this.buf.buffer);
  private at = 0;

  private need(n: number): void {
    if (this.at + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.at + n));
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number): void {
    this.need(1);
    this.buf[this.at++] = v & 0xff;
  }
  i16(v: number): void {
    this.need(2);
    this.view.setInt16(this.at, Math.max(-32768, Math.min(32767, v)), true);
    this.at += 2;
  }
  f32(v: number): void {
    this.need(4);
    this.view.setFloat32(this.at, v, true);
    this.at += 4;
  }
  /** 음이 아닌 정수 (LEB128). 작은 값은 1바이트. */
  varuint(v: number): void {
    this.need(8);
    let n = Math.max(0, Math.floor(v));
    while (n >= 0x80) {
      this.buf[this.at++] = (n % 0x80) | 0x80;
      n = Math.floor(n / 0x80);
    }
    this.buf[this.at++] = n;
  }
  /** 부호 있는 정수 (zigzag). id 차이처럼 대부분 작은 양수인 값에 쓴다. */
  varint(v: number): void {
    this.varuint(v < 0 ? -v * 2 - 1 : v * 2);
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.at);
  }
}

class Reader {
  private view: DataView;
  private at = 0;
  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  private need(n: number): void {
    if (this.at + n > this.buf.length) throw new RangeError('snapshot truncated');
  }
  u8(): number {
    this.need(1);
    return this.buf[this.at++]!;
  }
  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.at, true);
    this.at += 2;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.at, true);
    this.at += 4;
    return v;
  }
  varuint(): number {
    let v = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.u8();
      v += (b & 0x7f) * mul;
      if (b < 0x80) return v;
      mul *= 0x80;
    }
    throw new RangeError('varint too long');
  }
  varint(): number {
    const z = this.varuint();
    return z % 2 ? -(z + 1) / 2 : z / 2;
  }
  get done(): boolean {
    return this.at === this.buf.length;
  }
}

const clampByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v) || 0));

/** 한 종류의 엔티티 목록에서 허용하는 최대 개수. 손상된 데이터로 거대한 배열을 만들지 않게 한다. */
const MAX_LIST = 4096;

export function encodeSnapshot(s: Snapshot): Uint8Array {
  const w = new Writer();
  // 기준점 = 보고 있는 영역의 중심. 주변 엔티티는 이 점에서의 상대 좌표로 보낸다 (관전 시점이 묘비에서 멀어져도 범위를 넘지 않는다)
  const [ox, oy] = s.view;
  w.u8(VERSION);
  w.u8((s.paused ? 1 : 0) | (s.me.alive ? 2 : 0));
  w.varuint(s.tick);
  w.f32(ox);
  w.f32(oy);

  w.varuint(s.me.id);
  w.varuint(s.me.hp);
  w.varuint(s.me.maxHp);
  w.varuint(s.me.xp);
  w.varuint(s.me.xpNext);
  w.varuint(s.me.level);
  w.varuint(s.me.kills);
  w.u8(Math.max(0, Math.min(255, s.me.revives)));
  for (const id of UPGRADE_IDS) w.u8(s.me.up[id] ?? 0);

  // 플레이어는 멀리 있을 수 있어 절대 좌표(f32)로 보낸다. 최대 4명이라 크기 부담이 없다.
  w.u8(s.p.length);
  for (const p of s.p) {
    w.varuint(p[0]);
    w.f32(p[1]);
    w.f32(p[2]);
    // 방향(1) · 생존(2) · 러버덕 수(4,8,16) · 되살아난 직후 무적(32) · 2단계 인증 무적(64)
    w.u8((p[3] < 0 ? 1 : 0) | (p[4] ? 2 : 0) | ((Math.min(7, p[6]) & 7) << 2) | (p[7] ? 32 : 0) | (p[11] ? 64 : 0));
    w.u8(Math.max(0, Math.min(100, p[5])));
    w.u8(clampByte(p[8]));
    w.u8(clampByte(p[9]));
    w.u8(clampByte(p[10]));
  }

  const rel = (v: number, o: number): number => Math.round((v - o) * Q);
  let prev = 0;
  w.varuint(s.e.length);
  for (const e of s.e) {
    w.varint(e[0] - prev);
    prev = e[0];
    // 종류(하위 6비트) + 얼어 있음(0x40) + 피격 표시(0x80): 표시를 위해 바이트를 더 쓰지 않는다
    w.u8((e[1] & 0x3f) | (e[5] ? 0x40 : 0) | (e[4] ? 0x80 : 0));
    w.i16(rel(e[2], ox));
    w.i16(rel(e[3], oy));
  }
  prev = 0;
  w.varuint(s.s.length);
  for (const sh of s.s) {
    w.varint(sh[0] - prev);
    prev = sh[0];
    w.u8(sh[1]);
    w.i16(rel(sh[2], ox));
    w.i16(rel(sh[3], oy));
  }
  prev = 0;
  w.varuint(s.z.length);
  for (const z of s.z) {
    w.varint(z[0] - prev);
    prev = z[0];
    w.u8(z[1]);
    w.i16(rel(z[2], ox));
    w.i16(rel(z[3], oy));
    w.varuint(Math.round(z[4]));
    w.u8(clampByte(z[5]));
    w.u8(clampByte(z[6]));
  }
  for (const list of [s.g, s.h]) {
    prev = 0;
    w.varuint(list.length);
    for (const g of list) {
      w.varint(g[0] - prev);
      prev = g[0];
      w.i16(rel(g[1], ox));
      w.i16(rel(g[2], oy));
    }
  }
  // 필드 아이템: 멀리 있을 수 있어 플레이어처럼 절대 좌표로 보낸다 (몇 개 안 된다)
  prev = 0;
  w.u8(s.i.length);
  for (const it of s.i) {
    w.varint(it[0] - prev);
    prev = it[0];
    // 종류(하위 7비트) + 곧 사라짐(최상위 비트)
    w.u8((it[1] & 0x7f) | (it[4] ? 0x80 : 0));
    w.f32(it[2]);
    w.f32(it[3]);
  }
  return w.finish();
}

/** 형식이 맞지 않으면 예외를 던진다 (호출하는 쪽에서 그 메시지를 버린다). */
export function decodeSnapshot(data: ArrayBuffer | Uint8Array): Snapshot {
  const r = new Reader(data instanceof Uint8Array ? data : new Uint8Array(data));
  if (r.u8() !== VERSION) throw new RangeError('unknown snapshot version');
  const flags = r.u8();
  const tick = r.varuint();
  const ox = r.f32();
  const oy = r.f32();

  const me: Snapshot['me'] = {
    id: r.varuint(),
    hp: r.varuint(),
    maxHp: r.varuint(),
    xp: r.varuint(),
    xpNext: r.varuint(),
    level: r.varuint(),
    kills: r.varuint(),
    alive: (flags & 2) !== 0,
    revives: r.u8(),
    up: {},
  };
  for (const id of UPGRADE_IDS) {
    const lv = r.u8();
    if (lv > 0) (me.up as Partial<Record<UpgradeId, number>>)[id] = lv;
  }

  const count = (): number => {
    const n = r.varuint();
    if (n > MAX_LIST) throw new RangeError('snapshot list too long');
    return n;
  };
  const abs = (o: number): number => o + r.i16() / Q;

  const snap: Snapshot = { t: 'snap', tick, time: Math.round(tick * DT * 10) / 10, paused: (flags & 1) !== 0, view: [ox, oy], me, p: [], e: [], s: [], z: [], g: [], h: [], i: [] };
  const players = r.u8();
  for (let i = 0; i < players; i++) {
    const id = r.varuint();
    const x = r.f32();
    const y = r.f32();
    const bits = r.u8();
    const hp = r.u8();
    snap.p.push([id, x, y, bits & 1 ? -1 : 1, bits & 2 ? 1 : 0, hp, (bits >> 2) & 7, bits & 32 ? 1 : 0, r.u8(), r.u8(), r.u8(), bits & 64 ? 1 : 0]);
  }
  let id = 0;
  for (let i = count(); i > 0; i--) {
    id += r.varint();
    const type = r.u8();
    if ((type & 0x3f) >= ENEMY_IDS.length) throw new RangeError('unknown enemy type');
    snap.e.push([id, type & 0x3f, abs(ox), abs(oy), type >> 7, (type >> 6) & 1]);
  }
  id = 0;
  for (let i = count(); i > 0; i--) {
    id += r.varint();
    const kind = r.u8();
    snap.s.push([id, kind, abs(ox), abs(oy)]);
  }
  id = 0;
  for (let i = count(); i > 0; i--) {
    id += r.varint();
    const kind = r.u8();
    if (kind >= ZONE_KINDS.length) throw new RangeError('unknown zone kind');
    const x = abs(ox);
    const y = abs(oy);
    const size = r.varuint();
    const aux = r.u8();
    snap.z.push([id, kind, x, y, size, aux, r.u8()]);
  }
  for (const list of [snap.g, snap.h]) {
    id = 0;
    for (let i = count(); i > 0; i--) {
      id += r.varint();
      list.push([id, abs(ox), abs(oy)]);
    }
  }
  id = 0;
  for (let i = r.u8(); i > 0; i--) {
    id += r.varint();
    const kind = r.u8();
    if ((kind & 0x7f) >= FIELD_ITEM_KINDS.length) throw new RangeError('unknown field item kind');
    snap.i.push([id, kind & 0x7f, r.f32(), r.f32(), kind >> 7]);
  }
  if (!r.done) throw new RangeError('snapshot has trailing bytes');
  return snap;
}
