"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { request } from "../api-client";
import { Icon } from "../foundation";
import { CommandPalette, type PaletteItem } from "./palette";
import styles from "./topbar.module.css";

type Alert = { readAt?: string | null };

export function Topbar({
  pages,
  needs,
  members,
}: {
  pages: readonly { href: string; label: string }[];
  needs: readonly { id: string; label: string }[];
  members: readonly { id: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [mac, setMac] = useState(false);
  useEffect(() => {
    setMac(/mac|iphone|ipad/i.test(navigator.userAgent));
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "k" &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Silent by design: a failed or slow lookup just shows no count.
  const pathname = usePathname();
  useEffect(() => {
    // Re-read on every page change: the workspace stays mounted across
    // pages, so reading alerts elsewhere must refresh the badge.
    void pathname;
    let live = true;
    void request<Alert[]>("/api/product/notifications")
      .then((result) => {
        if (live && result.ok && Array.isArray(result.value))
          setUnread(result.value.filter((n) => !n.readAt).length);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [pathname]);
  const items = useMemo<PaletteItem[]>(
    () => [
      ...pages.map((p) => ({
        id: `page-${p.href}`,
        kind: "Page" as const,
        label: p.label,
        href: p.href,
      })),
      ...needs.map((n) => ({
        id: `need-${n.id}`,
        kind: "Need" as const,
        label: n.label,
        href: "/workspace/needs",
      })),
      ...members.map((m) => ({
        id: `member-${m.id}`,
        kind: "Member" as const,
        label: m.label,
        href: "/workspace/members",
      })),
    ],
    [pages, needs, members],
  );
  return (
    <>
      <button
        type="button"
        className={styles.search}
        aria-label="Search workspace"
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K"
        onClick={() => setOpen(true)}
      >
        <Icon name="search" size={16} />
        <span className={styles.searchLabel} aria-hidden="true">
          Search workspace
        </span>
        <span className={styles.hint} aria-hidden="true">
          {mac ? "⌘ K" : "Ctrl K"}
        </span>
      </button>
      <Link
        className={styles.alerts}
        href="/workspace/notifications"
        aria-label={unread > 0 ? `Unread alerts (${unread})` : "Unread alerts"}
      >
        <Icon name="notifications" size={20} />
        {unread > 0 && (
          <span className={styles.badge} aria-hidden="true">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </Link>
      {open && <CommandPalette items={items} onClose={() => setOpen(false)} />}
    </>
  );
}
