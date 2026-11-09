import {
  type AuthOrganizationChoices,
  type AuthPendingInvitations,
  apiErrorSchema,
  authOrganizationChoicesSchema,
  authPendingInvitationsSchema,
  errorCodeHttpStatus,
  type Result,
} from "@relay/contracts";
import { fetchJson } from "../api-client";

const unavailable = (): Result<never> => ({
  ok: false,
  error: {
    code: "DEPENDENCY_UNAVAILABLE",
    message: "Service unavailable",
    correlationId: "ui",
    retryable: true,
  },
});
// A code is trusted only with its canonical status.
const statuses = errorCodeHttpStatus;

/**
 * User copy for an `invitations/accept` refusal, or null for a code that is
 * not invitation-specific. NOT_AVAILABLE deliberately covers unknown, used,
 * withdrawn and other-recipient invitations alike: the server does not tell
 * them apart, so neither does the message.
 */
export function invitationAcceptMessage(code: string): string | null {
  switch (code) {
    case "EMAIL_NOT_VERIFIED":
      return "Verify your email to accept this invitation.";
    case "INVITATION_EXPIRED":
      return "This invitation has expired. Ask the organization to send a new invitation.";
    case "NOT_AVAILABLE":
      return "This invitation is not available to this account. It may have been used or withdrawn, or sent to a different email address.";
    default:
      return null;
  }
}
type Mutation =
  | "sign-in"
  | "sign-up"
  | "sign-out"
  | "reset/request"
  | "reset/confirm"
  | "verification/request"
  | "verification/confirm"
  | "invitations/accept"
  | "organizations/select";

// Fixed endpoint names only. Payloads are constructed by canonical form callbacks.
function request(path: string, body?: object) {
  return fetchJson(`/api/auth/${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers:
      body === undefined
        ? { Accept: "application/json" }
        : { Accept: "application/json", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function failure(
  response: Response,
  data: Record<string, unknown>,
): Result<never> {
  if (data.ok !== false || Object.keys(data).sort().join() !== "error,ok")
    return unavailable();
  const parsed = apiErrorSchema.safeParse({ error: data.error });
  if (!parsed.success || response.status !== statuses[parsed.data.error.code])
    return unavailable();
  // Retain only safe classification. Never forward arbitrary server messages/fields.
  return {
    ok: false,
    error: {
      code: parsed.data.error.code,
      message: "Request failed",
      correlationId: "ui",
      retryable: parsed.data.error.retryable,
    },
  };
}
export async function mutateAuth(
  path: Mutation,
  command: object,
): Promise<Result<void>> {
  const result = await request(path, command);
  if (!result) return unavailable();
  const { response, data } = result;
  if (
    response.status === 200 &&
    data.ok === true &&
    Object.keys(data).join() === "ok"
  )
    return { ok: true, value: undefined };
  return failure(response, data);
}
export async function loadOrganizations(): Promise<
  Result<AuthOrganizationChoices>
> {
  const result = await request("organizations");
  if (!result) return unavailable();
  const { response, data } = result;
  if (
    response.status === 200 &&
    data.ok === true &&
    Object.keys(data).sort().join() === "ok,value"
  ) {
    const parsed = authOrganizationChoicesSchema.safeParse(data.value);
    if (parsed.success) return { ok: true, value: parsed.data };
  }
  return failure(response, data);
}
// Invitations addressed to the signed-in user's verified email. Listing grants
// nothing: acceptance goes through `invitations/accept` and is reauthorized.
export async function loadPendingInvitations(): Promise<
  Result<AuthPendingInvitations>
> {
  const result = await request("invitations");
  if (!result) return unavailable();
  const { response, data } = result;
  if (
    response.status === 200 &&
    data.ok === true &&
    Object.keys(data).sort().join() === "ok,value"
  ) {
    const parsed = authPendingInvitationsSchema.safeParse(data.value);
    if (parsed.success) return { ok: true, value: parsed.data };
  }
  return failure(response, data);
}
