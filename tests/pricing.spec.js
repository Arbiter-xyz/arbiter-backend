import { describe, it, expect } from 'vitest';
import { stroopsToUsdc } from '../src/pricing.js';

describe('stroopsToUsdc', () => {
  it('formats zero', () => {
    expect(stroopsToUsdc(0n)).toBe('0.0000000');
    expect(stroopsToUsdc(0)).toBe('0.0000000');
  });

  it('formats positive whole amounts', () => {
    expect(stroopsToUsdc(10_000_000n)).toBe('1.0000000');
    expect(stroopsToUsdc(15_000_000n)).toBe('1.5000000');
  });

  it('formats positive sub-unit amounts', () => {
    expect(stroopsToUsdc(5n)).toBe('0.0000005');
    expect(stroopsToUsdc(1n)).toBe('0.0000001');
  });

  it('formats negative whole amounts', () => {
    expect(stroopsToUsdc(-15_000_000n)).toBe('-1.5000000');
    expect(stroopsToUsdc(-10_000_000n)).toBe('-1.0000000');
  });

  it('formats negative sub-unit amounts', () => {
    expect(stroopsToUsdc(-5n)).toBe('-0.0000005');
    expect(stroopsToUsdc(-1n)).toBe('-0.0000001');
  });
});
