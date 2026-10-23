import { Outlet, useMatches } from "react-router";
import { Shell } from "../components/ui";
import { OfflineBar } from "../components/offline-bar";
import { FreshnessLine } from "../components/refresh";

// Each page returns shell data from its own DB read. No duplicate layout lookup.
type ShellData = { user: { id: string; name: string }; groupName: string; isAdmin: boolean; myAvatar: number | null };

export default function AppLayout() {
  const shell = useMatches()
    .map((m) => (m.loaderData as { shell?: ShellData } | undefined)?.shell)
    .find(Boolean);
  if (!shell) return <Outlet />;
  return (
    <Shell user={shell.user} groupName={shell.groupName} isAdmin={shell.isAdmin} myAvatar={shell.myAvatar}>
      <OfflineBar />
      <FreshnessLine />
      <Outlet />
    </Shell>
  );
}
