import type { ReactNode } from "react";
import styles from "./card.module.css";

/**
 * The one product card. It carries the shared surface (paper, hairline border,
 * radius, shadow); each screen passes its own module class for what differs.
 */
export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <section
      className={className ? `${styles.surface} ${className}` : styles.surface}
    >
      {children}
    </section>
  );
}

/**
 * A live region that stays mounted so assistive technology observes the text
 * change. Pass an empty string to clear it; the visual class applies only when
 * there is something to show. "polite" announces without adding a status role.
 */
export function Live({
  kind,
  className,
  children,
}: {
  kind: "alert" | "status" | "polite";
  className?: string | undefined;
  children?: ReactNode;
}) {
  const filled =
    children !== undefined &&
    children !== "" &&
    children !== null &&
    children !== false;
  return (
    <div
      {...(kind === "polite"
        ? { "aria-live": "polite" as const }
        : { role: kind })}
      className={filled ? className : undefined}
    >
      {filled ? children : null}
    </div>
  );
}
