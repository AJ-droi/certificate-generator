const express = require("express")
const router = express.Router()

const reportController = require("../controllers/report.controller")

router.get("/admin", reportController.adminPage)
router.get("/api/certificates", reportController.list)
router.get("/api/certificates/:certificateNo", reportController.getByCertificateNo)
router.post("/api/certificates", reportController.save)

router.get("/generate", reportController.generate)
router.get("/:certificateNo/generate", reportController.generate)
router.get("/:certificateNo", reportController.preview)

module.exports = router
