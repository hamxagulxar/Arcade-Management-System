'use strict';

class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const badRequest = (msg, details) => new ApiError(400, msg, details);
const unauthorized = (msg = 'Authentication required') => new ApiError(401, msg);
const forbidden = (msg = 'You do not have permission to do that') => new ApiError(403, msg);
const notFound = (msg = 'Not found') => new ApiError(404, msg);
const conflict = (msg) => new ApiError(409, msg);

module.exports = { ApiError, badRequest, unauthorized, forbidden, notFound, conflict };
