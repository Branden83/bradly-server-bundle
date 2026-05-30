/**
 * Typed error for service-layer validation and business rules.
 * Route handlers should map status to HTTP responses.
 */
export class ServiceError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string }} [options]
   */
  constructor(message, { status = 400, code } = {}) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
  }
}

export function assertFound(row, message = 'Not found') {
  if (!row) throw new ServiceError(message, { status: 404 });
  return row;
}
