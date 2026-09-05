# SeegerWeissAI auth — Cognito wiring (local dev)

Replaces Supabase auth with **AWS Cognito** (authorization-code + PKCE, session in
an httpOnly cookie). Microsoft Entra can be federated into the same Cognito pool
later with no change to this code (add the IdP, link by email; the sign-in button
becomes "Sign in with Microsoft").

## Files added

- `src/lib/auth/cognito.server.ts` — server-only: config (env + dev defaults),
  PKCE, code/refresh exchange, id-token verification (jose + Cognito JWKS),
  cookie helpers, `getUserFromRequest`.
- `src/lib/auth/require-auth.ts` — `requireAuth` / `requireAdmin` serverFn
  middleware (replaces `requireSupabaseAuth`).
- `src/routes/auth.login.ts` — GET /auth/login: start PKCE flow, 302 to Cognito.
- `src/routes/auth.callback.ts` — GET /auth/callback: verify state, exchange code,
  set session cookie, 302 back.
- `src/routes/auth.logout.ts` — GET /auth/logout: clear cookies, 302 to Cognito logout.
- `src/routes/api/auth/me.ts` — GET /api/auth/me: `{ user }` from the cookie, or 401.

## Files changed

- `src/routes/_authenticated/route.tsx` — gate now checks `/api/auth/me` instead
  of `supabase.auth.getUser()`.
- `src/lib/use-auth.ts` — reads `/api/auth/me`; `signIn()`→/auth/login,
  `signOut()`→/auth/logout. `user` shape is now `{ sub, email, name, role, groups }`.
- `src/routes/auth.tsx` — email/password form replaced by a "Sign in" button to
  the Cognito flow.
- `src/start.ts` — removed the Supabase bearer-attacher (cookie auto-rides).
- `package.json` — added `jose`.

## Config (env, with dev defaults baked in)

`COGNITO_REGION=us-east-1`, `COGNITO_USER_POOL_ID=us-east-1_D7NX6OyAR`,
`COGNITO_CLIENT_ID=3ab10qboajkm0vc36lcv59k78m`,
`COGNITO_DOMAIN=seegerweissai-auth.auth.us-east-1.amazoncognito.com`,
`COGNITO_REDIRECT_URI=http://localhost:8080/auth/callback`,
`COGNITO_LOGOUT_URI=http://localhost:8080/`. No env needed for local dev; override
per environment (e.g., when hosting moves to AWS + a seegerweiss.com subdomain,
set the new redirect/logout URIs and add them to the Cognito app client).

## Run / test locally

```
cd lit-ai-extracted/lit-ai-main
bun install        # pulls jose
bun dev            # http://localhost:8080
```

Go to `/auth` -> Sign in -> Cognito hosted UI -> (first login: set password, opt
TOTP) -> redirected back signed in. `/api/auth/me` should return your user with
`role: "admin"`.

## Two things that may need a first-run tweak

1. **Route convention.** `/auth/login|callback|logout` are server-only routes
   (no component) using dot-notation files. If the TanStack router plugin
   complains they need a component, move them under `src/routes/api/auth/`
   (proven pattern, like `api/public/intel/run.ts`) and update the Cognito app
   client callback URL to `http://localhost:8080/api/auth/callback`:
   `aws cognito-idp update-user-pool-client --user-pool-id us-east-1_D7NX6OyAR --client-id 3ab10qboajkm0vc36lcv59k78m --callback-urls http://localhost:8080/api/auth/callback --logout-urls http://localhost:8080/ --allowed-o-auth-flows code --allowed-o-auth-scopes openid email profile --allowed-o-auth-flows-user-pool-client --supported-identity-providers COGNITO --explicit-auth-flows ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH --region us-east-1`
2. **Data features break until Phase 2 (expected).** Login + the authenticated
   shell work now, but server functions still tied to the managed Supabase project
   for identity/data will fail because there is no Supabase session anymore. See below.

## Phase 2 — data re-home (NOT done yet)

These still reference the retired managed Supabase project and must move to the
corpus project + Cognito identity:
- `src/lib/pipeline.functions.ts` — 5 serverFns use `requireSupabaseAuth` + `context.supabase.auth.getUser()` -> switch to `requireAuth`, read `context.user`.
- `src/lib/research-history.ts`, `src/lib/research-workspace.ts`, `src/lib/review/review-db.ts` — use `supabase.auth.getUser()` for ownership -> key on the Cognito principal instead; recreate these app tables fresh on the corpus project keyed on the principal.
- `src/routes/__root.tsx` — `supabase.auth.onAuthStateChange` is now a harmless no-op; remove it.
- Browser-direct `supabase.from()/storage` calls -> route through the AWS-authed backend.
Once these move, the retired managed Supabase project and its env vars can be deleted.
