import type { ReactNode } from "react";

import { IconInbox } from "@/components/icons";

export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rp-empty">
      <div className="rp-empty-icon">{icon ?? <IconInbox size={22} />}</div>
      <p className="rp-empty-title">{title}</p>
      {description ? <p className="rp-empty-desc">{description}</p> : null}
      {action}
    </div>
  );
}
