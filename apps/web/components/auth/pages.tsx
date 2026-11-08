"use client";

import type { AuthOrganizationChoices, Result } from "@relay/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button, FoundationRoot, PageHeading } from "../foundation";
import { Brand } from "../layout";
import {
  InvitationAcceptanceForm,
  OrganizationSwitcher,
  ResetConfirmForm,
  ResetRequestForm,
  SignInForm,
  SignOutForm,
  SignUpForm,
  VerificationConfirmForm,
  VerificationRequestForm,
} from ".";
import styles from "./auth.module.css";
import { destinationFromSearch } from "./next-path";
import { loadOrganizations, mutateAuth } from "./transport";

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <FoundationRoot>
      <div className={styles.authShell}>
        <header className={styles.authHeader}>
          <Brand />
          <a href="/">Back to home</a>
        </header>
        <main className={styles.preview}>
          <div className={styles.intro}>
            <span className={styles.eyebrow}>VOLUNTEER RELAY</span>
            <PageHeading
              title={title}
              description="A little clarity. More care."
            />
          </div>
          <div className={styles.authCard}>{children}</div>
          <nav aria-label="Account navigation" className={styles.navigation}>
            <a href="/sign-in">Sign in</a>
            <a href="/sign-up">Create account</a>
            <a href="/reset-password">Reset password</a>
            <a href="/verify-email">Verify email</a>
            <a href="/account">Account</a>
          </nav>
        </main>
      </div>
    </FoundationRoot>
  );
}
export function SignInPage() {
  return (
    <Shell title="Welcome back">
      <SignInForm
        onSignIn={async (command) => {
          const result = await mutateAuth("sign-in", command);
          if (result.ok)
            window.location.assign(
              destinationFromSearch(window.location.search),
            );
          return result;
        }}
      />
    </Shell>
  );
}
export function SignUpPage() {
  return (
    <Shell title="Join Volunteer Relay">
      <p>
        Creating an account grants no organization membership. You need an
        invitation to join an organization.
      </p>
      <SignUpForm onSignUp={(command) => mutateAuth("sign-up", command)} />
    </Shell>
  );
}
export function ResetPage({ token }: { token: string | undefined }) {
  return (
    <Shell title="Password reset">
      {token === undefined ? (
        <ResetRequestForm
          onRequestReset={(command) => mutateAuth("reset/request", command)}
        />
      ) : (
        <ResetConfirmForm
          token={token}
          onConfirmReset={(command) => mutateAuth("reset/confirm", command)}
        />
      )}
      <p>
        If your link has expired or was already used, request a new reset link.
      </p>
    </Shell>
  );
}
export function VerifyPage({ token }: { token: string | undefined }) {
  return (
    <Shell title="Email verification">
      <p>
        Verification confirms your email. Organization membership still requires
        an invitation.
      </p>
      {token === undefined ? (
        <VerificationRequestForm
          onRequestVerification={(command) =>
            mutateAuth("verification/request", command)
          }
        />
      ) : (
        <VerificationConfirmForm
          token={token}
          onConfirmVerification={(command) =>
            mutateAuth("verification/confirm", command)
          }
        />
      )}
      <p>
        If your link has expired or was already used, request a new verification
        link.
      </p>
    </Shell>
  );
}
export function InvitationPage({ invitationId }: { invitationId: string }) {
  return (
    <Shell title="Organization invitation">
      <p>
        Sign in with the matching verified recipient email before accepting this
        invitation. An expired invitation requires a new invitation from the
        organization.
      </p>
      <InvitationAcceptanceForm
        invitationId={invitationId}
        onAcceptInvitation={async (command) => {
          const result = await mutateAuth("invitations/accept", command);
          // The server has already made the accepted organization active.
          if (result.ok) window.location.assign("/workspace");
          return result;
        }}
      />
    </Shell>
  );
}
export function AccountPage() {
  const [result, setResult] = useState<Result<AuthOrganizationChoices> | null>(
    null,
  );
  const [generation, setGeneration] = useState(0);
  const feedback = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation explicitly requests a fresh server projection.
  useEffect(() => {
    let active = true;
    void loadOrganizations().then((next) => {
      if (active) setResult(next);
    });
    return () => {
      active = false;
    };
  }, [generation]);
  useEffect(() => {
    if (result && !result.ok) feedback.current?.focus();
  }, [result]);
  const reload = () => {
    setResult(null);
    setGeneration((n) => n + 1);
  };
  return (
    <Shell title="Your account">
      {!result ? (
        <p role="status">Loading organizations…</p>
      ) : !result.ok ? (
        <div
          ref={feedback}
          tabIndex={-1}
          role="alert"
          className={styles.feedback}
        >
          <p>
            {result.error.code === "UNAUTHENTICATED"
              ? "Please sign in to view your account."
              : "We could not load your organizations. Please try again."}
          </p>
          <Button onClick={reload}>Retry</Button>
        </div>
      ) : (
        <>
          <OrganizationSwitcher
            key={generation}
            options={result.value.options}
            currentOrganizationId={result.value.currentOrganizationId}
            onSelectOrganization={async (command) => {
              const selected = await mutateAuth(
                "organizations/select",
                command,
              );
              // The server has made the organization active; continue there.
              if (selected.ok) window.location.assign("/workspace");
              return selected;
            }}
          />
          <Button onClick={reload}>Refresh organizations</Button>
        </>
      )}
      <p>
        <a href="/workspace">Open workspace</a>
      </p>
      <SignOutForm
        onSignOut={async () => {
          const signedOut = await mutateAuth("sign-out", {});
          if (signedOut.ok) window.location.assign("/sign-in");
          return signedOut;
        }}
      />
    </Shell>
  );
}
