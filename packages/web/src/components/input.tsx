"use client";

import { cn } from "@/lib/utils";

export function Input({
  type = "text",
  placeholder,
  value,
  onChange,
  className,
}: {
  type?: "text" | "email" | "password";
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <input
      type={type}
      className={cn(
        "w-full p-2 rounded border border-border bg-bg-panel text-text text-sm focus:outline-none focus:ring-1 focus:ring-purple",
        className,
      )}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
