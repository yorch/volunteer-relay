import { AsyncLocalStorage } from "node:async_hooks";

export type MailKind = "reset" | "invitation" | "verification";

export interface MailDeliveryOutcome<T> {
  value: T;
  // Kinds whose transport failed during this call only. No recipient, token
  // or transport detail is recorded.
  failed: ReadonlySet<MailKind>;
}

// Each tracked call owns its own failure set through async context, so
// concurrent requests can never observe one another's delivery failures.
const scope = new AsyncLocalStorage<Set<MailKind>>();

/**
 * Runs one auth operation and reports which mail deliveries failed inside it.
 * Better Auth awaits its mail callbacks (no background-task handler is
 * configured), so a callback failure is recorded before `run` settles. If a
 * background-task handler is ever configured, delivery becomes unobservable
 * here and this must be revisited.
 */
export async function trackMailDelivery<T>(
  run: () => Promise<T>,
): Promise<MailDeliveryOutcome<T>> {
  const failed = new Set<MailKind>();
  const value = await scope.run(failed, run);
  return { value, failed };
}

/** Records a bounded failure for the enclosing tracked call, if any. */
export function recordMailDeliveryFailure(kind: MailKind): void {
  scope.getStore()?.add(kind);
}
