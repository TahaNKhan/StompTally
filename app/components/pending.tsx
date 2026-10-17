import { useEffect, type ComponentProps, type ReactNode } from "react";
import { useFetchers, useNavigation } from "react-router";
import { getPendingMessage } from "../lib/pending";

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return <span aria-hidden="true" className={`pending-spinner inline-block shrink-0 rounded-full border-2 border-current border-r-transparent ${className}`} />;
}

/** Busy lasts through the write AND loader revalidation; no fake timer or optimistic success. */
export function PendingButton({ busy, pendingLabel = "Saving…", children, disabled, ...props }: ComponentProps<"button"> & {
  busy: boolean;
  pendingLabel?: string;
  children: ReactNode;
}) {
  return (
    <button {...props} disabled={disabled || busy} aria-busy={busy}>
      {busy ? <><Spinner />{pendingLabel}</> : children}
    </button>
  );
}

export function PendingBoundary({ children }: { children: ReactNode }) {
  const navigation = useNavigation();
  const fetchers = useFetchers();
  const message = getPendingMessage(navigation, fetchers);
  const busy = message !== null;
  useEffect(() => {
    if (!busy) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [busy]);

  return (
    <>
      {/* inert blocks pointer and keyboard resubmissions without disabling fields or losing form values. */}
      <div inert={busy} aria-busy={busy} data-testid="page-content">{children}</div>
      {busy && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink/75 p-6 backdrop-blur-sm" data-testid="pending-screen">
          <div role="status" aria-live="polite" aria-atomic="true" className="w-full max-w-xs rounded-2xl border border-lime/20 bg-panel p-7 text-center shadow-2xl">
            <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-lime/10 text-lime">
              <Spinner className="h-7 w-7" />
            </div>
            <p className="font-display text-lg font-bold text-zinc-100">{message}</p>
            <p className="mt-2 text-sm text-muted">Hang tight. No need to tap again.</p>
          </div>
        </div>
      )}
    </>
  );
}
