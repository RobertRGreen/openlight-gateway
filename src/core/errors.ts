export interface ValidationDetail { path: string; code: string; message: string; deviceId?: string; capability?: string }
export interface ErrorDetail { code: string; message: string; requestId: string; details: ValidationDetail[] }
export class GatewayError extends Error {
  readonly detail: ErrorDetail;
  constructor(readonly statusCode: number, code: string, message: string, details: ValidationDetail[] = [], requestId = 'core') {
    super(message); this.name = 'GatewayError'; this.detail = { code, message, requestId, details };
  }
  get code(): string { return this.detail.code; }
  toJSON(): { error: ErrorDetail } { return { error: this.detail }; }
}
