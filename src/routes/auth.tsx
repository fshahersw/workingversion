import { createFileRoute } from "@tanstack/react-router";

import logoAsset from "@/assets/sw-logo.asset.json";

type Search = { redirect?: string };

export const Route = createFileRoute("/auth")({
  validateSearch: (raw: Record<string, unknown>): Search => ({
    redirect: typeof raw["redirect"] === "string" ? raw["redirect"] : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Sign in — Seeger Weiss Litigation Intelligence" },
      {
        name: "description",
        content: "Secure sign-in for the Seeger Weiss litigation research and matter workspace.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const search = Route.useSearch();
  const loginHref = `/auth/login${
    search.redirect ? `?redirect=${encodeURIComponent(search.redirect)}` : ""
  }`;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 flex justify-center">
          <img src={logoAsset.url} alt="Seeger Weiss LLP" className="h-9 w-auto" />
        </div>

        <div className="rounded-lg border border-border/70 bg-card p-6 text-center shadow-sm">
          <p className="mb-5 text-[13.5px] text-muted-foreground">
            Sign in to the Seeger Weiss research workspace with your firm account.
          </p>
          {/* Full-page navigation (not client routing): /auth/login is a server
              route that starts the Cognito authorization-code + PKCE flow.
              Becomes "Sign in with Microsoft" once Entra is federated. */}
          <a
            href={loginHref}
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-brand-navy text-[13.5px] font-medium text-white transition-opacity hover:opacity-90"
          >
            Sign in
          </a>
        </div>

        <p className="mt-4 text-center text-[11px] text-muted-foreground/70">
          Seeger Weiss LLP — authorized users only.
        </p>
      </div>
    </main>
  );
}
