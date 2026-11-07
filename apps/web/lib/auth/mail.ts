import type { ContractRole } from "@relay/domain/auth";

// Messages a server-side auth lifecycle may need to deliver. Routes inject an
// implementation; tests inject a memory recorder. A token must never be logged,
// and these payloads are the only fields a transport receives.
export interface ResetPasswordMail {
  to: string;
  name: string;
  resetUrl: string;
  token: string;
}

export interface InvitationMail {
  to: string;
  organizationName: string;
  role: ContractRole;
  invitationId: string;
  inviterName: string;
  acceptPath: string;
  expiresAt: Date;
}

export interface AuthMailCallbacks {
  sendPasswordReset(message: ResetPasswordMail): Promise<void>;
  sendInvitation(message: InvitationMail): Promise<void>;
}

export interface RecordingMailer extends AuthMailCallbacks {
  readonly resetMessages: ResetPasswordMail[];
  readonly invitationMessages: InvitationMail[];
  readonly failures: Array<{ kind: "reset" | "invitation"; at: Date }>;
}

export interface RecordingMailerOptions {
  failReset?: boolean;
  failInvitation?: boolean;
}

/**
 * Controlled in-memory transport for tests. Deliberate failures are recorded
 * with their kind only — never their payload — so a test can prove bounded
 * failure handling without exposing a token.
 */
export function createRecordingMailer(
  options: RecordingMailerOptions = {},
): RecordingMailer {
  const resetMessages: ResetPasswordMail[] = [];
  const invitationMessages: InvitationMail[] = [];
  const failures: Array<{ kind: "reset" | "invitation"; at: Date }> = [];
  return {
    resetMessages,
    invitationMessages,
    failures,
    async sendPasswordReset(message) {
      if (options.failReset) {
        failures.push({ kind: "reset", at: new Date() });
        throw new Error("reset transport unavailable");
      }
      resetMessages.push(message);
    },
    async sendInvitation(message) {
      if (options.failInvitation) {
        failures.push({ kind: "invitation", at: new Date() });
        throw new Error("invitation transport unavailable");
      }
      invitationMessages.push(message);
    },
  };
}

export interface TrackedMailer {
  mail: AuthMailCallbacks;
  // Kind-only failure records: no recipient, token or URL content.
  failures: Array<{ kind: "reset" | "invitation"; at: Date }>;
}

/**
 * Wraps a transport so a caller can tell that delivery failed while the pending
 * verification/invitation row remains, without exposing payload content.
 */
export function createTrackedMailer(inner: AuthMailCallbacks): TrackedMailer {
  const failures: TrackedMailer["failures"] = [];
  return {
    failures,
    mail: {
      async sendPasswordReset(message) {
        try {
          await inner.sendPasswordReset(message);
        } catch {
          failures.push({ kind: "reset", at: new Date() });
          throw new Error("reset delivery failed");
        }
      },
      async sendInvitation(message) {
        try {
          await inner.sendInvitation(message);
        } catch {
          failures.push({ kind: "invitation", at: new Date() });
          throw new Error("invitation delivery failed");
        }
      },
    },
  };
}
