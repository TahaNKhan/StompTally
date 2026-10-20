import { useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Avatar, ErrorNote, Notice } from "./ui";
import { PendingButton } from "./pending";
import { resizeToAvatar } from "../lib/avatar-resize";

type Action = { avatar?: "saved" | "removed"; error?: string };

/** One photo per person: Upload replaces it, Remove deletes it. */
export function AvatarUpload({ userId, name, version }: { userId: string; name: string; version: number | null }) {
  const fetcher = useFetcher<Action>();
  const input = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const busy = preparing || fetcher.state !== "idle";

  async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // picking the same file again must still fire change
    if (!file) return;
    setLocalError(null);
    setPreparing(true);
    try {
      const photo = await resizeToAvatar(file);
      const body = new FormData();
      body.set("intent", "avatar-upload");
      body.set("photo", photo, "avatar.jpg");
      fetcher.submit(body, { method: "post", encType: "multipart/form-data" });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Couldn't prepare that photo.");
    } finally {
      setPreparing(false);
    }
  }

  const saved = fetcher.data?.avatar === "saved";
  const removed = fetcher.data?.avatar === "removed";

  return (
    <section className="card p-5 rise">
      <h2 className="font-display text-lg font-bold">Photo</h2>
      <p className="mt-1 text-sm text-muted">One photo at a time. Only your group can see it.</p>
      <div className="mt-4 flex items-center gap-4">
        <Avatar id={userId} name={name} size={72} version={version} />
        <div className="flex flex-wrap gap-2">
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" className="sr-only" onChange={onPick} aria-label="Choose a photo" />
          <PendingButton type="button" className="btn-primary" busy={busy} pendingLabel="Saving…" onClick={() => input.current?.click()}>
            {version != null ? "Replace photo" : "Upload photo"}
          </PendingButton>
          {version != null && (
            <fetcher.Form method="post" onSubmit={(event) => !confirm("Delete your photo? This can't be undone.") && event.preventDefault()}>
              <input type="hidden" name="intent" value="avatar-delete" />
              <PendingButton className="btn-danger" busy={busy} pendingLabel="Deleting…">Delete</PendingButton>
            </fetcher.Form>
          )}
        </div>
      </div>
      {saved && <Notice>Photo saved.</Notice>}
      {removed && <Notice>Photo deleted.</Notice>}
      <ErrorNote error={localError ?? fetcher.data?.error ?? null} />
    </section>
  );
}
