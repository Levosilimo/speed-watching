// Tone-fixture server for the audio-invocation spike probe: serves the page
// that plays the WebAudio tone. Same local-only pattern as e2e/server.ts.
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const toneHtml = readFileSync(join(here, 'tone.html'), 'utf8');

export function createToneServer(port = 4321): Promise<{ baseUrl: string; close(): Promise<void> }> {
  let actualPort = port;
  const server: Server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/tone') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(toneHtml);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      actualPort = (server.address() as { port: number }).port;
      resolve({
        baseUrl: `http://127.0.0.1:${actualPort}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (import.meta.main) {
  const server = await createToneServer();
  console.log(`tone server on ${server.baseUrl}`);
}
