import { describe, expect, it } from 'vitest';
import { ModelStore, verifyChecksum, type ModelDb } from '../lib/model-store';

// In-memory ModelDb stand-in: fake-indexeddb is not a devDependency, so the
// atomicity logic is exercised against the same narrow interface the real
// IndexedDB backend implements (indexedDbModels).
function mockModels(): ModelDb {
  const data = new Map<string, Blob>();
  return {
    async get(key) {
      return data.get(key);
    },
    async count(key) {
      return data.has(key) ? 1 : 0;
    },
    async put(value, key) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
    async keys() {
      return [...data.keys()];
    },
  };
}

function blobOf(bytes: number[]): Blob {
  return new Blob([Uint8Array.from(bytes)]);
}

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('verifyChecksum', () => {
  it('accepts the sha-256 hex of the blob and rejects anything else', async () => {
    const blob = blobOf([1, 2, 3, 4]);
    const hex = await sha256Hex(blob);
    expect(await verifyChecksum(blob, hex)).toBe(true);
    expect(await verifyChecksum(blob, `${hex.slice(0, -1)}0`)).toBe(false);
    expect(await verifyChecksum(blobOf([1, 2, 3, 5]), hex)).toBe(false);
  });
});

describe('ModelStore', () => {
  it('round-trips a stored model under name@version', async () => {
    const db = mockModels();
    const store = new ModelStore(db);
    const blob = blobOf([1, 2, 3]);
    await store.storeModel('whisper', 'tiny', blob, await sha256Hex(blob));
    expect(await store.hasModel('whisper', 'tiny')).toBe(true);
    expect(await store.getModel('whisper', 'tiny')).toEqual(blob);
    expect(await db.keys()).toEqual(['whisper@tiny']);
  });

  it('keeps versions of the same model on separate keys', async () => {
    const store = new ModelStore(mockModels());
    const v1 = blobOf([1]);
    const v2 = blobOf([2]);
    await store.storeModel('whisper', '1', v1, await sha256Hex(v1));
    await store.storeModel('whisper', '2', v2, await sha256Hex(v2));
    expect(await store.getModel('whisper', '1')).toEqual(v1);
    expect(await store.getModel('whisper', '2')).toEqual(v2);
  });

  it('reports a missing model as null/false', async () => {
    const store = new ModelStore(mockModels());
    expect(await store.hasModel('whisper', 'tiny')).toBe(false);
    expect(await store.getModel('whisper', 'tiny')).toBeNull();
  });

  it('rejects a wrong checksum and leaves no final or temp entry', async () => {
    const db = mockModels();
    const store = new ModelStore(db);
    await expect(
      store.storeModel('whisper', 'tiny', blobOf([1, 2, 3]), 'deadbeef'),
    ).rejects.toThrow('checksum mismatch for whisper@tiny');
    expect(await store.hasModel('whisper', 'tiny')).toBe(false);
    expect(await db.keys()).toEqual([]);
  });

  it('commits directly when no checksum is given', async () => {
    const db = mockModels();
    const store = new ModelStore(db);
    await store.storeModel('whisper', 'tiny', blobOf([1, 2, 3]));
    expect(await db.keys()).toEqual(['whisper@tiny']);
  });

  it('deletes the temp entry when the commit write fails', async () => {
    const data = new Map<string, Blob>();
    let puts = 0;
    const db: ModelDb = {
      async get(key) {
        return data.get(key);
      },
      async count(key) {
        return data.has(key) ? 1 : 0;
      },
      async put(value, key) {
        puts += 1;
        if (puts > 1) throw new Error('commit write failed');
        data.set(key, value);
      },
      async delete(key) {
        data.delete(key);
      },
      async keys() {
        return [...data.keys()];
      },
    };
    const store = new ModelStore(db);
    await expect(store.storeModel('whisper', 'tiny', blobOf([1, 2, 3]))).rejects.toThrow(
      'commit write failed',
    );
    expect(await db.keys()).toEqual([]);
  });

  it('deleteModel removes every version of that model only', async () => {
    const db = mockModels();
    const store = new ModelStore(db);
    const whisper = blobOf([1]);
    const audio = blobOf([2]);
    await store.storeModel('whisper', '1', whisper, await sha256Hex(whisper));
    await store.storeModel('whisper', '2', whisper, await sha256Hex(whisper));
    await store.storeModel('audio', '1', audio, await sha256Hex(audio));
    await store.deleteModel('whisper');
    expect(await db.keys()).toEqual(['audio@1']);
    expect(await store.getModel('audio', '1')).toEqual(audio);
  });
});
