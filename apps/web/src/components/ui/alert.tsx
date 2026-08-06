import type { ReactNode } from "react";

import {
  IconAlertCircle,
  IconCheckCircle,
  IconInfo,
} from "@/components/icons";

export type AlertTone = "success" | "danger" | "warning" | "info";

function toneIcon(tone: AlertTone) {
  if (tone === "success") {
    return <IconCheckCircle size={17} />;
  }
  if (tone === "info") {
    return <IconInfo size={17} />;
  }
  return <IconAlertCircle size={17} />;
}

export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: AlertTone;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`rp-alert rp-alert--${tone}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      {toneIcon(tone)}
      <div>
        {title ? <div className="rp-alert-title">{title}</div> : null}
        {children ? <div>{children}</div> : null}
      </div>
    </div>
  );
}
