import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * Serves the built web interface on the API's origin, so the session cookie and the event stream need no proxy or CORS.
 * Files are served as they are; any other GET outside /api gets index.html and the client-side router takes over.
 */
export async function serveWebUi(app: NestFastifyApplication, dir: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: resolve(dir),
    wildcard: false,
    cacheControl: false,
    // Assets under /_nuxt have hashed names; the HTML is revalidated so a new release is picked up.
    setHeaders: (res, path) => {
      res.setHeader('Cache-Control', path.includes('/_nuxt/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  app
    .getHttpAdapter()
    .getInstance()
    .get('/*', (request, reply) => {
      const path = request.url.split('?', 1)[0] ?? '';
      if (path === '/api' || path.startsWith('/api/')) return reply.callNotFound();
      return reply.sendFile('index.html');
    });
}
