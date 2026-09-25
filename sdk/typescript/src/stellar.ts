/**
 * Optional helpers that need `@stellar/stellar-sdk` (an optional peer
 * dependency), kept out of the main entry so the core client stays
 * dependency-free and browser-friendly. Import from `@arbiter-xyz/sdk/stellar`.
 *
 * In a browser, prefer the user's wallet (e.g. Freighter's
 * `signTransaction`) as the TransactionSigner instead of handling a secret key.
 */
import { Keypair, Transaction } from '@stellar/stellar-sdk';
import type { TransactionSigner } from './client.ts';

/** A TransactionSigner backed by a secret key (`S...`). For servers, scripts, and agents. */
export function keypairSigner(secret: string): TransactionSigner {
  const keypair = Keypair.fromSecret(secret);
  return (xdr, networkPassphrase) => {
    const tx = new Transaction(xdr, networkPassphrase);
    tx.sign(keypair);
    return tx.toXDR();
  };
}
