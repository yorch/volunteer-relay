import { ResetPage } from "../../../components/auth/pages";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  return (
    <ResetPage
      token={
        typeof token === "string" ? token : token === undefined ? undefined : ""
      }
    />
  );
}
