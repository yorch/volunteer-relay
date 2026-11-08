import { InvitationPage } from "../../../../components/auth/pages";
export default async function Page({
  params,
}: {
  params: Promise<{ invitationId: string }>;
}) {
  const { invitationId } = await params;
  return <InvitationPage invitationId={invitationId} />;
}
