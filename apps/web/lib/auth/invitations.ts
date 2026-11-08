import {
  AUTH_PENDING_INVITATIONS_LIMIT,
  type AuthPendingInvitation,
} from "@relay/contracts";
import { isContractRole } from "@relay/domain/auth";

/** The subset of a Better Auth `listUserInvitations` row this projection reads. */
export interface InvitationRow {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date | string;
  organizationName?: string | null | undefined;
}

/**
 * Projects library rows to the recipient-facing list. Better Auth already
 * queries by the lowercased session email and keeps only `pending`; this
 * repeats every acceptance precondition the list can know about (recipient
 * by case-insensitive email, pending, unexpired, contract role) so a row that
 * acceptance would refuse is never offered. Sorted by soonest expiry, then
 * id, and capped. The inviter, recipient email and organization ID are
 * dropped: acceptance needs only the invitation ID.
 */
export function projectPendingInvitations(
  rows: readonly InvitationRow[],
  recipientEmail: string,
  now: Date,
): AuthPendingInvitation[] {
  const recipient = recipientEmail.toLowerCase();
  const items: { expires: number; item: AuthPendingInvitation }[] = [];
  for (const row of rows) {
    if (row.status !== "pending") continue;
    if (typeof row.email !== "string" || row.email.toLowerCase() !== recipient)
      continue;
    if (!isContractRole(row.role)) continue;
    const expires = new Date(row.expiresAt).getTime();
    if (!Number.isFinite(expires) || expires <= now.getTime()) continue;
    if (typeof row.organizationName !== "string" || !row.organizationName)
      continue;
    if (typeof row.id !== "string" || !row.id) continue;
    items.push({
      expires,
      item: {
        invitationId: row.id,
        organizationName: row.organizationName,
        role: row.role,
        expiresAt: new Date(expires).toISOString(),
      },
    });
  }
  items.sort(
    (a, b) =>
      a.expires - b.expires ||
      (a.item.invitationId < b.item.invitationId
        ? -1
        : a.item.invitationId > b.item.invitationId
          ? 1
          : 0),
  );
  const seen = new Set<string>();
  const unique: AuthPendingInvitation[] = [];
  for (const { item } of items) {
    if (seen.has(item.invitationId)) continue;
    seen.add(item.invitationId);
    unique.push(item);
    if (unique.length === AUTH_PENDING_INVITATIONS_LIMIT) break;
  }
  return unique;
}
