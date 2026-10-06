import type { ContentfulStatusCode } from 'hono/utils/http-status';
export class ApiError extends Error {
  constructor(public status: ContentfulStatusCode, public code: string, message: string) {
    super(message);
  }
}
