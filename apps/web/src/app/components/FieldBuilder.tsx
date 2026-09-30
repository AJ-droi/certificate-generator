// Visual editor for a template's field list (and table columns).
import type { Column, Field, FieldType } from "@doctrust/shared"

const FIELD_TYPES: FieldType[] = ["text", "textarea", "number", "date", "select", "checkbox", "image", "table"]
const COLUMN_TYPES = ["text", "number", "date", "select", "checkbox"] as const

type Item = Field | Column
type EditSchema = (fn: (schema: Field[]) => void) => void
// Finds the list a row lives in (the fields, or one table's columns) inside the schema.
type ListOf = (schema: Field[]) => Item[]

export function FieldBuilder({ schema, edit }: { schema: Field[]; edit: EditSchema }) {
  const fields: ListOf = (s) => s
  return (
    <div className="stack">
      {schema.map((f, i) => (
        <FieldRow key={i} value={f} index={i} count={schema.length} listOf={fields} isColumn={false} edit={edit} />
      ))}
      <button className="btn small" type="button" onClick={() => edit((s) => { s.push({ key: `field${s.length + 1}`, label: "New field", type: "text" }) })}>
        + Add field
      </button>
    </div>
  )
}

function FieldRow({ value: f, index: i, count, listOf, isColumn, edit }: {
  value: Item
  index: number
  count: number
  listOf: ListOf
  isColumn: boolean
  edit: EditSchema
}) {
  const types: readonly string[] = isColumn ? COLUMN_TYPES : FIELD_TYPES
  // Changes this row (found again in the schema being edited).
  const set = (fn: (item: Item) => void) => edit((s) => fn(listOf(s)[i]))
  const move = (d: number) => {
    const j = i + d
    if (j < 0 || j >= count) return
    edit((s) => {
      const list = listOf(s)
      ;[list[i], list[j]] = [list[j], list[i]]
    })
  }
  const field = f as Field
  const columnsOf: ListOf = (s) => (listOf(s)[i] as Field).columns!
  return (
    <div className="fieldset" style={isColumn ? { padding: 10, background: "var(--surface-2)" } : undefined}>
      <div className="grid-2">
        <label className="field">
          <span>Label</span>
          <input value={f.label} onChange={(e) => set((x) => { x.label = e.target.value })} />
        </label>
        <label className="field">
          <span>Key (used in the layout)</span>
          <input value={f.key} className="mono" onChange={(e) => set((x) => { x.key = e.target.value.trim() })} />
        </label>
        <label className="field">
          <span>Type</span>
          <select value={f.type} onChange={(e) => set((x) => {
            x.type = e.target.value as Field["type"] & Column["type"]
            if (x.type === "select" && !x.options) x.options = ["Option 1", "Option 2"]
            const fx = x as Field
            if (fx.type === "table" && !fx.columns) fx.columns = [{ key: "description", label: "Description", type: "text" }]
          })}>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        {f.type === "select" ? (
          <label className="field">
            <span>Options (comma separated)</span>
            <input value={(f.options || []).join(", ")} onChange={(e) => set((x) => { x.options = e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
          </label>
        ) : <div />}
        <div className="row full">
          <label className="check">
            <input type="checkbox" checked={Boolean(f.required)} onChange={(e) => set((x) => { x.required = e.target.checked })} />
            Required
          </label>
          {!isColumn && !["table", "image"].includes(f.type) ? (
            <label className="check">
              <input type="checkbox" checked={Boolean(field.showOnVerify)} onChange={(e) => set((x) => { (x as Field).showOnVerify = e.target.checked })} />
              Show on verify page
            </label>
          ) : null}
          <div className="spacer" />
          <button className="btn small ghost" type="button" aria-label="Move up" onClick={() => move(-1)}>↑</button>
          <button className="btn small ghost" type="button" aria-label="Move down" onClick={() => move(1)}>↓</button>
          <button className="btn small danger" type="button" onClick={() => edit((s) => { listOf(s).splice(i, 1) })}>Remove</button>
        </div>
      </div>
      {field.type === "table" && field.columns ? (
        <div className="stack" style={{ marginTop: 12 }}>
          <strong>Columns</strong>
          {field.columns.map((c, j) => (
            <FieldRow key={j} value={c} index={j} count={field.columns!.length} listOf={columnsOf} isColumn edit={edit} />
          ))}
          <button className="btn small" type="button" onClick={() => edit((s) => { const cols = columnsOf(s); cols.push({ key: `col${cols.length + 1}`, label: "Column", type: "text" }) })}>
            + Add column
          </button>
        </div>
      ) : null}
    </div>
  )
}
