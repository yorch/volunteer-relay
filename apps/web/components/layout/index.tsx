import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { FoundationRoot, Icon, type IconName } from "../foundation";
import styles from "./layout.module.css";

export type NavigationIcon = string;
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
const iconNames = new Set([
  "workspace",
  "inbox",
  "needs",
  "activities",
  "reports",
  "import",
  "settings",
  "members",
  "notifications",
  "history",
  "delivery",
  "retention",
]);
const navIcon = (name: string): IconName =>
  (iconNames.has(name) ? name : "workspace") as IconName;
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
          <details key={currentPath} className={styles.menu}>
            <summary className={styles.menuToggle}>
              <span>Menu</span>
              <span aria-hidden="true" className={styles.menuIcon}>
                <Icon name="menu" size={20} />
              </span>
            </summary>
            <div className={styles.menuContents}>
              <div className={styles.organization}>
                <span className={styles.orgMark} aria-hidden="true">
                  <Icon name="flag" size={20} />
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
                                <Link
                                  href={item.href as Route}
                                  aria-current={
                                    currentPath === item.href
                                      ? "page"
                                      : undefined
                                  }
                                >
                                  <Icon name={navIcon(item.icon)} size={20} />
                                  <span>{item.label}</span>
                                  {item.count !== undefined && (
                                    <span className={styles.count}>
                                      {item.count}
                                    </span>
                                  )}
                                </Link>
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
                    <Icon name="user" size={20} />
                  </span>
                  <div className={styles.accountBody}>
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
              {organization}
              <span className={styles.slash} aria-hidden="true">
                <Icon name="chevronRight" size={16} />
              </span>
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
