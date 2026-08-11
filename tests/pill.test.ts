import { describe, expect, it } from 'vitest';
import { warningNoteCopy } from '../ui/pill';

describe('warningNoteCopy', () => {
  it('uses the cliff note for the above-zone reason (and by default)', () => {
    const note = 'Past the safe zone — comprehension drops above ~275 wpm';
    expect(warningNoteCopy('above-zone')).toBe(note);
    expect(warningNoteCopy(undefined)).toBe(note);
  });

  it('uses the honest cap note for the capped-below reason', () => {
    expect(warningNoteCopy('capped-below')).toBe('Estimate uncertain — capped at 1.5x for safety');
  });
});
