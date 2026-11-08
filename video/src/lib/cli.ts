import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Small CLI runtime shared by the video scripts. */

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  let index = 0;
  while (index < argv.length) {
    const argument = argv[index];
    index += 1;
    if (argument === undefined) break;
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const body = argument.slice(2);
    const equals = body.indexOf("=");
    if (equals !== -1) {
      flags[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    const next = argv[index];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      index += 1; // a flag value is never also a positional
      continue;
    }
    flags[body] = true;
  }
  return { positional, flags };
}

export function flag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags[name] !== undefined;
}

export function requireNode26(): void {
  if (process.versions.node !== "26.11.1")
    throw new Error(
      `Use Node 26.11.1 for video tooling; got ${process.versions.node}`,
    );
}

export function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Binary artifact (providers return audio bytes; never pass them as text). */
export function writePrivateBytes(path: string, bytes: Uint8Array): void {
  ensureDir(dirname(path));
  writeFileSync(path, bytes, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Filesystems without POSIX modes still get the explicit 0600 request.
  }
}

/** Auth state, alignment and env writes stay owner-only where supported. */
export function writePrivate(path: string, contents: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Filesystems without POSIX modes still get the explicit 0600 request.
  }
}

export function gitCommit(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

export function gitIgnored(cwd: string, path: string): boolean {
  const result = spawnSync("git", ["check-ignore", "-q", path], { cwd });
  return result.status === 0;
}

export function commandExists(command: string): boolean {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  return result.status === 0;
}

export interface Step {
  name: string;
  status: "ok" | "warn" | "blocked" | "skipped";
  detail: string;
}

export class Report {
  private readonly steps: Step[] = [];
  add(step: Step): void {
    this.steps.push(step);
    const symbol =
      step.status === "ok"
        ? "PASS"
        : step.status === "warn"
          ? "WARN"
          : step.status === "blocked"
            ? "BLOCK"
            : "SKIP";
    log(`[${symbol}] ${step.name}: ${step.detail}`);
  }
  blocked(): Step[] {
    return this.steps.filter((step) => step.status === "blocked");
  }
  summary(): string {
    const counts = { ok: 0, warn: 0, blocked: 0, skipped: 0 };
    for (const step of this.steps) counts[step.status] += 1;
    return `${counts.ok} ok, ${counts.warn} warnings, ${counts.blocked} blockers, ${counts.skipped} skipped`;
  }
}

export function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

export function runOrThrow(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const result = run(command, args, options);
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr.trim()}`,
    );
  return result.stdout;
}
