// Pure UI state: background refreshes are intentionally not treated as user actions.
export type PendingRequest = {
  state: string;
  formMethod?: string;
  formAction?: string;
  formData?: Pick<FormData, "get">;
};

export function pendingLabel(request: PendingRequest): string {
  const path = (request.formAction ?? "").split("?")[0];
  if (path.startsWith("/auth/")) return "Logging you in…";
  if (path === "/login" || path.startsWith("/invite/")) return "Sending your email…";
  if (path === "/logout") return "Logging out…";
  if (path === "/setup") return "Creating your group…";
  const intent = request.formData?.get("intent");
  switch (intent) {
    case "manual": return "Saving your steps…";
    case "skip": return "Claiming your skip…";
    case "unskip": return "Undoing your skip…";
    case "invite": return "Sending your invite…";
    case "revoke": return "Revoking the invite…";
    case "remove": return "Removing the member…";
    case "correct": return "Updating the steps…";
    case "settings": return "Saving the rules…";
    case "settle":
    case "unsettle": return "Updating the ledger…";
    default: return "Saving your changes…";
  }
}

export function getPendingMessage(navigation: PendingRequest, fetchers: PendingRequest[]): string | null {
  if (navigation.state !== "idle") {
    return navigation.formMethod && navigation.formMethod.toUpperCase() !== "GET"
      ? pendingLabel(navigation)
      : "Loading your page…";
  }
  const mutation = fetchers.find((f) => f.state !== "idle" && f.formMethod && f.formMethod.toUpperCase() !== "GET");
  return mutation ? pendingLabel(mutation) : null;
}
