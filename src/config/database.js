const { DataSource } = require("typeorm")
const CertificateEntity = require("../entities/certificate.entity")

const useSsl = String(process.env.PGSSL || "").toLowerCase() === "true"

const baseOptions = process.env.DATABASE_URL
? {
type: "postgres",
url: process.env.DATABASE_URL
}
: {
type: "postgres",
host: process.env.PGHOST || "127.0.0.1",
port: Number(process.env.PGPORT || 5432),
username: process.env.PGUSER || "postgres",
password: process.env.PGPASSWORD || "",
database: process.env.PGDATABASE || "certificate_generator"
}

const AppDataSource = new DataSource({
...baseOptions,
ssl: useSsl ? { rejectUnauthorized: false } : false,
logging: false,
synchronize: true,
entities: [CertificateEntity]
})

async function initializeDatabase(){
if(AppDataSource.isInitialized){
return AppDataSource
}

return AppDataSource.initialize()
}

module.exports = {
AppDataSource,
initializeDatabase
}
