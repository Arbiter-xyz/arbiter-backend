/**
 * Thin HTTP client for the Arbiter backend's payer/consumer API. Keeps every
 * tool-call-to-HTTP-call mapping in one place so it can be tested with a
 * mocked `fetch` and nothing else.
 */
export class ArbiterError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ArbiterError';
    this.status = status;
    this.body = body;
  }
}

export class ArbiterClient {
  constructor({ baseUrl, apiKey, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    if (!baseUrl) throw new Error('baseUrl is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.fetch = fetchImpl;
    this.sleep = sleep;
  }

  async #request(method, path, { body, auth = false } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let res;
    try {
      res = await this.fetch(this.baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      throw new ArbiterError(`could not reach Arbiter at ${this.baseUrl}: ${err.message}`);
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON body (proxy error page etc.) — surfaced via `text` below
    }
    return { status: res.status, ok: res.ok, json, text };
  }

  /**
   * Submits a question. With an API key this is the wallet-free path:
   * `POST /oracle` with `Authorization: Bearer ak_live_...` returns 202
   * immediately with a jobId (the backend charges the key's fiat credit — no
   * 402 round trip). With `sandbox: true` it uses `POST /oracle/sandbox`,
   * which is free and simulated. A 402 here means the key has no credit (or no
   * key was sent, so the classic on-chain pay-per-call challenge came back —
   * which needs a Stellar wallet this server deliberately doesn't hold).
   */
  async ask({ question, tier, category, sandbox = false }) {
    const body = { question, ...(tier ? { tier } : {}), ...(category ? { category } : {}) };
    const res = sandbox
      ? await this.#request('POST', '/oracle/sandbox', { body })
      : await this.#request('POST', '/oracle', { body, auth: true });

    if (res.status === 202 && res.json?.jobId) return res.json;

    if (res.status === 402) {
      if (res.json?.questionId) {
        throw new ArbiterError(
          'Arbiter answered 402 with an on-chain payment challenge, which needs a Stellar wallet. Set ARBITER_API_KEY to use API-key billing (no wallet needed) or ARBITER_SANDBOX=true to try the free simulated sandbox.',
          { status: 402, body: res.json },
        );
      }
      throw new ArbiterError(res.json?.error || 'payment required (insufficient credit for this API key)', { status: 402, body: res.json });
    }
    throw new ArbiterError(res.json?.error || `Arbiter returned HTTP ${res.status}`, { status: res.status, body: res.json ?? res.text });
  }

  /** One `GET /oracle/:jobId`. 200 = settled, 202 = still in flight. */
  async getJob(jobId) {
    const res = await this.#request('GET', `/oracle/${encodeURIComponent(jobId)}`);
    if (res.status === 200 || res.status === 202) return res.json;
    if (res.status === 404) throw new ArbiterError('unknown or expired jobId', { status: 404, body: res.json });
    throw new ArbiterError(res.json?.error || `Arbiter returned HTTP ${res.status}`, { status: res.status, body: res.json ?? res.text });
  }

  /**
   * Polls a job until it settles or `maxWaitMs` elapses, so one tool call can
   * return a final answer instead of making the calling agent loop. Always
   * returns the latest job record; check `job.status === 'settled'`.
   */
  async awaitJob(jobId, { pollIntervalMs = 2000, maxWaitMs = 60_000 } = {}) {
    let waited = 0;
    let job = await this.getJob(jobId);
    while (job.status !== 'settled' && waited < maxWaitMs) {
      const step = Math.min(pollIntervalMs, maxWaitMs - waited);
      await this.sleep(step);
      waited += step;
      job = await this.getJob(jobId);
    }
    return job;
  }

  async leaderboard(limit) {
    const res = await this.#request('GET', `/leaderboard${limit ? `?limit=${encodeURIComponent(limit)}` : ''}`);
    if (!res.ok) throw new ArbiterError(res.json?.error || `Arbiter returned HTTP ${res.status}`, { status: res.status });
    return res.json;
  }

  async stats() {
    const res = await this.#request('GET', '/stats');
    if (!res.ok) throw new ArbiterError(res.json?.error || `Arbiter returned HTTP ${res.status}`, { status: res.status });
    return res.json;
  }
}
