// The document form built from a template's field schema, including tables
// (with "paste from spreadsheet").
import { useRef } from "react"
import type { Column, DocumentData, Field } from "@doctrust/shared"
import { readImage } from "../../shared/format"
import { errorMessage } from "../../shared/api"
import { useDialogs } from "../../shared/ui/Dialogs"
import { useToast } from "../../shared/ui/Toasts"

type Row = Record<string, unknown>

export function DocumentForm({ schema, value, onChange }: { schema: Field[]; value: DocumentData; onChange: (next: DocumentData) => void }) {
  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v })
  return (
    <div className="stack">
      <div className="grid-2">
        {schema
          .filter((f) => f.type !== "table")
          .map((f) => (
            <FieldControl key={f.key} field={f} value={value[f.key]} onChange={(v) => set(f.key, v)} />
          ))}
      </div>
      {schema
        .filter((f) => f.type === "table")
        .map((f) => (
          <TableEditor key={f.key} field={f} rows={Array.isArray(value[f.key]) ? (value[f.key] as Row[]) : []} onChange={(rows) => set(f.key, rows)} />
        ))}
    </div>
  )
}

const Label = ({ field }: { field: Pick<Field, "label" | "required"> }) => (
  <span>
    {field.label}
    {field.required ? <span className="req" aria-hidden="true"> *</span> : null}
  </span>
)

const inputType = (type: string) => (type === "number" ? "number" : type === "date" ? "date" : "text")
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v))

function FieldControl({ field, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  const toast = useToast()
  const help = field.help ? <small>{field.help}</small> : null
  switch (field.type) {
    case "textarea":
      return (
        <label className="field full">
          <Label field={field} />
          <textarea rows={3} value={str(value)} onChange={(e) => onChange(e.target.value)} />
          {help}
        </label>
      )
    case "checkbox":
      return (
        <label className="check">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          {field.label}
        </label>
      )
    case "select":
      return (
        <label className="field">
          <Label field={field} />
          <select value={str(value)} onChange={(e) => onChange(e.target.value)}>
            <option value="">—</option>
            {(field.options || []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          {help}
        </label>
      )
    case "image":
      return (
        <div className="field full">
          <label className="field">
            <Label field={field} />
          </label>
          <div className="img-field">
            {value ? <img src={String(value)} alt="" /> : <span className="muted">No image</span>}
            <label className="btn small">
              Choose image
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                style={{ display: "none" }}
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  try {
                    onChange(await readImage(file))
                  } catch (err) {
                    toast(errorMessage(err), true)
                  }
                }}
              />
            </label>
            {value ? (
              <button className="btn small ghost" type="button" onClick={() => onChange("")}>
                Remove
              </button>
            ) : null}
          </div>
          {help}
        </div>
      )
    default:
      return (
        <label className="field">
          <Label field={field} />
          <input type={inputType(field.type)} step={field.type === "number" ? "any" : undefined} value={str(value)} onChange={(e) => onChange(e.target.value)} />
          {help}
        </label>
      )
  }
}

function Cell({ col, value, onChange }: { col: Column; value: unknown; onChange: (v: unknown) => void }) {
  if (col.type === "checkbox") return <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} aria-label={col.label} />
  if (col.type === "select") {
    return (
      <select value={str(value)} onChange={(e) => onChange(e.target.value)} aria-label={col.label}>
        <option value="">—</option>
        {(col.options || []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  }
  return <input type={inputType(col.type)} value={str(value)} onChange={(e) => onChange(e.target.value)} aria-label={col.label} />
}

function TableEditor({ field, rows, onChange }: { field: Field; rows: Row[]; onChange: (rows: Row[]) => void }) {
  const columns = field.columns || []
  const dialogs = useDialogs()
  const toast = useToast()
  const tbody = useRef<HTMLTableSectionElement>(null)

  const setCell = (i: number, key: string, v: unknown) => onChange(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)))
  const emptyRow = () => Object.fromEntries(columns.map((c) => [c.key, c.type === "checkbox" ? false : ""]))

  const addRow = () => {
    onChange([...rows, emptyRow()])
    // Focus the first cell of the new row once it's drawn.
    setTimeout(() => {
      const first = tbody.current?.lastElementChild?.querySelector<HTMLElement>("input,select")
      first?.focus()
    })
  }

  const paste = async () => {
    const res = await dialogs.form(`Paste rows into ${field.label}`, (
      <>
        <p className="muted">Copy rows from Excel or Google Sheets and paste them below. Columns must be in this order: {columns.map((c) => c.label).join(" · ")}</p>
        <textarea name="tsv" rows={8} className="code" style={{ minHeight: 160 }} placeholder="Paste here" />
        <label className="check">
          <input type="checkbox" name="replace" />
          Replace existing rows
        </label>
      </>
    ), { submitLabel: "Add rows" })
    if (!res || !String(res.tsv).trim()) return
    const lines = String(res.tsv).replace(/\r/g, "").split("\n").filter((l) => l.trim())
    const added = lines.map((line) => {
      const cells = line.split("\t")
      return Object.fromEntries(columns.map((c, i) => {
        const val = (cells[i] || "").trim()
        return [c.key, c.type === "checkbox" ? /^(yes|y|true|1|x|✓)$/i.test(val) : val]
      }))
    })
    onChange(res.replace ? added : [...rows, ...added])
    toast(`${lines.length} row(s) added`)
  }

  return (
    <fieldset className="fieldset">
      <legend>
        {field.label}
        {field.required ? <span className="req"> *</span> : null}
      </legend>
      <div className="table-editor">
        <table>
          <thead>
            <tr>
              <th>#</th>
              {columns.map((c) => (
                <th key={c.key}>
                  {c.label}
                  {c.required ? <span className="req"> *</span> : null}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody ref={tbody}>
            {rows.length ? (
              rows.map((row, i) => (
                <tr key={i}>
                  <td className="n">{i + 1}</td>
                  {columns.map((c) => (
                    <td key={c.key}>
                      <Cell col={c} value={row[c.key]} onChange={(v) => setCell(i, c.key, v)} />
                    </td>
                  ))}
                  <td className="x">
                    <button className="btn small ghost" type="button" title="Remove row" aria-label={`Remove row ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={columns.length + 2} className="muted" style={{ padding: 14, textAlign: "center" }}>
                  No rows yet — add one or paste from a spreadsheet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn small" type="button" onClick={addRow}>
          + Add row
        </button>
        <button className="btn small" type="button" onClick={paste}>
          Paste from spreadsheet
        </button>
        <div className="spacer" />
        <span className="muted">{rows.length === 1 ? "1 row" : `${rows.length} rows`}</span>
      </div>
    </fieldset>
  )
}
