// STT model weights live in IndexedDB, not chrome.storage.local (hard 10 MB
// cap). One database 'speedwatcher', one object store 'models', keys
// 'name@version'. storeModel writes the blob to a temp key, verifies the
// sha-256 checksum, then commits under the final key; any failure deletes
// the temp entry, so a version is either fully stored or absent. The
// unlimitedStorage permission is a future manifest change, not this module's.

export const MODEL_DB_NAME = 'speedwatcher';
export const MODEL_STORE_NAME = 'models';

const TEMP_KEY_SUFFIX = '.tmp';

/** Minimal object-store surface; tests inject an in-memory mock. */
export interface ModelDb {
  get(key: string): Promise<Blob | undefined>;
  count(key: string): Promise<number>;
  put(value: Blob, key: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export async function verifyChecksum(blob: Blob, expected: string): Promise<boolean> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex === expected;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MODEL_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(MODEL_STORE_NAME)) {
        request.result.createObjectStore(MODEL_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
  });
}

/** Real IndexedDB backend; the connection is opened lazily and reused. */
export function indexedDbModels(): ModelDb {
  let dbPromise: Promise<IDBDatabase> | undefined;
  const db = () => (dbPromise ??= openDb());
  const objectStore = async (mode: IDBTransactionMode) =>
    (await db()).transaction(MODEL_STORE_NAME, mode).objectStore(MODEL_STORE_NAME);
  return {
    async get(key) {
      const value = await requestResult((await objectStore('readonly')).get(key));
      return value instanceof Blob ? value : undefined;
    },
    async count(key) {
      return await requestResult((await objectStore('readonly')).count(key));
    },
    async put(value, key) {
      await requestResult((await objectStore('readwrite')).put(value, key));
    },
    async delete(key) {
      await requestResult((await objectStore('readwrite')).delete(key));
    },
    async keys() {
      return (await requestResult((await objectStore('readonly')).getAllKeys())) as string[];
    },
  };
}

export class ModelStore {
  constructor(private readonly db: ModelDb = indexedDbModels()) {}

  async storeModel(name: string, version: string, blob: Blob, checksum?: string): Promise<void> {
    const finalKey = `${name}@${version}`;
    const tempKey = `${finalKey}${TEMP_KEY_SUFFIX}`;
    await this.db.put(blob, tempKey);
    try {
      if (checksum !== undefined && !(await verifyChecksum(blob, checksum))) {
        throw new Error(`checksum mismatch for ${finalKey}`);
      }
      await this.db.put(blob, finalKey);
    } finally {
      await this.db.delete(tempKey);
    }
  }

  async getModel(name: string, version: string): Promise<Blob | null> {
    return (await this.db.get(`${name}@${version}`)) ?? null;
  }

  async hasModel(name: string, version: string): Promise<boolean> {
    return (await this.db.count(`${name}@${version}`)) > 0;
  }

  /** Removes every stored version and pending temp entry of the model. */
  async deleteModel(name: string): Promise<void> {
    const prefix = `${name}@`;
    for (const key of await this.db.keys()) {
      if (key.startsWith(prefix)) await this.db.delete(key);
    }
  }
}
