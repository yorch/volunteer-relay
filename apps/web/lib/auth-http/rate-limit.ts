import { createHash } from "node:crypto";

export interface RateRule {
  limit: number;
  windowMs: number;
}

export interface RateLimiter {
  /** Seconds until `key` may be used again, or null when it is under `rule`. */
  blocked(key: string, rule: RateRule): number | null;
  /** Counts one use of `key` in its current fixed window. */
  hit(key: string, rule: RateRule): void;
  /** Returns one counted use, e.g. after a successful sign-in. */
  release(key: string): void;
}

export interface RateLimiterOptions {
  // Bounds memory under key flooding; the oldest windows are evicted first.
  maxKeys?: number;
  now?: () => number;
}

/**
 * In-memory fixed-window counters for one web process. The production profile
 * runs a single web replica; a horizontally scaled deployment needs a shared
 * store instead, or each replica enforces its own budget.
 */
export function createRateLimiter({
  maxKeys = 10_000,
  now = Date.now,
}: RateLimiterOptions = {}): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  function current(key: string) {
    const entry = windows.get(key);
    if (entry && entry.resetAt <= now()) {
      windows.delete(key);
      return undefined;
    }
    return entry;
  }
  function makeRoom() {
    if (windows.size < maxKeys) return;
    const at = now();
    for (const [key, entry] of windows)
      if (entry.resetAt <= at) windows.delete(key);
    // Map iteration is insertion order: drop the oldest windows first.
    for (const key of windows.keys()) {
      if (windows.size < maxKeys) break;
      windows.delete(key);
    }
  }
  return {
    blocked(key, rule) {
      const entry = current(key);
      if (!entry || entry.count < rule.limit) return null;
      return Math.max(1, Math.ceil((entry.resetAt - now()) / 1000));
    },
    hit(key, rule) {
      const entry = current(key);
      if (entry) {
        entry.count += 1;
        return;
      }
      makeRoom();
      windows.set(key, { count: 1, resetAt: now() + rule.windowMs });
    },
    release(key) {
      const entry = current(key);
      if (entry && entry.count > 0) entry.count -= 1;
    },
  };
}

/**
 * Client address for rate limiting only, never for authorization.
 *
 * Trusted-proxy assumption: the production web container publishes no ports
 * and is reachable only through the host Traefik, which sets X-Forwarded-For.
 * The right-most entry is the peer address Traefik itself observed, so a
 * client cannot spoof it by sending its own header (any left-hand entries are
 * client-controlled and ignored). If another proxy or CDN is placed in front
 * of Traefik, this becomes that proxy's address and per-address limits get
 * coarser; per-account limits still apply. Without the header (local
 * development) every request shares one bucket.
 */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const last = forwarded?.split(",").at(-1)?.trim();
  if (last && last.length <= 64 && /^[0-9A-Fa-f:.[\]]+$/.test(last))
    return last;
  return "unknown";
}

/** Account key without retaining the address in memory as plaintext. */
export function accountKey(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}
