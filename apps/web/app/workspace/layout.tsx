import type { ReactNode } from "react";
import { ProductWorkspace } from "../../components/product";

// Mounted once for every /workspace route: moving between pages is a client
// navigation, so the workspace snapshot loads once instead of on each page.
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ProductWorkspace />
      {children}
    </>
  );
}
