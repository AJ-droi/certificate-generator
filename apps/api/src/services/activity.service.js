// A company's activity log, with people's names.
const { repo } = require("../config/database")
const { namesById, actorName } = require("./user.service")

async function companyActivity(orgId, { limit } = {}) {
  const take = Math.min(500, Math.max(1, Number(limit) || 100))
  const events = await repo("AuditEvent").find({ where: { organizationId: orgId }, order: { createdAt: "DESC" }, take })
  const names = await namesById(events.map((e) => e.userId))
  return events.map((e) => ({ ...e, userName: actorName(e, names) }))
}

module.exports = { companyActivity }
