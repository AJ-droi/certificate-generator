const path = require("path")
const { DataSource } = require("typeorm")
const entities = require("../entities")
const { config } = require("./index")

function withPort(url) {
  const u = new URL(url)
  if (!u.port) u.port = "5432"
  // Certificates are always checked (see `ssl` below); say so, instead of the
  // weaker-sounding "require" that providers put in their connection strings.
  if (["prefer", "require", "verify-ca"].includes(u.searchParams.get("sslmode"))) u.searchParams.set("sslmode", "verify-full")
  return u.toString()
}

function dataSourceOptions() {
  const db = config.database
  // With DATABASE_URL, everything comes from it. Hosted providers often leave the
  // port out; it's filled in here, or a stray PGPORT (e.g. for a local database)
  // would silently be used instead.
  const connection = db.url ? { url: withPort(db.url) } : { host: db.host, port: db.port, username: db.user, password: db.password, database: db.name }
  return {
    type: "postgres",
    ...connection,
    // Hosted databases (Neon etc.) need TLS: set PGSSL=true or put sslmode=require
    // in DATABASE_URL. The server's certificate is always checked.
    ssl: db.ssl ? { rejectUnauthorized: true } : undefined,
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
