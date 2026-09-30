// Running database migrations, including adopting a database that was created
// by the old automatic schema sync (before migrations existed).
const { AppDataSource, initializeDatabase } = require("../config/database")
const { logger } = require("./logger")

const isDestructive = (sql) => /^\s*(DROP|ALTER TABLE \S+ DROP|ALTER TABLE \S+ ALTER COLUMN .* TYPE)/i.test(sql)

// A database made by the old auto-sync has tables but no "migrations" table.
// If the only differences from the initial migration are additions (new tables,
// columns, indexes), apply them and record the initial migration as done.
// Anything that would drop or change existing data stops with an explanation.
async function adoptExistingDatabase(runner) {
  const hasMigrationsTable = await runner.hasTable("migrations")
  const hasAppTables = await runner.hasTable("organizations")
  if (hasMigrationsTable || !hasAppTables) return false

  const initial = AppDataSource.migrations[0]
  const diff = await AppDataSource.driver.createSchemaBuilder().log()
  const queries = diff.upQueries.map((x) => x.query)
  const destructive = queries.filter(isDestructive)
  if (destructive.length) {
    throw new Error(
      "This database was created before migrations and differs from the initial schema in ways that could lose data:\n" +
        destructive.map((q) => `  ${q}`).join("\n") +
        "\nBack it up and fix these by hand, or start from an empty database.",
    )
  }
  await runner.startTransaction()
  try {
    for (const sql of queries) await runner.query(sql)
    // Documents issued before PDFs were made in the background already have their PDF.
    await runner.query(`UPDATE "documents" SET "pdf_status" = 'ready' WHERE "pdf_path" IS NOT NULL AND "pdf_status" IS NULL`)
    await runner.query(`CREATE TABLE "migrations" ("id" SERIAL NOT NULL, "timestamp" bigint NOT NULL, "name" character varying NOT NULL, CONSTRAINT "PK_migrations_id" PRIMARY KEY ("id"))`)
    const ts = Number(String(initial.name).match(/(\d{13})$/)[1])
    await runner.query(`INSERT INTO "migrations" ("timestamp", "name") VALUES ($1, $2)`, [ts, initial.name])
    await runner.commitTransaction()
  } catch (err) {
    await runner.rollbackTransaction()
    throw err
  }
  logger.info({ changes: queries.length }, `Adopted existing database: recorded ${initial.name} as applied`)
  return true
}

async function runMigrations() {
  await initializeDatabase()
  const runner = AppDataSource.createQueryRunner()
  try {
    await adoptExistingDatabase(runner)
  } finally {
    await runner.release()
  }
  const done = await AppDataSource.runMigrations({ transaction: "each" })
  for (const m of done) logger.info(`Migration applied: ${m.name}`)
  return done.map((m) => m.name)
}

module.exports = { runMigrations }
