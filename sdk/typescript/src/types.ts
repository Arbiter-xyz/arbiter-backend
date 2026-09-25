/**
 * Response shapes of the Arbiter HTTP API, mirrored from the backend source
 * (server.js, pricing.js, jobs.js, oracle.js, metered.js, leaderboard.js,
 * stats.js). Amounts are USDC: `amount` is a decimal string with 7 places
 * (pricing.js's stroopsToUsdc) and `amountStroops` is the same value as an
 * integer string of stroops (1 USDC = 10_000_000 stroops). Timestamps are
 * Unix epoch milliseconds.
 */

export type TierKey = 'instant' | 'standard' | 'express' | 'priority';

/** One entry of pricing.js's listTiersForClient(). */
export interface Tier {
  key: TierKey;
  label: string;
  amount: string;
  amountStroops: string;
  quorumSize: number;
  timeoutMs: number;
}

/** 402 body of POST /oracle with no payment (oracle.js's issueChallenge). */
export interface PaymentChallenge {
  questionId: string;
  amount: string;
  amountStroops: string;
  surgeMultiplier: number;
  asset: { code: string; issuer: string; sacId: string };
  contractId: string;
  network: string;
  tier: TierKey;
  tiers: Tier[];
  quorumSize: number;
  timeoutMs: number;
  autoRefundAfterLedgers: number;
  instructions: string;
}

/**
 * 202 body once a paid question is accepted. The classic flow (after
 * submit()) returns `question`/`quorumSize`/`timeoutMs`; the metered and
 * API-key flows return `tier`/`amount`/`amountStroops`/`tiers` instead.
 * `cancellableUntil`/`cancelUrl` are present while the undo window is open.
 */
export interface OracleAccepted {
  jobId: string;
  questionId: string;
  statusUrl: string;
  question?: string;
  quorumSize?: number;
  timeoutMs?: number;
  tier?: TierKey;
  amount?: string;
  amountStroops?: string;
  tiers?: Tier[];
  cancellableUntil?: number;
  cancelUrl?: string;
}

/** 202 body of POST /oracle/sandbox (sandbox.js's issueSandboxChallenge + job). */
export interface SandboxAccepted {
  sandbox: true;
  questionId: string;
  question: string;
  tier: TierKey;
  quorumSize: number;
  timeoutMs: number;
  amount: string;
  amountStroops: string;
  note: string;
  jobId: string;
  statusUrl: string;
}

export type SandboxSimulation = 'resolved' | 'disagreement' | 'no-answers';

/** `holding` is the undo window before dispatch; `cancelling` only follows a payer cancel. */
export type JobStatus = 'holding' | 'awaiting_workers' | 'reconciling' | 'cancelling' | 'settled';

export type JobOutcome = 'resolved' | 'refunded' | 'refund_pending_timeout' | 'lost_race_to_timeout_refund';

/** GET /oracle/:jobId — the job record from jobs.js, plus its id. */
export interface Job {
  jobId: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  question: string;
  tier: TierKey;
  quorumSize: number;
  timeoutMs: number;
  amountStroops?: string;
  amount?: string;
  payer?: string | null;
  sandbox?: boolean;

  cancellableUntil?: number | null;
  dispatchedAt?: number;
  cancelledAt?: number;
  cancelledByPayer?: boolean;

  /** Present once `status` is `settled`. */
  outcome?: JobOutcome;
  answer?: string;
  confidence?: number;
  reconciliationMethod?: string;
  totalAnswers?: number;
  matchingWorkers?: string[];
  slashedWorkers?: string[];
  payoutTx?: string;
  payoutModel?: string;
  refundTx?: string | null;
  reason?: string;
  /** Set when the admin refund failed: the payer may call refund_timeout() after this many ledgers. */
  autoRefundAfterLedgers?: number;
}

/** POST /payers/:address/session and /workers/:address/session. */
export interface Session {
  token: string;
  expiresAt: number;
}

/** GET /payers/:address/balance (metered.js's getMeteredBalance + depositInstructions). */
export interface PayerBalance {
  payerAddress: string;
  balanceStroops: string;
  balance: string;
  instructions: string;
}

/** Body of a 402 from the metered path when the prepaid balance can't cover the question. */
export interface InsufficientBalance {
  error: string;
  payerAddress: string;
  instructions: string;
}

/** GET /payers/:address/questions. */
export interface PayerQuestions {
  questions: Array<Omit<Job, 'jobId'> & { questionId: string }>;
  totalTracked: number;
  totalSpendStroops: string;
  totalSpend: string;
  successRate: number | null;
}

export interface WorkerOwed {
  owedStroops: string;
  owed: string;
}

export interface WorkerStake {
  stakeStroops: string;
  stake: string;
}

export interface WorkerReputation {
  matched: number;
  total: number;
  matchRatio: number | null;
}

export interface LeaderboardEntry {
  workerId: string;
  totalAnswers: number;
  matched: number;
  matchRatio: number | null;
  stakeStroops: string;
  stake: string;
  established: boolean;
}

export interface Stats {
  onlineWorkers: number;
  totalResolved: number;
  totalRefunded: number;
  totalSettled: number;
}
