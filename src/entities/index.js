const { EntitySchema } = require("typeorm")

const timestamps = {
  createdAt: { type: "timestamptz", name: "created_at", createDate: true },
  updatedAt: { type: "timestamptz", name: "updated_at", updateDate: true },
}

const Organization = new EntitySchema({
  name: "Organization",
  tableName: "organizations",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    name: { type: "varchar", length: 200 },
    slug: { type: "varchar", length: 80, unique: true },
    logo: { type: "text", nullable: true },
    // When true, the person who prepared a document cannot also approve it.
    requireSeparateApprover: { type: "boolean", name: "require_separate_approver", default: true },
    keyId: { type: "varchar", length: 64, name: "key_id" },
    publicKey: { type: "text", name: "public_key" },
    // Ed25519 private key, encrypted with APP_SECRET. Never stored in plain text.
    privateKeyEnc: { type: "text", name: "private_key_enc", select: false },
    ...timestamps,
  },
})

const User = new EntitySchema({
  name: "User",
  tableName: "users",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    organizationId: { type: "uuid", name: "organization_id" },
    email: { type: "varchar", length: 254, unique: true },
    name: { type: "varchar", length: 200 },
    qualification: { type: "varchar", length: 500, default: "" },
    signature: { type: "text", nullable: true },
    role: { type: "varchar", length: 20 }, // admin | approver | issuer
    passwordHash: { type: "varchar", length: 100, name: "password_hash", select: false },
    active: { type: "boolean", default: true },
    mustChangePassword: { type: "boolean", name: "must_change_password", default: false },
    tokenVersion: { type: "int", name: "token_version", default: 0 },
    ...timestamps,
  },
  indices: [{ columns: ["organizationId"] }],
})

const Template = new EntitySchema({
  name: "Template",
  tableName: "templates",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    organizationId: { type: "uuid", name: "organization_id" },
    name: { type: "varchar", length: 200 },
    description: { type: "text", default: "" },
    currentVersionId: { type: "uuid", name: "current_version_id", nullable: true },
    nextSequence: { type: "int", name: "next_sequence", default: 1 },
    archived: { type: "boolean", default: false },
    ...timestamps,
  },
  indices: [{ columns: ["organizationId"] }],
})

const TemplateVersion = new EntitySchema({
  name: "TemplateVersion",
  tableName: "template_versions",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    templateId: { type: "uuid", name: "template_id" },
    organizationId: { type: "uuid", name: "organization_id" },
    version: { type: "int" },
    html: { type: "text" },
    schema: { type: "jsonb" },
    settings: { type: "jsonb", default: () => "'{}'" },
    contentHash: { type: "varchar", length: 64, name: "content_hash" },
    createdBy: { type: "uuid", name: "created_by", nullable: true },
    createdAt: { type: "timestamptz", name: "created_at", createDate: true },
  },
  uniques: [{ columns: ["templateId", "version"] }],
})

const Document = new EntitySchema({
  name: "Document",
  tableName: "documents",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    organizationId: { type: "uuid", name: "organization_id" },
    templateId: { type: "uuid", name: "template_id" },
    templateVersionId: { type: "uuid", name: "template_version_id" },
    documentNo: { type: "varchar", length: 120, name: "document_no" },
    // draft -> pending_approval -> issued -> revoked | superseded
    status: { type: "varchar", length: 20, default: "draft" },
    data: { type: "jsonb" },
    // Random, unguessable ID used in the QR code. Set when issued.
    publicId: { type: "varchar", length: 40, name: "public_id", nullable: true, unique: true },
    createdBy: { type: "uuid", name: "created_by" },
    submittedAt: { type: "timestamptz", name: "submitted_at", nullable: true },
    reviewNote: { type: "text", name: "review_note", nullable: true },
    issuedBy: { type: "uuid", name: "issued_by", nullable: true },
    issuedAt: { type: "timestamptz", name: "issued_at", nullable: true },
    revokedBy: { type: "uuid", name: "revoked_by", nullable: true },
    revokedAt: { type: "timestamptz", name: "revoked_at", nullable: true },
    revokeReason: { type: "text", name: "revoke_reason", nullable: true },
    supersedesId: { type: "uuid", name: "supersedes_id", nullable: true },
    supersededById: { type: "uuid", name: "superseded_by_id", nullable: true },
    // Exactly what was signed at issue time, plus the signature over it.
    signedPayload: { type: "jsonb", name: "signed_payload", nullable: true },
    contentHash: { type: "varchar", length: 64, name: "content_hash", nullable: true },
    signature: { type: "text", nullable: true },
    keyId: { type: "varchar", length: 64, name: "key_id", nullable: true },
    pdfPath: { type: "varchar", length: 500, name: "pdf_path", nullable: true },
    pdfHash: { type: "varchar", length: 64, name: "pdf_hash", nullable: true },
    ...timestamps,
  },
  uniques: [{ columns: ["organizationId", "documentNo"] }],
  indices: [{ columns: ["organizationId", "status"] }],
})

const AuditEvent = new EntitySchema({
  name: "AuditEvent",
  tableName: "audit_events",
  columns: {
    id: { type: "bigint", primary: true, generated: "increment" },
    organizationId: { type: "uuid", name: "organization_id", nullable: true },
    userId: { type: "uuid", name: "user_id", nullable: true },
    action: { type: "varchar", length: 60 },
    entityType: { type: "varchar", length: 30, name: "entity_type", nullable: true },
    entityId: { type: "varchar", length: 64, name: "entity_id", nullable: true },
    details: { type: "jsonb", default: () => "'{}'" },
    ip: { type: "varchar", length: 64, nullable: true },
    createdAt: { type: "timestamptz", name: "created_at", createDate: true },
  },
  indices: [{ columns: ["organizationId", "createdAt"] }, { columns: ["entityId"] }],
})

module.exports = { Organization, User, Template, TemplateVersion, Document, AuditEvent }
