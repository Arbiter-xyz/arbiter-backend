/**
 * Ask a question against the sandbox endpoint and poll for the result —
 * no wallet, no payment, no chain. Run a backend locally (`npm start` in
 * the repo root), then:
 *
 *   ARBITER_URL=http://localhost:4000 npm run example:sandbox
 */
import { ArbiterClient } from '../src/index.ts';

const client = new ArbiterClient({ baseUrl: process.env.ARBITER_URL ?? 'http://localhost:4000' });

const accepted = await client.askSandbox('Is the Third Mainland Bridge open right now?', { tier: 'standard' });
console.log(`accepted job ${accepted.jobId} (sandbox=${accepted.sandbox})`);

const job = await client.waitForResult(accepted.jobId, {
  intervalMs: 250,
  onUpdate: (j) => console.log(`  status: ${j.status}`),
});

console.log(`outcome: ${job.outcome}`);
console.log(`answer: ${job.answer ?? '(none)'} (confidence ${job.confidence})`);
