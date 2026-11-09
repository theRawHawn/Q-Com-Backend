declare module 'ws' {
  import { EventEmitter } from 'events';
  import http from 'http';
  import { URL } from 'url';

  export class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;

    constructor(address: string | URL, protocols?: string | string[] | any, options?: any);

    readonly readyState: number;
    send(data: any, cb?: (err?: Error) => void): void;
    close(code?: number, reason?: string): void;
    ping(data?: any): void;
    terminate(): void;
  }

  export interface ServerOptions {
    noServer?: boolean;
    server?: http.Server;
    port?: number;
    path?: string;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options?: ServerOptions);
    clients: Set<WebSocket>;
    close(cb?: (err?: Error) => void): void;
    handleUpgrade(
      request: http.IncomingMessage,
      socket: any,
      upgradeHead: Buffer,
      callback: (client: WebSocket) => void
    ): void;
  }

  export default WebSocket;
}
