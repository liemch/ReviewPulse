import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  icon,
  actions,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="rp-page-head">
      <div>
        <h1 className="rp-page-title">
          {icon}
          {title}
        </h1>
        {description ? <p className="rp-page-desc">{description}</p> : null}
      </div>
      {actions ? <div className="rp-page-actions">{actions}</div> : null}
    </div>
  );
}
