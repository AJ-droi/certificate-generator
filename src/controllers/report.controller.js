const fs = require("fs");
const handlebars = require("handlebars");
const path = require("path");

const generateQR = require("../services/qr.service");
const generatePDF = require("../services/pdf.service");
const {
  getReportByCertificateNo,
  getDefaultReport,
  getAllReports,
  upsertReport,
  normalizeCertificatePayload,
  normalizeCertificateNo,
} = require("../services/report.service");

function chunkItems(items, size) {
  const chunks = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

function buildBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function getCertificateNoFromRequest(req) {
  return req.params.certificateNo || req.query.certificateNo || "";
}

function toSafeFileSegment(value) {
  return String(value || "").replace(/[\\/]/g, "-");
}

function parseBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return (
      normalized === "true" ||
      normalized === "1" ||
      normalized === "on" ||
      normalized === "yes"
    );
  }

  return false;
}

function parseItems(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    return JSON.parse(value);
  }

  return [];
}

function getPayloadFromRequest(req) {
  const body = req.body || {};

  return normalizeCertificatePayload({
    certificateNo: body.certificateNo,
    examDate: body.examDate,
    reportDate: body.reportDate,
    colorCode: body.colorCode,
    employerName: body.employerName,
    premisesAddress: body.premisesAddress,
    relevantStandard: body.relevantStandard,
    defectSheetAttached: parseBoolean(body.defectSheetAttached),
    reasons: {
      installation: parseBoolean(
        (body.reasons && body.reasons.installation) ?? body.reasonInstallation,
      ),
      sixMonthly: parseBoolean(
        (body.reasons && body.reasons.sixMonthly) ?? body.reasonSixMonthly,
      ),
      twelveMonthly: parseBoolean(
        (body.reasons && body.reasons.twelveMonthly) ??
          body.reasonTwelveMonthly,
      ),
      writtenScheme: parseBoolean(
        (body.reasons && body.reasons.writtenScheme) ??
          body.reasonWrittenScheme,
      ),
      exceptional: parseBoolean(
        (body.reasons && body.reasons.exceptional) ?? body.reasonExceptional,
      ),
    },
    inspector: {
      name: (body.inspector && body.inspector.name) || body.inspectorName,
      qualification:
        (body.inspector && body.inspector.qualification) ||
        body.inspectorQualification,
      signature:
        (body.inspector && body.inspector.signature) || body.inspectorSignature,
    },
    checkedBy: {
      name: (body.checkedBy && body.checkedBy.name) || body.checkedByName,
      qualification:
        (body.checkedBy && body.checkedBy.qualification) ||
        body.checkedByQualification,
      signature:
        (body.checkedBy && body.checkedBy.signature) || body.checkedBySignature,
      date: (body.checkedBy && body.checkedBy.date) || body.checkedByDate,
    },
    footerLogos: {
      iso: (body.footerLogos && body.footerLogos.iso) || body.logoIso,
      iadc: (body.footerLogos && body.footerLogos.iadc) || body.logoIadc,
      dpr: (body.footerLogos && body.footerLogos.dpr) || body.logoDpr,
      labour: (body.footerLogos && body.footerLogos.labour) || body.logoLabour,
    },
    items: parseItems(body.items),
  });
}

async function buildCertificateHtml(reportData, qr) {
  const template = fs.readFileSync(
    path.resolve("./src/templates/certificate.hbs"),
    "utf8",
  );

  const compiled = handlebars.compile(template);
  const pages = chunkItems(reportData.items || [], 10);

  return compiled({
    ...reportData,
    pages,
    qr,
    logo: "./public/images/logo.png",
    signature: "./public/images/signature.png",
  });
}

exports.preview = async (req, res) => {
  try {
    const certificateNo = getCertificateNoFromRequest(req);
    const reportData = await getReportByCertificateNo(certificateNo);

    if (!reportData) {
      res.status(404).send("Report not found");
      return;
    }

    const previewUrl = `${buildBaseUrl(req)}/report/${encodeURIComponent(reportData.certificateNo)}`;
    const qr = await generateQR(previewUrl);
    const html = await buildCertificateHtml(reportData, qr);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (error) {
    res.status(500).send("Unable to preview report");
  }
};

exports.adminPage = async (req, res) => {
  res.sendFile(path.resolve("./src/templates/report-admin.html"));
};

exports.list = async (req, res) => {
  const reports = await getAllReports();
  res.json(reports);
};

exports.getByCertificateNo = async (req, res) => {
  const certificateNo = normalizeCertificateNo(req.params.certificateNo);
  const report = await getReportByCertificateNo(certificateNo);

  if (!report) {
    res.status(404).json({ message: "Report not found" });
    return;
  }

  res.json(report);
};

exports.save = async (req, res) => {
  try {
    const payload = getPayloadFromRequest(req);
    const saved = await upsertReport(payload);
    res.json(saved);
  } catch (error) {
    res.status(400).json({ message: "Invalid payload", error: error.message });
  }
};

exports.generate = async (req, res) => {
  try {
    const certificateNo = getCertificateNoFromRequest(req);
    const reportData = certificateNo
      ? await getReportByCertificateNo(certificateNo)
      : await getDefaultReport();

    if (!reportData) {
      res.status(404).send("Report not found");
      return;
    }

    const previewUrl = `${buildBaseUrl(req)}/report/${encodeURIComponent(reportData.certificateNo)}`;
    const qr = await generateQR(previewUrl);
    const html = await buildCertificateHtml(reportData, qr);

    await generatePDF(
      html,
      `./public/generated/pdf/${toSafeFileSegment(reportData.certificateNo)}.pdf`,
    );

    res.send("Certificate Generated");
  } catch (error) {
    res.status(500).send("Unable to generate certificate");
  }
};
