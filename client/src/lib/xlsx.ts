import XLSXStyle from "xlsx-js-style";

// Map a column header to its background hex (no leading #).
function getColumnBg(header: string): string {
  const h = header.toLowerCase().trim();
  if (h === "blank") return "EBEBEB";
  if (h === "linkedin url" || h === "full name") return "D6E4F0";
  if (["company1", "title1", "yac", "company1 start date", "company1 end date"].includes(h))
    return "D5F5E3";
  if (["company2", "company2 title"].includes(h)) return "C8EFD4";
  if (h === "candidate location") return "FDEBD0";
  if (["school1", "school1 degree", "school1 major", "school 1 end date"].includes(h))
    return "FEF9E7";
  if (["linkedin id", "total yoe"].includes(h)) return "F0F0F0";
  if (
    ["phdata reasoning score", "phdata fit rationale", "phdata department fit"].includes(h)
  )
    return "FFF3CD";
  return "FFFFFF";
}

function getColumnWidth(header: string): number {
  const h = header.toLowerCase().trim();
  if (h === "blank") return 3;
  if (h === "linkedin url") return 32;
  if (h === "full name") return 22;
  if (h === "company1" || h === "company2") return 24;
  if (h === "title1" || h === "company2 title") return 28;
  if (h === "yac") return 8;
  if (h.includes("start date") || h.includes("end date")) return 14;
  if (h === "candidate location") return 22;
  if (h === "school1") return 24;
  if (h === "school1 degree" || h === "school1 major") return 22;
  if (h === "school 1 end date") return 12;
  if (h === "linkedin id") return 18;
  if (h === "total yoe") return 10;
  if (h === "phdata reasoning score") return 12;
  if (h === "phdata fit rationale") return 55;
  if (h === "phdata department fit") return 24;
  return 15;
}

const HEADER_BG = "264369"; // phData Blue
const HEADER_FG = "FFFFFF";

const THIN_BORDER = {
  top: { style: "thin", color: { rgb: "CCCCCC" } },
  bottom: { style: "thin", color: { rgb: "CCCCCC" } },
  left: { style: "thin", color: { rgb: "CCCCCC" } },
  right: { style: "thin", color: { rgb: "CCCCCC" } },
};

/**
 * Build and trigger a download of a styled .xlsx file.
 * Applies column-group color coding, frozen header row, autofilter, and borders.
 */
export function downloadXlsx(
  filename: string,
  headers: string[],
  rows: string[][],
): void {
  const aoa: string[][] = [headers, ...rows];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws: any = XLSXStyle.utils.aoa_to_sheet(aoa);
  const totalRows = aoa.length;
  const totalCols = headers.length;

  for (let r = 0; r < totalRows; r++) {
    for (let c = 0; c < totalCols; c++) {
      const addr = XLSXStyle.utils.encode_cell({ r, c });
      if (!ws[addr]) ws[addr] = { v: "", t: "s" };

      const header = headers[c];
      const isHeaderRow = r === 0;
      const hLower = header.toLowerCase().trim();
      const isRationale = hLower === "phdata fit rationale";
      const isDept = hLower === "phdata department fit";

      ws[addr].s = isHeaderRow
        ? {
            fill: { fgColor: { rgb: HEADER_BG } },
            font: { bold: true, color: { rgb: HEADER_FG }, sz: 10 },
            alignment: { wrapText: true, vertical: "center", horizontal: "center" },
            border: THIN_BORDER,
          }
        : {
            fill: { fgColor: { rgb: getColumnBg(header) } },
            font: { bold: isDept, sz: 10 },
            alignment: { wrapText: isRationale, vertical: "top", horizontal: "left" },
            border: THIN_BORDER,
          };
    }
  }

  ws["!cols"] = headers.map((h) => ({ wch: getColumnWidth(h) }));

  ws["!freeze"] = {
    xSplit: 0,
    ySplit: 1,
    topLeftCell: "A2",
    activePane: "bottomLeft",
    state: "frozen",
  };

  ws["!rows"] = [
    { hpt: 30 },
    ...Array<{ hpt: number }>(rows.length).fill({ hpt: 18 }),
  ];

  // Autofilter spans the full data range so columns are filterable in Sheets / Excel.
  ws["!autofilter"] = { ref: ws["!ref"] };

  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, "Candidates");

  const xlsxFilename = filename.replace(/\.csv$/i, "") + ".xlsx";
  XLSXStyle.writeFile(wb, xlsxFilename);
}
