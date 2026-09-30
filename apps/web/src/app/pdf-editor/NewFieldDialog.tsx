// "What goes in this box?" — shown after drawing a box on the page.
import { useState } from "react"
import type { Field, SystemItem } from "@doctrust/shared"
import { Modal } from "../../shared/ui/Dialogs"
import { COL_TYPES, TYPE_LABELS, type BoxChoice } from "./model"

export type NewFieldChoice = BoxChoice

export function NewFieldDialog({ unplacedFields, unplacedSystem, tables, onClose }: {
  unplacedFields: Field[]
  unplacedSystem: SystemItem[]
  tables: Field[]
  onClose: (choice: NewFieldChoice | null) => void
}) {
  const [c, setC] = useState<NewFieldChoice>({
    what: "new",
    label: "",
    type: "text",
    options: "",
    required: true,
    showOnVerify: false,
    table: tables.length ? tables[0].key : "__new",
    tableName: "",
    colType: "text",
    colLabel: "",
  })
  const set = <K extends keyof NewFieldChoice>(k: K, v: NewFieldChoice[K]) => setC((prev) => ({ ...prev, [k]: v }))
  const isNew = c.what === "new"
  const isColumn = c.what === "column"

  return (
    <Modal onCancel={() => onClose(null)}>
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); onClose(c) }}>
        <h2>What goes in this box?</h2>
        <div className="stack">
          <label className="field">
            <span>Fill this box with</span>
            <select value={c.what} onChange={(e) => set("what", e.target.value)}>
              <option value="new">A new field</option>
              {unplacedFields.length ? (
                <optgroup label="Existing fields">
                  {unplacedFields.map((f) => <option key={f.key} value={`field:${f.key}`}>{f.label}</option>)}
                </optgroup>
              ) : null}
              <optgroup label="Filled in automatically">
                {unplacedSystem.map((si) => <option key={si.key} value={`system:${si.key}`}>{si.label}</option>)}
              </optgroup>
              <option value="column">A column of a table (repeating rows)</option>
            </select>
          </label>
          {isNew ? (
            <>
              <label className="field">
                <span>Name of the field</span>
                <input value={c.label} onChange={(e) => set("label", e.target.value)} placeholder="e.g. Client name" autoComplete="off" autoFocus />
              </label>
              <label className="field">
                <span>Type</span>
                <select value={c.type} onChange={(e) => set("type", e.target.value)}>
                  {Object.entries(TYPE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </label>
              {c.type === "select" ? (
                <label className="field">
                  <span>Choices (comma separated)</span>
                  <input value={c.options} onChange={(e) => set("options", e.target.value)} placeholder="e.g. PASS, FAIL" />
                </label>
              ) : null}
              <div className="row">
                <label className="check">
                  <input type="checkbox" checked={c.required} onChange={(e) => set("required", e.target.checked)} />
                  Required
                </label>
                <label className="check">
                  <input type="checkbox" checked={c.showOnVerify} onChange={(e) => set("showOnVerify", e.target.checked)} />
                  Show on verify page
                </label>
              </div>
            </>
          ) : null}
          {isColumn ? (
            <div className="stack">
              <label className="field">
                <span>Table</span>
                <select value={c.table} onChange={(e) => set("table", e.target.value)}>
                  {tables.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                  <option value="__new">New table…</option>
                </select>
              </label>
              {c.table === "__new" ? (
                <label className="field">
                  <span>Table name</span>
                  <input value={c.tableName} onChange={(e) => set("tableName", e.target.value)} placeholder="e.g. Items tested" />
                </label>
              ) : null}
              <label className="field">
                <span>Column type</span>
                <select value={c.colType} onChange={(e) => set("colType", e.target.value)}>
                  <option value="#">Row number (S/N)</option>
                  {COL_TYPES.map((k) => <option key={k} value={k}>{k === "select" ? "Dropdown (add choices later)" : TYPE_LABELS[k]}</option>)}
                </select>
              </label>
              {c.colType !== "#" ? (
                <label className="field">
                  <span>Column name</span>
                  <input value={c.colLabel} onChange={(e) => set("colLabel", e.target.value)} placeholder="e.g. Description" />
                </label>
              ) : null}
              <p className="muted" style={{ fontSize: ".85rem", margin: 0 }}>Draw the box on the first row. Rows below follow automatically.</p>
            </div>
          ) : null}
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn" type="button" onClick={() => onClose(null)}>Cancel</button>
          <button className="btn primary" type="submit">Add</button>
        </div>
      </form>
    </Modal>
  )
}
