import type { ReactNode } from "react";

/** The one product card; each surface supplies its own module class. */
export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return <section className={className}>{children}</section>;
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
