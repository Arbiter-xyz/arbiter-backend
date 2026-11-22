import { createHash } from 'node:crypto';
import { xdr, Address } from '@stellar/stellar-sdk';
import { getServer } from './stellarClient.js';

/**
 * Startup contract-version verification (#465, closing the gap left by
 * #163). config.js computes compatibleContractWasmHash from
 * COMPATIBLE_CONTRACT_WASM_HASH and its own comment pointed here — but
 * this file never existed, so the hash was write-only and nothing ever
 * compared it against the actually-deployed contract.
 *
 * fetchDeployedWasmHash() reads the contract instance's ledger entry over
 * Soroban RPC and hashes its Wasm executable, mirroring what
 * `stellar contract info interface`/`soroban contract fetch` would show.
 * checkContractVersion() compares that against config.compatibleContractWasmHash
 * and reports a pass/fail result the caller can act on (fail loudly,
 * mirroring securityPosture.js's fatal-finding pattern).
 */
export async function fetchDeployedWasmHash(contractId) {
  const server = getServer();
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const { entries } = await server.getLedgerEntries(key);
  if (!entries || entries.length === 0) throw new Error(`no ledger entry for contract ${contractId}`);
  const entry = entries[0].val.contractData();
  const executable = entry.val().instance().executable();
  if (executable.switch().name !== 'contractExecutableWasm') {
    throw new Error(`contract ${contractId} is not a Wasm contract (executable type: ${executable.switch().name})`);
  }
  return executable.wasmHash().toString('hex');
}

/**
 * Compares the deployed contract's real Wasm hash against
 * config.compatibleContractWasmHash. Never throws: a misconfigured or
 * unreachable RPC endpoint is reported as a failed check, not an
 * unhandled rejection that would crash startup in a worse way than the
 * mismatch it's trying to catch.
 */
export async function checkContractVersion({ contractId, compatibleContractWasmHash }) {
  if (!compatibleContractWasmHash) {
    return { ok: true, skipped: true, reason: 'COMPATIBLE_CONTRACT_WASM_HASH not configured — check skipped' };
  }
  if (!contractId) {
    return { ok: false, skipped: false, reason: 'ORACLE_CONTRACT_ID not configured — cannot verify deployed contract version' };
  }
  try {
    const deployedHash = (await fetchDeployedWasmHash(contractId)).toLowerCase();
    const expectedHash = String(compatibleContractWasmHash).toLowerCase();
    return {
      ok: deployedHash === expectedHash,
      skipped: false,
      deployedHash,
      expectedHash,
      reason: deployedHash === expectedHash ? null : `deployed contract ${contractId} wasm hash (${deployedHash}) does not match the configured compatible version (${expectedHash})`,
    };
  } catch (err) {
    return { ok: false, skipped: false, reason: `could not verify deployed contract version: ${String(err.message || err)}` };
  }
}

/** Convenience for test/debug callers that already have a wasm buffer
 * rather than a contract id, kept beside the real check since it uses the
 * same hashing scheme (sha256 hex, same as the contract host's own
 * install-code hashing). */
export function hashWasm(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
