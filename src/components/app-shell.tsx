import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Briefcase,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  FileSearch,
  Home,
  Library,
  LogOut,
  Menu,
  Search,
  X,
} from "lucide-react";
import { type ComponentType, type ReactNode, useEffect, useState } from "react";

import logoAsset from "@/assets/sw-logo.asset.json";
import logoMark from "@/assets/sw-logo-mark.png.asset.json";
import { MatterSelector } from "@/components/matters/MatterSelector";
import { useAuth } from "@/lib/use-auth";

type NavItem = {
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  to: string;
};

const primaryNav: readonly NavItem[] = [
  { icon: Home, label: "Home", to: "/" },
  { icon: Search, label: "Research", to: "/research" },
  { icon: CalendarDays, label: "Calendar", to: "/calendar" },
  { icon: FileSearch, label: "Discovery", to: "/docs" },
  { icon: Library, label: "Library", to: "/library" },
] as const;

const COLLAPSED_W = 60;
const EXPANDED_W = 196;

const transitionEase = "cubic-bezier(0.4,0,0.2,1)";

function NavRow({
  item,
  active,
  expanded,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  expanded: boolean;
  onClick?: () => void;
}) {
  return (
    <Link
      to={item.to}
      onClick={onClick}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      title={expanded ? undefined : item.label}
      className={[
        "group flex items-center transition-colors",
        expanded
          ? "h-9 w-full gap-3 rounded-lg px-3"
          : "mx-auto h-10 w-10 justify-center rounded-xl",
        active
          ? "bg-brand-blue-soft text-brand-navy"
          : "text-brand-navy/60 hover:bg-brand-blue-soft/60 hover:text-brand-navy",
      ].join(" ")}
    >
      <item.icon
        className={expanded ? "h-4 w-4 shrink-0" : "h-[18px] w-[18px] shrink-0"}
        strokeWidth={2}
      />
      {expanded && (
        <span className="truncate text-[12.5px] font-medium tracking-[-0.005em]">
          {item.label}
        </span>
      )}
    </Link>
  );
}

function SidebarInner({
  expanded,
  pathname,
  onNavigate,
  onToggle,
  showToggle,
  onSignOut,
  email,
  onOpenSelector,
}: {
  expanded: boolean;
  pathname: string;
  onNavigate?: () => void;
  onToggle?: () => void;
  showToggle: boolean;
  onSignOut?: () => void;
  email?: string | null;
  onOpenSelector?: () => void;
}) {
  const mattersActive = pathname.startsWith("/matters");
  return (
    <div className="relative flex h-full flex-col">
      {/* Logo / brand header */}
      <div
        className={[
          "flex h-14 shrink-0 items-center border-b border-border/60",
          expanded ? "px-3" : "justify-center px-2",
        ].join(" ")}
      >
        {expanded ? (
          <img
            src={logoAsset.url}
            alt="Seeger Weiss LLP"
            className="block h-auto w-full max-h-full object-contain object-left transition-opacity duration-300"
          />
        ) : (
          <img
            src={logoMark.url}
            alt="Seeger Weiss LLP"
            className="h-8 w-8 shrink-0 rounded-md object-contain transition-opacity duration-300"
          />
        )}
      </div>

      {/* Floating collapse/expand toggle on the sidebar edge */}
      {showToggle && (
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
          title={expanded ? "Collapse sidebar" : "Expand sidebar"}
          className="absolute -right-3.5 top-[88px] z-50 grid h-7 w-7 place-items-center rounded-full border border-border/70 bg-card text-brand-navy/60 shadow-sm transition-colors hover:bg-brand-blue-soft hover:text-brand-navy"
        >
          {expanded ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      )}

      {/* Nav */}
      <nav
        className={[
          "flex flex-1 flex-col gap-1",
          expanded ? "px-2 pt-3" : "items-center px-2 pt-3",
        ].join(" ")}
      >
        {expanded && (
          <p className="mb-1 px-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Workspace
          </p>
        )}

        {/* Home */}
        <NavRow
          item={primaryNav[0]}
          active={pathname === "/"}
          expanded={expanded}
          onClick={onNavigate}
        />

        {/* Matters picker */}
        <button
          type="button"
          onClick={() => {
            onNavigate?.();
            onOpenSelector?.();
          }}
          aria-label="Select a matter"
          title={expanded ? undefined : "Select a matter"}
          className={[
            "group flex items-center transition-colors",
            expanded
              ? "h-9 w-full gap-3 rounded-lg px-3"
              : "mx-auto mt-1 h-10 w-10 justify-center rounded-xl",
            mattersActive
              ? "bg-brand-blue-soft text-brand-navy"
              : "text-brand-navy/60 hover:bg-brand-blue-soft/60 hover:text-brand-navy",
          ].join(" ")}
        >
          <Briefcase
            className={expanded ? "h-4 w-4 shrink-0" : "h-[18px] w-[18px] shrink-0"}
            strokeWidth={2}
          />
          {expanded && (
            <span className="truncate text-[12.5px] font-medium tracking-[-0.005em]">
              Matters
            </span>
          )}
        </button>

        {/* Research */}
        <NavRow
          item={primaryNav[1]}
          active={pathname.startsWith("/research")}
          expanded={expanded}
          onClick={onNavigate}
        />

        {/* Calendar */}
        <NavRow
          item={primaryNav[2]}
          active={pathname.startsWith("/calendar")}
          expanded={expanded}
          onClick={onNavigate}
        />

        {/* Discovery */}
        <NavRow
          item={primaryNav[3]}
          active={
            pathname.startsWith("/docs") ||
            pathname.startsWith("/discovery") ||
            pathname.startsWith("/summarize")
          }
          expanded={expanded}
          onClick={onNavigate}
        />

        {/* Library */}
        <NavRow
          item={primaryNav[4]}
          active={pathname.startsWith("/library")}
          expanded={expanded}
          onClick={onNavigate}
        />
      </nav>

      {/* Footer */}
      <div
        className={[
          "shrink-0 space-y-1 border-t border-border/60",
          expanded ? "px-2 py-2" : "flex flex-col items-center px-2 py-2",
        ].join(" ")}
      >
        {expanded && email && (
          <p className="mb-1 truncate px-2 text-[10.5px] text-muted-foreground" title={email}>
            {email}
          </p>
        )}
        {[
          { icon: LogOut, label: "Sign out", onClick: onSignOut },
        ].map((row) => (
          <button
            key={row.label}
            type="button"
            onClick={row.onClick}
            aria-label={row.label}
            title={expanded ? undefined : row.label}
            className={[
              "group flex items-center text-brand-navy/60 transition-colors hover:bg-brand-blue-soft/60 hover:text-brand-navy",
              expanded
                ? "h-9 w-full gap-3 rounded-lg px-3"
                : "mx-auto h-10 w-10 justify-center rounded-xl",
            ].join(" ")}
          >
            <row.icon
              className={expanded ? "h-4 w-4 shrink-0" : "h-[18px] w-[18px] shrink-0"}
              strokeWidth={2}
            />
            {expanded && (
              <span className="truncate text-[12.5px] font-medium">{row.label}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

export function AppShell({ children }: { showHeaderLogo?: boolean; children?: ReactNode }) {
  const { signOut, user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const handleSignOut = async () => {
    await queryClient.cancelQueries();
    queryClient.clear();
    await signOut();
    navigate({ to: "/auth", replace: true });
  };

  const [mobileOpen, setMobileOpen] = useState(false);
  const [expanded, setExpanded] = useState<boolean>(false);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("sw:sidebar");
      if (saved === "expanded") setExpanded(true);
      else if (saved === "collapsed") setExpanded(false);
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("sw:sidebar", expanded ? "expanded" : "collapsed");
    } catch {
      /* noop */
    }
  }, [expanded]);

  const desktopW = expanded ? EXPANDED_W : COLLAPSED_W;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      {/* Mobile overlay */}
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-30 bg-foreground/20 backdrop-blur-sm md:hidden"
        />
      )}

      {/* Mobile drawer sidebar */}
      <aside
        className={[
          "fixed inset-y-0 left-0 z-40 w-[232px] border-r border-border/70 bg-card transition-transform duration-300 md:hidden",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        ].join(" ")}
        style={{ transitionTimingFunction: transitionEase }}
      >
        <div className="flex h-full flex-col">
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-border/70 px-3">
            <div className="flex items-center gap-2">
              <img src={logoAsset.url} alt="Seeger Weiss LLP" className="h-7 w-auto" />
            </div>
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="grid h-7 w-7 place-items-center rounded-md text-brand-navy/50 hover:bg-brand-blue-soft hover:text-brand-navy"
              aria-label="Close sidebar"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <SidebarInner
            expanded
            pathname={pathname}
            onNavigate={() => setMobileOpen(false)}
            showToggle={false}
            onSignOut={() => { void handleSignOut(); }}
            email={user?.email ?? null}
            onOpenSelector={() => setSelectorOpen(true)}
          />
        </div>
      </aside>

      {/* Desktop sidebar */}
      <aside
        className="fixed inset-y-0 left-0 z-40 hidden border-r border-border/70 bg-card transition-[width] duration-300 md:block"
        style={{ width: desktopW, minWidth: desktopW, maxWidth: desktopW, transitionTimingFunction: transitionEase }}
      >
        <SidebarInner
          expanded={expanded}
          pathname={pathname}
          onToggle={() => setExpanded((v) => !v)}
          showToggle
          onSignOut={() => { void handleSignOut(); }}
          email={user?.email ?? null}
          onOpenSelector={() => setSelectorOpen(true)}
        />
      </aside>

      <MatterSelector open={selectorOpen} onOpenChange={setSelectorOpen} />

      <div
        className="flex h-full min-h-0 flex-col transition-[padding-left] duration-300 md:pl-[var(--wr-sidebar-w)]"
        style={{ paddingLeft: `var(--wr-sidebar-w)`, ["--wr-sidebar-w" as string]: `${desktopW}px`, transitionTimingFunction: transitionEase }}
      >
        <header className="flex h-14 shrink-0 items-center px-4 sm:px-6 md:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="grid h-9 w-9 place-items-center rounded-full border border-border/70 bg-card text-brand-navy/60 transition-colors hover:text-brand-navy"
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
