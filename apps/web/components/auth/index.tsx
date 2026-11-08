"use client";

import type {
  AuthInvitationAcceptance,
  AuthOrganizationOption,
  AuthOrganizationSelection,
  AuthResetConfirm,
  AuthResetRequest,
  AuthSignInCommand,
  AuthSignUpCommand,
  AuthVerificationConfirm,
  AuthVerificationRequest,
  Result,
} from "@relay/contracts";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button, Card, Field, Select, TextInput } from "../foundation";
import styles from "./auth.module.css";

type Command<T> = (command: T) => Promise<Result<void>>;

// Never render arbitrary transport messages/fields: they may contain secrets.
function safeError(result: Extract<Result<void>, { ok: false }>): string {
  switch (result.error.code) {
    case "NOT_FOUND":
      return "This invitation or link is unavailable or expired. Request a new link or invitation.";
    case "UNAUTHENTICATED":
      return "Please sign in and try again.";
    case "FORBIDDEN":
      return "This request is not permitted. Invitations require the matching verified email.";
    case "RATE_LIMITED":
      return "Too many attempts. Please wait before trying again.";
    case "DEPENDENCY_UNAVAILABLE":
      return "This service is unavailable. Please try again later.";
    default:
      return "We could not complete this request. Check your details and try again.";
  }
}

function CommandForm({
  title,
  action,
  success,
  submit,
  children,
  disabled = false,
}: {
  title: string;
  action: string;
  success: string;
  submit: (data: FormData) => Promise<Result<void>>;
  children: ReactNode;
  disabled?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const lock = useRef(false);
  const alertRegion = useRef<HTMLDivElement>(null);
  const statusRegion = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) (failed ? alertRegion : statusRegion).current?.focus();
  }, [message, failed]);
  return (
    <Card title={title}>
      {!hydrated && <p>Enable JavaScript to use this form safely.</p>}
      <form
        className={styles.form}
        method="post"
        aria-label={title}
        aria-busy={pending}
        onSubmit={async (event) => {
          event.preventDefault();
          if (lock.current || disabled || !hydrated) return;
          lock.current = true;
          const form = event.currentTarget;
          const data = new FormData(form);
          setPending(true);
          setMessage("");
          let result: Result<void>;
          try {
            result = await submit(data);
          } catch {
            result = {
              ok: false,
              error: {
                code: "DEPENDENCY_UNAVAILABLE",
                message: "Unavailable",
                correlationId: "ui",
                retryable: true,
              },
            };
          }
          if (result.ok) {
            for (const input of form.querySelectorAll<HTMLInputElement>(
              'input[type="password"]',
            ))
              input.value = "";
          }
          setFailed(!result.ok);
          setMessage(result.ok ? success : safeError(result));
          lock.current = false;
          setPending(false);
        }}
      >
        <fieldset
          disabled={!hydrated || pending || disabled}
          className={styles.fields}
        >
          {children}
          <Button type="submit">{pending ? "Please wait…" : action}</Button>
        </fieldset>
        {failed && message && (
          // An alert inserted with its text is announced reliably; it is
          // only mounted while an error is showing.
          <div
            ref={alertRegion}
            tabIndex={-1}
            role="alert"
            className={styles.feedback}
          >
            {message}
          </div>
        )}
        {/* Persistent status region: only its text changes. */}
        <div
          ref={statusRegion}
          tabIndex={-1}
          role="status"
          className={styles.feedback}
        >
          {failed ? "" : message}
        </div>
      </form>
    </Card>
  );
}

function EmailField() {
  const id = useId();
  return (
    <Field id={id} label="Email">
      <TextInput
        id={id}
        name="email"
        type="email"
        autoComplete="email"
        required
      />
    </Field>
  );
}
function PasswordField({ fresh = false }: { fresh?: boolean }) {
  const id = useId();
  return (
    <Field id={id} label={fresh ? "New password" : "Password"}>
      <TextInput
        id={id}
        name={fresh ? "newPassword" : "password"}
        type="password"
        autoComplete={fresh ? "new-password" : "current-password"}
        required
      />
    </Field>
  );
}
const value = (data: FormData, key: string) => String(data.get(key) ?? "");

export function SignInForm({
  onSignIn,
}: {
  onSignIn: Command<AuthSignInCommand>;
}) {
  return (
    <CommandForm
      title="Sign in"
      action="Sign in"
      success="Sign-in request completed."
      submit={(data) =>
        onSignIn({
          email: value(data, "email"),
          password: value(data, "password"),
        })
      }
    >
      <EmailField />
      <PasswordField />
    </CommandForm>
  );
}
export function ResetRequestForm({
  onRequestReset,
}: {
  onRequestReset: Command<AuthResetRequest>;
}) {
  return (
    <CommandForm
      title="Request a password reset"
      action="Request reset"
      success="If this account is eligible, reset instructions may be sent. Check your email for any next steps."
      submit={(data) => onRequestReset({ email: value(data, "email") })}
    >
      <EmailField />
    </CommandForm>
  );
}
export function ResetConfirmForm({
  token,
  onConfirmReset,
}: {
  token: string;
  onConfirmReset: Command<AuthResetConfirm>;
}) {
  return (
    <CommandForm
      key={token}
      title="Choose a new password"
      action="Update password"
      success="Password reset completed."
      disabled={!token}
      submit={(data) =>
        onConfirmReset({ token, newPassword: value(data, "newPassword") })
      }
    >
      <PasswordField fresh />
      {!token && <p>A reset token is required.</p>}
    </CommandForm>
  );
}
export function InvitationAcceptanceForm({
  invitationId,
  onAcceptInvitation,
}: {
  invitationId: string;
  onAcceptInvitation: Command<AuthInvitationAcceptance>;
}) {
  return (
    <CommandForm
      key={invitationId}
      title="Accept invitation"
      action="Accept invitation"
      success="Invitation request completed."
      disabled={!invitationId}
      submit={() => onAcceptInvitation({ invitationId })}
    >
      <p>The server will check this invitation and your current identity.</p>
      {!invitationId && <p>An invitation is required.</p>}
    </CommandForm>
  );
}
export function OrganizationSwitcher({
  currentOrganizationId,
  options,
  onSelectOrganization,
}: {
  currentOrganizationId: string | null;
  options: readonly AuthOrganizationOption[];
  onSelectOrganization: Command<AuthOrganizationSelection>;
}) {
  const id = useId();
  return (
    <CommandForm
      title="Switch organization"
      action="Switch organization"
      success="Organization selection request completed."
      disabled={options.length === 0}
      submit={(data) => {
        const organizationId = value(data, "organizationId");
        if (!options.some((option) => option.organizationId === organizationId))
          return Promise.resolve({
            ok: false,
            error: {
              code: "VALIDATION",
              message: "Choose an organization",
              correlationId: "ui",
              retryable: false,
            },
          });
        return onSelectOrganization({ organizationId });
      }}
    >
      <Field
        id={id}
        label="Organization"
        hint="Roles are supplied by the server. Selection does not grant access."
      >
        <Select
          id={id}
          key={currentOrganizationId}
          name="organizationId"
          required
          defaultValue={currentOrganizationId ?? ""}
          aria-describedby={`${id}-hint`}
        >
          <option value="" disabled>
            Choose an organization
          </option>
          {options.map((option) => (
            <option key={option.organizationId} value={option.organizationId}>
              {option.name} ({option.role})
            </option>
          ))}
        </Select>
      </Field>
      {options.length === 0 && <p>No organizations are available.</p>}
    </CommandForm>
  );
}

export function SignUpForm({
  onSignUp,
}: {
  onSignUp: Command<AuthSignUpCommand>;
}) {
  const id = useId();
  return (
    <CommandForm
      title="Create an account"
      action="Create account"
      success="Account created. Check your email for a verification link — you can request a new one on the verification page."
      submit={(data) =>
        onSignUp({
          name: value(data, "name"),
          email: value(data, "email"),
          password: value(data, "newPassword"),
        })
      }
    >
      <Field id={id} label="Name">
        <TextInput
          id={id}
          name="name"
          autoComplete="name"
          maxLength={200}
          required
        />
      </Field>
      <EmailField />
      <PasswordField fresh />
    </CommandForm>
  );
}
export function VerificationRequestForm({
  onRequestVerification,
}: {
  onRequestVerification: Command<AuthVerificationRequest>;
}) {
  return (
    <CommandForm
      title="Request email verification"
      action="Request verification"
      success="If this account is eligible, verification instructions may be sent. Check your email for any next steps."
      submit={(data) => onRequestVerification({ email: value(data, "email") })}
    >
      <EmailField />
    </CommandForm>
  );
}
export function VerificationConfirmForm({
  token,
  onConfirmVerification,
}: {
  token: string;
  onConfirmVerification: Command<AuthVerificationConfirm>;
}) {
  return (
    <CommandForm
      key={token}
      title="Verify your email"
      action="Verify email"
      success="Email verified. Organization membership still requires an invitation."
      disabled={!token}
      submit={() => onConfirmVerification({ token })}
    >
      <p>
        Confirm this email verification link. Verification does not grant
        organization membership.
      </p>
    </CommandForm>
  );
}
export function SignOutForm({
  onSignOut,
}: {
  onSignOut: () => Promise<Result<void>>;
}) {
  return (
    <CommandForm
      title="End your session"
      action="Sign out"
      success="Signed out."
      submit={onSignOut}
    >
      <p>Sign out on this browser.</p>
    </CommandForm>
  );
}
