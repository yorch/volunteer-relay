import type { BlobMimeType } from "./contracts.ts";

type Signature = {
  mime: BlobMimeType;
  check: (bytes: Uint8Array) => boolean;
};

const signatures: Signature[] = [
  {
    mime: "image/png",
    check: (b) =>
      b.length >= 8 &&
      b[0] === 137 &&
      b[1] === 80 &&
      b[2] === 78 &&
      b[3] === 71 &&
      b[4] === 13 &&
      b[5] === 10 &&
      b[6] === 26 &&
      b[7] === 10,
  },
  {
    mime: "image/jpeg",
    check: (b) =>
      b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: "image/webp",
    check: (b) =>
      b.length >= 12 &&
      String.fromCharCode(...Array.from(b.subarray(0, 4))) === "RIFF" &&
      String.fromCharCode(...Array.from(b.subarray(8, 12))) === "WEBP",
  },
];

/** Content sniffing only; callers still decode and re-encode before storage. */
export function detectedImageMime(bytes: Uint8Array): BlobMimeType | null {
  return signatures.find((entry) => entry.check(bytes))?.mime ?? null;
}
