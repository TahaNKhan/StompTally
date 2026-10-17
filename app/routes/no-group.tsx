import { AuthCard, LogoutButton } from "../components/ui";

export default function NoGroup() {
  return (
    <AuthCard title="No group yet" subtitle="You're logged in but not in a group. Ask the admin for an invite.">
      <LogoutButton />
    </AuthCard>
  );
}
