require("reflect-metadata")
const express = require("express")

const reportRoutes = require("./src/routes/report.routes")
const reportService = require("./src/services/report.service")

const app = express()

app.use(express.json({ limit: "2mb" }))
app.use(express.urlencoded({ extended: true, limit: "2mb" }))
app.use(express.static("public"))

app.use("/report", reportRoutes)
// app.get('/admin', authenticateUser, (req, res) => {
//   res.sendFile(__dirname + '/public/admin.html');
// });

async function start(){
try{
await reportService.initialize()

app.listen(3100, ()=>{
console.log("Server running on port 3100")
})
}catch(error){
console.error("Failed to initialize application", error)
process.exit(1)
}
}

start()
