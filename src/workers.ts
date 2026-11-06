/**
 * Several Node processes on one machine (WORKERS=n; unset or 1: one process, as
 * before). JavaScript runs on one thread per process and the realtime fan-out
 * is what fills it, so this is what lets the server use more than one core.
 *
 * A board's live copy must exist in exactly one process, or two of them would
 * overwrite each other's saves. So every board id belongs to one worker
 * (`shardOf`), and the primary only looks at the start of each connection and
 * hands the socket over to that worker: a room's sockets all share a process,
 * and the fan-out needs no Redis. Once handed over, the primary is out of the
 * path, so it never becomes the bottleneck.
 *
 * That only works one connection at a time, so with workers REST responses say
 * `Connection: close` (app.ts); a kept-alive connection would carry its next
 * request to the wrong worker.
 *
 * ponytail: per-address rate limits stay right (an address always lands on one
 * worker) but the per-account login limit can reach n times its value across
 * addresses; move it to Mongo or Redis if that matters. Several machines would
 * still need a load balancer routing the same way.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import type { Server as HttpServer } from 'node:http';

import { config } from './config.js';

const workerIndex = process.env.WORKER_INDEX;
export const isWorker = workerIndex !== undefined;
const self = Number(workerIndex ?? 0);

/** Only the first process checks shared things once, like the mail server. */
export const isFirstProcess = self === 0;

/** FNV-1a: stable across restarts, so a board keeps its worker for as long as WORKERS does not change. */
export function shardOf(id: string, workers: number = config.workers): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % workers;
}

export const ownsBoard = (id: string): boolean => config.workers <= 1 || shardOf(id) === self;

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** The board a request is about, or null when any worker can answer it. */
export function boardOfRequestLine(line: string): string | null {
  const target = line.split(' ')[1] ?? '';
  const socket = /^\/ws\?(?:.*&)?boardId=([^&]*)/.exec(target);
  if (socket) return decode(socket[1]!);
  const rest = /^(?:\/me)?\/boards\/([^/?]+)/.exec(target);
  if (!rest) return null;
  // Not board ids: they work from any worker.
  if (target.startsWith('/boards/code/') || target.startsWith('/boards/import')) return null;
  return decode(rest[1]!);
}

/**
 * Which worker takes a connection. The rest go by address, so a per-address
 * rate limit sees all of an address's requests.
 */
export function routeOf(head: string, remoteAddress: string, workers: number, trustProxy: number): number {
  const board = boardOfRequestLine(head.slice(0, head.indexOf('\r\n')));
  if (board) return shardOf(board, workers);
  let address = remoteAddress;
  if (trustProxy > 0) {
    // Same rule as Fastify's `trustProxy`: only the hops we trust, counted from the right.
    const hops = /^x-forwarded-for:[ \t]*(.*)$/im.exec(head)?.[1]?.split(',');
    address = hops?.at(-trustProxy)?.trim() ?? hops?.[0]?.trim() ?? remoteAddress;
  }
  return shardOf(address, workers);
}

// ---------- between workers ----------

export type WorkerEvent =
  /** Guest boards became an account's: another worker's live copy must not write the old owner back. */
  | { kind: 'transfer'; from: string; to: string }
  /** An account changed: other workers drop what they cached about it. */
  | { kind: 'session'; id: string };

const listeners: { [K in WorkerEvent['kind']]?: (event: Extract<WorkerEvent, { kind: K }>) => void } = {};

export function onWorkerEvent<K extends WorkerEvent['kind']>(kind: K, listener: (event: Extract<WorkerEvent, { kind: K }>) => void): void {
  (listeners as Record<string, unknown>)[kind] = listener;
}

/** Tells the other workers. Nothing to do with a single process. */
export function publish(event: WorkerEvent): void {
  if (isWorker) process.send?.({ t: 'event', event });
}

// ---------- the worker ----------

/** Serves the sockets the primary hands over, instead of listening on a port. */
export function serveFromPrimary(server: HttpServer): void {
  process.on('message', (message: { t: string; head?: string; event?: WorkerEvent }, handle?: unknown) => {
    if (message.t === 'event' && message.event) {
      const { event } = message;
      (listeners[event.kind] as ((e: WorkerEvent) => void) | undefined)?.(event);
    } else if (message.t === 'conn' && handle) {
      const socket = handle as Socket;
      server.emit('connection', socket);
      // What the primary read to route it: the parser has to see it first.
      socket.emit('data', Buffer.from(message.head ?? '', 'base64'));
      socket.resume();
    }
  });
  process.send?.({ t: 'ready' });
}

// ---------- the primary ----------

/** The longest request head accepted; Node's own default is 16 KB too. */
const MAX_HEAD_BYTES = 16 * 1024;
const HEAD_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 20_000;

export function runPrimary(): void {
  const workers: (ChildProcess | null)[] = Array.from({ length: config.workers }, () => null);
  const ready = new Set<number>();
  let stopping = false;
  let listener: NetServer | null = null;

  const start = (index: number) => {
    const child = fork(process.argv[1]!, process.argv.slice(2), {
      env: { ...process.env, WORKER_INDEX: String(index) },
      execArgv: process.execArgv,
    });
    workers[index] = child;
    child.on('message', (message: { t: string; event?: WorkerEvent }) => {
      if (message.t === 'ready') {
        ready.add(index);
        if (ready.size === workers.length && !listener) listen();
      } else if (message.t === 'event') {
        for (const other of workers) {
          if (other && other !== child && other.connected) other.send(message);
        }
      }
    });
    child.on('exit', (code, signal) => {
      workers[index] = null;
      if (stopping) {
        if (workers.every((w) => !w)) process.exit(0);
        return;
      }
      // One that never came up will not on a retry either (no database, a bad secret).
      if (!listener) {
        console.error(`Worker ${index} exited before it was ready (${signal ?? code})`);
        process.exit(1);
      }
      console.error(`Worker ${index} died (${signal ?? code}); restarting it`);
      setTimeout(() => start(index), 1000);
    });
  };

  const takeConnection = (socket: Socket) => {
    let head = Buffer.alloc(0);
    socket.setTimeout(HEAD_TIMEOUT_MS, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const text = head.toString('latin1');
      if (!text.includes('\r\n\r\n')) {
        if (head.length > MAX_HEAD_BYTES) socket.destroy();
        return;
      }
      socket.off('data', onData);
      socket.setTimeout(0);
      const child = workers[routeOf(text, socket.remoteAddress ?? '', workers.length, config.trustProxy)];
      if (!child?.connected) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      // In this same tick nothing else can be read: what follows is still in the kernel for the worker.
      child.send({ t: 'conn', head: head.toString('base64') }, socket, (err) => {
        if (err) socket.destroy();
      });
    };
    socket.on('data', onData);
  };

  const listen = () => {
    listener = createServer(takeConnection);
    listener.listen(config.port, config.host, () => {
      console.log(`Serving on ${config.host}:${config.port} with ${workers.length} workers`);
    });
  };

  // Ordered shutdown: each worker persists its boards; a stuck one does not hold the deploy.
  const stop = () => {
    if (stopping) return;
    stopping = true;
    listener?.close();
    for (const child of workers) child?.kill('SIGTERM');
    setTimeout(() => process.exit(1), STOP_TIMEOUT_MS).unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  for (let i = 0; i < workers.length; i++) start(i);
}
