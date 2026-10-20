import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Db } from "./db";
import { deleteAvatar, loadAvatar, MAX_AVATAR_BYTES, saveAvatar, sniffImageType } from "./avatars";
import { AppError } from "./service";

const JPEG = (n = 40) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: n }, (_, i) => i % 251)]);
const PNG = () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WEBP = () => Uint8Array.from([...Buffer.from("RIFF"), 4, 0, 0, 0, ...Buffer.from("WEBP"), 1, 2]);
const NOW = 1_000_000;

function fixture() {
  const sql = new DatabaseSync(":memory:");
  sql.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sql.exec(readFileSync(new URL(file, dir), "utf8"));
  // node:sqlite hands blobs back as Uint8Array; D1 returns number[]. Mimic D1 so the decode path is exercised.
  const toD1 = (row: any) => row && row.image instanceof Uint8Array ? { ...row, image: Array.from(row.image) } : row;
  const db: Db = {
    async all(q, ...p) { return sql.prepare(q).all(...p as any[]) as any; },
    async first(q, ...p) { return toD1(sql.prepare(q).get(...p as any[])) ?? null; },
    async run(q, ...p) { return { changes: Number(sql.prepare(q).run(...p as any[]).changes) }; },
    async batch() {},
    async query() { return []; },
  };
  for (const [id, name] of [["a", "Ann"], ["b", "Ben"], ["c", "Cy"]]) sql.prepare("INSERT INTO users VALUES (?,?,?,?)").run(id, `${id}@example.com`, name, NOW);
  sql.prepare("INSERT INTO groups (id,name,timezone,start_date,created_at) VALUES (?,?,?,?,?)").run("g", "Crew", "UTC", "2026-10-01", NOW);
  sql.prepare("INSERT INTO groups (id,name,timezone,start_date,created_at) VALUES (?,?,?,?,?)").run("h", "Other", "UTC", "2026-10-01", NOW);
  sql.exec("INSERT INTO memberships VALUES ('g','a','admin','2026-10-01',NULL),('g','b','member','2026-10-01',NULL),('h','c','admin','2026-10-01',NULL)");
  const rows = (id: string) => (sql.prepare("SELECT COUNT(*) AS n FROM user_avatars WHERE user_id=?").get(id) as { n: number }).n;
  return { db, sql, rows };
}

describe("image type sniffing", () => {
  it("reads the type from the bytes", () => {
    expect(sniffImageType(JPEG())).toBe("image/jpeg");
    expect(sniffImageType(PNG())).toBe("image/png");
    expect(sniffImageType(WEBP())).toBe("image/webp");
  });
  it.each([
    ["text", Uint8Array.from(Buffer.from("<script>alert(1)</script>"))],
    ["svg", Uint8Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))],
    ["gif", Uint8Array.from(Buffer.from("GIF89a...."))],
    ["riff but not webp", Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")])],
    ["empty", new Uint8Array()],
  ])("rejects %s", (_name, bytes) => {
    expect(sniffImageType(bytes)).toBeNull();
  });
});

describe("one photo per person: upload, delete, upload another", () => {
  it("stores a photo and reads it back unchanged", async () => {
    const f = fixture();
    const photo = JPEG();
    await saveAvatar(f.db, "a", photo, NOW);
    const got = await loadAvatar(f.db, "a", "a");
    expect(got?.contentType).toBe("image/jpeg");
    expect([...got!.bytes]).toEqual([...photo]);
    expect(got?.updatedAt).toBe(NOW);
  });

  it("a second upload replaces the first and never leaves two rows", async () => {
    const f = fixture();
    await saveAvatar(f.db, "a", JPEG(), NOW);
    await saveAvatar(f.db, "a", PNG(), NOW + 1);
    expect(f.rows("a")).toBe(1);
    const got = await loadAvatar(f.db, "a", "a");
    expect(got?.contentType).toBe("image/png");
    expect(got?.updatedAt).toBe(NOW + 1);
  });

  it("delete really removes the row and its bytes", async () => {
    const f = fixture();
    await saveAvatar(f.db, "a", JPEG(), NOW);
    expect(await deleteAvatar(f.db, "a")).toEqual({ removed: true });
    expect(f.rows("a")).toBe(0);
    expect(await loadAvatar(f.db, "a", "a")).toBeNull();
    expect(f.sql.prepare("SELECT COUNT(*) AS n FROM user_avatars").get()).toEqual({ n: 0 });
  });

  it("upload, delete, then upload another leaves exactly the new one", async () => {
    const f = fixture();
    await saveAvatar(f.db, "a", JPEG(), NOW);
    await deleteAvatar(f.db, "a");
    await saveAvatar(f.db, "a", WEBP(), NOW + 5);
    expect(f.rows("a")).toBe(1);
    expect((await loadAvatar(f.db, "a", "a"))?.contentType).toBe("image/webp");
  });

  it("deleting with no photo is harmless", async () => {
    const f = fixture();
    expect(await deleteAvatar(f.db, "a")).toEqual({ removed: false });
  });

  it("the database itself refuses a second row for the same person", () => {
    const f = fixture();
    const insert = () => f.sql.prepare("INSERT INTO user_avatars VALUES ('a', X'ffd8ff', 'image/jpeg', 3, 1)").run();
    insert();
    expect(insert).toThrow(/UNIQUE|PRIMARY/);
  });

  it("deleting a user removes their photo", () => {
    const f = fixture();
    f.sql.prepare("INSERT INTO user_avatars VALUES ('c', X'ffd8ff', 'image/jpeg', 3, 1)").run();
    f.sql.prepare("DELETE FROM users WHERE id='c'").run();
    expect(f.rows("c")).toBe(0);
  });
});

describe("bad uploads", () => {
  it.each([
    ["empty file", new Uint8Array(), 400],
    ["not an image", Uint8Array.from(Buffer.from("hello world, not an image")), 400],
    ["too big", (() => { const b = JPEG(); const big = new Uint8Array(MAX_AVATAR_BYTES + 1); big.set(b); return big; })(), 413],
  ])("rejects %s and keeps the old photo", async (_name, bytes, status) => {
    const f = fixture();
    await saveAvatar(f.db, "a", JPEG(), NOW);
    await expect(saveAvatar(f.db, "a", bytes, NOW + 1)).rejects.toMatchObject({ status });
    await expect(saveAvatar(f.db, "a", bytes, NOW + 1)).rejects.toBeInstanceOf(AppError);
    expect(f.rows("a")).toBe(1);
    expect((await loadAvatar(f.db, "a", "a"))?.updatedAt).toBe(NOW);
  });

  it("accepts a photo exactly at the size cap", async () => {
    const f = fixture();
    const exact = new Uint8Array(MAX_AVATAR_BYTES); exact.set(JPEG());
    await saveAvatar(f.db, "a", exact, NOW);
    expect(f.rows("a")).toBe(1);
  });
});

describe("who can see a photo", () => {
  it("group members see each other's photos", async () => {
    const f = fixture();
    await saveAvatar(f.db, "a", JPEG(), NOW);
    expect(await loadAvatar(f.db, "b", "a")).not.toBeNull();
  });
  it("people in other groups see nothing", async () => {
    const f = fixture();
    await saveAvatar(f.db, "a", JPEG(), NOW);
    expect(await loadAvatar(f.db, "c", "a")).toBeNull();
  });
  it("a person who left the group no longer sees photos", async () => {
    const f = fixture();
    await saveAvatar(f.db, "a", JPEG(), NOW);
    f.sql.exec("UPDATE memberships SET left_date='2026-10-05' WHERE user_id='b'");
    expect(await loadAvatar(f.db, "b", "a")).toBeNull();
  });
  it("you can always see your own, even with no group", async () => {
    const f = fixture();
    await saveAvatar(f.db, "c", PNG(), NOW);
    f.sql.exec("DELETE FROM memberships WHERE user_id='c'");
    expect(await loadAvatar(f.db, "c", "c")).not.toBeNull();
  });
});
