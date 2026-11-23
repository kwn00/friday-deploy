/**
 * 초대 링크 (?room=CODE).
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
