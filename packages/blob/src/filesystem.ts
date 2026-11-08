import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  statfs,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  assertValidBlob,
  type BlobCapacity,
  BlobError,
  type BlobIdentity,
  type BlobLifecycle,
  type BlobScanPage,
  type BlobSettlement,
  type BlobWrite,
  digestFromKey,
  type PrivateBlobStore,
  type RecoverOptions,
  storageKeyFor,
} from "./contracts.ts";
import { detectedImageMime } from "./image.ts";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const PENDING_DIRECTORY = ".pending";

async function syncDir(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pendingDirectory(root: string) {
  const base = resolve(root);
  await mkdir(base, { recursive: true, mode: 0o700 });
  if ((await realpath(base)) !== base)
    throw new BlobError("invalid", "Invalid attachment root");
  const pending = join(base, PENDING_DIRECTORY);
  await mkdir(pending, { mode: 0o700, recursive: true });
  if ((await realpath(pending)) !== pending)
    throw new BlobError("invalid", "Invalid pending directory");
  return pending;
}

async function stage(root: string, blob: BlobIdentity) {
  assertValidBlob(blob);
  const dir = await pendingDirectory(root);
  const temp = join(dir, `.${blob.sha256}.${randomUUID()}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ ...blob, createdAt: Date.now() }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, join(dir, `${blob.sha256}.json`));
  await syncDir(dir);
  await syncDir(resolve(root));
}

async function clear(root: string, blob: BlobIdentity) {
  const dir = await pendingDirectory(root);
  try {
    await unlink(join(dir, `${blob.sha256}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await syncDir(dir);
}

async function recoverPending(
  root: string,
  settle: BlobSettlement,
  options: RecoverOptions,
): Promise<number> {
  const dir = join(resolve(root), PENDING_DIRECTORY);
  try {
    if (
      (await realpath(resolve(root))) !== resolve(root) ||
      (await realpath(dir)) !== dir
    )
      throw new BlobError("invalid", "Invalid pending root");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (count >= (options.limit ?? 100)) break;
    if (!entry.isFile() || !/^([a-f0-9]{64})\.json$/.test(entry.name)) continue;
    const handle = await open(join(dir, entry.name), "r");
    let record: BlobIdentity & { createdAt: number };
    try {
      if ((await handle.stat()).size > 4096) continue;
      record = JSON.parse(await handle.readFile("utf8"));
    } catch {
      continue;
    } finally {
      await handle.close();
    }
    if (
      !record ||
      record.storageKey !== storageKeyFor(record.sha256) ||
      entry.name !== `${record.sha256}.json` ||
      !Number.isFinite(record.createdAt) ||
      record.createdAt >
        (options.now ?? Date.now()) - (options.minimumAgeMs ?? 3600000)
    )
      continue;
    try {
      await settle(record, () => clear(root, record));
      count++;
    } catch {
      console.warn(JSON.stringify({ event: "private-blob-recovery-pending" }));
    }
  }
  return count;
}

async function readAt(root: string, key: string, maxBytes: number) {
  if (!digestFromKey(key)) return null;
  try {
    const base = await realpath(root);
    const file = resolve(base, key);
    if (!(await realpath(dirname(file))).startsWith(`${base}${sep}`))
      return null;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) return null;
      const bytes = await handle.readFile();
      // Return the contract type, not a Buffer subclass.
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function eraseAt(
  root: string,
  key: string,
  sha256: string,
  maxBytes: number,
) {
  const digest = digestFromKey(key);
  if (!digest || digest !== sha256)
    throw new BlobError("invalid", "Invalid erasure identity");
  const base = await realpath(root);
  if (base !== resolve(root))
    throw new BlobError("invalid", "Attachment root must not be a symlink");
  const file = resolve(base, key);
  try {
    if (!(await realpath(dirname(file))).startsWith(`${base}${sep}`))
      throw new BlobError("invalid", "Invalid erasure directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (handle) {
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes)
        throw new BlobError("corrupt", "Invalid erasure file");
      const bytes = await handle.readFile();
      if (createHash("sha256").update(bytes).digest("hex") !== sha256)
        throw new BlobError("corrupt", "Erasure digest mismatch");
    } finally {
      await handle.close();
    }
    await unlink(file);
  }
  const directory = dirname(file);
  const entries = await readdir(directory).catch(() => [] as string[]);
  for (const entry of entries) {
    if (
      !entry.startsWith(`.${sha256}.`) ||
      !/^\.[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(entry)
    )
      continue;
    const temp = resolve(directory, entry);
    if ((await lstat(temp)).isFile()) await unlink(temp);
  }
  await syncDir(directory);
}

export interface FilesystemBlobStoreOptions {
  root: string;
  maxBytes?: number;
}

/**
 * Private bytes on a local volume with digest keys.
 *
 * `probe()` is the only place that creates the root, so a misconfigured volume
 * fails at startup rather than on the first upload.
 */
export function createFilesystemBlobStore(
  options: FilesystemBlobStoreOptions,
): PrivateBlobStore {
  const root = resolve(options.root);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const lifecycle: BlobLifecycle = {
    async begin(blob) {
      await stage(root, blob);
    },
    async end(blob) {
      try {
        await clear(root, blob);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
    async scan(cursor, limit) {
      const entries: BlobScanPage["entries"] = [];
      const start = cursor ? Number.parseInt(cursor, 10) : 0;
      if (!Number.isSafeInteger(start) || start < 0)
        throw new BlobError("invalid", "Invalid scan cursor");
      const buckets = await readdir(root, { withFileTypes: true });
      const directories = buckets
        .filter(
          (entry) => entry.isDirectory() && /^[a-f0-9]{2}$/.test(entry.name),
        )
        .map((entry) => entry.name)
        .sort();
      let index = start;
      for (; index < directories.length; index++) {
        if (entries.length >= limit) break;
        const directory = directories[index] as string;
        for (const entry of await readdir(join(root, directory))) {
          const key = `${directory}/${entry}`;
          if (!digestFromKey(key)) continue;
          const stat = await lstat(join(root, key)).catch(() => null);
          if (!stat?.isFile()) continue;
          entries.push({
            storageKey: key,
            sha256: entry,
            updatedAt: stat.mtime,
          });
          if (entries.length >= limit) break;
        }
      }
      return {
        entries,
        cursor: index < directories.length ? String(index) : null,
      };
    },
    async recover(settle, options = {}) {
      return recoverPending(root, settle, options);
    },
    async close() {},
  };

  return {
    backend: "filesystem",
    lifecycle,
    async put(bytes) {
      const data = Buffer.from(bytes);
      if (data.length === 0 || data.length > maxBytes)
        throw new BlobError("invalid", "Attachment size is invalid");
      const detected = detectedImageMime(data);
      if (!detected)
        throw new BlobError("invalid", "Unsupported image content");
      await mkdir(root, { recursive: true, mode: 0o700 });
      const capacity = await statfs(root);
      if (capacity.bavail * capacity.bsize < maxBytes * 2)
        throw new BlobError("quota", "Attachment storage is full");
      const actualRoot = await realpath(root);
      if (actualRoot !== root)
        throw new BlobError("invalid", "Attachment root must not be a symlink");
      const digest = createHash("sha256").update(data).digest("hex");
      const storageKey = storageKeyFor(digest);
      const destination = resolve(root, storageKey);
      if (!destination.startsWith(`${root}${sep}`))
        throw new BlobError("invalid", "Invalid storage key");
      await mkdir(join(root, digest.slice(0, 2)), {
        recursive: true,
        mode: 0o700,
      });
      const directory = await realpath(join(root, digest.slice(0, 2)));
      if (!directory.startsWith(`${root}${sep}`))
        throw new BlobError("invalid", "Attachment directory escapes root");
      const tempPath = join(directory, `.${digest}.${randomUUID()}.tmp`);
      const handle = await open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } catch (error) {
        await unlink(tempPath).catch(() => {});
        throw error;
      } finally {
        await handle.close();
      }
      try {
        await rename(tempPath, destination);
      } catch (error) {
        await unlink(tempPath).catch(() => {});
        throw error;
      }
      for (const path of [directory, root]) await syncDir(path);
      return {
        storageKey,
        sha256: digest,
        mimeType: detected,
        bytes: data.length,
      } satisfies BlobWrite;
    },
    async read(key) {
      return readAt(root, key, maxBytes);
    },
    async erase(key, sha256) {
      await eraseAt(root, key, sha256, maxBytes);
    },
    async capacity(): Promise<BlobCapacity> {
      try {
        const disk = await statfs(root, { bigint: true });
        const bytes = disk.bavail * disk.bsize;
        return {
          availableBytes:
            bytes <= BigInt(Number.MAX_SAFE_INTEGER)
              ? Number(bytes)
              : Number.MAX_SAFE_INTEGER,
        };
      } catch {
        return { availableBytes: null };
      }
    },
    async probe() {
      await mkdir(root, { recursive: true, mode: 0o700 });
      if ((await realpath(root)) !== root)
        throw new BlobError("invalid", "Attachment root must not be a symlink");
      const capacity = await statfs(root);
      if (capacity.bavail * capacity.bsize < maxBytes * 2)
        throw new BlobError("quota", "Attachment storage is full");
    },
  };
}

/** Compatibility helper for tests and local inspection; never use in a request path. */
export function readFilesystemBlob(
  root: string,
  key: string,
  maxBytes = DEFAULT_MAX_BYTES,
) {
  return readAt(resolve(root), key, maxBytes);
}

/** Compatibility helper for tests and local inspection; never use in a request path. */
export function eraseFilesystemBlob(
  root: string,
  key: string,
  sha256: string,
  maxBytes = DEFAULT_MAX_BYTES,
) {
  return eraseAt(resolve(root), key, sha256, maxBytes);
}
