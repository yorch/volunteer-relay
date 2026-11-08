import { parseEnvironment } from "@relay/config";
import type { Database } from "@relay/db";
import nodemailer from "nodemailer";
import { createAuth } from "../auth/auth.ts";

export function createProductionAuth(db: Database) {
  const env = parseEnvironment(process.env);
  if (!env.BETTER_AUTH_SECRET)
    throw new Error("Authentication secret is required");
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_TLS === "true",
    connectionTimeout: 10000,
    socketTimeout: 10000,
    ...(env.SMTP_USER
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? "" } }
      : {}),
  });
  const app = new URL(env.APP_URL);
  const send = async (
    to: string,
    subject: string,
    text: string,
    url: string,
  ) => {
    const link = new URL(url, app);
    if (link.origin !== app.origin) throw new Error("Invalid application link");
    await transport.sendMail({
      from: env.SMTP_FROM,
      to,
      subject,
      text: `${text}\n\n${link.href}`,
    });
  };
  return createAuth({
    db,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_URL,
    mail: {
      sendPasswordReset: (message) =>
        send(
          message.to,
          "Reset your Volunteer Relay password",
          "Use this link to reset your password.",
          message.resetUrl,
        ),
      sendInvitation: (message) =>
        send(
          message.to,
          "Your Volunteer Relay invitation",
          `You have been invited to ${message.organizationName} as ${message.role}.`,
          message.acceptPath,
        ),
      sendEmailVerification: (message) =>
        send(
          message.to,
          "Verify your Volunteer Relay email",
          "Use this link to verify your email.",
          message.verificationUrl,
        ),
    },
  });
}
