import { redirect } from "next/navigation";
import { SignUpPage } from "../../../components/auth/pages";
import { isSignedIn } from "../../../lib/auth/server-session.ts";

export default async function Page() {
  // Creating a second account while signed in is almost always a mistake; send
  // the visitor to the workspace they already have.
  if (await isSignedIn()) redirect("/workspace");
  return <SignUpPage />;
}
