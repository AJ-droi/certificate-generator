const { repo } = require("../config/database")

async function audit(req, action, { organizationId, entityType, entityId, details } = {}, manager) {
  const repository = manager ? manager.getRepository("AuditEvent") : repo("AuditEvent")
  await repository.insert({
    organizationId: organizationId ?? (req && req.user ? req.user.organizationId : null),
    userId: req && req.user ? req.user.id : null,
    action,
    entityType: entityType || null,
    entityId: entityId ? String(entityId) : null,
    details: details || {},
    ip: req ? req.ip : null,
  })
}

module.exports = { audit }
