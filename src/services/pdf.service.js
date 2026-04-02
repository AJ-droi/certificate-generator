const puppeteer = require("puppeteer")
const fs = require("fs")
const path = require("path")

async function generatePDF(html, outputPath){

const browser = await puppeteer.launch()

const page = await browser.newPage()

await page.setContent(html)

const dir = path.dirname(outputPath)
fs.mkdirSync(dir, { recursive: true })

await page.pdf({
path: outputPath,
format:"A4",
margin:{ top:"0", right:"0", bottom:"0", left:"0" },
preferCSSPageSize:true,
printBackground:true
})

await browser.close()

}

module.exports = generatePDF
