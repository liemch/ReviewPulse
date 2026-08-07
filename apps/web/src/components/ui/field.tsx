import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

export function Field({
  id,
  label,
  help,
  error,
  required = false,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="rp-field">
      <label className="rp-label" htmlFor={id}>
        {label}
        {required ? (
          <>
            {" "}
            <span className="rp-required" aria-hidden="true">
              *
            </span>
          </>
        ) : null}
      </label>
      {children}
      {help ? (
        <p className="rp-help" id={`${id}-help`}>
          {help}
        </p>
      ) : null}
      {error ? (
        <p className="rp-field-error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TextInput({
  id,
  help,
  invalid = false,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  help?: boolean;
  invalid?: boolean;
}) {
  return (
    <input
      {...props}
      id={id}
      className="rp-input"
      aria-invalid={invalid ? true : undefined}
      aria-describedby={help ? `${id}-help` : undefined}
    />
  );
}

export function Select({
  id,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { id: string }) {
  return (
    <select {...props} id={id} className="rp-select">
      {children}
    </select>
  );
}

export function TextArea({
  id,
  help,
  invalid = false,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  id: string;
  help?: boolean;
  invalid?: boolean;
}) {
  return (
    <textarea
      {...props}
      id={id}
      className="rp-input rp-textarea"
      aria-invalid={invalid ? true : undefined}
      aria-describedby={help ? `${id}-help` : undefined}
    />
  );
}

export function Checkbox({
  id,
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { id: string; label: string }) {
  return (
    <label className="rp-checkbox" htmlFor={id}>
      <input {...props} id={id} type="checkbox" />
      <span>{label}</span>
    </label>
  );
}
