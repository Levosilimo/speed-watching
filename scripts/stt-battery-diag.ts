// Throwaway seam diagnostic: dump hyp chunks + ref words around the seam.
import { loadClipRef, runInference, startServer } from './stt-battery-lib';
import type { Server } from 'node:http';

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const clipId = process.argv[2] ?? 'jGwO_UgTS7I';
const model = process.argv[3] ?? 'Xenova/whisper-base.en';
const chunkS = process.argv[4] === undefined ? 29 : Number(process.argv[4]);
const strideS = process.argv[5] === undefined ? 5 : Number(process.argv[5]);

async function main(): Promise<void> {
  const server = await startServer();
  try {
    let refWords: Array<{ text: string; startSec: number }> = [];
    try {
      const ref = loadClipRef(clipId);
      refWords = ref.words.map((w) => ({ text: w.text, startSec: w.startSec - ref.window.startSec }));
    } catch {
      console.log('--- no clip ref for', clipId);
    }
    const cfg = { chunkLengthS: chunkS, strideLengthS: strideS, forceFull: false };
    const result = await runInference(model, [clipId], cfg);
    const c = result.clips?.[0];
    if (!c) {
      console.error('no clip', result);
      return;
    }
    console.log('--- clipError:', c.clipError, 'words:', JSON.stringify(c.words?.slice(0, 200)));
    console.log('--- hyp chunks (24-40s):');
    for (const ch of c.chunks.filter((x) => x.start >= 22 && x.start <= 40)) {
      console.log(`  [${ch.start.toFixed(2)}-${ch.end.toFixed(2)}] ${JSON.stringify(ch.text)}`);
    }
    console.log('--- ref words (24-40s):');
    for (const w of refWords.filter((x) => x.startSec >= 24 && x.startSec <= 40)) {
      console.log(`  [${w.startSec.toFixed(2)}] ${JSON.stringify(w.text)}`);
    }
    console.log('--- hyp chunks (0-10s):');
    for (const ch of c.chunks.filter((x) => x.start <= 10)) {
      console.log(`  [${ch.start.toFixed(2)}-${ch.end.toFixed(2)}] ${JSON.stringify(ch.text)}`);
    }
    console.log('--- ref words (0-10s):');
    for (const w of refWords.filter((x) => x.startSec <= 10)) {
      console.log(`  [${w.startSec.toFixed(2)}] ${JSON.stringify(w.text)}`);
    }
    const firsts = c.chunks.slice(0, 12);
    console.log('--- first 12 hyp chunks:');
    for (const ch of firsts) console.log(`  [${ch.start.toFixed(2)}-${ch.end.toFixed(2)}] ${JSON.stringify(ch.text)}`);
  } finally {
    await closeServer(server);
  }
}

await main();
