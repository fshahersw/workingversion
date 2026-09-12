// Test-only component entry. No route, data flag, or auth bypass exists in the product.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { KnowledgeGraph } from "../../src/components/summarize/KnowledgeGraph";
import { parseDepAnalysis, verifyDepAnalysis } from "../../src/lib/pile/deposition-analysis";
import { parseTranscript } from "../../src/lib/pile/transcript";
import { insightAnalysis, insightTranscripts } from "./graph-insights.fixture";
import "../../src/styles.css";

const transcript = parseTranscript(
  "DEPOSITION OF JANE SMITH\n1\n1 Q. Who employed you?\n2 A. I worked at Acme Corporation.\n3 Q. What did you review?\n4 A. I reviewed the safety memorandum in 2019.\n5 Q. Did you attend?\n6 A. I attended the recall meeting in 2020.",
  "Smith.txt",
);
const analysis = verifyDepAnalysis(
  parseDepAnalysis(
    JSON.stringify({
      graph: {
        nodes: [
          { id: "jane", label: "Jane Smith", kind: "person" },
          { id: "acme", label: "Acme Corporation", kind: "org" },
          { id: "memo", label: "Safety memorandum", kind: "doc" },
          { id: "meeting", label: "Recall meeting", kind: "event" },
        ],
        edges: [
          {
            from: "jane",
            to: "acme",
            label: "employed by",
            fileName: "Smith.txt",
            quote: "I worked at Acme Corporation.",
            cite: "1:2",
          },
          {
            from: "jane",
            to: "memo",
            label: "reviewed",
            fileName: "Smith.txt",
            quote: "I reviewed the safety memorandum in 2019.",
            cite: "1:4",
          },
          {
            from: "jane",
            to: "meeting",
            label: "attended",
            fileName: "Smith.txt",
            quote: "I attended the recall meeting in 2020.",
            cite: "1:6",
          },
          { from: "acme", to: "memo", label: "approved", cite: "9:3" },
        ],
      },
    }),
  ),
  transcript,
);
export function Harness() {
  const [citation, setCitation] = useState("");
  const [rich, setRich] = useState(window.location.hash === "#insights");
  return (
    <main
      style={{ display: "flex", height: "100vh", flexDirection: "column", gap: 12, padding: 20 }}
    >
      <h1 className="text-xl font-semibold">Deposition knowledge graph</h1>
      <p className="text-xs text-muted-foreground">
        Component verification · synthetic testimony confined to tests
        {rich && (
          <button type="button" onClick={() => setRich(false)}>
            Use simple graph
          </button>
        )}
      </p>
      <div style={{ minHeight: 0, flex: 1 }}>
        <KnowledgeGraph
          analysis={rich ? insightAnalysis : analysis}
          multi={rich}
          transcripts={
            rich
              ? insightTranscripts
              : [{ fileId: "smith", fileName: "Smith.txt", witness: "Jane Smith" }]
          }
          onCite={(cite, file) => setCitation(`${file} ${cite}`)}
        />
      </div>
      <output aria-label="Opened citation" className="text-xs">
        {citation}
      </output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
