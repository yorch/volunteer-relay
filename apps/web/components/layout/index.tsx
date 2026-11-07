import type { ReactNode } from "react";
import { FoundationRoot } from "../foundation";
import styles from "./layout.module.css";

export type NavigationItem = { href: string; label: string };
export function StaffShell({
  organization,
  navigation,
  currentPath,
  mainId,
  children,
  account,
}: {
  organization: string;
  navigation: readonly NavigationItem[];
  currentPath: string;
  mainId: string;
  children: ReactNode;
  account?: ReactNode;
}) {
  return (
    <FoundationRoot>
      <div className={styles.staff}>
        <a className={styles.skip} href={`#${mainId}`}>
          Skip to main content
        </a>
        <aside className={styles.sidebar}>
          <div className={styles.brand}>
            <span aria-hidden="true" className={styles.mark}>
              ↗
            </span>
            Volunteer Relay
          </div>
          <div className={styles.organization}>{organization}</div>
          <nav aria-label="Workspace">
            <ul className={styles.navigation}>
              {navigation.map((item) => (
                <li key={item.href}>
                  <a
                    href={item.href}
                    aria-current={
                      currentPath === item.href ? "page" : undefined
                    }
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          {account && <div className={styles.account}>{account}</div>}
        </aside>
        <div className={styles.mainColumn}>
          <header className={styles.topbar}>Your community, connected.</header>
          <main id={mainId} tabIndex={-1} className={styles.content}>
            {children}
          </main>
        </div>
      </div>
    </FoundationRoot>
  );
}
export function VolunteerShell({
  organization,
  mainId,
  children,
  account,
}: {
  organization: string;
  mainId: string;
  children: ReactNode;
  account?: ReactNode;
}) {
  return (
    <FoundationRoot>
      <a className={styles.skip} href={`#${mainId}`}>
        Skip to main content
      </a>
      <header className={styles.volunteerHeader}>
        <div className={styles.brand}>
          <span aria-hidden="true" className={styles.mark}>
            ↗
          </span>
          Volunteer Relay
        </div>
        <span>{organization}</span>
        {account}
      </header>
      <main id={mainId} tabIndex={-1} className={styles.volunteerContent}>
        {children}
      </main>
    </FoundationRoot>
  );
}
export { FoundationPreview } from "./preview";
