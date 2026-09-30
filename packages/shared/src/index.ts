// Shapes of what the API returns (apps/api/src/routes). The API is JavaScript,
// so these are written by hand: when a response changes, change it here too.

export type Role = "admin" | "approver" | "issuer"
export type DocumentStatus = "draft" | "pending_approval" | "issued" | "revoked" | "superseded"
export type PdfStatus = "pending" | "ready" | "failed" | null
export type VerificationStatus = "unverified" | "pending" | "verified" | "rejected" | "suspended"

export interface PublicConfig {
  appName: string
  allowSignup: boolean
}

export interface User {
  id: string
  email: string
  name: string
  role: Role
  qualification: string
  signature: string | null
  active: boolean
  mustChangePassword: boolean
  createdAt: string
}

export interface DnsRecord {
  name: string
  type: "TXT"
  value: string
}

export interface Verification {
  status: VerificationStatus
  legalName: string | null
  registrationNumber: string | null
  registrationCountry: string | null
  domain: string | null
  domainVerified: boolean
  dnsRecord: DnsRecord | null
  requestedAt: string | null
  verifiedAt: string | null
  note: string | null
}

export interface Organization {
  id: string
  name: string
  slug: string
  logo: string | null
  requireSeparateApprover: boolean
  keyId: string
  publicKey: string
  verification: Verification
}

export interface Me {
  user: User
  organization: Organization
}

// ---- Templates -------------------------------------------------------------------

export type FieldType = "text" | "textarea" | "number" | "date" | "select" | "checkbox" | "image" | "table"
export type ColumnType = "text" | "number" | "date" | "select" | "checkbox"

export interface Column {
  key: string
  label: string
  type: ColumnType
  required?: boolean
  options?: string[]
}

export interface Field {
  key: string
  label: string
  type: FieldType
  required?: boolean
  help?: string
  showOnVerify?: boolean
  options?: string[]
  columns?: Column[]
}

export type DocumentData = Record<string, unknown>

export interface TemplateSettings {
  numberPrefix?: string
  numberPadding?: number
  sampleData?: DocumentData
}

export interface PageSize {
  width: number
  height: number
}

export interface LayoutItem {
  id: string
  kind: "field" | "system" | "column"
  key?: string
  table?: string
  column?: string
  page: number
  x: number
  y: number
  w: number
  h: number
  fontSize?: number
  align?: "left" | "center" | "right"
  font?: "sans" | "serif" | "mono"
  bold?: boolean
  color?: string
  erase?: boolean
  eraseColor?: string
}

export interface TableLayout {
  rowHeight?: number
  rowsPerPage?: number
}

export interface Layout {
  items: LayoutItem[]
  tables?: Record<string, TableLayout>
  pages: PageSize[]
  originalSourceHash?: string
}

export interface TemplateVersion {
  id: string
  templateId: string
  version: number
  kind: "html" | "pdf"
  html: string
  layout: Layout | null
  sourceHash: string | null
  schema: Field[]
  settings: TemplateSettings
  contentHash: string
  createdAt: string
}

export interface Template {
  id: string
  name: string
  description: string
  currentVersionId: string | null
  archived: boolean
  createdAt: string
  updatedAt: string
  currentVersion?: Pick<TemplateVersion, "id" | "version" | "kind" | "schema" | "settings" | "createdAt"> | null
}

export interface TemplateHistoryItem {
  id: string
  version: number
  contentHash: string
  createdAt: string
}

export interface TemplateDetail {
  template: Template
  version: TemplateVersion
  history: TemplateHistoryItem[]
}

export interface SystemItem {
  key: string
  label: string
  type?: "text" | "image" | "qr" | "date"
}

export interface FormField {
  name: string
  label: string
  type: FieldType
  options?: string[]
  page: number
  x: number
  y: number
  w: number
  h: number
}

export interface UploadedSource {
  sourceHash: string
  pageCount: number
  pages: PageSize[]
  formFields: FormField[]
}

export interface SavedTemplate {
  template: Template
  version: TemplateVersion
  unchanged?: boolean
  unplaced?: string[]
}

export interface RenderResult {
  kind: "html" | "pdf"
  previewUrl: string
}

// ---- Documents -------------------------------------------------------------------------

export interface DocumentRecord {
  id: string
  templateId: string
  templateVersionId: string
  documentNo: string
  status: DocumentStatus
  data: DocumentData
  publicId: string | null
  createdBy: string
  reviewNote: string | null
  issuedBy: string | null
  issuedAt: string | null
  revokedAt: string | null
  revokeReason: string | null
  supersedesId: string | null
  supersededById: string | null
  contentHash: string | null
  pdfStatus: PdfStatus
  pdfPath: string | null
  pdfHash: string | null
  createdAt: string
  updatedAt: string
}

export type DocumentSummary = Pick<
  DocumentRecord,
  "id" | "documentNo" | "status" | "templateId" | "createdBy" | "issuedAt" | "createdAt" | "updatedAt" | "publicId" | "supersedesId" | "pdfStatus"
>

export interface DocumentList {
  documents: DocumentSummary[]
  total: number
  counts: Partial<Record<DocumentStatus, number>>
}

export interface AuditEvent {
  id: string
  userId: string | null
  action: string
  entityType: string | null
  entityId: string | null
  details: Record<string, unknown>
  ip: string | null
  createdAt: string
  userName?: string
}

export interface DocumentDetail {
  document: DocumentRecord
  template: { id: string; name: string; currentVersionId: string | null }
  version: { id: string; version: number; schema: Field[] }
  related: Array<Pick<DocumentRecord, "id" | "documentNo" | "status" | "supersedesId">>
  people: Record<string, string>
  history: AuditEvent[]
  verifyUrl: string | null
}

// ---- Platform staff ------------------------------------------------------------------

export interface Staff {
  id: string
  email: string
  name: string
  totpEnabled: boolean
  mustChangePassword: boolean
  lastLoginAt: string | null
}

export interface CompanyRow {
  id: string
  name: string
  slug: string
  legalName: string | null
  domain: string | null
  status: VerificationStatus
  domainVerified: boolean
  requestedAt: string | null
  verifiedAt: string | null
  createdAt: string
  users: number
  issued: number
  lastIssuedAt: string | null
  scans30: number
  invalid30: number
}

export interface PlatformOverview {
  stats: {
    companies: Record<VerificationStatus | "total", number>
    documents: { issued: number; issued30: number }
    scans: { scans30: number; invalid30: number }
  }
  pending: CompanyRow[]
  flagged: CompanyRow[]
}

export interface CompanyDetail {
  organization: Organization & { createdAt: string; verifiedBy: string | null }
  users: Array<Pick<User, "id" | "name" | "email" | "role" | "active" | "createdAt">>
  templates: number
  documents: Partial<Record<DocumentStatus, number>>
  scans30: Record<string, number>
  recentDocuments: Array<Pick<DocumentRecord, "id" | "documentNo" | "status" | "publicId" | "issuedAt" | "updatedAt">>
  warnings: { adminsOffDomain: string[]; similar: Array<{ id: string; name: string; slug: string; domain: string | null }> }
  events: Array<AuditEvent & { who: string }>
}

export interface PlatformActivityEvent {
  id: string
  action: string
  createdAt: string
  ip: string | null
  organizationId: string | null
  organizationName: string | null
  who: string
  details: Record<string, unknown>
}
