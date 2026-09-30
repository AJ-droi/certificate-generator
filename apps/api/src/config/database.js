const path = require("path")
const { DataSource } = require("typeorm")
const entities = require("../entities")
const { config } = require("./index")

function dataSourceOptions() {
  const db = config.database
  const connection = db.url
    ? { url: db.url }
    : { host: db.host, port: db.port, username: db.user, password: db.password, database: db.name }
  return {
    type: "postgres",
    ...connection,
    ssl: db.ssl ? { rejectUnauthorized: false } : false,
    logging: false,
    // The schema only changes through migrations (src/migrations, `npm run db:migrate`),
    // never automatically: an automatic sync can drop columns holding real data.
    synchronize: false,
    migrationsRun: false,
    migrationsTableName: "migrations",
    migrations: [path.join(__dirname, "..", "migrations", "*.js")],
    entities: Object.values(entities),
    extra: { max: db.poolSize },
  }
}

const AppDataSource = new DataSource(dataSourceOptions())

async function initializeDatabase() {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  return AppDataSource
}

// Migrations that exist in code but haven't been run on this database.
async function pendingMigrations() {
  await initializeDatabase()
  const runner = AppDataSource.createQueryRunner()
  try {
    const hasTable = await runner.hasTable("migrations")
    const applied = hasTable ? new Set((await runner.query("SELECT name FROM migrations")).map((r) => r.name)) : new Set()
    return AppDataSource.migrations.map((m) => m.name || m.constructor.name).filter((name) => !applied.has(name))
  } finally {
    await runner.release()
  }
}

const repo = (name) => AppDataSource.getRepository(name)

module.exports = { AppDataSource, initializeDatabase, pendingMigrations, repo, dataSourceOptions }
