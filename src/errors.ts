// Error envelope shared by REST and WS: { error: { code, message } }. 
import type { ServerErrorCode } from './model/protocol.js';

const STATUS: Record<ServerErrorCode, number> = {
  VALIDATION: 400,
  PIN_REQUIRED: 401,
  PIN_INVALID: 401,
  FORBIDDEN: 403,
  BOARD_NOT_FOUND: 404,
  NICKNAME_TAKEN: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class AppError extends Error {
  constructor(
    readonly code: ServerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get status(): number {
    return STATUS[this.code];
  }

  toBody() {
    return { error: { code: this.code, message: this.message } };
  }
}

export const notFound = () => new AppError('BOARD_NOT_FOUND', 'Board not found');
export const forbidden = (msg = 'Not allowed') => new AppError('FORBIDDEN', msg);
export const invalid = (msg: string) => new AppError('VALIDATION', msg);
