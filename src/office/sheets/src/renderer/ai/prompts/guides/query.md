# Query & import guide (query)

Two range-level operations that move data WITHOUT the model reading or retyping it. Both write **static values** starting at `target` (the top-left cell); the result's height is only known once it runs, so `target` must be a single cell in empty space (to the right of or below the source, or on a fresh sheet). Both handle sources up to 200,000 cells in one op. Neither can share a batch with row/column inserts or deletes.

## query_range — filter / sort / select / distinct / group + aggregate

Use it whenever the user wants a subset, an ordering, or a rollup of tabular data: "the withheld documents", "top 20 by amount", "totals by custodian", "unique witnesses", "everything dated in January". Do NOT read_range 5,000 rows and pick rows yourself — this op is exact, instant, and does not spend context.

```json
{"op":"query_range","sheetId":"s1","source":"A4:H2400","hasHeader":true,
 "where":{"all":[{"column":"Status","op":"eq","value":"Withheld"},
                 {"column":"Date","op":"between","value":"2026-01-01","value2":"2026-01-31"}]},
 "orderBy":[{"column":"Date","direction":"asc"}],
 "select":["Bates","Custodian","Date","Description"],
 "target":"K4"}
```

Fields:

- `source` — the block INCLUDING its header row when `hasHeader` is true (default). `sourceSheetId` when the data is on another sheet.
- Columns are named by **header text** (case-insensitive) or by **column letter**. A header name wins over a same-looking letter.
- `where.all` (AND) and `where.any` (OR); both given = all AND (any). Predicate ops: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `between` (value, value2), `contains`, `notContains`, `startsWith`, `endsWith`, `in` / `notIn` (values[]), `blank`, `notBlank`, `matches` (regex, case-insensitive, ≤200 chars).
- Comparisons are typed: numbers compare numerically when BOTH sides are numeric (numeric text such as `"$1,200"` or `"12%"` counts), dates compare as dates when both parse as dates (`2026-01-31`, `1/31/2026`, `Jan. 31, 2026`), otherwise as trimmed case-insensitive text. `eq`/`in` use the same rule, so `"1,200"` equals `1200`.
- `orderBy` — up to 3 keys; blanks sort last in either direction; ties keep source order.
- `select` — output columns (default all, in source order). `distinct: true` dedupes the projected rows.
- `groupBy` + `aggregates` — one output row per group: the group columns, then each aggregate. `fn`: `sum`, `avg`, `min`, `max` (numeric cells only), `count` (non-blank), `countDistinct`, `first`. `as` names the output column (default `fn(column)`). `orderBy` after grouping may refer to output names (e.g. the `as` label). `select`/`distinct` do not combine with grouping.
- `limit` / `offset` page the result; `writeHeader:false` omits the header row.
- Wholly blank source rows never match.

Grouped example — totals and counts by custodian, largest first:

```json
{"op":"query_range","sheetId":"s1","source":"A4:H2400","groupBy":["Custodian"],
 "aggregates":[{"column":"Amount","fn":"sum","as":"Total"},{"column":"Bates","fn":"count","as":"Documents"}],
 "orderBy":[{"column":"Total","direction":"desc"}],"target":"K4"}
```

The tool result reports `matched of total` rows and what was written. Zero matches writes only the header: read the filter column first (`aggregate_range` shows its most frequent values) rather than guessing spellings. Then format the result block like any table (`format_range`, `set_col_width`; the litigation-workbook guide has the house style) and, if the user wants it live, add a native table or filter over it.

## import_file — land a sandbox file in the grid

`run_python` returns a `platform-file:<id>` handle for every CSV/TSV it writes. Import it directly; never read the CSV back and retype values.

```json
{"op":"import_file","sheetId":"s2","file":"platform-file:3f9a1c2b","target":"A1"}
```

- `delimiter`: `","`, `";"`, `"\t"`, `"|"` or `"auto"` (default: sniffed).
- Typing is Excel-like: numbers (including `1,200.50`, `4.5e3`) and TRUE/FALSE become typed cells; identifiers with leading zeros (`000123`, Bates numbers) and long digit strings stay text. `asText:true` keeps everything as text.
- Files are capped at 200,000 cells; reduce in pandas first (filter rows, drop columns) and write a smaller file when a run reports the cap.
- Typical flow for heavy analysis: `load_attachment_for_python` (or read_range the block and write it from Python) → pandas transform → `df.to_csv("result.csv", index=False)` → `import_file` onto a new sheet → format. The values written are exactly the file's.

## Choosing between them

- Subset / order / rollup of data already in the workbook → `query_range`.
- Joins across sheets, fuzzy matching, regex-heavy cleanup, statistics beyond sum/avg/min/max, date arithmetic in bulk → Python + `import_file`.
- Fill a formula down a column → `fill_range`. Duplicate a block → `copy_range`.
