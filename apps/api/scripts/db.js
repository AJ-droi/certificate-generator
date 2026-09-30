// Database migrations.
//
//   npm run db:migrate                     apply pending migrations (run on every deploy)
//   npm run db:status                      show applied and pending migrations
//   npm run db:revert                      undo the most recent migration
//   npm run db:migration:generate -- Name  write a new migration from entity changes
//   npm run db:check                       fail if src/entities has changes without a migration (CI)
//
// Workflow for a schema change: edit src/entities, run db:migrate so your database
// is current, then db:migration:generate -- AddSomething, review the file, commit it.
require("reflect-metadata")
const fs = require("fs")
const path = require("path")
const { AppDataSource, initializeDatabase, pendingMigrations } = require("../src/config/database")
const { runMigrations } = require("../src/lib/migrations")

async function status() {
  await initializeDatabase()
  const pending = new Set(await pendingMigrations())
  for (const m of AppDataSource.migrations) console.log(`${pending.has(m.name) ? "pending " : "applied "} ${m.name}`)
  if (!pending.size) console.log("\nDatabase is up to date.")
}

async function generate(rawName) {
  const name = String(rawName || "").replace(/[^A-Za-z0-9]/g, "")
  if (!name) throw new Error("Give the migration a name: npm run db:migration:generate -- AddSomething")
  await initializeDatabase()
  if ((await pendingMigrations()).length) throw new Error("Run npm run db:migrate first, so the new migration only contains your changes")
  const diff = await AppDataSource.driver.createSchemaBuilder().log()
  if (!diff.upQueries.length) return console.log("No changes: the database already matches src/entities.")
  const ts = Date.now()
  const lines = (qs) => qs.map((x) => `    await q.query(${JSON.stringify(x.query.trim())})`).join("\n")
  const file = path.join(__dirname, "..", "src", "migrations", `${ts}-${name}.js`)
  fs.writeFileSync(
    file,
    `module.exports = class ${name}${ts} {
  name = "${name}${ts}"

  async up(q) {
${lines(diff.upQueries)}
  }

  async down(q) {
${lines([...diff.downQueries].reverse())}
  }
}
`,
  )
  console.log(`Wrote ${path.relative(process.cwd(), file)} — review it before committing.`)
}

// After migrating, the database should match the entities exactly.
async function check() {
  await runMigrations()
  const diff = await AppDataSource.driver.createSchemaBuilder().log()
  if (diff.upQueries.length) {
    console.error("src/entities has changes that no migration covers. Run npm run db:migration:generate -- Name. Missing:")
    for (const q of diff.upQueries) console.error(`  ${q.query}`)
    process.exitCode = 1
  } else {
    console.log("Migrations match src/entities.")
  }
}

async function main() {
  const [command, arg] = process.argv.slice(2)
  switch (command) {
    case "migrate": {
      const done = await runMigrations()
      console.log(done.length ? `Applied: ${done.join(", ")}` : "Nothing to apply — database is up to date.")
      return
    }
    case "status":
      return status()
    case "revert":
      await initializeDatabase()
      await AppDataSource.undoLastMigration({ transaction: "each" })
      return console.log("Reverted the most recent migration.")
    case "generate":
      return generate(arg)
    case "check":
      return check()
    default:
      console.log("Usage: node scripts/db.js migrate|status|revert|generate <Name>")
      process.exitCode = 1
  }
}

main()
  .catch((err) => {
    console.error(err.message || err)
    process.exitCode = 1
  })
  .finally(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })
