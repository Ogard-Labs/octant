import type { WorkArtifactFormat } from "@octant/contracts/work-artifacts";
import {
  WorkAdapterBudgetError,
  type WorkFormatAdapter,
  registerWorkFormatAdapter,
} from "./workFormatAdapter";
import { MAX_WORK_OUTPUT_BYTES } from "./workBudget";
import { readWorkZip, writeWorkZip } from "./workZipPort";

/**
 * DOCX (OOXML) format adapter for Work. Materializes valid minimal
 * `.docx` containers from renderer-supplied text using the dependency-free
 * OPC ZIP port, with paragraph-level round-trip decode. The container is a
 * real Office Open XML package: `[Content_Types].xml`, the package
 * relationship part, the document relationship part, and `word/document.xml`
 * with one paragraph per non-empty input line. Decode parses `<w:t>` text
 * runs and `<w:p>` paragraph boundaries back into normalized text. DOCX is
 * advertised as a lossy derived export to markdown; same-format conversion
 * returns the source bytes unchanged. The domain policy already marks docx
 * as inherently limited fidelity so the renderer shows the fidelity notice.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const PACKAGE_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const DOCUMENT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildDocumentXml(content: string): string {
  // Preserve every line, including intentional blank paragraphs, so that
  // round-trip decode returns user-authored structure unchanged. An empty line
  // becomes a paragraph with an empty text run rather than being dropped.
  const lines = content.split("\n");
  const paragraphs = lines
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${paragraphs}</w:body></w:document>`;
}

function decodeDocumentXml(xml: string): string | undefined {
  const bodyMatch = /<w:body[^>]*>([\s\S]*?)<\/w:body>/.exec(xml);
  const bodyContent = bodyMatch !== null ? bodyMatch[1] : xml;
  if (bodyContent === undefined) return undefined;
  const paragraphs = bodyContent.split(/<w:p[\s>]/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph === undefined || paragraph.length === 0) continue;
    const runTexts: string[] = [];
    const runRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
    let match = runRegex.exec(paragraph);
    while (match !== null) {
      const text = match[1];
      if (text !== undefined) runTexts.push(unescapeXml(text));
      match = runRegex.exec(paragraph);
    }
    // Emit an empty string for paragraphs with no text run so blank paragraphs
    // authored on encode are preserved through the round trip.
    lines.push(runTexts.join(""));
  }
  return lines.join("\n");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

const docxAdapter: WorkFormatAdapter = {
  format: "docx" as WorkArtifactFormat,
  encode(content: string): Uint8Array {
    const documentXml = buildDocumentXml(content);
    // Preflight the largest XML part against the output budget before ZIP
    // compression. XML escaping (e.g. `<` -> `&lt;`) can expand content that
    // passed the 16 MiB input check past the 16 MiB uncompressed-entry ceiling
    // enforced by `readWorkZip`, which would let a compressed container pass
    // `validateWorkOutputBudget` while failing to round-trip. The mutation
    // service catch surfaces this `WorkAdapterBudgetError` as `oversize`.
    if (textEncoder.encode(documentXml).byteLength > MAX_WORK_OUTPUT_BYTES) {
      throw new WorkAdapterBudgetError(
        "docx encode rejected: word/document.xml exceeds the 16 MiB output budget after XML wrapping",
      );
    }
    return writeWorkZip([
      { name: "[Content_Types].xml", data: textEncoder.encode(CONTENT_TYPES_XML) },
      { name: "_rels/.rels", data: textEncoder.encode(PACKAGE_RELS_XML) },
      { name: "word/_rels/document.xml.rels", data: textEncoder.encode(DOCUMENT_RELS_XML) },
      { name: "word/document.xml", data: textEncoder.encode(documentXml) },
    ]);
  },
  decode(bytes: Uint8Array): string | undefined {
    try {
      const entries = readWorkZip(bytes);
      const document = entries.get("word/document.xml");
      if (document === undefined) return undefined;
      const xml = textDecoder.decode(document);
      return decodeDocumentXml(xml);
    } catch {
      return undefined;
    }
  },
  capabilities: {
    // canRead reflects the adapter's decode capability for round-trip revise.
    // The preview sniffer classifies OOXML ZIP containers as unsupported
    // until a native renderer is wired; the preview surface shows an
    // external-handoff affordance for DOCX until then.
    canRead: true,
    canCreate: true,
    canMutate: true,
    canRoundTrip: true,
    canExport: true,
    canVersion: true,
  },
  exportFormats: ["markdown"],
  convertTo(targetFormat: WorkArtifactFormat, sourceBytes: Uint8Array): Uint8Array | undefined {
    if (targetFormat === "docx") return sourceBytes;
    if (targetFormat === "markdown") {
      const text = this.decode(sourceBytes);
      if (text === undefined) return undefined;
      return textEncoder.encode(text);
    }
    return undefined;
  },
};

registerWorkFormatAdapter(docxAdapter);
