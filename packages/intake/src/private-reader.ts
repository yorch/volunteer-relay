import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
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
