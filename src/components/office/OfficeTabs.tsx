// Office section header: title plus the editor tabs (Drafts, Sheets, Slides).
// Shown on the list pages; the editors themselves render full-bleed without it.
import { Link } from "@tanstack/react-router";
import { FileText, Presentation, Table2 } from "lucide-react";
import type { ComponentType } from "react";

export type OfficeTab = "drafts" | "sheets" | "slides";

const TABS: ReadonlyArray<{
  id: OfficeTab;
  label: string;
  to: "/office/drafts" | "/office/sheets" | "/office/slides";
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
}> = [
  { id: "drafts", label: "Drafts", to: "/office/drafts", icon: FileText },
  { id: "sheets", label: "Sheets", to: "/office/sheets", icon: Table2 },
  { id: "slides", label: "Slides", to: "/office/slides", icon: Presentation },
];

export function OfficeTabs({ active, description }: { active: OfficeTab; description: string }) {
  return (
    <div>
      <h1 className="text-[19px] font-semibold tracking-[-0.01em] text-foreground">Office</h1>
      <p className="mt-1 text-[12.5px] text-muted-foreground">{description}</p>
      <nav
        role="tablist"
        aria-label="Office editors"
        className="mt-4 flex gap-1 border-b border-border/70"
      >
        {TABS.map((tab) => {
          const selected = tab.id === active;
          return (
            <Link
              key={tab.id}
              to={tab.to}
              role="tab"
              aria-selected={selected}
              className={[
                "-mb-px inline-flex h-9 items-center gap-1.5 border-b-2 px-3 text-[12.5px] font-medium transition-colors",
                selected
                  ? "border-brand-navy text-brand-navy"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
              ].join(" ")}
            >
              <tab.icon className="h-3.5 w-3.5" strokeWidth={1.9} />
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
