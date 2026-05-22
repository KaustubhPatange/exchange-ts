import WebSocket from 'ws';

type Listener<T = unknown> = (data: T) => void;

const DEFAULT_WS_URL = 'ws://localhost:8080/ws';

export class GatewayWS {
  private socket: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private wantedChannels = new Set<string>();

  constructor(private readonly url: string = DEFAULT_WS_URL) {}

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = new WebSocket(this.url);
      this.socket = sock;
      sock.on('open', () => {
        if (this.wantedChannels.size > 0) {
          sock.send(JSON.stringify({ type: 'subscribe', channels: [...this.wantedChannels] }));
        }
        resolve();
      });
      sock.on('error', (err) => reject(err));
      sock.on('message', (raw: Buffer) => {
        let envelope: { channel?: string; data?: unknown };
        try {
          envelope = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!envelope.channel) return;
        const set = this.listeners.get(envelope.channel);
        if (!set) return;
        for (const cb of set) cb(envelope.data);
      });
    });
  }

  subscribe(channels: string[]): void {
    for (const ch of channels) this.wantedChannels.add(ch);
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'subscribe', channels }));
    }
  }

  on<T = unknown>(channel: string, cb: Listener<T>): void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(cb as Listener);
  }

  close(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}
