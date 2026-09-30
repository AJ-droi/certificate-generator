// File storage tools (uses the storage configured in .env).
//
//   npm run storage -- copy [--from ./storage]   copy a local storage folder into the bucket
//                                                (skips files already there; checks each copy)
//   npm run storage -- check                     every issued PDF and uploaded form the database
//                                                refers to is in storage and unaltered
//   npm run storage -- orphans [--delete]        files no document or template refers to
//                                                (e.g. left by tests); --delete removes them
require("reflect-metadata")
const crypto = require("crypto")
const path = require("path")
const { AppDataSource, initializeDatabase } = require("../src/config/database")
const { config } = require("../src/config")
const storage = require("../src/services/storage.service")

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex")
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const describe = () => (config.storage.driver === "s3" ? `bucket "${config.storage.s3.bucket}"` : `folder ${path.resolve(config.storage.dir)}`)

// Files the database refers to: issued PDFs (with their fingerprint) and uploaded forms.
async function referencedFiles() {
  await initializeDatabase()
  const pdfs = await AppDataSource.query("SELECT pdf_path AS key, pdf_hash AS hash, document_no AS label FROM documents WHERE pdf_path IS NOT NULL")
  const forms = await AppDataSource.query(
    "SELECT organization_id AS org, source_hash AS hash, layout->>'originalSourceHash' AS original FROM template_versions WHERE source_hash IS NOT NULL",
  )
  const out = new Map()
  for (const p of pdfs) out.set(p.key.split(path.sep).join("/"), { hash: p.hash, what: `PDF of ${p.label}` })
  for (const f of forms) {
    for (const hash of [f.hash, f.original].filter(Boolean)) out.set(`templates/${f.org}/${hash}.pdf`, { hash, what: "template form" })
  }
  return out
}

async function copy() {
  if (config.storage.driver !== "s3") throw new Error("Set STORAGE_DRIVER=s3 (and the bucket settings) first: copy puts files into the bucket.")
  if (arg("from")) process.env.STORAGE_DIR = path.resolve(arg("from"))
  const folder = path.resolve(config.storage.dir)
  const from = storage.localStorage()
  const keys = await from.list()
  console.log(`Copying ${keys.length} file(s) from ${folder} to ${describe()}`)
  let copied = 0
  let skipped = 0
  for (const key of keys) {
    const bytes = await from.get(key)
    if (await storage.hasKey(key)) {
      const there = await storage.readFile(key)
      if (sha256(there) !== sha256(bytes)) throw new Error(`${key} is already in the bucket with different content — stopping.`)
      skipped++
      continue
    }
    await storage.putKey(key, bytes)
    const back = await storage.readFile(key)
    if (sha256(back) !== sha256(bytes)) throw new Error(`${key} didn't copy correctly (content differs) — stopping.`)
    copied++
    console.log(`  copied  ${key}`)
  }
  console.log(`Done: ${copied} copied, ${skipped} already there.`)
}

async function check() {
  const files = await referencedFiles()
  console.log(`Checking ${files.size} file(s) the database refers to, in ${describe()}`)
  let problems = 0
  for (const [key, { hash, what }] of files) {
    let bytes
    try {
      bytes = await storage.readFile(key)
    } catch (err) {
      problems++
      console.log(`  MISSING   ${key} (${what}) ${err.code === "ENOENT" ? "" : err.message}`)
      continue
    }
    if (hash && sha256(bytes) !== hash) {
      problems++
      console.log(`  ALTERED   ${key} (${what})`)
    }
  }
  console.log(problems ? `\n${problems} problem(s).` : "All present and unaltered.")
  if (problems) process.exitCode = 1
}

async function orphans() {
  const files = await referencedFiles()
  const keys = await storage.listKeys()
  const unused = keys.filter((k) => !files.has(k))
  console.log(`${keys.length} file(s) in ${describe()}, ${unused.length} not used by any document or template:`)
  for (const k of unused) console.log(`  ${k}`)
  if (!process.argv.includes("--delete") || !unused.length) return
  for (const k of unused) await storage.removeKey(k)
  console.log(`Deleted ${unused.length} file(s).`)
}

async function main() {
  const command = process.argv[2]
  if (command === "copy") return copy()
  if (command === "check") return check()
  if (command === "orphans") return orphans()
  console.log("Usage: npm run storage -- copy [--from ./storage] | check | orphans [--delete]")
  process.exitCode = 1
}

main()
  .catch((err) => {
    console.error(err.message || err)
    process.exitCode = 1
  })
  .finally(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })
