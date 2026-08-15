// buildWpmResponse unit spec: the measured-rate provider's answer assembly
// (lib/wpm-provider.ts) — the wpm:get response wire format. The module had
// no spec of its own (the audit's stryker-scope pass put it under mutation
// with zero killing tests), so the mapping and the no-measurement branch
// are pinned from the protocol shape.

import { describe, expect, it } from 'vitest';
import { buildWpmResponse, type MeasurementContext } from '../lib/wpm-provider';

const context: MeasurementContext = {
  site: 'youtube.com',
  contentType: 'talk',
  naturalRate: 160.25,
  platformMax: 2,
  tier: 'manual-cue',
  unit: 'wpm',
  language: 'en',
  target: 250,
  recommendation: { multiplier: 1.55, mode: 'recommend' },
};

describe('buildWpmResponse', () => {
  it('maps the measurement context onto the wpm:get wire format', () => {
    expect(buildWpmResponse(context)).toEqual({
      ok: true,
      version: 1,
      ts: expect.any(Number) as number,
      site: 'youtube.com',
      naturalRate: 160.25,
      unit: 'wpm',
      language: 'en',
      tier: 'manual-cue',
      contentType: 'talk',
      platformMax: 2,
      recommendation: { target: 250, recommendedMultiplier: 1.55, mode: 'recommend' },
    });
  });

  it('carries a null language when no model maps (English defaults)', () => {
    const noLanguage = buildWpmResponse({ ...context, language: null });
    expect(noLanguage.ok).toBe(true);
    if (noLanguage.ok) expect(noLanguage.language).toBeNull();
  });

  it('reports no-active-video without a measurement', () => {
    expect(buildWpmResponse(null)).toEqual({ ok: false, error: 'no-active-video' });
  });
});
