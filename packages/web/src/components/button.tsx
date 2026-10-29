import { cn } from "@/lib/utils";

export default function Button({
  children,
  onClick,
  disabled,
  className,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit" | "reset";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "bg-green text-bg px-4 py-2 rounded cursor-pointer disabled:cursor-default disabled:opacity-60 flex items-center justify-center gap-2",
        disabled && "opacity-60 cursor-default",
        className,
      )}
      aria-disabled={disabled}
    >
      {children}
    </button>
  );
}
