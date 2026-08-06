import type { ReactNode } from "react";

export function Card({ children }: { children: ReactNode }) {
  return <section className="rp-card">{children}</section>;
}

export function CardHead({
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
    <div className="rp-card-head">
      <div>
        <h2 className="rp-card-title">
          {icon}
          {title}
        </h2>
        {description ? <p className="rp-card-desc">{description}</p> : null}
      </div>
      {actions ? <div className="rp-card-actions">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ children }: { children: ReactNode }) {
  return <div className="rp-card-body">{children}</div>;
}
