/**
 * Repair "mojibake": text whose UTF-8 bytes were decoded as Windows-1252 before
 * being stored. The court reference library is populated out-of-band, and 207 of
 * its 270 court names plus 324 document titles arrived double-encoded, so an
 * em dash (U+2014, bytes E2 80 94) reads back as "a-circumflex, euro, right
 * double quote". Repairing on read keeps the workspace legible no matter what
 * the upstream tooling writes next.
 *
 * The repair is deliberately conservative. It only runs when the text carries
 * the telltale lead character, it refuses any character Windows-1252 cannot
 * represent, and it discards its own result unless the bytes decode as strictly
 * valid UTF-8. Anything it is not sure about is returned untouched, so text that
 * was never mojibake and text that is only partly recoverable both survive
 * unchanged. That also makes it idempotent: repaired text no longer carries the
 * lead character, so a second pass is a no-op.
 */

/**
 * Windows-1252 assigns printable characters to 0x80-0x9F, where ISO-8859-1 has
 * control codes. Those 27 code points are the only ones whose byte value cannot
 * be read straight off the UTF-16 code unit, so they need an explicit reverse
 * map. Encoding via "latin1" instead of this table is the usual reason a
 * mojibake repair silently fails on curly quotes and dashes.
 */
const CP1252_FROM_UNICODE = new Map<number, number>([
  [0x20ac, 0x80], // €
  [0x201a, 0x82], // ‚
  [0x0192, 0x83], // ƒ
  [0x201e, 0x84], // „
  [0x2026, 0x85], // …
  [0x2020, 0x86], // †
  [0x2021, 0x87], // ‡
  [0x02c6, 0x88], // ˆ
  [0x2030, 0x89], // ‰
  [0x0160, 0x8a], // Š
  [0x2039, 0x8b], // ‹
  [0x0152, 0x8c], // Œ
  [0x017d, 0x8e], // Ž
  [0x2018, 0x91], // '
  [0x2019, 0x92], // '
  [0x201c, 0x93], // "
  [0x201d, 0x94], // "
  [0x2022, 0x95], // •
  [0x2013, 0x96], // –
  [0x2014, 0x97], // —
  [0x02dc, 0x98], // ˜
  [0x2122, 0x99], // ™
  [0x0161, 0x9a], // š
  [0x203a, 0x9b], // ›
  [0x0153, 0x9c], // œ
  [0x017e, 0x9e], // ž
  [0x0178, 0x9f], // Ÿ
]);

/**
 * Every multi-byte UTF-8 sequence begins with a lead byte in 0xC2-0xF4. Those
 * byte values are identical in Windows-1252 and Latin-1, so a misread leaves the
 * lead byte visible as the matching U+00C2-U+00F4 character. Punctuation is the
 * common case here: an em dash is E2 80 94, and 0xE2 surfaces as U+00E2 ("a with
 * circumflex"), which is why narrowing this to U+00C2 and U+00C3 would miss
 * nearly every corrupted court name.
 *
 * The range deliberately over-matches. Ordinary accented text such as "e with
 * acute" (U+00E9) also lands in it, and that is fine: those strings fail the
 * strict UTF-8 decode below and are returned untouched.
 */
const SUSPECT = /[Â-ô]/;

/** Strict decoder: throws on any malformed sequence rather than substituting. */
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** U+FFFD. Its presence means the decode lost information. */
const REPLACEMENT = "�";

/** Repair a mojibake string, or return it unchanged when unsure. */
export function repairMojibake(value: string): string {
  if (!value || !SUSPECT.test(value)) return value;

  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0xff) {
      bytes[i] = code;
      continue;
    }
    const mapped = CP1252_FROM_UNICODE.get(code);
    // Not representable in Windows-1252, so these bytes were never the product
    // of a Windows-1252 misread. Leave the text alone.
    if (mapped === undefined) return value;
    bytes[i] = mapped;
  }

  try {
    const decoded = utf8.decode(bytes);
    // A replacement character means we destroyed information rather than
    // recovering it; the original is the safer answer.
    return decoded.includes(REPLACEMENT) ? value : decoded;
  } catch {
    // The bytes are not valid UTF-8, so the input was genuine text that merely
    // happened to contain "Â" or "Ã".
    return value;
  }
}

/** Nullable convenience wrapper: passes null and undefined straight through. */
export function repairMojibakeOrNull<T extends string | null | undefined>(value: T): T {
  return typeof value === "string" ? (repairMojibake(value) as T) : value;
}
