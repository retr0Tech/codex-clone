"use client";

import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "../ui/cn";

/**
 * The two controls `ui/Field` does not have yet.
 *
 * Kept here rather than added to the shared file for a reason that is about
 * merge order rather than taste: milestone 9 and milestone 8 are being built in
 * parallel and `ui/Field.tsx` is a file they would both be editing. The styling
 * is lifted verbatim from `CONTROL` there, so the day one of these earns its
 * place in the shared set it moves without changing how it looks.
 */

const CONTROL =
  "w-full bg-surface text-fg border border-border-strong rounded-lg " +
  "placeholder:text-fg-faint transition-colors hover:border-fg-faint " +
  "disabled:opacity-50 disabled:pointer-events-none";

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(CONTROL, "h-9 px-3 text-[13.5px]", className)} {...props} />;
}

/**
 * A checkbox with its explanation attached.
 *
 * The hint is not decoration: "skip if the previous execution is still running"
 * and "fire once on recovery" are choices whose consequences are invisible
 * until the night they matter, so the box says what it will do.
 */
export function CheckField({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={cn("flex items-start gap-2.5", disabled && "opacity-50")}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-3.5 shrink-0 accent-[var(--accent,currentColor)]"
      />
      <span className="min-w-0">
        <span className="block text-[13px] leading-5">{label}</span>
        {hint ? <span className="block text-[11.5px] leading-4 text-fg-faint">{hint}</span> : null}
      </span>
    </label>
  );
}
