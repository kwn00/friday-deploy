import { PROTOCOL_VERSION, type ClientMsg, type GameMode, type ServerMsg } from '@friday-deploy/shared';

/**
 * 네트워크 계층. 클라이언트는 "입력 의도"만 보내고, 서버가 보내준 상태를 그리기만 한다.
 * 여기서 무엇을 조작해도 서버의 검증(스키마/범위/레이트리밋/시퀀스)을 통과해야 하며,
 * 통과하더라도 할 수 있는 일은 '정상 속도로 이동'과 '제시된 선택지 고르기'뿐이다.
 */
/**
 * 게임 서버 주소. 비워두면 같은 출처(same-origin)를 사용한다.
 * 클라이언트를 Vercel 등 정적 호스팅에, 서버를 별도 호스트에 둘 때 빌드 시 VITE_GAME_SERVER_URL 로 지정.
 */
const SERVER = (import.meta.env.VITE_GAME_SERVER_URL ?? '').trim().replace(/\/+$/, '');
const HTTP_BASE = SERVER;
const WS_URL = SERVER
  ? `${SERVER.replace(/^http/, 'ws')}/ws`
  : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;

export class Net {
  private ws: WebSocket | null = null;
  private seq = 0;

  constructor(
    private readonly onMessage: (msg: ServerMsg) => void,
    private readonly onClose: (reason: string) => void,
  ) {}

  async connect(name: string, mode: GameMode): Promise<void> {
    this.close();
    const res = await fetch(`${HTTP_BASE}/api/session`, { method: 'POST' });
    if (!res.ok) throw new Error(res.status === 429 ? '요청이 너무 많아요. 잠시 후 다시 시도해주세요.' : '세션 발급 실패');
    const { token } = (await res.json()) as { token: string };

    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    this.seq = 0;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('서버에 연결할 수 없어요'));
    });
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        this.onMessage(JSON.parse(ev.data) as ServerMsg);
      } catch {
        /* 무시 */
      }
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) {
        this.ws = null;
        this.onClose(ev.reason || `code ${ev.code}`);
      }
    };
    this.send({ t: 'hello', v: PROTOCOL_VERSION, token, name, mode });
  }

  sendInput(dx: number, dy: number): void {
    this.send({ t: 'input', seq: ++this.seq, dx, dy });
  }

  sendPick(choice: number): void {
    this.send({ t: 'pick', choice });
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
