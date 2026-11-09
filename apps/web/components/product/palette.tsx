"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "../foundation";
import styles from "./palette.module.css";

export type PaletteItem = {
  id: string;
  kind: "Page" | "Need" | "Member";
  label: string;
  href: string;
};

const focusable =
  'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';
const maxResults = 12;

export function CommandPalette({
  items,
  onClose,
}: {
  items: readonly PaletteItem[];
  onClose: () => void;
}) {
  const router = useRouter();
  const titleId = useId();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const found = q
      ? items.filter((item) => item.label.toLowerCase().includes(q))
      : items;
    return found.slice(0, maxResults);
  }, [items, query]);
  const current = Math.min(active, Math.max(results.length - 1, 0));

  // Return focus to whatever opened the palette once it closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  // Lock page scroll while the palette is open; restore the prior value.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);
  useEffect(() => {
    document
      .getElementById(`${listId}-${current}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [current, listId]);

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    router.push(item.href as Route);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only backdrop dismiss; Escape is the keyboard path.
    <div
      role="presentation"
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === "Tab") {
            const nodes =
              dialog.current?.querySelectorAll<HTMLElement>(focusable);
            if (!nodes?.length) return;
            const first = nodes[0];
            const last = nodes[nodes.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <h2 id={titleId} className={styles.title}>
          Command palette
        </h2>
        <div className={styles.field}>
          <Icon name="search" size={20} />
          <input
            ref={input}
            className={styles.input}
            type="text"
            role="combobox"
            aria-label="Find a page, need or team member"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              results.length ? `${listId}-${current}` : undefined
            }
            autoComplete="off"
            spellCheck={false}
            placeholder="Type to filter"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive(results.length ? (current + 1) % results.length : 0);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive(
                  results.length
                    ? (current - 1 + results.length) % results.length
                    : 0,
                );
              } else if (event.key === "Home") {
                event.preventDefault();
                setActive(0);
              } else if (event.key === "End") {
                event.preventDefault();
                setActive(Math.max(results.length - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(results[current]);
              }
            }}
          />
        </div>
        <div
          id={listId}
          className={styles.list}
          role="listbox"
          aria-label="Results"
        >
          {results.map((item, index) => (
            <div
              key={item.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === current}
              data-active={index === current}
              className={styles.option}
              onMouseMove={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              tabIndex={-1}
              onClick={() => choose(item)}
              onKeyDown={(event) => {
                if (event.key === "Enter") choose(item);
              }}
            >
              <span className={styles.kind}>{item.kind}</span>
              <span className={styles.label}>{item.label}</span>
              {index === current && (
                <span className={styles.go} aria-hidden="true">
                  <Icon name="arrowRight" size={16} />
                </span>
              )}
            </div>
          ))}
        </div>
        {results.length === 0 && (
          <p className={styles.empty}>Nothing matches. Try a shorter word.</p>
        )}
        <p className={styles.help}>
          Arrow keys to move, Enter to open, Escape to close.
        </p>
      </div>
    </div>
  );
}
