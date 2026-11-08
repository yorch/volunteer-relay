import { notFound } from "next/navigation";
import { AuthPreview } from "../../../components/auth/preview";

export const dynamic = "force-dynamic";
export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <AuthPreview />;
}
