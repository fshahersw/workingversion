# Site-wide login (email + password, no sign-up)

Lock the whole app behind a single login screen. Only accounts you approve can sign in; there is no public sign-up, no social login, no magic links.

## What changes for users

- Visiting any page while signed out lands on `/auth` — a clean Seeger Weiss branded login card (logo, email, password, "Sign in").
- After signing in, the user goes to the page they originally requested (default: Home).
- Wrong credentials show an inline error; no account creation path exists anywhere in the UI.
- The sidebar footer gains the signed-in email plus a "Sign out" action.
- `fshaher@seegerweiss.com` is created as the first account. You'll set the password (I'll generate a temporary one and you can change it, or you tell me the password to set).

## What does not change

Research, Matters, ingestion, RAG, agents, the corpus database, and the in-flight embedding job are all untouched. Login uses the app's own auth backend, separate from the corpus database.

## Technical outline

1. **Auth backend**: enable email/password on the managed auth project (`sqzmsvntyallbhthlbev`), signups disabled, no anonymous users, auto-confirm off (the account is created pre-confirmed via the admin API). No profiles table — `local-profile.ts` keeps handling name/title/avatar.
2. **Route restructure**: move `index.tsx`, `research.tsx`, `matters.index.tsx`, `matters.$slug.tsx`, `eval.tsx`, and the `/conversations` redirect under `src/routes/_authenticated/`, and add the integration-managed `_authenticated/route.tsx` gate (`ssr: false`, redirect to `/auth`) in the same edit. Because the signed-in home becomes `/_authenticated/index.tsx`, the old public `src/routes/index.tsx` is removed at the same moment to avoid a duplicate-route build error. Server API routes under `src/routes/api/*` stay where they are.
3. **`/auth` route**: new public route with the login form, calling `supabase.auth.signInWithPassword`. Redirects to `redirect` search param (validated same-origin) or `/` when already signed in.
4. **`use-auth.ts`**: replace the placeholder with the real hook (`session`, `user`, `loading`, `signIn`, `signOut`) backed by the browser Supabase client — same shape, so `app-shell.tsx` and `HomeDashboard.tsx` keep working.
5. **Root wiring**: one `onAuthStateChange` subscriber in `__root.tsx` filtered to SIGNED_IN / SIGNED_OUT / USER_UPDATED that invalidates the router and query cache; register the bearer `functionMiddleware` in `src/start.ts`.
6. **Sign-out hygiene**: cancel queries, clear cache, `signOut()`, then `navigate({ to: "/auth", replace: true })`.
7. **Verify**: typecheck plus a headless browser pass — signed-out hits `/auth`, bad password errors, good password reaches Home, sign-out returns to `/auth` and Back does not restore the app.

## Note

This gates the UI. The agent/API server routes stay callable directly; if you want those authenticated too, that's a follow-up pass.
