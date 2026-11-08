import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
export interface BlobIdentity {
  storageKey: string;
  sha256: string;
}
export type BlobSettlement = (
  blob: BlobIdentity,
  onSettled: () => Promise<void>,
) => Promise<unknown>;
function valid(blob: BlobIdentity) {
  return (
    /^[a-f0-9]{64}$/.test(blob.sha256) &&
    blob.storageKey === `${blob.sha256.slice(0, 2)}/${blob.sha256}`
  );
}
async function pendingDirectory(root: string) {
  const base = resolve(root);
  await mkdir(base, { recursive: true, mode: 0o700 });
  if ((await realpath(base)) !== base)
    throw new Error("Invalid attachment root");
  const pending = join(base, ".pending");
  await mkdir(pending, { mode: 0o700, recursive: true });
  if ((await realpath(pending)) !== pending)
    throw new Error("Invalid pending directory");
  return pending;
}
async function syncDir(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function stage(root: string, blob: BlobIdentity) {
  if (!valid(blob)) throw new Error("Invalid pending blob");
  const dir = await pendingDirectory(root),
    temp = join(dir, `.${blob.sha256}.${randomUUID()}.tmp`);
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
/** note must run under the intake advisory lock before writing bytes. */
export async function withTrackedBlobWrites<T>(
  root: string,
  work: (note: (blob: BlobIdentity) => Promise<void>) => Promise<T>,
  settle: BlobSettlement,
): Promise<T> {
  const touched = new Map<string, BlobIdentity>();
  try {
    return await work(async (blob) => {
      touched.set(blob.storageKey, blob);
      await stage(root, blob);
    });
  } finally {
    for (const blob of [...touched.values()].sort((a, b) =>
      a.storageKey.localeCompare(b.storageKey),
    )) {
      try {
        await settle(blob, () => clear(root, blob));
      } catch {
        console.warn(JSON.stringify({ event: "private-blob-cleanup-pending" }));
      }
    }
  }
}
/** Recovers only persisted write intents, never scans arbitrary user files. */
export async function recoverPendingBlobWrites(
  root: string,
  settle: BlobSettlement,
  options: { now?: number; minimumAgeMs?: number; limit?: number } = {},
): Promise<number> {
  const dir = join(resolve(root), ".pending");
  try {
    if (
      (await realpath(resolve(root))) !== resolve(root) ||
      (await realpath(dir)) !== dir
    )
      throw new Error("Invalid pending root");
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
      !valid(record) ||
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
