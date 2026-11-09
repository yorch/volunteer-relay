import type { Metadata } from "next";
import { OperatorConsole } from "../../components/operator/console";

// Cross-organization administration: deliberately outside /workspace so no
// tenant shell, snapshot or organization selection is loaded with it.
export const metadata: Metadata = {
  title: "Organizations",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <OperatorConsole />;
}
