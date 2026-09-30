export const fmtDate = (d: string | null | undefined, empty = ""): string =>
  d ? new Date(d).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : empty

export const fmtDay = (d: string | null | undefined): string =>
  d ? new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—"

// Activity-log details as "key: value · key: value", without noisy hashes.
export const detailText = (details: Record<string, unknown> | null | undefined, hide: string[] = []): string =>
  Object.entries(details || {})
    .filter(([k]) => !["userAgent", "contentHash", "pdfHash", ...hide].includes(k))
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ")

export function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return reject(new Error("Use a PNG, JPEG, WebP or GIF image"))
    if (file.size > 500 * 1024) return reject(new Error("Image must be under 500 KB"))
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error("Couldn't read that file"))
    r.readAsDataURL(file)
  })
}

export function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error("Couldn't read that file"))
    r.readAsText(file)
  })
}
