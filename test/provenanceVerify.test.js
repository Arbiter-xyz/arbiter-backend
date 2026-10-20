'use strict';

const { extractContractCall, verifyPayout } = require('../src/provenanceVerify');

describe('extractContractCall', () => {
  it('returns null for non-object input', () => {
    expect(extractContractCall(null)).toBeNull();
    expect(extractContractCall(undefined)).toBeNull();
    expect(extractContractCall('not-an-object')).toBeNull();
    expect(extractContractCall(42)).toBeNull();
  });

  it('returns null when no contract call is present', () => {
    expect(extractContractCall({})).toBeNull();
    expect(extractContractCall({ operations: [] })).toBeNull();
  });

  it('extracts a contract call from a well-formed envelope', () => {
    const contractCall = {
      contractId: 'CABC123',
      functionName: 'payout',
      args: ['a', 'b'],
    };
    const envelope = {
      operations: [
        { type: 'payment', amount: '10' },
        { type: 'invokeHostFunction', contractCall },
      ],
    };

    expect(extractContractCall(envelope)).toEqual(contractCall);
  });

  it('ignores malformed operations without throwing', () => {
    const envelope = {
      operations: [null, undefined, {}, { type: 'invokeHostFunction' }],
    };

    expect(() => extractContractCall(envelope)).not.toThrow();
    expect(extractContractCall(envelope)).toBeNull();
  });
});

describe('verifyPayout', () => {
  it('returns a falsy result for missing input', () => {
    expect(() => verifyPayout(null)).not.toThrow();
    expect(verifyPayout(null)).toBeFalsy();
  });

  it('verifies a matching payout against the expected contract call', () => {
    const contractCall = {
      contractId: 'CABC123',
      functionName: 'payout',
      args: ['recipient', '100'],
    };
    const envelope = {
      operations: [{ type: 'invokeHostFunction', contractCall }],
    };

    const result = verifyPayout(envelope, contractCall);
    expect(result).toBeTruthy();
  });

  it('rejects a payout that does not match the expected contract call', () => {
    const envelope = {
      operations: [
        {
          type: 'invokeHostFunction',
          contractCall: { contractId: 'CABC123', functionName: 'payout', args: ['x'] },
        },
      ],
    };
    const expected = { contractId: 'CABC123', functionName: 'payout', args: ['y'] };

    expect(verifyPayout(envelope, expected)).toBeFalsy();
  });

  it('does not throw on malformed envelopes', () => {
    expect(() => verifyPayout({}, {})).not.toThrow();
    expect(() => verifyPayout({ operations: [null] }, {})).not.toThrow();
  });
});
