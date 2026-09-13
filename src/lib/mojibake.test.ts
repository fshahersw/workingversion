import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { repairMojibake, repairMojibakeOrNull } from "./mojibake.ts";

// Every literal here is an escape so the expectations survive whatever encoding
// this file is checked out with. An em dash (U+2014) is the UTF-8 bytes E2 80 94,
// which Windows-1252 reads back as U+00E2, U+20AC, U+201D. A right single quote
// (U+2019) is E2 80 99, which reads back as U+00E2, U+20AC, U+2122.
const MOJIBAKE_EM_DASH = "â€”";
const MOJIBAKE_APOSTROPHE = "â€™";
const EM_DASH = "—";
const RIGHT_QUOTE = "’";
const A_CIRCUMFLEX_CAP = "Â";
const A_TILDE_CAP = "Ã";

describe("repairMojibake", () => {
  it("repairs the court names the reference library actually stores", () => {
    assert.equal(
      repairMojibake(`United States District Court ${MOJIBAKE_EM_DASH} Florida Northern`),
      `United States District Court ${EM_DASH} Florida Northern`,
    );
    assert.equal(
      repairMojibake(`United States Bankruptcy Court ${MOJIBAKE_EM_DASH} Alaska`),
      `United States Bankruptcy Court ${EM_DASH} Alaska`,
    );
  });

  it("repairs mangled curly punctuation in document titles", () => {
    assert.equal(
      repairMojibake(`Judge${MOJIBAKE_APOSTROPHE}s Standing Order`),
      `Judge${RIGHT_QUOTE}s Standing Order`,
    );
  });

  it("leaves correctly encoded text untouched", () => {
    const clean = `United States District Court ${EM_DASH} Minnesota`;
    assert.equal(repairMojibake(clean), clean);
  });

  it("leaves plain ASCII untouched", () => {
    assert.equal(
      repairMojibake("Notice of Intent to Request Redaction"),
      "Notice of Intent to Request Redaction",
    );
    assert.equal(repairMojibake(""), "");
  });

  it("is idempotent, so a second pass cannot double-decode", () => {
    const once = repairMojibake(`United States District Court ${MOJIBAKE_EM_DASH} New Jersey`);
    assert.equal(repairMojibake(once), once);
    assert.equal(once, `United States District Court ${EM_DASH} New Jersey`);
  });

  it("preserves accented text that was never mojibake", () => {
    // No suspect lead character, so it is never even examined.
    const accented = "Tribunal de Paris, Secé";
    assert.equal(repairMojibake(accented), accented);
  });

  it("returns the original when the bytes are not valid UTF-8", () => {
    // A lone U+00C2 is byte 0xC2, an incomplete UTF-8 sequence. Repairing it
    // would destroy information, so the original has to come back.
    assert.equal(repairMojibake(A_CIRCUMFLEX_CAP), A_CIRCUMFLEX_CAP);
    const stray = `Court ${A_TILDE_CAP} Division`;
    assert.equal(repairMojibake(stray), stray);
  });

  it("refuses characters Windows-1252 cannot represent", () => {
    // The lead character triggers a look, but the CJK glyphs have no cp1252
    // byte, so the function must bail out rather than guess.
    const input = `${A_CIRCUMFLEX_CAP}中文`;
    assert.equal(repairMojibake(input), input);
  });

  it("passes null and undefined through", () => {
    assert.equal(repairMojibakeOrNull(null), null);
    assert.equal(repairMojibakeOrNull(undefined), undefined);
    assert.equal(
      repairMojibakeOrNull(`Court ${MOJIBAKE_EM_DASH} Alaska`),
      `Court ${EM_DASH} Alaska`,
    );
  });
});
