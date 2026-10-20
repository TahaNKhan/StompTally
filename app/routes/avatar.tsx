import type { Route } from "./+types/avatar";
import { db, requireMember } from "../lib/http.server";
import { loadAvatar } from "../lib/avatars";

/** Resource route: serves one member's photo to people in the same group. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { user } = await requireMember(request);
  const avatar = await loadAvatar(db(), user.id, params.userId);
  if (!avatar) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(avatar.bytes.buffer.slice(avatar.bytes.byteOffset, avatar.bytes.byteOffset + avatar.bytes.byteLength) as ArrayBuffer, {
    headers: {
      "Content-Type": avatar.contentType,
      "X-Content-Type-Options": "nosniff",
      // The URL carries ?v=updated_at, so a new upload gets a new URL and old copies never go stale.
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
