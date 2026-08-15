// Corpus for the disabled-assertion gate: one line per pattern the scan must
// flag, plus the skipIf control it must not. The scan reads this file's raw
// text; vitest never executes it (not a *.test.ts glob) and the gate only
// scans it when the audit specs pass it explicitly.

export const CORPUS = `
it.skip('legacy path')
describe.skip('old suite')
test.todo('later')
xit('not now')
xdescribe('abandoned')
// happy-dom cannot focus the pill host
// happy-dom skipped the focus check
it.skipIf(!bundleExists)('conditional')
`;
