import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

/** Card plat (docs/17 §1): bordură fină, fără umbră, fără degrade. */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-line-subtle bg-surface-page text-ink", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 p-6", className)} {...props} />;
}

/**
 * Nivelul de titlu se alege la folosire (`as`): `h1` când cardul e conținutul principal al paginii (titlu de pagină,
 * 22 / 28 px), altfel titlu de secțiune (16 / 24 px).
 */
export function CardTitle({
  className,
  as: Tag = "h2",
  ...props
}: HTMLAttributes<HTMLHeadingElement> & { as?: "h1" | "h2" | "h3" }) {
  return <Tag className={cn(Tag === "h1" ? "text-title" : "text-section", className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-body text-ink-secondary", className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-6 pt-0", className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center p-6 pt-0", className)} {...props} />;
}
