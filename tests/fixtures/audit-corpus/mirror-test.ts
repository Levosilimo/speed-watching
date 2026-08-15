// Corpus "test" for the mirror and contract-not-count lanes. The honest
// variant calls the lib exports; the copycat repeats their private values
// verbatim — exactly what audit-mirror-scan flags. Never run by vitest (not
// a *.test.ts glob) and never scanned by the gates outside the audit specs.

import { bandWidth, surgeKey } from './mirror-lib';

export const honest = { retryMs: bandWidth(), key: surgeKey() };
export const copycat = { retryMs: 482, key: 'surge-window' };
export const countSamples = {
  spy: `vi.spyOn(engine, 'apply')`,
  call: `expect(engine.apply).toHaveBeenCalledWith(1.5)`,
};
