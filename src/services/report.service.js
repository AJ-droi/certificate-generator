const fs = require("fs")
const path = require("path")
const { AppDataSource, initializeDatabase } = require("../config/database")

const legacyReportPath = path.resolve("./src/data/report.json")

function normalizeCertificateNo(value = ""){
return String(value).trim().toUpperCase()
}

function normalizeBoolean(value){
if(typeof value === "boolean"){
return value
}

if(typeof value === "string"){
const normalized = value.trim().toLowerCase()
return normalized === "true" || normalized === "1" || normalized === "on" || normalized === "yes"
}

if(typeof value === "number"){
return value === 1
}

return false
}

function normalizeItems(items){
if(!Array.isArray(items)){
return []
}

return items.map((item, index) => ({
sn: Number(item.sn) || index + 1,
identificationNumber: item.identificationNumber || "",
description: item.description || "",
wllOrSwl: item.wllOrSwl || "",
lastThoroughExamDate: item.lastThoroughExamDate || "",
manufactureDate: item.manufactureDate || "",
nextThoroughExamDate: item.nextThoroughExamDate || "",
examinationReason: item.examinationReason || "",
testDetails: item.testDetails || "",
status: item.status || "",
safeToUse: item.safeToUse || ""
}))
}

function normalizeCertificatePayload(payload = {}){
const certificateNo = normalizeCertificateNo(payload.certificateNo)

return {
certificateNo,
examDate: payload.examDate || "",
reportDate: payload.reportDate || "",
colorCode: payload.colorCode || "",
employerName: payload.employerName || "",
premisesAddress: payload.premisesAddress || "",
relevantStandard: payload.relevantStandard || "",
defectSheetAttached: normalizeBoolean(payload.defectSheetAttached),
reasons: {
installation: normalizeBoolean(payload.reasons && payload.reasons.installation),
sixMonthly: normalizeBoolean(payload.reasons && payload.reasons.sixMonthly),
twelveMonthly: normalizeBoolean(payload.reasons && payload.reasons.twelveMonthly),
writtenScheme: normalizeBoolean(payload.reasons && payload.reasons.writtenScheme),
exceptional: normalizeBoolean(payload.reasons && payload.reasons.exceptional)
},
inspector: {
name: (payload.inspector && payload.inspector.name) || "",
qualification: (payload.inspector && payload.inspector.qualification) || "",
signature: (payload.inspector && payload.inspector.signature) || "./public/images/signature.png"
},
checkedBy: {
name: (payload.checkedBy && payload.checkedBy.name) || "",
qualification: (payload.checkedBy && payload.checkedBy.qualification) || "",
signature: (payload.checkedBy && payload.checkedBy.signature) || "./public/images/signature.png",
date: (payload.checkedBy && payload.checkedBy.date) || ""
},
footerLogos: {
iso: (payload.footerLogos && payload.footerLogos.iso) || "",
iadc: (payload.footerLogos && payload.footerLogos.iadc) || "",
dpr: (payload.footerLogos && payload.footerLogos.dpr) || "",
labour: (payload.footerLogos && payload.footerLogos.labour) || ""
},
items: normalizeItems(payload.items)
}
}

function getLegacyReports(){
if(!fs.existsSync(legacyReportPath)){
return []
}

const raw = JSON.parse(fs.readFileSync(legacyReportPath, "utf8"))

if(Array.isArray(raw)){
return raw
}

if(Array.isArray(raw.reports)){
return raw.reports
}

if(raw && raw.certificateNo){
return [raw]
}

return []
}

async function seedFromLegacyIfEmpty(){
await initializeDatabase()
const repository = AppDataSource.getRepository("Certificate")
const count = await repository.count()

if(count > 0){
return
}

const legacyReports = getLegacyReports()

for(const report of legacyReports){
const normalized = normalizeCertificatePayload(report)
if(!normalized.certificateNo){
continue
}

await repository.save({
certificateNo: normalized.certificateNo,
payload: normalized
})
}
}

async function initialize(){
await initializeDatabase()
await seedFromLegacyIfEmpty()
}

async function getAllReports(){
await initializeDatabase()
const repository = AppDataSource.getRepository("Certificate")
const rows = await repository.find({
order: {
certificateNo: "ASC"
}
})

return rows.map((row) => row.payload)
}

async function getReportByCertificateNo(certificateNo){
const normalized = normalizeCertificateNo(certificateNo)

if(!normalized){
return null
}

await initializeDatabase()
const repository = AppDataSource.getRepository("Certificate")
const row = await repository.findOne({
where: {
certificateNo: normalized
}
})

return row ? row.payload : null
}

async function getDefaultReport(){
await initializeDatabase()
const repository = AppDataSource.getRepository("Certificate")
const row = await repository.findOne({
order: {
certificateNo: "ASC"
}
})

return row ? row.payload : null
}

async function upsertReport(payload){
const normalized = normalizeCertificatePayload(payload)

if(!normalized.certificateNo){
throw new Error("certificateNo is required")
}

await initializeDatabase()
const repository = AppDataSource.getRepository("Certificate")
await repository.save({
certificateNo: normalized.certificateNo,
payload: normalized
})

return normalized
}

module.exports = {
initialize,
getAllReports,
getReportByCertificateNo,
getDefaultReport,
upsertReport,
normalizeCertificatePayload,
normalizeCertificateNo
}
