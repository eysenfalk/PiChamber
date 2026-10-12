export class OrchestrationError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'OrchestrationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
