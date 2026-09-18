# Litigation workbook guide (litigation-workbook)

Applies to the workbooks a litigation team actually builds: damages models, privilege logs, exhibit and witness lists, deposition and deadline trackers, settlement and allocation matrices, discovery indexes, bellwether comparisons. The goal is a workbook a partner can open cold and read in ten seconds, print without fixing anything, and filter without breaking a formula. All operations are `propose_operations` ops; formats and content may share a batch, structural changes (row/column insert-delete) need their own batch.

## Layout skeleton (every sheet)

1. **Row 1 title** — merged across the used columns, bold, 14 pt, left-aligned. Row 2 a one-line subtitle in gray: matter, "as of" date, preparer. Leave row 3 blank.
2. **Row 4 header** — one row, bold, white text on navy `#1F3864`, wrap text on, vertical center, 30 pt row height. Never two header rows; never merged header cells (they break filters and pivots).
3. **Data starts row 5.** One record per row, one fact per column, no blank spacer rows inside the data (they break sorting and `SUBTOTAL`).
4. **Freeze the header and the key column** so both stay in view while scrolling.
5. **AutoFilter on the header row.** Analysts filter; do not pre-sort into groups separated by blank rows.

```json
[
 {"op":"merge_cells","sheetId":"s1","range":"A1:H1"},
 {"op":"set_cell","sheetId":"s1","address":"A1","value":"Privilege Log — In re [Matter] (MDL No. ____)"},
 {"op":"format_range","sheetId":"s1","range":"A1:H1","format":{"bold":true,"fontSize":14}},
 {"op":"set_cell","sheetId":"s1","address":"A2","value":"Prepared [date] · Privileged & Confidential · Attorney Work Product"},
 {"op":"format_range","sheetId":"s1","range":"A2:H2","format":{"italic":true,"fontColor":"#666666","fontSize":9}},
 {"op":"format_range","sheetId":"s1","range":"A4:H4","format":{"bold":true,"fillColor":"#1F3864","fontColor":"#FFFFFF","wrapText":true,"verticalAlign":"center"}},
 {"op":"set_row_height","sheetId":"s1","row":4,"heightPoints":30},
 {"op":"set_freeze","sheetId":"s1","rows":4,"columns":1},
 {"op":"set_filter","sheetId":"s1","range":"A4:H200"}
]
```

## Column widths and alignment

- Set widths explicitly with `set_col_width`; never leave Excel's default 64 px for text columns. Rough guide: id/Bates 110 px, dates 96 px, short codes 90 px, names 180 px, descriptions 320–420 px with `wrapText`, currency 110 px.
- Text left, numbers and currency right, dates and short codes center. Wrap long text columns instead of widening past ~420 px; set `verticalAlign: "top"` on wrapped data rows so multi-line cells read from the top.
- Body text 10 pt (`fontSize: 10`); one font family for the whole workbook (leave the default unless the firm style says otherwise).

```json
[
 {"op":"set_col_width","sheetId":"s1","column":"A","widthPx":110},
 {"op":"set_col_width","sheetId":"s1","column":"B","count":2,"widthPx":96},
 {"op":"set_col_width","sheetId":"s1","column":"F","widthPx":380},
 {"op":"format_range","sheetId":"s1","range":"F5:F200","format":{"wrapText":true,"verticalAlign":"top"}},
 {"op":"format_range","sheetId":"s1","range":"B5:C200","format":{"horizontalAlign":"center"}}
]
```

## Number and date formats

- Dates: `mm/dd/yyyy` for U.S. filings, or `mmm d, yyyy` in narrative trackers; one format per workbook. Store real dates, never text, so sorting and `DATEDIF`/`NETWORKDAYS` work.
- Currency: `[$$-409]#,##0;[Red]([$$-409]#,##0);"-"` (negatives in red parentheses, zero as a dash). Whole dollars in summaries; cents only in line-item detail.
- Bates ranges are text (`PLTF000001–PLTF000045`); set the column format to `@` before writing so leading zeros survive.
- Percentages `0.0%`; page counts and document counts `#,##0`.

## Banding, rules and totals

- Subtle banding on long logs: alternate `#F8FAFC` fill on even data rows, or use a native table (`add_table`, style `TableStyleLight9`) which bands automatically and extends formulas — prefer the native table for logs over ~50 rows.
- Grid: thin inner borders `#D9D9D9`; outline the used range once with `border:{type:"all",color:"#D9D9D9"}`. No heavy black grids.
- Totals: bold, `#F2F2F2` fill, thin top border + double-effect via a bottom border; totals use `SUBTOTAL(9, range)` so filtered views total correctly.
- Status columns get a dropdown (`set_data_validation`, `kind: "list"`) and a conditional format per state. Keep the palette to three states: green `#E2F0D9` done, amber `#FFF2CC` pending, red `#F8D7DA` overdue/at risk.

```json
[
 {"op":"set_data_validation","sheetId":"s1","range":"G5:G200","validation":{"kind":"list","values":["Produced","Withheld","Redacted","Clawback"]}},
 {"op":"add_conditional_format","sheetId":"s1","range":"G5:G200","rule":{"kind":"text","operator":"contains","text":"Withheld","format":{"fillColor":"#FFF2CC"}}},
 {"op":"add_conditional_format","sheetId":"s1","range":"E5:E200","rule":{"kind":"blank","blank":true,"format":{"fillColor":"#F8D7DA"}}}
]
```

Deadline trackers: highlight dates in the next 14 days with a `number` rule on a helper column `=D5-TODAY()` (`lessThanOrEqual` 14, amber) and overdue (`lessThan` 0, red). Hide the helper column with `set_cols_hidden` rather than deleting it.

## Damages and settlement models

- Inputs blue text `#0000FF`, formulas black, cross-sheet links green `#008000`; a dedicated **Assumptions** sheet holds every hard-coded input with a source note beside it. No number appears twice — reference the assumption cell.
- One scenario per column (Low / Mid / High), one line item per row; a `Notes/Source` column on the far right, never interleaved.
- Round only in presentation cells (`numberFormat`), never in the formula chain.
- Sensitivity tables use `fill_range`/`set_formula` with absolute references; label the axis cells in bold and shade the base case.
- Charts (see the `charts` guide): one message per chart, categories on the x-axis, no 3-D, no gridlines heavier than `#D9D9D9`, series colors from the navy/blue palette, data labels only on totals. Put charts on a **Summary** sheet next to the table they read from, never floating over data.

## Print-ready

Every deliverable sheet is set up to print before you finish: landscape for wide logs, fit to one page wide, header row repeated by keeping it in the print area, `printGridlines` off (borders carry the grid), print area limited to the used range.

```json
{"op":"set_page_setup","sheetId":"s1","orientation":"landscape","fitToWidth":1,"fitToHeight":0,"margins":"narrow","printGridlines":false,"printArea":"A1:H200"}
```

## Discipline

- Confidentiality legends ("Privileged & Confidential — Attorney Work Product", "CONFIDENTIAL — Subject to Protective Order") go in the row-2 subtitle and, for produced documents, in a footer note; never in a data column.
- Never type a Bates number, date, or dollar figure that is not in the source data or the user's instruction; leave the cell blank and say so.
- Styling failures never block: deliver correct data first, then re-apply formats once.
- Do not merge cells inside the data area, and do not use color as the only carrier of meaning — a status word or code always accompanies a fill.
