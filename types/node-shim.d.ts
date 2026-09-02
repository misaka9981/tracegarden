declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exitCode?: number;
  version: string;
};

declare module "node:http" {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    headers?: Record<string, string | undefined>;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string | string[]): void;
    end(body?: string): void;
    writeHead(statusCode: number, headers?: Record<string, string>): void;
    write(chunk: string): boolean;
  }
  export interface Server {
    listen(port: number, hostname?: string, callback?: () => void): this;
    close(callback?: (error?: Error) => void): this;
  }
  export function createServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): Server;
}

declare module "node:url" {
  export class URL {
    constructor(input: string, base?: string);
    readonly origin: string;
    readonly pathname: string;
    readonly protocol: string;
    readonly hostname: string;
    readonly searchParams: URLSearchParams;
    toString(): string;
  }
  export function fileURLToPath(url: URL): string;
}

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
}

declare module "node:child_process" {
  export function spawn(command: string, args?: string[], options?: Record<string, unknown>): {
    once(event: string, listener: (...args: unknown[]) => void): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
    kill(signal?: string): void;
  };
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    match(value: string, regexp: RegExp, message?: string): void;
  };
  export default assert;
}

declare module "node:crypto" {
  export interface Hmac {
    update(data: string): Hmac;
    digest(): Uint8Array;
  }
  export function createHmac(algorithm: string, key: string): Hmac;
  export function randomUUID(): string;
  export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean;
}

declare module "pg" {
  export interface QueryResult<T = Record<string, unknown>> {
    rows: T[];
    rowCount: number;
  }
  export interface QueryConfig {
    text: string;
    values?: unknown[];
    query_timeout?: number;
  }
  export interface PoolClient {
    query<T = Record<string, unknown>>(config: QueryConfig): Promise<QueryResult<T>>;
    query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
    on(event: "notification", listener: (message: { channel: string; payload?: string }) => void): this;
    on(event: "error", listener: (error: unknown) => void): this;
    removeListener(event: "notification", listener: (message: { channel: string; payload?: string }) => void): this;
    removeListener(event: "error", listener: (error: unknown) => void): this;
    release(error?: Error): void;
  }
  export class Pool {
    constructor(options?: Record<string, unknown>);
    connect(): Promise<PoolClient>;
    query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
    end(): Promise<void>;
  }
}
