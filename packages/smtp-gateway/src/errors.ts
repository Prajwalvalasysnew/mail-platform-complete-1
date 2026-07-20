// smtp-server surfaces custom SMTP status codes via err.responseCode.
export class AuthenticationError extends Error {
  constructor(public responseCode: number, message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}
