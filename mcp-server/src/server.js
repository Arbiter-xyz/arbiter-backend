import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ArbiterClient, ArbiterError } from './client.js';

const DEFAULT_MAX_WAIT_MS = 60_000;
const HARD_MAX_WAIT_MS = 300_000;

function text(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

function errorResult(err) {
  const msg = err instanceof ArbiterError ? err.message : `unexpected error: ${err?.message || err}`;
  return { isError: true, content: [{ type: 'text', text: msg }] };
}

/** Shapes a job record into what an agent needs: the answer if there is one, the status if not. */
export function summarizeJob(job) {
  const base = { jobId: job.jobId, status: job.status };
  if (job.sandbox) base.warning = 'SANDBOX: simulated result, not a real human answer.';
  if (job.status !== 'settled') {
    return { ...base, note: 'Still being answered. Call arbiter_get_job again with this jobId to keep waiting.' };
  }
  if (job.outcome === 'resolved') {
    return { ...base, outcome: 'resolved', answer: job.answer, confidence: job.confidence, workersAnswered: job.totalAnswers, reconciliationMethod: job.reconciliationMethod };
  }
  return { ...base, outcome: job.outcome, reason: job.reason, note: 'No answer was settled and the payment was refunded (or is refundable).' };
}

/**
 * Builds the MCP server. `client` is injectable so tests can hand in an
 * ArbiterClient over a mocked fetch; `config` carries the env-derived defaults.
 */
export function createServer({ client, config = {} }) {
  const { sandbox = false, pollIntervalMs = 2000, maxWaitMs = DEFAULT_MAX_WAIT_MS } = config;
  const server = new McpServer({ name: 'arbiter', version: '0.1.0' });

  const clampWait = (seconds) => {
    if (seconds === undefined) return Math.min(maxWaitMs, HARD_MAX_WAIT_MS);
    return Math.min(seconds * 1000, HARD_MAX_WAIT_MS);
  };

  server.registerTool(
    'arbiter_ask',
    {
      title: 'Ask Arbiter',
      description:
        'Ask a question that needs human judgment and get back a consensus answer from a staked quorum of human workers. ' +
        'Submits the question, then (by default) waits for the result, so one call returns the final answer. ' +
        'Uses the configured API key (no crypto wallet needed) or, if ARBITER_SANDBOX is set, the free simulated sandbox. ' +
        'Tiers: instant (LLM draft, no humans), standard, express (fast), priority, auto (asks one worker, recruits more only if unsure).',
      inputSchema: {
        question: z.string().min(1).describe('The question to ask, phrased so a human can answer it directly.'),
        tier: z.enum(['instant', 'standard', 'express', 'priority', 'auto']).optional().describe('Pricing tier. Defaults to standard.'),
        category: z.string().optional().describe('Optional routing category so specialist workers get the question.'),
        wait: z.boolean().optional().describe('Wait for the result (default true). If false, returns the jobId immediately; poll with arbiter_get_job.'),
        timeoutSeconds: z.number().int().min(1).max(300).optional().describe('Max seconds to wait for the answer (default 60).'),
      },
    },
    async ({ question, tier, category, wait = true, timeoutSeconds }) => {
      try {
        if (!sandbox && !client.apiKey) {
          throw new ArbiterError('No ARBITER_API_KEY configured. Set ARBITER_API_KEY (an ak_live_... key) for real questions, or ARBITER_SANDBOX=true for the free simulated sandbox.');
        }
        const submitted = await client.ask({ question, tier, category, sandbox });
        if (!wait) {
          return text({ jobId: submitted.jobId, status: 'submitted', tier: submitted.tier, ...(sandbox ? { warning: 'SANDBOX: simulated result, not a real human answer.' } : {}), note: 'Poll with arbiter_get_job.' });
        }
        const job = await client.awaitJob(submitted.jobId, { pollIntervalMs, maxWaitMs: clampWait(timeoutSeconds) });
        return text(summarizeJob(job));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'arbiter_get_job',
    {
      title: 'Get Arbiter job result',
      description: 'Fetch (and by default wait for) the result of a question submitted to Arbiter, by jobId.',
      inputSchema: {
        jobId: z.string().min(1).describe('The jobId returned by arbiter_ask.'),
        wait: z.boolean().optional().describe('Poll until settled or timeout (default true). If false, returns the current status once.'),
        timeoutSeconds: z.number().int().min(1).max(300).optional().describe('Max seconds to wait (default 60).'),
      },
    },
    async ({ jobId, wait = true, timeoutSeconds }) => {
      try {
        const job = wait
          ? await client.awaitJob(jobId, { pollIntervalMs, maxWaitMs: clampWait(timeoutSeconds) })
          : await client.getJob(jobId);
        return text(summarizeJob(job));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'arbiter_leaderboard',
    {
      title: 'Arbiter worker leaderboard',
      description: 'Read-only: the public leaderboard of Arbiter workers ranked by track record and stake. Useful context for how much to trust the network.',
      inputSchema: { limit: z.number().int().min(1).max(200).optional().describe('Rows to return (default 50).') },
    },
    async ({ limit }) => {
      try {
        return text(await client.leaderboard(limit));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'arbiter_stats',
    {
      title: 'Arbiter platform stats',
      description: 'Read-only: platform-wide counters (workers online, questions resolved/refunded). Real settlements only; sandbox traffic is excluded.',
      inputSchema: {},
    },
    async () => {
      try {
        return text(await client.stats());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

/** Reads the documented environment variables into client + server config. */
export function fromEnv(env = process.env, fetchImpl) {
  const client = new ArbiterClient({
    baseUrl: env.ARBITER_BASE_URL || 'http://localhost:4000',
    apiKey: env.ARBITER_API_KEY,
    fetchImpl,
  });
  const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
  return {
    client,
    config: {
      sandbox: /^(1|true|yes)$/i.test(env.ARBITER_SANDBOX || ''),
      pollIntervalMs: num(env.ARBITER_POLL_INTERVAL_MS, 2000),
      maxWaitMs: num(env.ARBITER_MAX_WAIT_MS, DEFAULT_MAX_WAIT_MS),
    },
  };
}
