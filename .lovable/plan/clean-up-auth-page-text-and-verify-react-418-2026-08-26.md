# Clean up auth page text and verify React #418

## What to change

Remove the following text from `src/routes/auth.tsx`:

- The `<h1>` heading **"Sign in"**.
- The subtext **"Litigation Intelligence is restricted to authorized Seeger Weiss personnel."**.
- The footer paragraph **"Access is provisioned by the firm. Contact your administrator for an account."**.

The page will keep the Seeger Weiss logo, the email/password form, inline error messaging, and the loading spinner.

## About the React #418 error

React error #418 is a hydration-mismatch warning ("Expected server HTML to contain a matching ..."). The `/auth` route is already set to `ssr: false`, so the auth page should not itself be server-rendered. The mismatch is likely coming from one of these places:

1. The root layout (`src/routes/__root.tsx`) is still rendered during SSR and may contain content that differs between server and client (e.g., `localStorage` profile data, auth state, or time/date values).
2. A browser extension or Lovable preview overlay is injecting DOM nodes into the rendered tree before React hydrates.
3. The dev server is serving a stale SSR shell from before the recent route/auth changes.

Plan verification step: after the auth text change, run a typecheck and a fresh browser pass while watching the console. If #418 persists, inspect the dev-server log and the SSR-rendered markup to locate the mismatch and either move client-only state behind a hydration-safe guard or force a dev-server restart.

## Verification

- TypeScript passes.
- `/auth` renders without the removed text.
- No new console errors (especially #418) after a hard refresh.
