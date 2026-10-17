// Email via Resend's HTTP API. In dev (no key), links are logged to the console instead.

export type MailEnv = { RESEND_API_KEY?: string; MAIL_FROM?: string };

function layout(title: string, body: string, cta: { href: string; label: string }) {
  return `<!doctype html><html><body style="margin:0;background:#0b0b0f;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Inter,sans-serif;color:#e7e7ea">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
  <table width="100%" style="max-width:440px;background:#15151c;border:1px solid #26262f;border-radius:16px;padding:32px">
  <tr><td>
    <div style="font-size:28px">👟</div>
    <h1 style="font-size:20px;margin:12px 0 8px;color:#fff">${title}</h1>
    <p style="font-size:15px;line-height:1.5;color:#a1a1aa;margin:0 0 24px">${body}</p>
    <a href="${cta.href}" style="display:inline-block;background:#a3e635;color:#0b0b0f;font-weight:600;text-decoration:none;padding:12px 20px;border-radius:10px">${cta.label}</a>
    <p style="font-size:12px;color:#71717a;margin:24px 0 0">Or paste this link: <br><span style="word-break:break-all">${cta.href}</span></p>
  </td></tr></table></td></tr></table></body></html>`;
}

export async function sendMail(env: MailEnv, to: string, subject: string, html: string, text: string) {
  if (!env.RESEND_API_KEY) {
    console.log(`[mail:dev] to=${to} subject="${subject}"\n${text}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM || "Stomp Tally <steps@tahakhan.dev>", to: [to], subject, html, text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

export function loginEmail(link: string) {
  return {
    subject: "Your Stomp Tally login link",
    html: layout("Log in to Stomp Tally", "Tap the button to log in. This link works once and expires in 20 minutes.", { href: link, label: "Log in" }),
    text: `Log in to Stomp Tally (expires in 20 min): ${link}`,
  };
}

export function inviteEmail(link: string, inviter: string, group: string) {
  return {
    subject: `${inviter} invited you to ${group} on Stomp Tally`,
    html: layout(`Join ${group}`, `${inviter} added you to the step challenge. Lowest under 10k each day owes $5 toward the group meal.`, { href: link, label: "Accept invite" }),
    text: `${inviter} invited you to ${group} on Stomp Tally: ${link}`,
  };
}

export function confirmInviteEmail(link: string, group: string) {
  return {
    subject: `Confirm your email to join ${group}`,
    html: layout("Confirm it's you", `Tap to confirm your email and join ${group}. Expires in 20 minutes.`, { href: link, label: "Confirm & join" }),
    text: `Confirm and join ${group}: ${link}`,
  };
}
