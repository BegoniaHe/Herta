import { strToU8, zipSync } from "fflate";

/**
 * Synthetic PDF and DOCX bytes for the extraction tests (ADR 0038). Built by
 * hand so the suite depends on no binary fixture files and can vary the shape
 * per test — page count, an empty page, an encryption dictionary, an entity in
 * a run.
 */

/**
 * A minimal, well-formed PDF: one Helvetica page per entry of `pages`, each an
 * array of text lines. An empty array yields a page with an EMPTY content
 * stream — the shape of a scanned page, which has an image and no text.
 * `encrypt` adds a standard-security-handler dictionary with garbage O/U
 * strings, so the empty user password fails validation and pdfjs raises
 * `PasswordException` before it needs to decrypt anything.
 */
/** A bookmark for `makePdf`'s `bookmarks` option: title, 1-based target
 *  page, optional children. `named` routes the dest through the catalog's
 *  `/Dests` name tree instead of an explicit array — the other shape real
 *  producers emit. `page: 0` leaves the bookmark with no dest at all. */
export interface PdfBookmark {
  readonly title: string;
  readonly page: number;
  readonly named?: boolean;
  readonly items?: readonly PdfBookmark[];
}

export function makePdf(
  pages: ReadonlyArray<readonly string[]>,
  opts: {
    readonly encrypt?: boolean;
    readonly bookmarks?: readonly PdfBookmark[];
  } = {},
): Buffer {
  const objs: string[] = [];
  const add = (body: string): number => {
    objs.push(body);
    return objs.length; // 1-based object number
  };
  const catalog = add("");
  const pagesObj = add("");
  const font = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  const kids: string[] = [];
  for (const lines of pages) {
    const ops = ["BT", "/F1 12 Tf", "72 720 Td"];
    lines.forEach((line, i) => {
      if (i > 0) ops.push("0 -14 Td");
      const esc = line
        .replace(/\\/g, "\\\\")
        .replace(/\(/g, "\\(")
        .replace(/\)/g, "\\)");
      ops.push(`(${esc}) Tj`);
    });
    ops.push("ET");
    const stream = lines.length === 0 ? "" : ops.join("\n");
    const contents = add(
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    );
    const page = add(
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    );
    kids.push(`${page} 0 R`);
  }
  // Outline tree (2026-08-23): a doubly linked sibling list per level, the
  // spec's shape. Named dests collect into a flat `/Dests` dictionary on the
  // catalog (the pre-1.2 form pdfjs resolves through getDestination).
  const namedDests: string[] = [];
  let outlinesRef = "";
  if (opts.bookmarks !== undefined && opts.bookmarks.length > 0) {
    const outlines = add("");
    const link = (
      items: readonly PdfBookmark[],
      parent: number,
    ): { first: number; last: number; count: number } => {
      const nums = items.map(() => add(""));
      let count = nums.length;
      items.forEach((b, i) => {
        const num = nums[i] as number;
        const target = kids[b.page - 1];
        let dest = "";
        if (target !== undefined) {
          if (b.named === true) {
            const name = `bm${num}`;
            namedDests.push(`/${name} [${target} /Fit]`);
            dest = ` /Dest (${name})`;
          } else {
            dest = ` /Dest [${target} /XYZ null null null]`;
          }
        }
        const children =
          b.items !== undefined && b.items.length > 0
            ? link(b.items, num)
            : undefined;
        if (children !== undefined) count += children.count;
        const prev = i > 0 ? ` /Prev ${nums[i - 1]} 0 R` : "";
        const next = i < nums.length - 1 ? ` /Next ${nums[i + 1]} 0 R` : "";
        const kidsPart =
          children !== undefined
            ? ` /First ${children.first} 0 R /Last ${children.last} 0 R /Count ${children.count}`
            : "";
        const title = b.title
          .replace(/\\/g, "\\\\")
          .replace(/\(/g, "\\(")
          .replace(/\)/g, "\\)");
        objs[num - 1] =
          `<< /Title (${title}) /Parent ${parent} 0 R${prev}${next}${dest}${kidsPart} >>`;
      });
      return {
        first: nums[0] as number,
        last: nums[nums.length - 1] as number,
        count,
      };
    };
    const top = link(opts.bookmarks, outlines);
    objs[outlines - 1] =
      `<< /Type /Outlines /First ${top.first} 0 R /Last ${top.last} 0 R /Count ${top.count} >>`;
    outlinesRef = ` /Outlines ${outlines} 0 R`;
  }
  const destsRef =
    namedDests.length > 0 ? ` /Dests << ${namedDests.join(" ")} >>` : "";
  objs[catalog - 1] =
    `<< /Type /Catalog /Pages ${pagesObj} 0 R${outlinesRef}${destsRef} >>`;
  objs[pagesObj - 1] =
    `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;
  let encryptRef = "";
  if (opts.encrypt === true) {
    const enc = add(
      `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -1 /O <${"00".repeat(32)}> /U <${"11".repeat(32)}> >>`,
    );
    encryptRef = ` /Encrypt ${enc} 0 R /ID [<01234567890123456789012345678901> <01234567890123456789012345678901>]`;
  }
  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R${encryptRef} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/**
 * A minimal `.docx` package: `[Content_Types].xml` plus `word/document.xml`
 * whose body is the given raw WordprocessingML (already-escaped XML). Use
 * `docxParagraphs` for the common case.
 */
export function makeDocx(bodyXml: string): Buffer {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`;
  const zipped = zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    "word/document.xml": strToU8(doc),
    // A binary sibling part, so the filter's skip-without-inflate is exercised.
    "word/media/image1.bin": new Uint8Array([0, 1, 2, 3, 255, 254]),
  });
  return Buffer.from(zipped);
}

/** One `w:p` with one `w:t` per entry. Text is escaped for XML here. */
export function docxParagraphs(paragraphs: readonly string[]): string {
  return paragraphs
    .map(
      (p) =>
        `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`,
    )
    .join("");
}

/** One heading paragraph: `style` is the `w:pStyle` id (`Heading1`, or the
 *  bare `1` Chinese Word writes), `outlineLvl` an explicit 0-based level. */
export function docxHeading(
  text: string,
  opts: { readonly style?: string; readonly outlineLvl?: number } = {},
): string {
  const style =
    opts.style !== undefined ? `<w:pStyle w:val="${opts.style}"/>` : "";
  const lvl =
    opts.outlineLvl !== undefined
      ? `<w:outlineLvl w:val="${opts.outlineLvl}"/>`
      : "";
  return `<w:p><w:pPr>${style}${lvl}</w:pPr><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

/** A zip that is NOT a Word package (no `word/document.xml`) — the shape of a
 *  `.xlsx` or `.pptx` renamed to `.docx`. */
export function makeNonWordZip(): Buffer {
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "xl/workbook.xml": strToU8("<workbook/>"),
    }),
  );
}

/** The 8-byte OLE compound-file signature followed by padding — what a legacy
 *  `.doc` (or an encrypted OOXML package) starts with. */
export function makeOleBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(512, 0),
  ]);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
