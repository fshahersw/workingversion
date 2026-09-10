// ============================================================================
// Bounded OOXML package validation (server-only). Ported from the Office
// server's docx-validation.mjs. Walks the ZIP central directory without
// extracting anything to disk, enforces decompression limits, rejects
// macro/ActiveX/signed/embedded parts and unsafe external relationships, and
// confirms the package really is the declared kind. Every upload and save
// passes through here before bytes reach S3.
// ============================================================================
import { inflateRawSync } from "node:zlib";

import { XMLParser, XMLValidator } from "fast-xml-parser";

import { MAX_OFFICE_BYTES, type OfficeKind } from "./types";

const MAX_EXPANDED = 128 * 1024 * 1024;
const MAX_ENTRY = 32 * 1024 * 1024;
const MAX_PARTS = 4096;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  processEntities: true,
});

export class ArchiveError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ArchiveError";
    this.status = status;
  }
}

function ensure(ok: unknown, message: string): asserts ok {
  if (!ok) throw new ArchiveError(422, message);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buffer) c = CRC_TABLE[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function parseXml(
  buffer: Uint8Array,
  name: string,
): { text: string; value: Record<string, unknown> } {
  ensure(!(buffer[0] === 255 || buffer[0] === 254), "UTF-16 XML parts are not supported.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  ensure(
    !/<!\s*(?:DOCTYPE|ENTITY)/i.test(text),
    "XML DOCTYPE/entity declarations are not allowed.",
  );
  ensure(XMLValidator.validate(text) === true, `Invalid XML in Office part ${name}.`);
  return { text, value: parser.parse(text) as Record<string, unknown> };
}

const FORMATS: Record<OfficeKind, { main: string; mime: string; label: string }> = {
  docx: { main: "word/document.xml", mime: "wordprocessingml.document", label: "Word document" },
  xlsx: { main: "xl/workbook.xml", mime: "spreadsheetml.sheet", label: "Excel workbook" },
  pptx: {
    main: "ppt/presentation.xml",
    mime: "presentationml.presentation",
    label: "PowerPoint deck",
  },
};

export type ArchiveReport = { kind: OfficeKind; parts: number; expandedBytes: number };

/**
 * Validate an OOXML package of the given kind. Throws ArchiveError(413/422)
 * with a user-facing message; returns part statistics on success.
 */
export function validateOfficeArchive(
  input: Uint8Array,
  kind: OfficeKind,
  budget: { expanded: number } = { expanded: 0 },
): ArchiveReport {
  const fmt = FORMATS[kind];
  const b = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (b.length < 22 || b.length > MAX_OFFICE_BYTES) {
    throw new ArchiveError(
      413,
      `The ${fmt.label} must be between 22 bytes and ${MAX_OFFICE_BYTES / 1024 / 1024} MB.`,
    );
  }
  ensure(
    b.readUInt32LE(0) === 0x04034b50,
    `Expected a standard ${fmt.label} (.${kind}); encrypted and legacy binary files are not supported.`,
  );

  // End-of-central-directory record.
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50 && i + 22 + b.readUInt16LE(i + 20) === b.length) {
      end = i;
      break;
    }
  }
  ensure(end >= 0, "Invalid ZIP end record.");
  ensure(
    b.readUInt16LE(end + 4) === 0 && b.readUInt16LE(end + 6) === 0,
    "Multi-volume ZIP is not supported.",
  );
  const count = b.readUInt16LE(end + 10);
  const size = b.readUInt32LE(end + 12);
  const start = b.readUInt32LE(end + 16);
  ensure(
    count > 0 && count <= MAX_PARTS && count === b.readUInt16LE(end + 8),
    "The package has too many ZIP parts.",
  );
  ensure(start + size === end && start > 0, "Invalid or ZIP64 package directory.");

  let at = start;
  let total = 0;
  const names = new Set<string>();
  const parts = new Map<string, string>();
  const ranges: Array<[number, number]> = [];

  for (let index = 0; index < count; index++) {
    ensure(at + 46 <= end && b.readUInt32LE(at) === 0x02014b50, "Invalid ZIP directory entry.");
    const flags = b.readUInt16LE(at + 8);
    const method = b.readUInt16LE(at + 10);
    const crc = b.readUInt32LE(at + 16);
    const compressed = b.readUInt32LE(at + 20);
    const expanded = b.readUInt32LE(at + 24);
    const nl = b.readUInt16LE(at + 28);
    const el = b.readUInt16LE(at + 30);
    const cl = b.readUInt16LE(at + 32);
    const offset = b.readUInt32LE(at + 42);
    ensure(nl > 0 && nl <= 512 && at + 46 + nl + el + cl <= end, "Invalid ZIP part name.");
    const raw = b.subarray(at + 46, at + 46 + nl);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    ensure(
      !name.startsWith("/") &&
        // eslint-disable-next-line no-control-regex
        !/[\\:\x00-\x1f]/.test(name) &&
        !name.split("/").includes("..") &&
        !name.split("/").includes("."),
      "Unsafe ZIP path.",
    );
    ensure(!names.has(name.toLowerCase()), "Duplicate ZIP part.");
    names.add(name.toLowerCase());
    ensure(!(flags & 0x41) && [0, 8].includes(method), "Encrypted or unsupported ZIP compression.");
    ensure(
      expanded <= MAX_ENTRY &&
        (compressed > 0 || expanded === 0) &&
        expanded <= Math.max(4096, compressed * 200),
      "A package part exceeds decompression limits.",
    );
    total += expanded;
    budget.expanded += expanded;
    ensure(budget.expanded <= MAX_EXPANDED, "The package exceeds expanded-size limits.");

    const embedded = name.toLowerCase().includes("embeddings/");
    ensure(
      !/(?:vbaProject|activeX|_xmlsignatures\/)/i.test(name) && !embedded,
      "Macro, ActiveX, embedded-object or digitally signed parts are not supported. Save the file without them and upload again.",
    );

    ensure(
      offset + 30 <= start && b.readUInt32LE(offset) === 0x04034b50,
      "Invalid local ZIP header.",
    );
    const localName = b.readUInt16LE(offset + 26);
    const localExtra = b.readUInt16LE(offset + 28);
    const dataAt = offset + 30 + localName + localExtra;
    ensure(
      b.readUInt16LE(offset + 6) === flags && b.readUInt16LE(offset + 8) === method,
      "ZIP headers disagree.",
    );
    ensure(
      b.subarray(offset + 30, offset + 30 + localName).equals(raw) && dataAt + compressed <= start,
      "Invalid local part range.",
    );
    ranges.push([offset, dataAt + compressed]);

    let decoded: Buffer;
    try {
      decoded =
        method === 0
          ? b.subarray(dataAt, dataAt + compressed)
          : inflateRawSync(b.subarray(dataAt, dataAt + compressed), {
              maxOutputLength: Math.max(1, expanded),
            });
    } catch {
      throw new ArchiveError(422, "Invalid or oversized compressed part.");
    }
    ensure(
      decoded.length === expanded && crc32(decoded) === crc,
      "Part length or checksum mismatch.",
    );

    if (/\.(xml|rels)$/i.test(name)) {
      const parsed = parseXml(decoded, name);
      ensure(
        name !== "[Content_Types].xml" || !/macroEnabled|vbaProject/i.test(parsed.text),
        `Macro-enabled files are not accepted. Save as an ordinary .${kind} and upload again.`,
      );
      if (name.endsWith(".rels")) {
        const relationships = parsed.value["Relationships"] as Record<string, unknown> | undefined;
        let rels = relationships?.["Relationship"] ?? [];
        if (!Array.isArray(rels)) rels = [rels];
        for (const rel of rels as Array<Record<string, unknown>>) {
          if (String(rel["TargetMode"] ?? "").toLowerCase() !== "external") continue;
          ensure(
            String(rel["Type"] ?? "").endsWith("/hyperlink"),
            "External content relationships are blocked.",
          );
          let u: URL;
          try {
            u = new URL(String(rel["Target"]));
          } catch {
            throw new ArchiveError(422, "Invalid external hyperlink.");
          }
          ensure(
            ["https:", "http:", "mailto:"].includes(u.protocol),
            "Unsafe external hyperlink scheme.",
          );
        }
      }
      parts.set(name, parsed.text);
    }
    at += 46 + nl + el + cl;
  }

  ensure(at === end, "Trailing invalid ZIP directory data.");
  ranges.sort((a, c) => a[0] - c[0]);
  for (let i = 1; i < ranges.length; i++) {
    ensure(ranges[i]![0] >= ranges[i - 1]![1], "Overlapping ZIP entries.");
  }
  ensure(
    parts.has(fmt.main) && parts.has("[Content_Types].xml"),
    `Missing required ${fmt.label} content.`,
  );
  ensure(
    parts
      .get("[Content_Types].xml")!
      .includes(`application/vnd.openxmlformats-officedocument.${fmt.mime}.main+xml`),
    `Not an ordinary ${fmt.label}.`,
  );
  return { kind, parts: count, expandedBytes: total };
}
