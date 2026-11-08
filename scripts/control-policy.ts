import type { Lane, State } from "./supervisor.ts";

const lanes = ["A", "B", "C", "D", "E", "F", "R", "V"];
export interface Control {
  action: string;
  lane?: Lane;
  at?: string;
  text?: string;
}
export function control(value: unknown): Control {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { action: "invalid" };
  const c = value as Record<string, unknown>;
  if (
    typeof c.action !== "string" ||
    !["pause", "resume", "retry", "nudge", "stop", "rollout"].includes(c.action)
  )
    return { action: "invalid" };
  if (
    !["stop", "rollout"].includes(c.action) &&
    !lanes.includes(c.lane as string)
  )
    return { action: "invalid" };
  if (
    c.text !== undefined &&
    (typeof c.text !== "string" || c.text.length > 32768)
  )
    return { action: "invalid" };
  if (
    c.at !== undefined &&
    (typeof c.at !== "string" || !Number.isFinite(Date.parse(c.at)))
  )
    return { action: "invalid" };
  return {
    action: c.action,
    ...(typeof c.lane === "string" ? { lane: c.lane as Lane } : {}),
    ...(typeof c.text === "string" ? { text: c.text } : {}),
    ...(typeof c.at === "string" ? { at: c.at } : {}),
  };
}
export function validState(value: unknown): value is State {
  if (!value || typeof value !== "object") return false;
  const s = value as State;
  if (
    s.version !== 1 ||
    !s.records ||
    typeof s.records !== "object" ||
    Array.isArray(s.records) ||
    !Array.isArray(s.held) ||
    s.held.some((l) => !lanes.includes(l)) ||
    !Array.isArray(s.commands) ||
    !s.commands.every((x) => typeof x === "string") ||
    !s.notices ||
    typeof s.notices !== "object"
  )
    return false;
  for (const [key, r] of Object.entries(s.records))
    if (
      !r ||
      r.key !== key ||
      !lanes.includes(r.lane) ||
      !["running", "idle", "paused"].includes(r.status) ||
      typeof r.cwd !== "string" ||
      !Array.isArray(r.seen) ||
      !r.seen.every((x) => typeof x === "string") ||
      !Array.isArray(r.runs) ||
      !r.runs.every((n) => Number.isSafeInteger(n) && n >= 0) ||
      ![r.noProgress, r.inputTokens, r.outputTokens].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      )
    )
      return false;
  return Object.entries(s.notices).every(
    ([l, notes]) =>
      lanes.includes(l) &&
      Array.isArray(notes) &&
      notes.length <= 100 &&
      notes.every((n) => typeof n === "string" && n.length <= 32768),
  );
}
