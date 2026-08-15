// Schema pins: the exact parse output the rate pipeline reads from the
// recorded payloads, pinned as inline snapshots. The pins derive from the
// committed real fixtures (the recorded truth) — not from the parsers'
// implementations — so a parser change that starts reading a new field,
// or a fixture change that drops a field the parser reads, shifts the
// pinned output and fails loudly.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import vttjs from 'vtt.js';
import { parseYouTubeJson3 } from '../lib/captions';
import { parseSrt, parseVtt, parseVttWords, type VttHost } from '../lib/captions-harvest';
import { getTranscriptParams, parseTranscriptSegments } from '../lib/transcript';
import { readFixture } from './fixtures/helpers';

const VTT_HOST: VttHost = {
  VTTCue: vttjs.VTTCue,
  document: {
    createElement: (tagName: string) => ({
      tagName,
      style: {},
      children: [],
      appendChild() {},
      setAttribute() {},
    }),
  },
};

const vttFixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/synthetic/${name}`, import.meta.url)), 'utf8');

const REAL_FIXTURES = [
  'real/asr-word.json',
  'real/manual-cue.json',
  'real/windows-asr--rg9mV6DBl4-trunc.json',
  'real/windows-asr-Ks-_Mh1QhMc-trunc.json',
  'real/windows-asr-arj7oStGLkU-trunc.json',
  'real/windows-asr-iG9CE55wbtY-trunc.json',
] as const;

describe('schema pins — parseYouTubeJson3 on the recorded payloads', () => {
  it('real/asr-word.json — the ANDROID word-timed payload', () => {
    const { words, cues } = parseYouTubeJson3(readFixture('real/asr-word.json'));
    expect({ words, cues }).toMatchInlineSnapshot(`
      {
        "cues": [
          {
            "durSec": 3.88,
            "startSec": 6.26,
            "text": "[Music]",
          },
          {
            "durSec": 6.4,
            "startSec": 26.56,
            "text": "good morning",
          },
          {
            "durSec": 6.24,
            "startSec": 28.4,
            "text": "how are you it's been great hasn't it",
          },
          {
            "durSec": 5.2,
            "startSec": 32.96,
            "text": "it's been i've been blown away by the",
          },
          {
            "durSec": 3.52,
            "startSec": 34.64,
            "text": "whole thing in fact i'm leaving",
          },
          {
            "durSec": 5.521,
            "startSec": 40.399,
            "text": "um there have been three themes haven't",
          },
          {
            "durSec": 3.681,
            "startSec": 44.079,
            "text": "they running through the conference",
          },
          {
            "durSec": 3.479,
            "startSec": 45.92,
            "text": "uh which are rather relevant to what i",
          },
          {
            "durSec": 4,
            "startSec": 47.76,
            "text": "want to talk about one is the",
          },
          {
            "durSec": 3.721,
            "startSec": 49.399,
            "text": "extraordinary evidence of human",
          },
        ],
        "words": [
          {
            "durSec": 1.9200000000000017,
            "startSec": 26.72,
            "text": " morning",
          },
          {
            "durSec": 0.1999999999999993,
            "startSec": 28.64,
            "text": " are",
          },
          {
            "durSec": 1.879999999999999,
            "startSec": 28.84,
            "text": " you",
          },
          {
            "durSec": 0.16000000000000014,
            "startSec": 30.72,
            "text": " it's",
          },
          {
            "durSec": 0.15900000000000247,
            "startSec": 30.88,
            "text": " been",
          },
          {
            "durSec": 0.23999999999999844,
            "startSec": 31.039,
            "text": " great",
          },
          {
            "durSec": 0.23999999999999844,
            "startSec": 31.279,
            "text": " hasn't",
          },
          {
            "durSec": 1.6810000000000045,
            "startSec": 31.519,
            "text": " it",
          },
          {
            "durSec": 0.23999999999999488,
            "startSec": 33.2,
            "text": " been",
          },
          {
            "durSec": 0.3200000000000003,
            "startSec": 33.44,
            "text": " i've",
          },
          {
            "durSec": 0.1600000000000037,
            "startSec": 33.76,
            "text": " been",
          },
          {
            "durSec": 0.23999999999999488,
            "startSec": 33.92,
            "text": " blown",
          },
          {
            "durSec": 0.23900000000000432,
            "startSec": 34.16,
            "text": " away",
          },
          {
            "durSec": 0.1599999999999966,
            "startSec": 34.399,
            "text": " by",
          },
          {
            "durSec": 0.24099999999999966,
            "startSec": 34.559,
            "text": " the",
          },
          {
            "durSec": 0.5600000000000023,
            "startSec": 34.8,
            "text": " thing",
          },
          {
            "durSec": 0.1600000000000037,
            "startSec": 35.36,
            "text": " in",
          },
          {
            "durSec": 0.23999999999999488,
            "startSec": 35.52,
            "text": " fact",
          },
          {
            "durSec": 0.0800000000000054,
            "startSec": 35.76,
            "text": " i'm",
          },
          {
            "durSec": 6.959999999999994,
            "startSec": 35.84,
            "text": " leaving",
          },
          {
            "durSec": 0.1600000000000037,
            "startSec": 42.8,
            "text": " there",
          },
          {
            "durSec": 0.0799999999999983,
            "startSec": 42.96,
            "text": " have",
          },
          {
            "durSec": 0.240000000000002,
            "startSec": 43.04,
            "text": " been",
          },
          {
            "durSec": 0.240000000000002,
            "startSec": 43.28,
            "text": " three",
          },
          {
            "durSec": 0.3200000000000003,
            "startSec": 43.52,
            "text": " themes",
          },
          {
            "durSec": 0.3989999999999938,
            "startSec": 43.84,
            "text": " haven't",
          },
          {
            "durSec": 0.3200000000000003,
            "startSec": 44.239,
            "text": " running",
          },
          {
            "durSec": 0.1600000000000037,
            "startSec": 44.559,
            "text": " through",
          },
          {
            "durSec": 0.08099999999999596,
            "startSec": 44.719,
            "text": " the",
          },
          {
            "durSec": 1.5990000000000038,
            "startSec": 44.8,
            "text": " conference",
          },
          {
            "durSec": 0.24099999999999966,
            "startSec": 46.399,
            "text": " which",
          },
          {
            "durSec": 0.07900000000000063,
            "startSec": 46.64,
            "text": " are",
          },
          {
            "durSec": 0.40099999999999625,
            "startSec": 46.719,
            "text": " rather",
          },
          {
            "durSec": 0.3200000000000003,
            "startSec": 47.12,
            "text": " relevant",
          },
          {
            "durSec": 0.1600000000000037,
            "startSec": 47.44,
            "text": " to",
          },
          {
            "durSec": 0.0799999999999983,
            "startSec": 47.6,
            "text": " what",
          },
          {
            "durSec": 0.1600000000000037,
            "startSec": 47.68,
            "text": " i",
          },
          {
            "durSec": 0.1599999999999966,
            "startSec": 47.84,
            "text": " to",
          },
          {
            "durSec": 0.1599999999999966,
            "startSec": 48,
            "text": " talk",
          },
          {
            "durSec": 0.23900000000000432,
            "startSec": 48.16,
            "text": " about",
          },
          {
            "durSec": 0.24099999999999966,
            "startSec": 48.399,
            "text": " one",
          },
          {
            "durSec": 0.1599999999999966,
            "startSec": 48.64,
            "text": " is",
          },
          {
            "durSec": 2.0790000000000006,
            "startSec": 48.8,
            "text": " the",
          },
          {
            "durSec": 0.48100000000000165,
            "startSec": 50.879,
            "text": " evidence",
          },
          {
            "durSec": 0.0799999999999983,
            "startSec": 51.36,
            "text": " of",
          },
          {
            "startSec": 51.44,
            "text": " human",
          },
        ],
      }
    `);
  });

  it('real/manual-cue.json — the professional-caption payload', () => {
    const { words, cues } = parseYouTubeJson3(readFixture('real/manual-cue.json'));
    expect({ words, cues }).toMatchInlineSnapshot(`
      {
        "cues": [
          {
            "durSec": 3.966,
            "startSec": 16.257,
            "text": "How do you explain when things don't go as we assume?",
          },
          {
            "durSec": 2.966,
            "startSec": 20.257,
            "text": "Or better, how do you explain",
          },
          {
            "durSec": 3.966,
            "startSec": 23.257,
            "text": "when others are able to achieve things that seem to defy all of the assumptions?",
          },
          {
            "durSec": 1.966,
            "startSec": 27.257,
            "text": "For example:",
          },
          {
            "durSec": 1.966,
            "startSec": 29.257,
            "text": "Why is Apple so innovative?",
          },
          {
            "durSec": 1.966,
            "startSec": 31.257,
            "text": "Year after year, after year,",
          },
          {
            "durSec": 2.966,
            "startSec": 33.257,
            "text": "they're more innovative than all their competition.",
          },
          {
            "durSec": 1.966,
            "startSec": 36.257,
            "text": "And yet, they're just a computer company.",
          },
          {
            "durSec": 1.966,
            "startSec": 38.257,
            "text": "They're just like everyone else.",
          },
          {
            "durSec": 2.2,
            "startSec": 40.257,
            "text": "They have the same access to the same talent,",
          },
          {
            "durSec": 1,
            "startSec": 42.457,
            "text": "the same agencies,",
          },
          {
            "durSec": 1.867,
            "startSec": 43.49,
            "text": "the same consultants, the same media.",
          },
          {
            "durSec": 3.433,
            "startSec": 45.39,
            "text": "Then why is it that they seem to have something different?",
          },
          {
            "durSec": 3.966,
            "startSec": 50.257,
            "text": "Why is it that Martin Luther King led the Civil Rights Movement?",
          },
          {
            "durSec": 3.966,
            "startSec": 54.257,
            "text": "He wasn't the only man who suffered in pre-civil rights America,",
          },
          {
            "durSec": 2.733,
            "startSec": 58.257,
            "text": "and he certainly wasn't the only great orator of the day.",
          },
          {
            "durSec": 1.2,
            "startSec": 61.023,
            "text": "Why him?",
          },
          {
            "durSec": 2.966,
            "startSec": 62.257,
            "text": "And why is it that the Wright brothers",
          },
          {
            "durSec": 2.966,
            "startSec": 65.257,
            "text": "were able to figure out controlled, powered man flight",
          },
          {
            "durSec": 2.166,
            "startSec": 68.257,
            "text": "when there were certainly other teams",
          },
        ],
        "words": [],
      }
    `);
  });

  it('real/windows-asr--rg9mV6DBl4-trunc.json', () => {
    const { words, cues } = parseYouTubeJson3(readFixture('real/windows-asr--rg9mV6DBl4-trunc.json'));
    expect({ words, cues }).toMatchInlineSnapshot(`
      {
        "cues": [
          {
            "durSec": 6.589,
            "startSec": 0.12,
            "text": "[музыка]",
          },
          {
            "durSec": 5.26,
            "startSec": 7.04,
            "text": "Элементарные частицы",
          },
          {
            "durSec": 5.141,
            "startSec": 9.679,
            "text": "интуитивно понятно что это означает это",
          },
          {
            "durSec": 4.86,
            "startSec": 12.3,
            "text": "что-то такое такое самое элементарное",
          },
          {
            "durSec": 5.539,
            "startSec": 14.82,
            "text": "что уже нельзя расколоть на части нельзя",
          },
          {
            "durSec": 5.459,
            "startSec": 17.16,
            "text": "найти из чего это с частица состоит",
          },
          {
            "durSec": 3.701,
            "startSec": 20.359,
            "text": "исторически в то же время понятия",
          },
          {
            "durSec": 3.66,
            "startSec": 22.619,
            "text": "менялось",
          },
          {
            "durSec": 5.299,
            "startSec": 24.06,
            "text": "наверное самый элементарными частицами",
          },
          {
            "durSec": 6,
            "startSec": 26.279,
            "text": "когда-то считались атомы потому что еще",
          },
        ],
        "words": [
          {
            "durSec": 2.639000000000001,
            "startSec": 8.04,
            "text": " частицы",
          },
          {
            "durSec": 0.18099999999999916,
            "startSec": 10.679,
            "text": " понятно",
          },
          {
            "durSec": 0.41999999999999993,
            "startSec": 10.86,
            "text": " что",
          },
          {
            "durSec": 0.1800000000000015,
            "startSec": 11.28,
            "text": " это",
          },
          {
            "durSec": 0.23999999999999844,
            "startSec": 11.46,
            "text": " означает",
          },
          {
            "durSec": 0.8990000000000009,
            "startSec": 11.7,
            "text": " это",
          },
          {
            "durSec": 0.24099999999999966,
            "startSec": 12.599,
            "text": " такое",
          },
          {
            "durSec": 0.7799999999999994,
            "startSec": 12.84,
            "text": " такое",
          },
          {
            "durSec": 0.5400000000000009,
            "startSec": 13.62,
            "text": " самое",
          },
          {
            "durSec": 0.9599999999999991,
            "startSec": 14.16,
            "text": " элементарное",
          },
          {
            "durSec": 0.17900000000000027,
            "startSec": 15.12,
            "text": " уже",
          },
          {
            "durSec": 0.18100000000000094,
            "startSec": 15.299,
            "text": " нельзя",
          },
          {
            "durSec": 0.7800000000000011,
            "startSec": 15.48,
            "text": " расколоть",
          },
          {
            "durSec": 0.23999999999999844,
            "startSec": 16.26,
            "text": " на",
          },
          {
            "durSec": 0.23999999999999844,
            "startSec": 16.5,
            "text": " части",
          },
          {
            "durSec": 0.7800000000000011,
            "startSec": 16.74,
            "text": " нельзя",
          },
          {
            "durSec": 0.5990000000000002,
            "startSec": 17.52,
            "text": " из",
          },
          {
            "durSec": 0.12099999999999866,
            "startSec": 18.119,
            "text": " чего",
          },
          {
            "durSec": 0.29900000000000304,
            "startSec": 18.24,
            "text": " это",
          },
          {
            "durSec": 0.18099999999999739,
            "startSec": 18.539,
            "text": " с",
          },
          {
            "durSec": 0.240000000000002,
            "startSec": 18.72,
            "text": " частица",
          },
          {
            "durSec": 2.399000000000001,
            "startSec": 18.96,
            "text": " состоит",
          },
          {
            "durSec": 0.4809999999999981,
            "startSec": 21.359,
            "text": " в",
          },
          {
            "durSec": 0.05999999999999872,
            "startSec": 21.84,
            "text": " то",
          },
          {
            "durSec": 0.120000000000001,
            "startSec": 21.9,
            "text": " же",
          },
          {
            "durSec": 0.05999999999999872,
            "startSec": 22.02,
            "text": " время",
          },
          {
            "durSec": 2.580000000000002,
            "startSec": 22.08,
            "text": " понятия",
          },
          {
            "durSec": 0.5390000000000015,
            "startSec": 24.66,
            "text": " самый",
          },
          {
            "durSec": 0.7210000000000001,
            "startSec": 25.199,
            "text": " элементарными",
          },
          {
            "durSec": 1.139999999999997,
            "startSec": 25.92,
            "text": " частицами",
          },
          {
            "durSec": 0.29900000000000304,
            "startSec": 27.06,
            "text": " считались",
          },
          {
            "durSec": 0.4809999999999981,
            "startSec": 27.359,
            "text": " атомы",
          },
          {
            "durSec": 0.9600000000000009,
            "startSec": 27.84,
            "text": " потому",
          },
          {
            "durSec": 0.35999999999999943,
            "startSec": 28.8,
            "text": " что",
          },
          {
            "startSec": 29.16,
            "text": " еще",
          },
        ],
      }
    `);
  });

  it('real/windows-asr-Ks-_Mh1QhMc-trunc.json', () => {
    const { words, cues } = parseYouTubeJson3(readFixture('real/windows-asr-Ks-_Mh1QhMc-trunc.json'));
    expect({ words, cues }).toMatchInlineSnapshot(`
      {
        "cues": [
          {
            "durSec": 12.85,
            "startSec": 2.63,
            "text": "[Music]",
          },
          {
            "durSec": 3.17,
            "startSec": 12.31,
            "text": "[Applause]",
          },
          {
            "durSec": 6.4,
            "startSec": 16.52,
            "text": "so I want to start by um offering you a",
          },
          {
            "durSec": 6.2,
            "startSec": 18.8,
            "text": "free no Tech life hack um and all it",
          },
          {
            "durSec": 5.96,
            "startSec": 22.92,
            "text": "requires of you is this that you change",
          },
          {
            "durSec": 6.039,
            "startSec": 25,
            "text": "your posture for two minutes but before",
          },
          {
            "durSec": 4.679,
            "startSec": 28.88,
            "text": "I give it away I want to ask you to",
          },
          {
            "durSec": 4.401,
            "startSec": 31.039,
            "text": "right now do a little audit of your body",
          },
          {
            "durSec": 3.081,
            "startSec": 33.559,
            "text": "and what you're doing with your body so",
          },
          {
            "durSec": 3.72,
            "startSec": 35.44,
            "text": "how many of you are sort of making",
          },
        ],
        "words": [
          {
            "durSec": 0.0799999999999983,
            "startSec": 16.76,
            "text": " I",
          },
          {
            "durSec": 0.120000000000001,
            "startSec": 16.84,
            "text": " want",
          },
          {
            "durSec": 0.1999999999999993,
            "startSec": 16.96,
            "text": " to",
          },
          {
            "durSec": 0.35999999999999943,
            "startSec": 17.16,
            "text": " start",
          },
          {
            "durSec": 0.3200000000000003,
            "startSec": 17.52,
            "text": " by",
          },
          {
            "durSec": 0.19900000000000162,
            "startSec": 17.84,
            "text": " um",
          },
          {
            "durSec": 0.3999999999999986,
            "startSec": 18.039,
            "text": " offering",
          },
          {
            "durSec": 0.16100000000000136,
            "startSec": 18.439,
            "text": " you",
          },
          {
            "durSec": 1.0799999999999983,
            "startSec": 18.6,
            "text": " a",
          },
          {
            "durSec": 0.43900000000000006,
            "startSec": 19.68,
            "text": " no",
          },
          {
            "durSec": 0.240000000000002,
            "startSec": 20.119,
            "text": " Tech",
          },
          {
            "durSec": 0.6799999999999997,
            "startSec": 20.359,
            "text": " life",
          },
          {
            "durSec": 1,
            "startSec": 21.039,
            "text": " hack",
          },
          {
            "durSec": 0.3200000000000003,
            "startSec": 22.039,
            "text": " um",
          },
          {
            "durSec": 0.20099999999999696,
            "startSec": 22.359,
            "text": " and",
          },
          {
            "durSec": 0.16000000000000014,
            "startSec": 22.56,
            "text": " all",
          },
          {
            "durSec": 0.6799999999999997,
            "startSec": 22.72,
            "text": " it",
          },
          {
            "durSec": 0.16000000000000014,
            "startSec": 23.4,
            "text": " of",
          },
          {
            "durSec": 0.240000000000002,
            "startSec": 23.56,
            "text": " you",
          },
          {
            "durSec": 0.31899999999999906,
            "startSec": 23.8,
            "text": " is",
          },
          {
            "durSec": 0.240000000000002,
            "startSec": 24.119,
            "text": " this",
          },
          {
            "durSec": 0.12099999999999866,
            "startSec": 24.359,
            "text": " that",
          },
          {
            "durSec": 0.16000000000000014,
            "startSec": 24.48,
            "text": " you",
          },
          {
            "durSec": 0.9589999999999996,
            "startSec": 24.64,
            "text": " change",
          },
          {
            "durSec": 1,
            "startSec": 25.599,
            "text": " posture",
          },
          {
            "durSec": 0.5199999999999996,
            "startSec": 26.599,
            "text": " for",
          },
          {
            "durSec": 0.3200000000000003,
            "startSec": 27.119,
            "text": " two",
          },
          {
            "durSec": 0.9609999999999985,
            "startSec": 27.439,
            "text": " minutes",
          },
          {
            "durSec": 0.240000000000002,
            "startSec": 28.4,
            "text": " but",
          },
          {
            "durSec": 0.3990000000000009,
            "startSec": 28.64,
            "text": " before",
          },
          {
            "durSec": 0.12099999999999866,
            "startSec": 29.039,
            "text": " give",
          },
          {
            "durSec": 0.16000000000000014,
            "startSec": 29.16,
            "text": " it",
          },
          {
            "durSec": 0.6799999999999997,
            "startSec": 29.32,
            "text": " away",
          },
          {
            "durSec": 0.0799999999999983,
            "startSec": 30,
            "text": " I",
          },
          {
            "durSec": 0.11900000000000333,
            "startSec": 30.08,
            "text": " want",
          },
          {
            "durSec": 0.16000000000000014,
            "startSec": 30.199,
            "text": " to",
          },
          {
            "durSec": 0.20099999999999696,
            "startSec": 30.359,
            "text": " ask",
          },
          {
            "durSec": 0.16000000000000014,
            "startSec": 30.56,
            "text": " you",
          },
          {
            "durSec": 0.559000000000001,
            "startSec": 30.72,
            "text": " to",
          },
          {
            "durSec": 0.4800000000000004,
            "startSec": 31.279,
            "text": " now",
          },
          {
            "durSec": 0.2010000000000005,
            "startSec": 31.759,
            "text": " do",
          },
          {
            "durSec": 0.11899999999999977,
            "startSec": 31.96,
            "text": " a",
          },
          {
            "durSec": 0.2809999999999988,
            "startSec": 32.079,
            "text": " little",
          },
          {
            "durSec": 0.4399999999999977,
            "startSec": 32.36,
            "text": " audit",
          },
          {
            "durSec": 0.20000000000000284,
            "startSec": 32.8,
            "text": " of",
          },
          {
            "durSec": 0.23899999999999721,
            "startSec": 33,
            "text": " your",
          },
          {
            "durSec": 0.480000000000004,
            "startSec": 33.239,
            "text": " body",
          },
          {
            "durSec": 0.12100000000000222,
            "startSec": 33.719,
            "text": " what",
          },
          {
            "durSec": 0.1599999999999966,
            "startSec": 33.84,
            "text": " you're",
          },
          {
            "durSec": 0.23899999999999721,
            "startSec": 34,
            "text": " doing",
          },
          {
            "durSec": 0.12100000000000222,
            "startSec": 34.239,
            "text": " with",
          },
          {
            "durSec": 0.19899999999999807,
            "startSec": 34.36,
            "text": " your",
          },
          {
            "durSec": 0.6799999999999997,
            "startSec": 34.559,
            "text": " body",
          },
          {
            "durSec": 0.3200000000000003,
            "startSec": 35.239,
            "text": " so",
          },
          {
            "durSec": 0.2010000000000005,
            "startSec": 35.559,
            "text": " many",
          },
          {
            "durSec": 0.11899999999999977,
            "startSec": 35.76,
            "text": " of",
          },
          {
            "durSec": 0.12100000000000222,
            "startSec": 35.879,
            "text": " you",
          },
          {
            "durSec": 0.11999999999999744,
            "startSec": 36,
            "text": " are",
          },
          {
            "durSec": 0.1600000000000037,
            "startSec": 36.12,
            "text": " sort",
          },
          {
            "durSec": 0.11899999999999977,
            "startSec": 36.28,
            "text": " of",
          },
          {
            "startSec": 36.399,
            "text": " making",
          },
        ],
      }
    `);
  });

  it('real/windows-asr-arj7oStGLkU-trunc.json', () => {
    const { words, cues } = parseYouTubeJson3(readFixture('real/windows-asr-arj7oStGLkU-trunc.json'));
    expect({ words, cues }).toMatchInlineSnapshot(`
      {
        "cues": [
          {
            "durSec": 4.48,
            "startSec": 12.559,
            "text": "so in",
          },
          {
            "durSec": 5.28,
            "startSec": 14.36,
            "text": "college I was a government major which",
          },
          {
            "durSec": 3.881,
            "startSec": 17.039,
            "text": "means I had to write a lot of papers now",
          },
          {
            "durSec": 2.479,
            "startSec": 19.64,
            "text": "when a normal student writes a paper",
          },
          {
            "durSec": 5.04,
            "startSec": 20.92,
            "text": "they might spread the work out a little",
          },
          {
            "durSec": 5.881,
            "startSec": 22.119,
            "text": "like this so you",
          },
          {
            "durSec": 3.399,
            "startSec": 25.96,
            "text": "know you get started maybe a little",
          },
          {
            "durSec": 2.96,
            "startSec": 28,
            "text": "slowly but you get enough done in the",
          },
          {
            "durSec": 3.801,
            "startSec": 29.359,
            "text": "first week that that with some heavier",
          },
          {
            "durSec": 3.96,
            "startSec": 30.96,
            "text": "days later on everything gets done and",
          },
        ],
        "words": [
          {
            "durSec": 2.600999999999999,
            "startSec": 12.759,
            "text": " in",
          },
          {
            "durSec": 0.08000000000000007,
            "startSec": 15.36,
            "text": " I",
          },
          {
            "durSec": 0.1590000000000007,
            "startSec": 15.44,
            "text": " was",
          },
          {
            "durSec": 0.11999999999999922,
            "startSec": 15.599,
            "text": " a",
          },
          {
            "durSec": 0.4410000000000007,
            "startSec": 15.719,
            "text": " government",
          },
          {
            "durSec": 0.7600000000000016,
            "startSec": 16.16,
            "text": " major",
          },
          {
            "durSec": 0.3999999999999986,
            "startSec": 16.92,
            "text": " which",
          },
          {
            "durSec": 0.11899999999999977,
            "startSec": 17.32,
            "text": " I",
          },
          {
            "durSec": 0.12099999999999866,
            "startSec": 17.439,
            "text": " had",
          },
          {
            "durSec": 0.16000000000000014,
            "startSec": 17.56,
            "text": " to",
          },
          {
            "durSec": 0.16000000000000014,
            "startSec": 17.72,
            "text": " write",
          },
          {
            "durSec": 0.120000000000001,
            "startSec": 17.88,
            "text": " a",
          },
          {
            "durSec": 0.11899999999999977,
            "startSec": 18,
            "text": " lot",
          },
          {
            "durSec": 0.3200000000000003,
            "startSec": 18.119,
            "text": " of",
          },
          {
            "durSec": 1,
            "startSec": 18.439,
            "text": " papers",
          },
          {
            "durSec": 0.3210000000000015,
            "startSec": 19.439,
            "text": " now",
          },
          {
            "durSec": 0.0799999999999983,
            "startSec": 19.76,
            "text": " a",
          },
          {
            "durSec": 0.2789999999999999,
            "startSec": 19.84,
            "text": " normal",
          },
          {
            "durSec": 0.2809999999999988,
            "startSec": 20.119,
            "text": " student",
          },
          {
            "durSec": 0.20000000000000284,
            "startSec": 20.4,
            "text": " writes",
          },
          {
            "durSec": 0.0799999999999983,
            "startSec": 20.6,
            "text": " a",
          },
          {
            "durSec": 0.3200000000000003,
            "startSec": 20.68,
            "text": " paper",
          },
          {
            "durSec": 0.16000000000000014,
            "startSec": 21,
            "text": " might",
          },
          {
            "durSec": 0.23999999999999844,
            "startSec": 21.16,
            "text": " spread",
          },
          {
            "durSec": 0.11899999999999977,
            "startSec": 21.4,
            "text": " the",
          },
          {
            "durSec": 0.16100000000000136,
            "startSec": 21.519,
            "text": " work",
          },
          {
            "durSec": 0.16000000000000014,
            "startSec": 21.68,
            "text": " out",
          },
          {
            "durSec": 0.08000000000000185,
            "startSec": 21.84,
            "text": " a",
          },
          {
            "durSec": 0.7999999999999972,
            "startSec": 21.92,
            "text": " little",
          },
          {
            "durSec": 1,
            "startSec": 22.72,
            "text": " this",
          },
          {
            "durSec": 0.28000000000000114,
            "startSec": 23.72,
            "text": " so",
          },
          {
            "durSec": 2.960000000000001,
            "startSec": 24,
            "text": " you",
          },
          {
            "durSec": 0.15899999999999892,
            "startSec": 26.96,
            "text": " you",
          },
          {
            "durSec": 0.16000000000000014,
            "startSec": 27.119,
            "text": " get",
          },
          {
            "durSec": 0.3200000000000003,
            "startSec": 27.279,
            "text": " started",
          },
          {
            "durSec": 0.16100000000000136,
            "startSec": 27.599,
            "text": " maybe",
          },
          {
            "durSec": 0.0799999999999983,
            "startSec": 27.76,
            "text": " a",
          },
          {
            "durSec": 0.5190000000000019,
            "startSec": 27.84,
            "text": " little",
          },
          {
            "durSec": 0.0799999999999983,
            "startSec": 28.359,
            "text": " but",
          },
          {
            "durSec": 0.12099999999999866,
            "startSec": 28.439,
            "text": " you",
          },
          {
            "durSec": 0.16000000000000014,
            "startSec": 28.56,
            "text": " get",
          },
          {
            "durSec": 0.20000000000000284,
            "startSec": 28.72,
            "text": " enough",
          },
          {
            "durSec": 0.1599999999999966,
            "startSec": 28.92,
            "text": " done",
          },
          {
            "durSec": 0.11900000000000333,
            "startSec": 29.08,
            "text": " in",
          },
          {
            "durSec": 0.3609999999999971,
            "startSec": 29.199,
            "text": " the",
          },
          {
            "durSec": 0.28000000000000114,
            "startSec": 29.56,
            "text": " week",
          },
          {
            "durSec": 0.19900000000000162,
            "startSec": 29.84,
            "text": " that",
          },
          {
            "durSec": 0.2809999999999988,
            "startSec": 30.039,
            "text": " that",
          },
          {
            "durSec": 0.16000000000000014,
            "startSec": 30.32,
            "text": " with",
          },
          {
            "durSec": 0.16000000000000014,
            "startSec": 30.48,
            "text": " some",
          },
          {
            "durSec": 0.559000000000001,
            "startSec": 30.64,
            "text": " heavier",
          },
          {
            "durSec": 0.23999999999999844,
            "startSec": 31.199,
            "text": " later",
          },
          {
            "durSec": 0.8400000000000034,
            "startSec": 31.439,
            "text": " on",
          },
          {
            "durSec": 0.3199999999999932,
            "startSec": 32.279,
            "text": " everything",
          },
          {
            "durSec": 0.24100000000000676,
            "startSec": 32.599,
            "text": " gets",
          },
          {
            "durSec": 0.1599999999999966,
            "startSec": 32.84,
            "text": " done",
          },
          {
            "startSec": 33,
            "text": " and",
          },
        ],
      }
    `);
  });

  it('real/windows-asr-iG9CE55wbtY-trunc.json', () => {
    const { words, cues } = parseYouTubeJson3(readFixture('real/windows-asr-iG9CE55wbtY-trunc.json'));
    expect({ words, cues }).toMatchInlineSnapshot(`
      {
        "cues": [
          {
            "durSec": 3.88,
            "startSec": 6.26,
            "text": "[Music]",
          },
          {
            "durSec": 6.4,
            "startSec": 26.56,
            "text": "good morning",
          },
          {
            "durSec": 6.24,
            "startSec": 28.4,
            "text": "how are you it's been great hasn't it",
          },
          {
            "durSec": 5.2,
            "startSec": 32.96,
            "text": "it's been i've been blown away by the",
          },
          {
            "durSec": 3.52,
            "startSec": 34.64,
            "text": "whole thing in fact i'm leaving",
          },
          {
            "durSec": 5.521,
            "startSec": 40.399,
            "text": "um there have been three themes haven't",
          },
          {
            "durSec": 3.681,
            "startSec": 44.079,
            "text": "they running through the conference",
          },
          {
            "durSec": 3.479,
            "startSec": 45.92,
            "text": "uh which are rather relevant to what i",
          },
          {
            "durSec": 4,
            "startSec": 47.76,
            "text": "want to talk about one is the",
          },
          {
            "durSec": 3.721,
            "startSec": 49.399,
            "text": "extraordinary evidence of human",
          },
        ],
        "words": [
          {
            "durSec": 1.9200000000000017,
            "startSec": 26.72,
            "text": " morning",
          },
          {
            "durSec": 0.1999999999999993,
            "startSec": 28.64,
            "text": " are",
          },
          {
            "durSec": 1.879999999999999,
            "startSec": 28.84,
            "text": " you",
          },
          {
            "durSec": 0.16000000000000014,
            "startSec": 30.72,
            "text": " it's",
          },
          {
            "durSec": 0.15900000000000247,
            "startSec": 30.88,
            "text": " been",
          },
          {
            "durSec": 0.23999999999999844,
            "startSec": 31.039,
            "text": " great",
          },
          {
            "durSec": 0.23999999999999844,
            "startSec": 31.279,
            "text": " hasn't",
          },
          {
            "durSec": 1.6810000000000045,
            "startSec": 31.519,
            "text": " it",
          },
          {
            "durSec": 0.23999999999999488,
            "startSec": 33.2,
            "text": " been",
          },
          {
            "durSec": 0.3200000000000003,
            "startSec": 33.44,
            "text": " i've",
          },
          {
            "durSec": 0.1600000000000037,
            "startSec": 33.76,
            "text": " been",
          },
          {
            "durSec": 0.23999999999999488,
            "startSec": 33.92,
            "text": " blown",
          },
          {
            "durSec": 0.23900000000000432,
            "startSec": 34.16,
            "text": " away",
          },
          {
            "durSec": 0.1599999999999966,
            "startSec": 34.399,
            "text": " by",
          },
          {
            "durSec": 0.24099999999999966,
            "startSec": 34.559,
            "text": " the",
          },
          {
            "durSec": 0.5600000000000023,
            "startSec": 34.8,
            "text": " thing",
          },
          {
            "durSec": 0.1600000000000037,
            "startSec": 35.36,
            "text": " in",
          },
          {
            "durSec": 0.23999999999999488,
            "startSec": 35.52,
            "text": " fact",
          },
          {
            "durSec": 0.0800000000000054,
            "startSec": 35.76,
            "text": " i'm",
          },
          {
            "durSec": 6.959999999999994,
            "startSec": 35.84,
            "text": " leaving",
          },
          {
            "durSec": 0.1600000000000037,
            "startSec": 42.8,
            "text": " there",
          },
          {
            "durSec": 0.0799999999999983,
            "startSec": 42.96,
            "text": " have",
          },
          {
            "durSec": 0.240000000000002,
            "startSec": 43.04,
            "text": " been",
          },
          {
            "durSec": 0.240000000000002,
            "startSec": 43.28,
            "text": " three",
          },
          {
            "durSec": 0.3200000000000003,
            "startSec": 43.52,
            "text": " themes",
          },
          {
            "durSec": 0.3989999999999938,
            "startSec": 43.84,
            "text": " haven't",
          },
          {
            "durSec": 0.3200000000000003,
            "startSec": 44.239,
            "text": " running",
          },
          {
            "durSec": 0.1600000000000037,
            "startSec": 44.559,
            "text": " through",
          },
          {
            "durSec": 0.08099999999999596,
            "startSec": 44.719,
            "text": " the",
          },
          {
            "durSec": 1.5990000000000038,
            "startSec": 44.8,
            "text": " conference",
          },
          {
            "durSec": 0.24099999999999966,
            "startSec": 46.399,
            "text": " which",
          },
          {
            "durSec": 0.07900000000000063,
            "startSec": 46.64,
            "text": " are",
          },
          {
            "durSec": 0.40099999999999625,
            "startSec": 46.719,
            "text": " rather",
          },
          {
            "durSec": 0.3200000000000003,
            "startSec": 47.12,
            "text": " relevant",
          },
          {
            "durSec": 0.1600000000000037,
            "startSec": 47.44,
            "text": " to",
          },
          {
            "durSec": 0.0799999999999983,
            "startSec": 47.6,
            "text": " what",
          },
          {
            "durSec": 0.1600000000000037,
            "startSec": 47.68,
            "text": " i",
          },
          {
            "durSec": 0.1599999999999966,
            "startSec": 47.84,
            "text": " to",
          },
          {
            "durSec": 0.1599999999999966,
            "startSec": 48,
            "text": " talk",
          },
          {
            "durSec": 0.23900000000000432,
            "startSec": 48.16,
            "text": " about",
          },
          {
            "durSec": 0.24099999999999966,
            "startSec": 48.399,
            "text": " one",
          },
          {
            "durSec": 0.1599999999999966,
            "startSec": 48.64,
            "text": " is",
          },
          {
            "durSec": 2.0790000000000006,
            "startSec": 48.8,
            "text": " the",
          },
          {
            "durSec": 0.48100000000000165,
            "startSec": 50.879,
            "text": " evidence",
          },
          {
            "durSec": 0.0799999999999983,
            "startSec": 51.36,
            "text": " of",
          },
          {
            "startSec": 51.44,
            "text": " human",
          },
        ],
      }
    `);
  });
});

describe('schema pins — the transcript endpoint surface', () => {
  it('parseTranscriptSegments on the transcript-gated payload', () => {
    expect(parseTranscriptSegments(readFixture('synthetic/transcript-gated.json'))).toMatchInlineSnapshot(`
      [
        {
          "startSec": 0,
          "text": "alpha bravo charlie delta echo",
        },
        {
          "startSec": 3,
          "text": "foxtrot golf hotel india juliet",
        },
        {
          "startSec": 6,
          "text": "kilo lima mike november oscar",
        },
        {
          "startSec": 9,
          "text": "papa quebec romeo sierra tango",
        },
        {
          "startSec": 12,
          "text": "uniform victor whiskey xray yankee",
        },
        {
          "startSec": 15,
          "text": "zulu alpha bravo charlie delta",
        },
        {
          "startSec": 18,
          "text": "echo foxtrot golf hotel india",
        },
        {
          "startSec": 21,
          "text": "juliet kilo lima mike november",
        },
        {
          "startSec": 24,
          "text": "oscar papa quebec romeo sierra",
        },
        {
          "startSec": 27,
          "text": "tango uniform victor whiskey xray",
        },
      ]
    `);
  });

  it('getTranscriptParams finds no transcript panel in the recorded fixtures', () => {
    for (const fixture of REAL_FIXTURES) {
      expect(getTranscriptParams(readFixture(fixture)), fixture).toBeNull();
    }
  });
});

describe('schema pins — the vtt/srt parsers on the recorded fixtures', () => {
  it('parseVtt on sample.vtt', () => {
    expect(parseVtt(vttFixture('sample.vtt'), VTT_HOST)).toMatchInlineSnapshot(`
      [
        {
          "durSec": 2.5,
          "startSec": 0,
          "text": "Welcome back to the show.",
        },
        {
          "durSec": 2.5,
          "startSec": 2.5,
          "text": "Second cue with markup",
        },
        {
          "durSec": 2.25,
          "startSec": 5,
          "text": "A & B, 1 < 2 > 0 now",
        },
        {
          "durSec": 1.75,
          "startSec": 7.25,
          "text": "Last line here",
        },
      ]
    `);
  });

  it('parseVttWords on dzen-word.vtt', () => {
    expect(parseVttWords(vttFixture('dzen-word.vtt'), VTT_HOST)).toMatchInlineSnapshot(`
      [
        {
          "durSec": 0,
          "startSec": 19.225,
          "text": "С",
        },
        {
          "durSec": 0.5609999999999999,
          "startSec": 19.225,
          "text": "самого",
        },
        {
          "durSec": 0.46199999999999974,
          "startSec": 19.786,
          "text": "начала",
        },
        {
          "durSec": 0.36299999999999955,
          "startSec": 20.248,
          "text": "вы",
        },
        {
          "durSec": 0.46199999999999974,
          "startSec": 20.611,
          "text": "уже",
        },
        {
          "durSec": 0.5620000000000012,
          "startSec": 21.073,
          "text": "знаете",
        },
        {
          "durSec": 0.3619999999999983,
          "startSec": 21.635,
          "text": "что",
        },
        {
          "durSec": 0.46199999999999974,
          "startSec": 21.997,
          "text": "такое",
        },
        {
          "durSec": 0.26099999999999923,
          "startSec": 22.459,
          "text": "скорость",
        },
        {
          "durSec": 0.46199999999999974,
          "startSec": 22.72,
          "text": "и",
        },
        {
          "durSec": 0.46199999999999974,
          "startSec": 23.182,
          "text": "почему",
        },
        {
          "durSec": 0.3620000000000019,
          "startSec": 23.644,
          "text": "она",
        },
        {
          "durSec": 0.46199999999999974,
          "startSec": 24.006,
          "text": "важна",
        },
        {
          "durSec": 0.3619999999999983,
          "startSec": 24.468,
          "text": "для",
        },
        {
          "durSec": 0.5620000000000012,
          "startSec": 24.83,
          "text": "восприятия",
        },
        {
          "startSec": 25.392,
          "text": "речи",
        },
      ]
    `);
  });

  it('parseSrt on rutube.srt', () => {
    expect(parseSrt(vttFixture('rutube.srt'), VTT_HOST)).toMatchInlineSnapshot(`
      [
        {
          "durSec": 3.5,
          "startSec": 1,
          "text": "Это первая реплика",
        },
        {
          "durSec": 3.5,
          "startSec": 4.5,
          "text": "А это вторая реплика",
        },
        {
          "durSec": 4,
          "startSec": 8,
          "text": "И третья реплика финальная",
        },
      ]
    `);
  });
});
