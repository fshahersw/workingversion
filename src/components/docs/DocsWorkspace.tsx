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
      <div className="flex h-full min-h-0 flex-col overflow-hidden px-5 pt-3 pb-5 lg:px-8 lg:pt-4 lg:pb-7">
      <Tabs
        value={activeTab}
        onValueChange={(value) => onTabChange(value as DocsTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="mb-4 w-fit">
          <TabsTrigger value="search" className="gap-1.5 text-[12.5px]">
            <FileSearch className="h-3.5 w-3.5" strokeWidth={1.75} />
            Working set
          </TabsTrigger>
          <TabsTrigger value="deposition" className="gap-1.5 text-[12.5px]">
            <MessageSquareText className="h-3.5 w-3.5" strokeWidth={1.75} />
            Depositions
          </TabsTrigger>
          {reviewOn ? (
            <TabsTrigger value="review" className="gap-1.5 text-[12.5px]">
              <Table2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              Review Tables
            </TabsTrigger>
          ) : null}
        </TabsList>

        <TabsContent value="search" className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
          <DocSearchTab />
        </TabsContent>

        <TabsContent
          value="deposition"
          className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden"
        >
          <DepositionAnalysisTab />
        </TabsContent>
        {reviewOn ? (
          <TabsContent
            value="review"
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

