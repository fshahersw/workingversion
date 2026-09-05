// Tests fetch_page against real text-first legal/gov pages.
//   bun run scripts/test-fetch-page.ts
import { fetchPage } from "../src/lib/agents/fetch-page.server";

const URLS = [
  "https://www.law.cornell.edu/uscode/text/28/1407", // MDL transfer statute
  "https://www.epa.gov/pfas",                          // agency page
];

async function main() {
  let ok = 0;
  for (const u of URLS) {
    try {
      const p = await fetchPage(u, { maxChars: 4000 });
      console.log(`\n${u}`);
      console.log(`  status=${p.status} type=${p.contentType.split(";")[0]} title="${p.title.slice(0, 60)}"`);
      console.log(`  textChars=${p.text.length} links=${p.links.length} truncated=${p.truncated}`);
      console.log(`  text[0:200]: ${p.text.replace(/\n/g, " ").slice(0, 200)}`);
      if (p.status === 200 && p.text.length > 200) ok++;
    } catch (e) {
      console.log(`\n${u}\n  ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\n${ok}/${URLS.length} pages returned readable text.`);
  if (ok === 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
