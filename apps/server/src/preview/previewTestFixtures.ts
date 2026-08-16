import { writeWorkZip, type WorkZipEntry } from "../work/workZipPort";

const textEncoder = new TextEncoder();

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnLetter(index: number): string {
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * Build a valid minimal single-worksheet XLSX container from a grid of
 * cell values. Mirrors the Work encoder's structure so the preview
 * workbook parser can round-trip representative fixtures.
 */
export function buildXlsxFixture(rows: ReadonlyArray<ReadonlyArray<string>>): Uint8Array {
  let body = "";
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const cells = rows[rowIndex];
    if (cells === undefined) continue;
    const rowNumber = rowIndex + 1;
    body += `<row r="${rowNumber}">`;
    for (let colIndex = 0; colIndex < cells.length; colIndex += 1) {
      const ref = `${columnLetter(colIndex)}${rowNumber}`;
      const escaped = escapeXml(cells[colIndex] ?? "");
      body += `<c r="${ref}" t="inlineStr"><is><t>${escaped}</t></is></c>`;
    }
    body += "</row>";
  }
  const worksheetXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>' +
    body +
    "</sheetData></worksheet>";
  return writeWorkZip([
    {
      name: "[Content_Types].xml",
      data: textEncoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      ),
    },
    {
      name: "_rels/.rels",
      data: textEncoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: textEncoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
    },
    {
      name: "xl/workbook.xml",
      data: textEncoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
    },
    { name: "xl/worksheets/sheet1.xml", data: textEncoder.encode(worksheetXml) },
  ]);
}

/**
 * Build a valid minimal DOCX container from paragraph lines.
 */
export function buildDocxFixture(lines: ReadonlyArray<string>): Uint8Array {
  const paragraphs = lines
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`)
    .join("");
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>' +
    paragraphs +
    "</w:body></w:document>";
  const entries: WorkZipEntry[] = [
    {
      name: "[Content_Types].xml",
      data: textEncoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
    },
    {
      name: "_rels/.rels",
      data: textEncoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
    },
    {
      name: "word/_rels/document.xml.rels",
      data: textEncoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
      ),
    },
    { name: "word/document.xml", data: textEncoder.encode(documentXml) },
  ];
  return writeWorkZip(entries);
}

/**
 * Build a valid minimal PPTX container from slide specs (title + bullets).
 */
export function buildPptxFixture(
  slides: ReadonlyArray<{ readonly title: string; readonly bullets: ReadonlyArray<string> }>,
): Uint8Array {
  const slideCount = slides.length;
  const slideOverrides = slides
    .map((_, i) => {
      const n = i + 1;
      return `<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
    })
    .join("");
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    slideOverrides +
    "</Types>";
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>';
  const sldIds = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("");
  const presentationXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst>' +
    sldIds +
    '</p:sldIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>';
  const presentationRels = slides
    .map((_, i) => {
      const n = i + 1;
      return `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/>`;
    })
    .join("");
  const presentationRelsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    presentationRels +
    "</Relationships>";
  const entries: WorkZipEntry[] = [
    { name: "[Content_Types].xml", data: textEncoder.encode(contentTypes) },
    { name: "_rels/.rels", data: textEncoder.encode(rootRels) },
    { name: "ppt/_rels/presentation.xml.rels", data: textEncoder.encode(presentationRelsXml) },
    { name: "ppt/presentation.xml", data: textEncoder.encode(presentationXml) },
  ];
  for (let i = 0; i < slideCount; i += 1) {
    const n = i + 1;
    const slide = slides[i];
    if (slide === undefined) continue;
    const titleText = escapeXml(slide.title);
    const bodyRuns = slide.bullets
      .map(
        (bullet) =>
          `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escapeXml(bullet)}</a:t></a:r></a:p>`,
      )
      .join("");
    const bodyParagraphs =
      bodyRuns.length > 0 ? bodyRuns : `<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>`;
    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt x="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title ${n}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><p:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></p:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${titleText}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Content ${n}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><p:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="4572000"/></p:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${bodyParagraphs}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    entries.push({ name: `ppt/slides/slide${n}.xml`, data: textEncoder.encode(slideXml) });
  }
  return writeWorkZip(entries);
}

/**
 * Build a valid minimal PDF 1.4 document from page text lines. Each page
 * holds up to `linesPerPage` lines. Uses uncompressed content streams so
 * the preview PDF parser can extract text without FlateDecode.
 */
export function buildPdfFixture(pages: ReadonlyArray<ReadonlyArray<string>>): Uint8Array {
  const pageCount = Math.max(1, pages.length);
  const objects: Array<{ number: number; body: string }> = [];
  objects.push({ number: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" });
  const pageRefs = Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`);
  objects.push({
    number: 2,
    body: `<< /Type /Pages /Count ${pageCount} /Kids [${pageRefs.join(" ")}] >>`,
  });
  const fontObjectNumber = 3 + pageCount * 2;
  for (let page = 0; page < pageCount; page += 1) {
    const pageObjectNumber = 3 + page * 2;
    const contentObjectNumber = 4 + page * 2;
    const lines = pages[page] ?? [];
    const escaped = lines.map((line) => line.replace(/([\\()])/g, "\\$1"));
    const streamParts: string[] = ["BT", "/F1 12 Tf", "50 750 Td", "14 TL"];
    if (escaped.length > 0) {
      streamParts.push(`(${escaped[0]}) Tj`);
      for (let i = 1; i < escaped.length; i += 1) {
        streamParts.push("T*");
        streamParts.push(`(${escaped[i]}) Tj`);
      }
    }
    streamParts.push("ET");
    const stream = streamParts.join("\n");
    objects.push({
      number: pageObjectNumber,
      body: [
        "<< /Type /Page",
        "  /Parent 2 0 R",
        "  /MediaBox [0 0 612 792]",
        `  /Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >>`,
        `  /Contents ${contentObjectNumber} 0 R`,
        ">>",
      ].join("\n"),
    });
    objects.push({
      number: contentObjectNumber,
      body: [
        `<< /Length ${Buffer.byteLength(stream, "latin1")} >>`,
        "stream",
        stream,
        "endstream",
      ].join("\n"),
    });
  }
  objects.push({
    number: fontObjectNumber,
    body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  });
  const header = "%PDF-1.4\n";
  const chunks: Uint8Array[] = [Buffer.from(header, "latin1")];
  const offsets = new Map<number, number>();
  let offset = header.length;
  for (const obj of objects) {
    offsets.set(obj.number, offset);
    const objText = `${obj.number} 0 obj\n${obj.body}\nendobj\n`;
    const objBytes = Buffer.from(objText, "latin1");
    chunks.push(objBytes);
    offset += objBytes.byteLength;
  }
  const xrefStart = offset;
  const xrefLines: string[] = [`xref`, `0 ${objects.length + 1}`, `0000000000 65535 f `];
  for (let n = 1; n <= objects.length; n += 1) {
    xrefLines.push(`${offsets.get(n)!.toString().padStart(10, "0")} 00000 n `);
  }
  chunks.push(Buffer.from(xrefLines.join("\n") + "\n", "latin1"));
  const trailer = [
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    `${xrefStart}`,
    "%%EOF",
  ].join("\n");
  chunks.push(Buffer.from(trailer + "\n", "latin1"));
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return out;
}
