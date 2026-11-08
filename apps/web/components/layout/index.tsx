import type { ReactNode } from "react";
import { FoundationRoot } from "../foundation";
import styles from "./layout.module.css";

export type NavigationIcon = keyof typeof icons;
export type NavigationItem = {
  href: string;
  label: string;
  icon: NavigationIcon;
  count?: number | string;
  group?: "workspace" | "administration";
};
const adminPaths = new Set([
  "settings",
  "history",
  "delivery",
  "members",
  "retention",
]);
const icons: Record<string, string> = {
  workspace: "M3 10 12 3l9 7v10h-6v-6H9v6H3z",
  inbox: "M4 4h16v12h-4l-2 3h-4l-2-3H4z M4 12h16",
  needs: "M5 21V4m0 1h12l-2 4 2 4H5",
  activities: "M12 3a9 9 0 1 0 9 9 9 9 0 0 0-9-9Zm0 4v5l3 2",
  reports: "M4 20V10h4v10m4 0V4h4v16m4 0v-7h2v7",
  import: "M12 3v11m-4-4 4 4 4-4M4 16v4h16v-4",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2",
  members:
    "M16 20v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m6-10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7 4a4 4 0 0 1 3 4v2",
  notifications: "M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3Zm5 3h4",
  history: "M4 5v5h5M5 10a8 8 0 1 1 1 7m6-9v4l3 2",
  delivery: "M3 5h12v12H3z M15 9h3l3 3v5h-6z M6 20h2m9 0h2",
  retention: "M4 6h16M9 6V4h6v2m-9 0 1 14h10l1-14M10 10v6m4-6v6",
};
function Icon({ path }: { path: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} />
    </svg>
  );
}
export function Brand() {
  return (
    <a href="/" className={styles.brand}>
      <span aria-hidden="true" className={styles.mark}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
          <path
            d="M5 17 17 5M8 5h9v9"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span>
        volunteer relay<span className={styles.brandDot}>.</span>
      </span>
    </a>
  );
}
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
  const group = (item: NavigationItem) =>
    item.group ??
    (adminPaths.has(item.href.split("/").pop() ?? "")
      ? "administration"
      : "workspace");
  const current = navigation.find((item) => item.href === currentPath);
  return (
    <FoundationRoot>
      <div className={styles.staff}>
        <a className={styles.skip} href={`#${mainId}`}>
          Skip to main content
        </a>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHead}>
            <Brand />
            <span className={styles.mobileOrganization}>{organization}</span>
          </div>
          <details className={styles.menu}>
            <summary className={styles.menuToggle}>
              <span>Menu</span>
              <span aria-hidden="true">☰</span>
            </summary>
            <div className={styles.menuContents}>
              <div className={styles.organization}>
                <span className={styles.orgMark} aria-hidden="true">
                  ✳
                </span>
                <span>
                  <small>YOUR ORGANIZATION</small>
                  <strong>{organization}</strong>
                </span>
              </div>
              <nav aria-label="Workspace">
                {(["workspace", "administration"] as const).map((section) => {
                  const items = navigation.filter(
                    (item) => group(item) === section,
                  );
                  return (
                    items.length > 0 && (
                      <div className={styles.navGroup} key={section}>
                        <p className={styles.overline}>
                          {section === "workspace"
                            ? "Workspace"
                            : "Administration"}
                        </p>
                        <ul className={styles.navigation}>
                          {items.map((item) => {
                            return (
                              <li key={item.href}>
                                <a
                                  href={item.href}
                                  aria-current={
                                    currentPath === item.href
                                      ? "page"
                                      : undefined
                                  }
                                >
                                  <Icon path={icons[item.icon] ?? ""} />
                                  <span>{item.label}</span>
                                  {item.count !== undefined && (
                                    <span className={styles.count}>
                                      {item.count}
                                    </span>
                                  )}
                                </a>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )
                  );
                })}
              </nav>
              {account && (
                <div className={styles.account}>
                  <span className={styles.accountIcon} aria-hidden="true">
                    <Icon path="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 21v-2a7 7 0 0 1 14 0v2" />
                  </span>
                  <div>
                    <strong>Account</strong>
                    <div>{account}</div>
                  </div>
                </div>
              )}
            </div>
          </details>
        </aside>
        <div className={styles.mainColumn}>
          <header className={styles.topbar}>
            <span>
              {organization} <span className={styles.slash}>/</span>{" "}
              <strong>{current?.label ?? "Workspace"}</strong>
            </span>
            <span className={styles.topbarNote}>
              A little clarity. More care.
            </span>
          </header>
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
        <Brand />
        <span className={styles.volunteerOrg}>{organization}</span>
        {account && <div className={styles.volunteerAccount}>{account}</div>}
      </header>
      <main id={mainId} tabIndex={-1} className={styles.volunteerContent}>
        {children}
      </main>
    </FoundationRoot>
  );
}
export { FoundationPreview } from "./preview";
