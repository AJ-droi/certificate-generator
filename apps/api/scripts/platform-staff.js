// Platform staff accounts for the /platform dashboard. Only possible from the
// server, so nobody can create staff through the web.
//
//   npm run staff -- create --email you@yourcompany.com --name "Your Name"
//   npm run staff -- reset --email you@yourcompany.com     (new password + authenticator)
//   npm run staff -- disable --email ...  |  enable --email ...
//   npm run staff -- list
require("reflect-metadata")
const { AppDataSource, initializeDatabase, repo } = require("../src/config/database")
const platform = require("../src/services/platform.service")

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const when = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "never")

function printPassword(staff, password) {
  console.log(`
Temporary password for ${staff.email}:

    ${password}

Give it to them privately. At /platform they sign in with it, choose a new
password and set up an authenticator app (Google Authenticator, 1Password, …).`)
}

async function main() {
  const command = process.argv[2]
  await initializeDatabase()
  switch (command) {
    case "create": {
      const { staff, temporaryPassword } = await platform.createStaff({ email: arg("email"), name: arg("name") })
      return printPassword(staff, temporaryPassword)
    }
    case "reset": {
      const { staff, temporaryPassword } = await platform.resetStaff(arg("email"))
      return printPassword(staff, temporaryPassword)
    }
    case "disable":
    case "enable": {
      const staff = await platform.setStaffActive(arg("email"), command === "enable")
      return console.log(`${staff.email} ${staff.active ? "can sign in again" : "is disabled and signed out"}.`)
    }
    case "list": {
      const all = await repo("PlatformAdmin").find({ order: { createdAt: "ASC" } })
      if (!all.length) return console.log('No staff yet. npm run staff -- create --email ... --name "..."')
      for (const s of all) {
        console.log([s.email.padEnd(36), s.name.padEnd(24), s.active ? "active  " : "disabled", s.totpEnabled ? "2FA ✓" : "2FA not set up", `last sign-in ${when(s.lastLoginAt)}`].join("  "))
      }
      return
    }
    default:
      console.log("Usage: npm run staff -- create|reset|disable|enable|list [--email ...] [--name ...]")
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
