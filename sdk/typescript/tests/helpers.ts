import type { FetchLike } from '../src/index.ts';

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: any;
}

export interface MockReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Handler = (req: RecordedRequest) => MockReply | Error | Promise<MockReply | Error>;

/**
 * A fetch stand-in that records every request and answers from `handler`
 * (or from a queue of replies, consumed in order). Returning an Error
 * simulates a network failure.
 */
export function mockFetch(handlerOrQueue: Handler | Array<MockReply | Error>) {
  const requests: RecordedRequest[] = [];
  const queue = Array.isArray(handlerOrQueue) ? [...handlerOrQueue] : null;

  const fetch: FetchLike = async (input, init = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const req: RecordedRequest = {
      method: init.method ?? 'GET',
      url: new URL(input),
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    requests.push(req);

    const reply = queue ? queue.shift() : await (handlerOrQueue as Handler)(req);
    if (!reply) throw new Error(`mockFetch: no reply queued for ${req.method} ${req.url.pathname}`);
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json', ...reply.headers },
    });
  };

  return { fetch, requests };
}

export const BASE_URL = 'http://arbiter.test';

export const JOB_BASE = {
  createdAt: 1,
  updatedAt: 1,
  question: 'Is the bridge open?',
  tier: 'standard',
  quorumSize: 3,
  timeoutMs: 45_000,
} as const;
