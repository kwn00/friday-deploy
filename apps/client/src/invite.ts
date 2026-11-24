/**
 * 초대 링크 (?room=CODE): 주소에서 꺼내기, 공유 창이나 클립보드로 보내기.
 * 이 파일은 화면(DOM)을 쓰지 않는다 (단위 테스트에서 검사한다). 주소를 바꾸고 화면에 쓰는 것은 main.ts 가 한다.
 */

/**
 * 주소에서 초대 코드(room)를 꺼내고, room 만 뺀 주소(경로 + 나머지 쿼리 + 해시)를 돌려준다. room 이 없으면 null.
 * 나머지 쿼리는 적힌 그대로 둔다 (다시 인코딩하지 않는다). room 이 여러 번 있으면 첫 번째 값을 쓰고 모두 뺀다.
 * 코드가 맞는 모양인지는 보지 않는다 (normalizeRoomCode 로 확인한다).
 */
export function takeInvite(href: string): { room: string; rest: string } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  let room: string | null = null;
  const keep: string[] = [];
  for (const part of url.search.slice(1).split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (decode(eq < 0 ? part : part.slice(0, eq)) !== 'room') {
      keep.push(part);
      continue;
    }
    room ??= decode(eq < 0 ? '' : part.slice(eq + 1));
  }
  if (room === null) return null;
  return { room, rest: `${url.pathname}${keep.length > 0 ? `?${keep.join('&')}` : ''}${url.hash}` };
}

/** 쿼리의 이름이나 값 하나를 읽는다 (URLSearchParams 와 같이 + 는 띄어쓰기). 잘못된 % 는 그대로 둔다 */
function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

export interface InviteData {
  title: string;
  text: string;
  url: string;
}

/** 초대 링크를 보낸 결과. shared: 공유 창으로 보냄, cancelled: 공유 창을 닫음, copied: 클립보드에 복사함, failed: 둘 다 안 됨 */
export type InviteOutcome = 'shared' | 'cancelled' | 'copied' | 'failed';

/**
 * 초대 링크를 보낸다: share 가 있으면(휴대폰) 공유 창, 없으면 클립보드 복사.
 * 공유 창을 닫기만 했으면(AbortError) cancelled: 사용자가 그만둔 것이니 아무 말도 하지 않는다.
 * 그 밖의 공유 오류(허용되지 않음 등)면 클립보드 복사로 한 번 더 해 보고, 그것도 안 될 때만 failed.
 */
export async function sendInvite(
  data: InviteData,
  share: ((data: InviteData) => Promise<void>) | null,
  copy: (text: string) => Promise<void>,
): Promise<InviteOutcome> {
  if (share) {
    try {
      await share(data);
      return 'shared';
    } catch (err) {
      if (isAbort(err)) return 'cancelled';
    }
  }
  try {
    await copy(data.url);
    return 'copied';
  } catch {
    return 'failed';
  }
}

function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}
