import { redirect } from "next/navigation";
import { SignInPage } from "../../../components/auth/pages";
import { isSignedIn } from "../../../lib/auth/server-session.ts";

export default async function Page() {
  // Someone who is already signed in has no use for the sign-in form; showing
  // it was the reported bug. Request-time check, so this route is dynamic.
  if (await isSignedIn()) redirect("/workspace");
  return <SignInPage />;
}
