import type { ButtonHTMLAttributes } from "react";
import Link from "next/link";

type Variant = "primary" | "secondary" | "danger" | "ghost";

function classes(
  variant: Variant,
  size: "md" | "sm",
  block: boolean,
  extra?: string,
): string {
  return [
    "rp-btn",
    `rp-btn--${variant}`,
    size === "sm" ? "rp-btn--sm" : null,
    block ? "rp-btn--block" : null,
    extra,
  ]
    .filter(Boolean)
    .join(" ");
}

export function Button({
  variant = "secondary",
  size = "md",
  block = false,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "md" | "sm";
  block?: boolean;
}) {
  return (
    <button
      {...props}
      className={classes(variant, size, block, className)}
      type={props.type ?? "button"}
    />
  );
}

export function ButtonLink({
  href,
  variant = "secondary",
  size = "md",
  block = false,
  children,
}: {
  href: string;
  variant?: Variant;
  size?: "md" | "sm";
  block?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className={classes(variant, size, block)}>
      {children}
    </Link>
  );
}
