interface GlobalLoadingProps {
  label?: string;
  overlay?: boolean;
}

export function GlobalLoading({
  label = "Loading your workspace…",
  overlay = false
}: GlobalLoadingProps) {
  return (
    <div
      aria-live="polite"
      aria-label={label}
      className={
        overlay
          ? "fixed inset-0 z-50 grid place-items-center bg-white/90 backdrop-blur-sm"
          : "grid min-h-screen place-items-center bg-zinc-50"
      }
      role="status"
    >
      <div className="flex flex-col items-center gap-4">
        <span
          aria-hidden="true"
          className="h-10 w-10 animate-spin rounded-full border-4 border-zinc-200 border-t-violet-600"
        />
        <p className="text-sm font-medium text-zinc-600">{label}</p>
      </div>
    </div>
  );
}
