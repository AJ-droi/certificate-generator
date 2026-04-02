const QRCode = require("qrcode")

async function generateQR(url){

return await QRCode.toDataURL(url)

}

module.exports = generateQR