// Shared UI bits.
import { Form, Link, NavLink, useNavigation } from "react-router";
import { PendingButton } from "./pending";
import { InstallBanner } from "./install-banner";

const PALETTE = ["#b6f35c", "#7cc4ff", "#ffc857", "#ff8fab", "#c4a7ff", "#5eead4", "#fdba74"];

export function colorFor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** `version` is the photo's updated_at. Omit it (or pass null) to show initials. */
export function Avatar({ id, name, size = 36, ring, version }: { id: string; name: string; size?: number; ring?: string; version?: number | null }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      className="relative inline-grid shrink-0 place-items-center overflow-hidden rounded-full font-display font-bold text-[#09090c]"
      style={{ width: size, height: size, background: colorFor(id), fontSize: size * 0.38, boxShadow: ring ? `0 0 0 2px var(--color-ink), 0 0 0 4px ${ring}` : undefined }}
      title={name}
    >
      {initials}
      {version != null && (
        <img
          src={`/avatar/${encodeURIComponent(id)}?v=${version}`}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
          onError={(event) => { event.currentTarget.style.display = "none"; }}
        />
      )}
    </span>
  );
}

export const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
export const fmtSteps = (n: number | null | undefined) => (n == null ? "–" : n.toLocaleString("en-US"));

export function timeAgo(ts: number | null, now = Date.now()) {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function Shell({ children, user, groupName, isAdmin, myAvatar }: { children: React.ReactNode; user: { id: string; name: string }; groupName: string; isAdmin: boolean; myAvatar?: number | null }) {
  const tabs = [
    { to: "/", label: "Today", icon: "🔥", end: true },
    { to: "/month", label: "Month", icon: "📅" },
    { to: "/history", label: "Ledger", icon: "💸" },
    { to: "/me", label: "Me", icon: "👟" },
  ];
  return (
    <div className="page-top mx-auto min-h-dvh max-w-2xl px-4 pb-28">
      <header className="flex items-center justify-between py-3">
        <Link to="/" className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-lime text-lg">👟</span>
          <div className="leading-tight">
            <div className="font-display text-[17px] font-bold tracking-tight">Stomp Tally</div>
            <div className="text-xs text-muted">{groupName}</div>
          </div>
        </Link>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <NavLink to="/group" className={({ isActive }) => `btn-ghost !px-3 !py-2 ${isActive ? "!border-lime/50 text-lime" : ""}`}>
              ⚙️ <span className="hidden sm:inline">Group</span>
            </NavLink>
          )}
          <Link to="/me">
            <Avatar id={user.id} name={user.name} size={36} version={myAvatar} />
          </Link>
        </div>
      </header>
      <InstallBanner />
      <main className="mt-2 space-y-3">{children}</main>
      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-ink/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl">
        <div className="mx-auto grid max-w-2xl grid-cols-4">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) => `flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium transition ${isActive ? "text-lime" : "text-muted hover:text-soft"}`}
            >
              <span className="text-xl leading-none">{t.icon}</span>
              {t.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}

export function AuthCard({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle?: React.ReactNode }) {
  return (
    <main className="mx-auto grid min-h-dvh max-w-md place-items-center p-5">
      <div className="w-full rise">
        <div className="mb-8 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-lime text-3xl shadow-[0_0_60px_-10px_#b6f35c]">👟</div>
          <h1 className="mt-5 font-display text-3xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-2 text-muted">{subtitle}</p>}
        </div>
        <div className="card p-6">{children}</div>
      </div>
    </main>
  );
}

export function ErrorNote({ error }: { error?: string | null }) {
  if (!error) return null;
  return <p className="mt-3 rounded-xl border border-coral/30 bg-coral/10 px-3 py-2 text-sm text-coral">{error}</p>;
}

export function Notice({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 rounded-xl border border-lime/30 bg-lime/10 px-3 py-2 text-sm text-lime">{children}</p>;
}

export function LogoutButton() {
  const navigation = useNavigation();
  return (
    <Form method="post" action="/logout">
      <PendingButton className="btn-ghost w-full" busy={navigation.state !== "idle"} pendingLabel="Logging out…">Log out</PendingButton>
    </Form>
  );
}
