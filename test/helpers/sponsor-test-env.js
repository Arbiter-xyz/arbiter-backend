// Must be the FIRST import in any test file that needs a non-default
// config.contractId — ESM hoists all `import` statements above plain
// top-level code, so a bare `process.env.X = ...` line in the test file
// itself would run AFTER config.js has already loaded (and frozen) its
// values via a transitive import, regardless of source order. Putting the
// assignment inside its own module and importing it first sidesteps that:
// import statements still execute in source order relative to each other.
import { StrKey } from '@stellar/stellar-sdk';

process.env.ORACLE_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
process.env.PLATFORM_SECRET = '';
