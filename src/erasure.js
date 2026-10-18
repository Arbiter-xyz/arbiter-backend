import { erasePayerRecords } from './payerIndex.js';
import { eraseAnchorRecords } from './anchorRecords.js';

/**
 * GDPR/CCPA erasure for one Stellar address (#126/#127): the per-store
 * erasure hooks fanned out behind a single operator-run endpoint. The only
 * identifier this system holds is the address itself (see the CCPA notes in
 * payerIndex.js and anchorRecords.js), so erasure is address-keyed.
 *
 * On-chain state (questions, stake, owed balances, settlement history) is
 * structurally permanent and is NOT touched — the response says so in the
 * body, not just here, so whoever relays it to the data subject can't miss
 * the distinction.
 */
export async function eraseAddressRecords(address) {
  const [payer, anchor] = await Promise.all([erasePayerRecords(address), eraseAnchorRecords(address)]);
  return {
    address,
    erased: { payer, anchor },
    notErased:
      'On-chain records (questions, stake, owed balances, settlement transactions) are permanent on the ' +
      'Stellar ledger and cannot be erased by this backend.',
  };
}

/** DELETE /admin/erasure/:address, gated by `adminGate`. */
export function mountErasureRoutes(app, adminGate) {
  app.delete('/admin/erasure/:address', adminGate, async (req, res) => {
    const { address } = req.params;
    if (!address || address.length > 128) return res.status(400).json({ error: 'a Stellar address is required' });
    try {
      const result = await eraseAddressRecords(address);
      req.log?.info({ address, erased: result.erased }, 'address records erased');
      res.json(result);
    } catch (err) {
      req.log?.error({ err }, 'erasure failed');
      res.status(500).json({ error: 'erasure failed' });
    }
  });
}
