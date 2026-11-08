import { configuration } from './auth.ts';
import { createApi } from './routes.ts';
import { failure } from './responses.ts';

// A bad deployment configuration fails closed without printing environment data.
let handler: (request: Request) => Response | Promise<Response>;
try {
  handler = createApi(configuration());
} catch {
  handler = () => failure('INTERNAL_ERROR');
}
Deno.serve(handler);
