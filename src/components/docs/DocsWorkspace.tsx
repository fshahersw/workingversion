import { FileSearch, MessageSquareText, Table2 } from "lucide-react";

import { DepositionAnalysisTab } from "./DepositionAnalysisTab";
import { DocSearchTab } from "./DocSearchTab";
import { ReviewTablesTab } from "./review/ReviewTablesTab";
import { REVIEW_TABLES_ENABLED } from "@/lib/review/types";
import { PileProvider } from "@/lib/pile-context";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type DocsTab = "search" | "deposition" | "review";

export function DocsWorkspace({ tab, onTabChange }: { tab: DocsTab; onTabChange: (tab: DocsTab) => void }) {
  const reviewOn = REVIEW_TABLES_ENABLED;
  const activeTab =
    tab === "deposition" ? "deposition" : tab === "review" && reviewOn ? "review" : "search";

  return (
    <PileProvider>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface px-3 pt-2 pb-3 lg:px-5 lg:pt-3 lg:pb-5">
      <Tabs
        value={activeTab}
        onValueChange={(value) => onTabChange(value as DocsTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="mb-3 h-10 w-full justify-start rounded-none border-b border-border bg-transparent p-0">
          <TabsTrigger
            value="search"
            className="h-10 gap-1.5 rounded-none border-b-2 border-transparent px-3 text-[12px] shadow-none data-[state=active]:border-brand-navy data-[state=active]:bg-transparent data-[state=active]:text-brand-navy data-[state=active]:shadow-none"
          >
            <FileSearch className="h-3.5 w-3.5" strokeWidth={1.75} />
            Working set
          </TabsTrigger>
          <TabsTrigger
            value="deposition"
            className="h-10 gap-1.5 rounded-none border-b-2 border-transparent px-3 text-[12px] shadow-none data-[state=active]:border-brand-navy data-[state=active]:bg-transparent data-[state=active]:text-brand-navy data-[state=active]:shadow-none"
          >
            <MessageSquareText className="h-3.5 w-3.5" strokeWidth={1.75} />
            Depositions
          </TabsTrigger>
          {reviewOn ? (
            <TabsTrigger
              value="review"
              className="h-10 gap-1.5 rounded-none border-b-2 border-transparent px-3 text-[12px] shadow-none data-[state=active]:border-brand-navy data-[state=active]:bg-transparent data-[state=active]:text-brand-navy data-[state=active]:shadow-none"
            >
              <Table2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              Tabular Review
            </TabsTrigger>
          ) : null}
        </TabsList>

        <TabsContent value="search" className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
          <DocSearchTab />
        </TabsContent>

        {/* Kept mounted: a multi-pass analysis must survive a tab switch. */}
        <TabsContent
          value="deposition"
          forceMount
          className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden"
        >
          <DepositionAnalysisTab />
        </TabsContent>
        {reviewOn ? (
          <TabsContent
            value="review"
            forceMount
            className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden"
          >
            <ReviewTablesTab />
          </TabsContent>
        ) : null}
      </Tabs>
      </div>
    </PileProvider>
  );
}

