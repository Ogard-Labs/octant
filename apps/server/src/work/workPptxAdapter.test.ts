import { describe, expect, it } from "vitest";
import { workPptxAdapter } from "./workPptxAdapter";
import { readWorkZip, writeWorkZip } from "./workZipPort";

const deck = "# Title One\n- bullet a\n---\n# Title Two\n- bullet b";

describe("workPptxAdapter", () => {
  it("encode produces bytes starting with the ZIP magic 0x50 0x4b", () => {
    const bytes = workPptxAdapter.encode("# Intro\n- point");
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it("readWorkZip(encode(deck)) contains ppt/presentation.xml and ppt/slides/slide1.xml", () => {
    const bytes = workPptxAdapter.encode("# Intro\n- point one");
    const entries = readWorkZip(bytes);
    expect(entries.has("ppt/presentation.xml")).toBe(true);
    expect(entries.has("ppt/slides/slide1.xml")).toBe(true);
  });

  it("encodes a multi-slide deck with slide1.xml and slide2.xml", () => {
    const bytes = workPptxAdapter.encode(deck);
    const entries = readWorkZip(bytes);
    expect(entries.has("ppt/slides/slide1.xml")).toBe(true);
    expect(entries.has("ppt/slides/slide2.xml")).toBe(true);
  });

  it("round-trips a two-slide markdown-deck through encode and decode", () => {
    const bytes = workPptxAdapter.encode(deck);
    const decoded = workPptxAdapter.decode(bytes);
    expect(decoded).toBe(deck);
  });

  it("decode returns undefined for a non-ZIP byte array", () => {
    const notZip = new TextEncoder().encode("not a zip file at all");
    expect(workPptxAdapter.decode(notZip)).toBeUndefined();
  });

  it("convertTo markdown-deck returns UTF-8 bytes decoding to the deck text", () => {
    const bytes = workPptxAdapter.encode(deck);
    const converted = workPptxAdapter.convertTo("markdown-deck", bytes);
    expect(converted).not.toBeUndefined();
    if (converted === undefined) return;
    const text = new TextDecoder().decode(converted);
    expect(text).toBe(deck);
  });

  it("convertTo csv returns undefined", () => {
    const bytes = workPptxAdapter.encode(deck);
    expect(workPptxAdapter.convertTo("csv", bytes)).toBeUndefined();
  });

  it("convertTo pptx returns the same bytes", () => {
    const bytes = workPptxAdapter.encode(deck);
    expect(workPptxAdapter.convertTo("pptx", bytes)).toBe(bytes);
  });

  it("reports the specified capability flags", () => {
    expect(workPptxAdapter.capabilities).toEqual({
      canRead: true,
      canCreate: true,
      canMutate: true,
      canRoundTrip: false,
      canExport: true,
      canVersion: true,
    });
  });

  it("advertises markdown-deck as a lossy derived export format", () => {
    expect(workPptxAdapter.exportFormats).toEqual(["markdown-deck"]);
  });

  it("starts generated slide IDs at 256 per ST_SlideId", () => {
    const bytes = workPptxAdapter.encode("# Intro\n- point");
    const entries = readWorkZip(bytes);
    const presXml = new TextDecoder().decode(entries.get("ppt/presentation.xml")!);
    expect(presXml).toContain('id="256"');
    expect(presXml).not.toContain('id="1"');
  });

  it("does not declare a slide master relationship or sldMasterIdLst", () => {
    const bytes = workPptxAdapter.encode("# Intro\n- point");
    const entries = readWorkZip(bytes);
    const presXml = new TextDecoder().decode(entries.get("ppt/presentation.xml")!);
    expect(presXml).not.toContain("sldMasterIdLst");
    const relsXml = new TextDecoder().decode(entries.get("ppt/_rels/presentation.xml.rels")!);
    expect(relsXml).not.toContain("rIdMaster");
    expect(relsXml).not.toContain("slideMaster");
  });

  it("decode follows presentation.xml slide order, not filename order", () => {
    const bytes = workPptxAdapter.encode("# First\n- a\n---\n# Second\n- b");
    const entries = readWorkZip(bytes);

    // Swap the slide order in presentation.xml: rId2 before rId1
    const presXml = new TextDecoder().decode(entries.get("ppt/presentation.xml")!);
    const swappedPres = presXml.replace(
      /<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/,
      '<p:sldIdLst><p:sldId id="257" r:id="rId2"/><p:sldId id="256" r:id="rId1"/></p:sldIdLst>',
    );
    entries.set("ppt/presentation.xml", new TextEncoder().encode(swappedPres));

    // Rebuild the ZIP from the modified entries
    const rebuiltBytes = writeWorkZip(
      Array.from(entries.entries()).map(([name, data]) => ({ name, data })),
    );
    const decoded = workPptxAdapter.decode(rebuiltBytes);
    // Second slide should now come first
    expect(decoded).toBe("# Second\n- b\n---\n# First\n- a");
  });

  it("decodes relationship attributes independently of XML attribute order", () => {
    const bytes = workPptxAdapter.encode("# First\n- a\n---\n# Second\n- b");
    const entries = readWorkZip(bytes);
    const relsPath = "ppt/_rels/presentation.xml.rels";
    const relsXml = new TextDecoder().decode(entries.get(relsPath)!);
    entries.set(
      relsPath,
      new TextEncoder().encode(
        relsXml.replace(
          /<Relationship Id="([^"]+)" Type="([^"]+)" Target="([^"]+)"\/>/g,
          '<Relationship Target="$3" Type="$2" Id="$1"/>',
        ),
      ),
    );
    const rebuiltBytes = writeWorkZip(
      Array.from(entries.entries()).map(([name, data]) => ({ name, data })),
    );
    expect(workPptxAdapter.decode(rebuiltBytes)).toBe("# First\n- a\n---\n# Second\n- b");
  });

  it("decode falls back to filename sort when presentation.xml has no sldIdLst", () => {
    const bytes = workPptxAdapter.encode("# First\n- a\n---\n# Second\n- b");
    const entries = readWorkZip(bytes);

    // Remove the sldIdLst from presentation.xml
    const presXml = new TextDecoder().decode(entries.get("ppt/presentation.xml")!);
    const strippedPres = presXml.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, "");
    entries.set("ppt/presentation.xml", new TextEncoder().encode(strippedPres));

    const rebuiltBytes = writeWorkZip(
      Array.from(entries.entries()).map(([name, data]) => ({ name, data })),
    );
    const decoded = workPptxAdapter.decode(rebuiltBytes);
    // Falls back to filename order: slide1 then slide2
    expect(decoded).toBe("# First\n- a\n---\n# Second\n- b");
  });

  it("throws when encoding a deck with too many slides", () => {
    // Build a deck with MAX_PPTX_SLIDE_COUNT + 1 slides (10001)
    const slides: string[] = [];
    for (let i = 0; i < 10001; i += 1) {
      slides.push(`# Slide ${i}\n- bullet`);
    }
    const hugeDeck = slides.join("\n---\n");
    expect(() => workPptxAdapter.encode(hugeDeck)).toThrow();
  });

  it("assigns unique p:cNvPr id values within each slide (no duplicates)", () => {
    const bytes = workPptxAdapter.encode("# Intro\n- point one");
    const entries = readWorkZip(bytes);
    const slideXml = new TextDecoder().decode(entries.get("ppt/slides/slide1.xml")!);
    const idMatches = [...slideXml.matchAll(/<p:cNvPr\s+id="(\d+)"/g)].map((m) => m[1]);
    expect(idMatches.length).toBeGreaterThan(0);
    const uniqueIds = new Set(idMatches);
    expect(uniqueIds.size).toBe(idMatches.length);
    // The group shape uses id="1"; user shapes must not collide with it.
    expect(idMatches).toContain("1");
    expect(idMatches).toContain("2");
    expect(idMatches).toContain("3");
  });

  it("emits explicit geometry (prstGeom rect) and extents (xfrm/off/ext) for shapes", () => {
    const bytes = workPptxAdapter.encode("# Intro\n- point one");
    const entries = readWorkZip(bytes);
    const slideXml = new TextDecoder().decode(entries.get("ppt/slides/slide1.xml")!);
    expect(slideXml).toContain('<a:prstGeom prst="rect">');
    expect(slideXml).toContain("<p:xfrm>");
    expect(slideXml).toContain("<a:off ");
    expect(slideXml).toContain("<a:ext ");
  });
});
