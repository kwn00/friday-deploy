import { createReadStream, type ReadStream } from 'node:fs';
import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream';

/**
 * 파일 하나를 200 응답으로 보낸다 (화면 파일: index.html, assets/*).
 *
 * - 파일을 연 뒤에 응답 머리를 쓴다. 열지 못하면(파일이 없음, 열린 파일이 너무 많음 등) 아직 머리를 보내지 않았으므로
 *   fail(404 또는 500)로 답한다. 읽기 스트림의 오류는 반드시 여기서 받는다: 받지 않으면 'error' 이벤트 하나가
 *   프로세스(= 모든 방)를 죽인다.
 * - 보내는 도중에 상대가 끊거나 읽기가 실패하면 양쪽을 함께 닫는다 (pipeline). `.pipe()` 는 응답이 먼저 닫혀도
 *   읽기 스트림을 닫지 않아서, 다운로드가 끊길 때마다 열린 파일(fd)이 하나씩 남았다. 쌓여서 한도에 닿으면 새 파일을 열지 못한다.
 * - 파일이 열리기 전에 상대가 끊었으면 열리는 대로 닫는다.
 *
 * 돌려주는 읽기 스트림은 테스트가 파일이 닫혔는지 확인하는 데 쓴다.
 */
export function sendFile(res: ServerResponse, file: string, headers: OutgoingHttpHeaders, fail: (status: 404 | 500) => void): ReadStream {
  const src = createReadStream(file);
  const abort = (): void => void src.destroy();
  const early = (err: NodeJS.ErrnoException): void => {
    res.off('close', abort);
    console.error('[error] static', err.code ?? err.message);
    if (res.headersSent || res.destroyed) res.destroy();
    else fail(err.code === 'ENOENT' ? 404 : 500);
  };
  res.once('close', abort);
  src.once('error', early);
  src.once('open', () => {
    src.off('error', early);
    res.off('close', abort);
    // 열리는 사이에 상대가 끊었다 (abort 가 이미 닫는 중이다)
    if (src.destroyed || res.destroyed) return void src.destroy();
    res.writeHead(200, headers);
    pipeline(src, res, (err) => {
      // 상대가 받는 도중에 끊은 것은 흔한 일이다 (화면을 닫음, 통신 끊김). 그 밖의 읽기 오류만 남긴다
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('[error] static', err.code ?? err.message);
    });
  });
  return src;
}
