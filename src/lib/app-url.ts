// Single source of truth for the app's public base URL. Several integrations bake this into URLs
// they store on their side — Square's OAuth redirect, Supabase's email confirmation link, Postmark's
// inbound webhook — so a mismatch here breaks sign-in in ways that are annoying to trace.
//
// Set APP_BASE_URL in the environment; the fallback below is only for local/unset cases. When the
// custom domain is live, change the fallback here (one line) rather than in each caller.

const FALLBACK = 'https://punctum-production.up.railway.app';

export function appBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.APP_BASE_URL || FALLBACK).replace(/\/$/, '');
}
