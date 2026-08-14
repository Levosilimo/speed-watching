import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyCarrier,
  parseCarrierBody,
  passCriteria,
  recordLine,
  videoVerdict,
  type CarrierOutcome,
  type CarrierRecord,
  type ProbeRecord,
} from '../scripts/adapters-cdn-probe-lib';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/synthetic/${name}`, import.meta.url)), 'utf8');

const okOutcome = (status: number, body: string, acao: string | null = '*'): CarrierOutcome => ({
  kind: 'ok',
  status,
  acao,
  bytes: body.length,
  text: body,
});

const rejectedOutcome = (error: string): CarrierOutcome => ({ kind: 'cors-or-network', error });

const carrier = (outcome: CarrierOutcome): CarrierRecord => ({
  url: 'https://vd1.okcdn.ru/?type=2&subId=abc',
  fetch:
    outcome.kind === 'ok'
      ? { kind: 'ok', status: outcome.status, acao: outcome.acao, bytes: outcome.bytes }
      : { kind: 'cors-or-network', error: outcome.error },
  parse: outcome.kind === 'ok' ? parseCarrierBody(outcome.text) : null,
});

describe('classifyCarrier', () => {
  it('classifies a rejected fetch as cors-blocked', () => {
    const outcome = rejectedOutcome('TypeError: Failed to fetch');
    expect(classifyCarrier(outcome, null)).toBe('cors-blocked');
  });

  it('classifies an ok 403 as signed-expiry', () => {
    const outcome = okOutcome(403, '<html>expired</html>');
    expect(classifyCarrier(outcome, null)).toBe('signed-expiry');
  });

  it('classifies a non-403 error status as http-error', () => {
    const outcome = okOutcome(404, '');
    expect(classifyCarrier(outcome, null)).toBe('http-error');
  });

  it('classifies an ok 200 Dzen word-timed VTT as fetch-ok', () => {
    const outcome = okOutcome(200, fixture('dzen-word.vtt'), '*');
    const record = carrier(outcome);
    expect(classifyCarrier(outcome, record.parse)).toBe('fetch-ok');
    expect(record.parse).toEqual({ words: 16, cues: 2 });
  });

  it('classifies a parse-empty ok 200 as parse-fail', () => {
    const outcome = okOutcome(200, 'WEBVTT\n\n');
    expect(classifyCarrier(outcome, { words: 0, cues: 0 })).toBe('parse-fail');
  });
});

describe('videoVerdict', () => {
  it('aggregates all-fetch-ok Dzen carriers to word-ok', () => {
    const record = carrier(okOutcome(200, fixture('dzen-word.vtt')));
    expect(videoVerdict([record], 1)).toEqual({ status: 'word-ok', reason: null });
  });

  it('aggregates all-fetch-ok Rutube SRT carriers to cue-ok (words empty)', () => {
    const record = carrier(okOutcome(200, fixture('rutube.srt')));
    expect(record.parse?.words).toBe(0);
    expect(record.parse?.cues).toBe(3);
    expect(videoVerdict([record], 1)).toEqual({ status: 'cue-ok', reason: null });
  });

  it('reports no-track when the page exposes no track srcs', () => {
    expect(videoVerdict([], 0)).toEqual({ status: 'no-track', reason: null });
  });

  it('reports fetch-fail cors-blocked when one carrier is cors-blocked and none fetched ok', () => {
    const blocked = carrier(rejectedOutcome('TypeError: Failed to fetch'));
    expect(videoVerdict([blocked], 1)).toEqual({ status: 'fetch-fail', reason: 'cors-blocked' });
  });

  it('reports fetch-fail signed-expiry when only expired carriers exist', () => {
    const expired = carrier(okOutcome(403, 'expired'));
    expect(videoVerdict([expired], 1)).toEqual({ status: 'fetch-fail', reason: 'signed-expiry' });
  });

  it('reports fetch-fail http-404 for a missing carrier', () => {
    const missing = carrier(okOutcome(404, ''));
    expect(videoVerdict([missing], 1)).toEqual({ status: 'fetch-fail', reason: 'http-404' });
  });

  it('reports fetch-fail parse-fail when every carrier parsed empty', () => {
    const empty = carrier(okOutcome(200, 'WEBVTT\n\n'));
    expect(videoVerdict([empty], 1)).toEqual({ status: 'fetch-fail', reason: 'parse-fail' });
  });

  it('prefers word-ok when a fetch-ok carrier coexists with a cors-blocked one', () => {
    const good = carrier(okOutcome(200, fixture('dzen-word.vtt')));
    const blocked = carrier(rejectedOutcome('TypeError: Failed to fetch'));
    expect(videoVerdict([blocked, good], 2)).toEqual({ status: 'word-ok', reason: null });
  });
});

describe('passCriteria', () => {
  it('fails on a single cors-blocked outcome', () => {
    expect(passCriteria(1, 5, 6, 0)).toBe(false);
  });

  it('fails on any parse-fail outcome', () => {
    expect(passCriteria(0, 5, 6, 1)).toBe(false);
  });

  it('passes on 5/6 fetch-ok with zero cors-blocked', () => {
    expect(passCriteria(0, 5, 6, 0)).toBe(true);
  });

  it('fails below the 80% fetch-ok floor', () => {
    expect(passCriteria(0, 3, 5, 0)).toBe(false);
  });
});

describe('recordLine', () => {
  it('serializes a record stably', () => {
    const record: ProbeRecord = {
      platform: 'dzen',
      url: 'https://dzen.ru/video/watch/6a673a21d29c014a1b594be3',
      title: 'Источник: история Крещения Руси. Серия 1',
      status: 'word-ok',
      reason: null,
      carriers: [carrier(okOutcome(200, fixture('dzen-word.vtt'), '*'))],
      probeMs: 41234,
    };
    expect(recordLine(record)).toBe('dzen word-ok carriers=1/1 41234ms');
  });

  it('renders the reason for fetch-fail records', () => {
    const record: ProbeRecord = {
      platform: 'rutube',
      url: 'https://rutube.ru/video/abc/',
      title: null,
      status: 'fetch-fail',
      reason: 'signed-expiry',
      carriers: [carrier(okOutcome(403, 'expired'))],
      probeMs: 30123,
    };
    expect(recordLine(record)).toBe('rutube fetch-fail (signed-expiry) carriers=0/1 30123ms');
  });
});
