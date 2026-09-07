import type { PileFileHits } from "./types.ts";

export type SourceCoverage = {
  totalFiles: number;
  matchedFiles: number;
  unmatchedFiles: string[];
  passages: number;
};

export function sourceCoverage(groups: PileFileHits[]): SourceCoverage {
  const matched = groups.filter((group) => group.hits.length > 0);
  return {
    totalFiles: groups.length,
    matchedFiles: matched.length,
    unmatchedFiles: groups
      .filter((group) => group.hits.length === 0)
      .map((group) => group.fileName),
    passages: groups.reduce((total, group) => total + group.hits.length, 0),
  };
}
