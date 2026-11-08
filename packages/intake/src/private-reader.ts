import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
/** Read digest-keyed private bytes; no caller-controlled filesystem paths. */
export async function readPrivateBlob(
  root: string,
  key: string,
): Promise<Uint8Array | null> {
  if (!/^[a-f0-9]{2}\/[a-f0-9]{64}$/.test(key)) return null;
  try {
    const base = await realpath(root);
    const file = resolve(base, key);
    if (!(await realpath(dirname(file))).startsWith(`${base}${sep}`))
      return null;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      return stat.isFile() && stat.size <= 10485760
        ? await handle.readFile()
        : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Called only while the durable erasure job holds the shared database key lock. */
export async function erasePrivateBlob(
  root: string,
  key: string,
  sha256: string,
): Promise<void> {
  if (
    !/^[a-f0-9]{64}$/.test(sha256) ||
    key !== `${sha256.slice(0, 2)}/${sha256}`
  )
    throw new Error("Invalid erasure identity");
  const base = await realpath(root);
  if (base !== resolve(root))
    throw new Error("Attachment root must not be a symlink");
  const file = resolve(base, key);
  try {
    if (!(await realpath(dirname(file))).startsWith(`${base}${sep}`))
      throw new Error("Invalid erasure directory");
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
      if (!stat.isFile() || stat.size > 10485760)
        throw new Error("Invalid erasure file");
      const bytes = await handle.readFile();
      if (createHash("sha256").update(bytes).digest("hex") !== sha256)
        throw new Error("Erasure digest mismatch");
    } finally {
      await handle.close();
    }
    await unlink(file);
  }
  const directory = dirname(file);
  for (const entry of await readdir(directory)) {
    if (
      !entry.startsWith(`.${sha256}.`) ||
      !/^\.[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(entry)
    )
      continue;
    const temp = resolve(directory, entry);
    if ((await lstat(temp)).isFile()) await unlink(temp);
  }
  const synced = await open(directory, "r");
  try {
    await synced.sync();
  } finally {
    await synced.close();
  }
}
