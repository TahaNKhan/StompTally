import type { Db } from "./db";
import { AppError } from "./service";

/** The browser shrinks photos to 256 px first, so real uploads are far below this cap. */
export const MAX_AVATAR_BYTES = 65536;

export type AvatarType = "image/jpeg" | "image/png" | "image/webp";
export type StoredAvatar = { bytes: Uint8Array; contentType: AvatarType; updatedAt: number };

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) => signature.every((b, i) => bytes[offset + i] === b);
const ascii = (bytes: Uint8Array, text: string, offset: number) => [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));

/** The type comes from the file's own bytes, never from what the client claims. */
export function sniffImageType(bytes: Uint8Array): AvatarType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (bytes.length >= 12 && ascii(bytes, "RIFF", 0) && ascii(bytes, "WEBP", 8)) return "image/webp";
  return null;
}

/** Replaces any existing photo in one statement, so a person never has two. */
export async function saveAvatar(db: Db, userId: string, bytes: Uint8Array, now = Date.now()) {
  if (bytes.length === 0) throw new AppError(400, "Choose a photo first.");
  if (bytes.length > MAX_AVATAR_BYTES) throw new AppError(413, "That photo is too big. Try a smaller one.");
  const contentType = sniffImageType(bytes);
  if (!contentType) throw new AppError(400, "Use a JPEG, PNG or WebP photo.");
  await db.run(
    `INSERT INTO user_avatars (user_id, image, content_type, byte_size, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET image=excluded.image, content_type=excluded.content_type,
       byte_size=excluded.byte_size, updated_at=excluded.updated_at`,
    userId, bytes, contentType, bytes.length, now);
  return { updatedAt: now };
}

/** Really deletes the row, so the bytes are gone from D1. */
export async function deleteAvatar(db: Db, userId: string) {
  const { changes } = await db.run("DELETE FROM user_avatars WHERE user_id = ?", userId);
  return { removed: changes > 0 };
}

/** Only people in the viewer's group are visible. Anyone else reads as "no photo". */
export async function loadAvatar(db: Db, viewerId: string, ownerId: string): Promise<StoredAvatar | null> {
  const row = await db.first<{ image: ArrayBuffer | number[]; content_type: AvatarType; updated_at: number }>(
    `SELECT a.image, a.content_type, a.updated_at FROM user_avatars a
     WHERE a.user_id = ?2 AND (a.user_id = ?1 OR EXISTS (
       SELECT 1 FROM memberships v JOIN memberships o ON o.group_id = v.group_id
       WHERE v.user_id = ?1 AND v.left_date IS NULL AND o.user_id = ?2 AND o.left_date IS NULL))`,
    viewerId, ownerId);
  if (!row) return null;
  const bytes = row.image instanceof ArrayBuffer ? new Uint8Array(row.image) : Uint8Array.from(row.image);
  return { bytes, contentType: row.content_type, updatedAt: row.updated_at };
}
