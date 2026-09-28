class HttpError extends Error {
  constructor(status, message, details) {
    super(message)
    this.status = status
    this.details = details
  }
}

const badRequest = (msg, details) => new HttpError(400, msg, details)
const forbidden = (msg = "You don't have permission to do that") => new HttpError(403, msg)
const notFound = (msg = "Not found") => new HttpError(404, msg)
const conflict = (msg) => new HttpError(409, msg)

// Express 5 forwards rejected promises to the error handler, so handlers can just throw.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err)
  if (err.type === "entity.too.large") {
    return res.status(413).json({ message: "Upload is too large" })
  }
  if (err instanceof SyntaxError && err.status === 400) {
    return res.status(400).json({ message: "Request body is not valid JSON" })
  }
  if (err.code === "23505") {
    return res.status(409).json({ message: "That value is already in use" })
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ message: err.message, details: err.details })
  }
  console.error(err)
  res.status(500).json({ message: "Something went wrong" })
}

module.exports = { HttpError, badRequest, forbidden, notFound, conflict, errorHandler }
