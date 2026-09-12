// Synthetic testimony for browser verification only; never imported by application code.
import { parseDepAnalysis, verifyDepAnalysis } from "../../src/lib/pile/deposition-analysis";
import { parseTranscript } from "../../src/lib/pile/transcript";

export const insightTranscripts = [
  { fileId: "smith", fileName: "Smith.txt", witness: "Jane Smith" },
  { fileId: "jones", fileName: "Jones.txt", witness: "Robert Jones" },
  { fileId: "quinn", fileName: "Quinn.txt", witness: "Alex Quinn" },
];
const parsed = [
  parseTranscript(
    "DEPOSITION OF JANE SMITH\n1\n1 Q. Who employed you?\n2 A. I worked at Acme Corporation.\n3 Q. What did you review?\n4 A. I reviewed the safety memorandum in 2019.\n5 Q. Did you attend?\n6 A. I attended the recall meeting in 2020.",
    "Smith.txt",
  ),
  parseTranscript(
    "DEPOSITION OF ROBERT JONES\n1\n1 Q. What did you review?\n2 A. I did not review the safety memorandum until 2021.\n3 Q. Did you attend the launch?\n4 A. I attended the product launch in 2021.",
    "Jones.txt",
  ),
  parseTranscript(
    "DEPOSITION OF ALEX QUINN\n1\n1 Q. Who employed you?\n2 A. I worked at Omega Labs.\n3 Q. What did you prepare?\n4 A. I prepared the laboratory report in 2022.",
    "Quinn.txt",
  ),
];
export const insightAnalysis = verifyDepAnalysis(
  parseDepAnalysis(
    JSON.stringify({
      graph: {
        nodes: [
          { id: "jane", label: "Jane Smith", kind: "person" },
          { id: "acme", label: "Acme Corporation", kind: "org" },
          { id: "memo", label: "Safety memorandum", kind: "doc" },
          { id: "meeting", label: "Recall meeting", kind: "event" },
          { id: "robert", label: "Robert Jones", kind: "person" },
          { id: "launch", label: "Product launch", kind: "event" },
          { id: "alex", label: "Alex Quinn", kind: "person" },
          { id: "omega", label: "Omega Labs", kind: "org" },
          { id: "report", label: "Laboratory report", kind: "doc" },
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
          {
            from: "robert",
            to: "memo",
            label: "reviewed in 2021",
            fileName: "Jones.txt",
            quote: "I did not review the safety memorandum until 2021.",
            cite: "1:2",
          },
          {
            from: "robert",
            to: "launch",
            label: "attended",
            fileName: "Jones.txt",
            quote: "I attended the product launch in 2021.",
            cite: "1:4",
          },
          {
            from: "alex",
            to: "omega",
            label: "employed by",
            fileName: "Quinn.txt",
            quote: "I worked at Omega Labs.",
            cite: "1:2",
          },
          {
            from: "alex",
            to: "report",
            label: "prepared",
            fileName: "Quinn.txt",
            quote: "I prepared the laboratory report in 2022.",
            cite: "1:4",
          },
          { from: "acme", to: "memo", label: "approved", cite: "9:3" },
        ],
      },
      contradictions: [
        {
          title: "Timing of review",
          severity: "medium",
          why: "Compare the scope of these two accounts.",
          a: {
            witness: "Jane Smith",
            fileName: "Smith.txt",
            cite: "1:4",
            quote: "I reviewed the safety memorandum in 2019.",
          },
          b: {
            witness: "Robert Jones",
            fileName: "Jones.txt",
            cite: "1:2",
            quote: "I did not review the safety memorandum until 2021.",
          },
        },
      ],
    }),
  ),
  parsed,
);
