// Secrets (set with `wrangler secret put`, or .dev.vars locally) aren't in wrangler.jsonc,
// so `wrangler types` can't see them. Declare them here.
declare namespace Cloudflare {
  interface Env {
    RESEND_API_KEY?: string;
    SETUP_KEY: string;
  }
}
