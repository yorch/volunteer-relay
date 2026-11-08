import type { VideoEnv } from "./env.ts";

/**
 * Capture-target guard. Hosted capture is the default; a local rehearsal target
 * must be requested explicitly. Credentials are only ever submitted to the
 * exact allowed origin, so an unexpected redirect can never leak a password.
 */

export type TargetMode = "hosted" | "local";
export type CaptureOrigin = "hosted" | "local";

export interface CaptureTarget {
  mode: TargetMode;
  baseUrl: string;
  allowedOrigin: string;
  /** Label written into every capture artifact and readiness report. */
  originLabel: CaptureOrigin;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname) || hostname.endsWith(".localhost");
}

export function resolveTarget(env: VideoEnv): CaptureTarget {
  const rawMode = (env.VIDEO_TARGET_MODE ?? "hosted").trim();
  if (rawMode !== "hosted" && rawMode !== "local")
    throw new Error(
      `VIDEO_TARGET_MODE must be "hosted" or "local", got ${JSON.stringify(rawMode)}`,
    );
  const baseUrlValue = env.VIDEO_BASE_URL?.trim();
  if (!baseUrlValue)
    throw new Error(
      "VIDEO_BASE_URL is required. Hosted capture defaults to https://volunteer-relay.brnby.com.",
    );
  let base: URL;
  try {
    base = new URL(baseUrlValue);
  } catch {
    throw new Error("VIDEO_BASE_URL must be an absolute URL");
  }
  if (base.pathname !== "/" || base.search || base.hash)
    throw new Error("VIDEO_BASE_URL must be an origin without a path");
  const allowedValue = env.VIDEO_ALLOWED_ORIGIN?.trim();
  if (!allowedValue)
    throw new Error(
      "VIDEO_ALLOWED_ORIGIN must repeat the exact origin that may receive credentials",
    );
  let allowed: URL;
  try {
    allowed = new URL(allowedValue);
  } catch {
    throw new Error("VIDEO_ALLOWED_ORIGIN must be an absolute URL");
  }
  if (allowed.origin !== allowedValue)
    throw new Error("VIDEO_ALLOWED_ORIGIN must be a bare origin");
  if (allowed.origin !== base.origin)
    throw new Error(
      `VIDEO_ALLOWED_ORIGIN (${allowed.origin}) must equal the VIDEO_BASE_URL origin (${base.origin})`,
    );

  if (rawMode === "hosted") {
    if (base.protocol !== "https:")
      throw new Error("Hosted capture must use https; TLS is never disabled");
    if (isLoopbackHost(base.hostname))
      throw new Error(
        "Hosted mode cannot target a loopback host. Use VIDEO_TARGET_MODE=local for a rehearsal.",
      );
    return {
      mode: "hosted",
      baseUrl: base.origin,
      allowedOrigin: allowed.origin,
      originLabel: "hosted",
    };
  }

  if (!isLoopbackHost(base.hostname))
    throw new Error(
      "Local mode is a rehearsal target only and must use a loopback host",
    );
  if (base.protocol !== "http:" && base.protocol !== "https:")
    throw new Error("Local rehearsal target must be http or https");
  return {
    mode: "local",
    baseUrl: base.origin,
    allowedOrigin: allowed.origin,
    originLabel: "local",
  };
}

/**
 * Refuse to submit credentials to anything but the configured origin. Called on
 * every navigation that precedes a sign-in form.
 */
export function assertOriginAllowed(url: string, allowedOrigin: string): URL {
  const parsed = new URL(url);
  if (parsed.origin !== allowedOrigin)
    throw new Error(
      `Refusing to reach ${parsed.origin}; the allowed origin is ${allowedOrigin}`,
    );
  return parsed;
}
