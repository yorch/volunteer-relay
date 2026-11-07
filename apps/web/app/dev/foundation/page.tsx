import { notFound } from "next/navigation";
import { FoundationPreview } from "../../../components/layout";

export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ audience?: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();
  const { audience } = await searchParams;
  return (
    <FoundationPreview
      audience={audience === "volunteer" ? "volunteer" : "staff"}
    />
  );
}
