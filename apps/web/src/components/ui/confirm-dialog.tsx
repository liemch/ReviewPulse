"use client";

import { useId, useRef } from "react";

import { Button } from "@/components/ui/button";

/**
 * Confirmation before a destructive form POST. The form keeps the same action
 * and hidden fields as the inline version, so CSRF handling is unchanged.
 */
export function ConfirmDialog({
  action,
  fields,
  triggerLabel,
  triggerIcon,
  title,
  description,
  confirmLabel,
  triggerVariant = "danger",
  confirmVariant = "danger",
}: {
  action: string;
  fields: Record<string, string>;
  triggerLabel: string;
  triggerIcon?: React.ReactNode;
  title: string;
  description: string;
  confirmLabel: string;
  triggerVariant?: "danger" | "primary" | "ghost";
  confirmVariant?: "danger" | "primary" | "ghost";
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  return (
    <>
      <Button
        variant={triggerVariant}
        size="sm"
        onClick={() => dialogRef.current?.showModal()}
      >
        {triggerIcon}
        {triggerLabel}
      </Button>
      <dialog
        ref={dialogRef}
        className="rp-dialog"
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        <form method="post" action={action} className="rp-dialog-body">
          {Object.entries(fields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <h2 className="rp-dialog-title" id={titleId}>
            {title}
          </h2>
          <p className="rp-dialog-desc" id={descId}>
            {description}
          </p>
          <div className="rp-dialog-actions">
            <Button
              variant="ghost"
              onClick={() => dialogRef.current?.close()}
            >
              Hủy
            </Button>
            <Button variant={confirmVariant} type="submit">
              {confirmLabel}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
