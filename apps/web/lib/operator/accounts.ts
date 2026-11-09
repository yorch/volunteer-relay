import { parseOperatorAccounts } from "@relay/contracts";

export interface OperatorIdentity {
  userId: string;
}

export interface OperatorDirectory {
  /** False when no account is configured: every console request answers 404. */
  readonly enabled: boolean;
  /**
   * Resolves a verified session to operator authority.
   *
   * Both the immutable user id AND the email must match one configured entry.
   * An email alone is not ownership of an account: public sign-up lets anyone
   * register an address that is not yet registered and wait for the real person
   * to click the verification link, which marks the squatter's account verified
   * without rotating its password or sessions. Binding the id removes that
   * takeover path, and the email keeps a hand-edited allowlist honest.
   */
  identify(input: {
    userId: string;
    email: string;
    emailVerified: boolean;
  }): OperatorIdentity | null;
}

/**
 * Builds the allowlist from deployment configuration. Parsing throws on a
 * malformed value; the web composition parses environment once at start-up, so
 * a bad list refuses to serve rather than silently granting nothing.
 */
export function createOperatorDirectory(
  raw: string | undefined,
): OperatorDirectory {
  const accounts = parseOperatorAccounts(raw);
  // One entry per user id, enforced by the contract schema; the map is only a
  // lookup aid, so a later duplicate could not widen authority.
  const byUserId = new Map(
    accounts.map((account) => [account.userId, account.email.toLowerCase()]),
  );
  return {
    enabled: accounts.length > 0,
    identify(input) {
      if (!input.emailVerified) return null;
      const configured = byUserId.get(input.userId);
      if (!configured) return null;
      // Compare the session's own address case-insensitively; sign-up lowercases
      // stored addresses, and the config schema lowercases configured ones.
      if (configured !== input.email.trim().toLowerCase()) return null;
      return { userId: input.userId };
    },
  };
}
