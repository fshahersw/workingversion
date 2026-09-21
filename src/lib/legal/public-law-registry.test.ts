import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COURT_DIRECTORY_AS_OF,
  courtDirectory,
  courtDirectoryByUrl,
  courtIdFromHost,
  courtsForMdl,
  describeCourtLinks,
  describeCourtMdls,
  listCourtDirectory,
} from "./court-directory.ts";
import { scrapeAllowed, sourceNote, sourceRegistryStats, sourceTrust } from "./source-registry.ts";

test("court directory covers the federal system and joins on CourtListener/DocketBird ids", () => {
  const all = listCourtDirectory();
  assert.ok(all.filter((c) => c.kind === "district").length >= 88, "districts present");
  assert.equal(all.filter((c) => c.kind === "circuit").length, 13);
  assert.ok(courtDirectory("jpml"));
  assert.equal(courtIdFromHost("www.njd.uscourts.gov"), "njd");
  assert.equal(courtIdFromHost("ecf.alnd.uscourts.gov"), null, "e-filing hosts are not courts");
  assert.equal(courtIdFromHost("example.com"), null);
  assert.equal(courtDirectoryByUrl("https://www.cand.uscourts.gov/judges")?.id, "cand");
  assert.equal(courtDirectory("NJD")?.id, "njd", "case-insensitive");
  assert.match(COURT_DIRECTORY_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
});

test("D.N.J. carries the JPML active-MDL summary and named MDLs with judge routes", () => {
  const njd = courtDirectory("njd")!;
  assert.equal(njd.url, "https://www.njd.uscourts.gov/");
  assert.ok(njd.pages.rules?.includes("local-rules"));
  assert.ok(njd.mdl && njd.mdl.active >= 10 && njd.mdl.judges.includes("Michael A. Shipp"));
  const talc = njd.mdls.find((m) => m.number === "2738")!;
  assert.match(talc.title, /Talcum Powder/);
  assert.equal(talc.judge, "Michael A. Shipp", "slug name reconciled to the full form");
  assert.ok(talc.judgeUrl?.startsWith("https://www.njd.uscourts.gov/"));
  // The transferee district and the JPML's own report row both name MDL 2738.
  const hits = courtsForMdl("MDL 2738");
  assert.ok(hits.some((h) => h.court.id === "njd"));
  assert.ok(hits.every((h) => h.court.id === "njd" || h.court.id === "jpml"));
  assert.deepEqual(courtsForMdl("0000"), []);
});

test("court link and MDL descriptions are compact and cite the registry vintage", () => {
  const njd = courtDirectory("njd")!;
  const links = describeCourtLinks(njd, "D.N.J.");
  assert.match(links, /^D\.N\.J\. official: https:\/\/www\.njd\.uscourts\.gov\//);
  assert.match(links, /local rules: https:\/\//);
  const mdls = describeCourtMdls(njd);
  assert.match(mdls, /active MDLs, [\d,]+ pending actions/);
  assert.match(mdls, /MDL 2738 \(Johnson & Johnson Talcum Powder/);
  assert.match(mdls, new RegExp(`verified ${COURT_DIRECTORY_AS_OF}`));
  assert.equal(describeCourtMdls(courtDirectory("ca1")!), "", "circuits have no MDL summary");
});

test("source trust: official domains, parent-domain inheritance, unknown hosts", () => {
  const fda = sourceTrust("https://www.fda.gov/advisory-committees");
  assert.ok(fda.known && fda.official && fda.domain === "fda.gov");
  const ecf = sourceTrust("https://ecf.alnd.uscourts.gov/");
  assert.ok(ecf.known, "subdomain inherits its registry parent");
  assert.ok(ecf.official);
  const unknown = sourceTrust("https://nonexistent-example-host.invalid/x");
  assert.equal(unknown.known, false);
  assert.equal(unknown.policy, "open");
  assert.equal(sourceNote("https://nonexistent-example-host.invalid/x"), "");
  const stats = sourceRegistryStats();
  assert.ok(stats.domains > 2000 && stats.official > 1000);
});

test("crawl policy from the registry is honored: never / verify_only block scraping, open allows", () => {
  assert.equal(scrapeAllowed("https://www.law.cornell.edu/uscode/text/28/1407"), false, "LII: crawl_policy never");
  assert.equal(sourceTrust("https://www.njcourts.gov/").policy, "never");
  assert.equal(scrapeAllowed("https://caselaw.findlaw.com/court/us-supreme-court/x.html"), false, "verify_only");
  assert.equal(scrapeAllowed("https://www.fda.gov/drugs"), true);
  assert.equal(scrapeAllowed("https://some-unknown-host.example/"), true, "unknown hosts are not blocked by the overlay");
});

test("sourceNote never overstates liveness", () => {
  const note = sourceNote("https://www.uscourts.gov/forms-rules/forms");
  assert.match(note, /^official source, (registry-verified live \d{4}-\d{2}-\d{2}|listed in the source registry)/);
  const nh = sourceTrust("https://www.courts.state.nh.us/");
  if (nh.known && nh.livePct < 50) assert.match(sourceNote("https://www.courts.state.nh.us/"), /listed in the source registry/);
});
