import { Outlet, useLoaderData } from "react-router";
import type { Route } from "./+types/_app";
import { Shell } from "../components/ui";
import { requireMember } from "../lib/http.server";

export async function loader({ request }: Route.LoaderArgs) {
  const { user, group, role } = await requireMember(request);
  return { user, groupName: group.name, isAdmin: role === "admin" };
}

export default function AppLayout() {
  const { user, groupName, isAdmin } = useLoaderData<typeof loader>();
  return (
    <Shell user={user} groupName={groupName} isAdmin={isAdmin}>
      <Outlet />
    </Shell>
  );
}
