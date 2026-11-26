import type { RequestHandler, Response } from 'express';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Registry } from './registry.js';

const types = { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp' } as const;
const filenamePattern = /^[a-z\d][a-z\d_.-]{0,199}\.(svg|png|webp)$/i;
const cacheControl = 'public, max-age=3600';

function sendIcon(res: Response, path: string) {
  return new Promise<boolean>((resolve, reject) => res.sendFile(path, { cacheControl: false, acceptRanges: false }, (error?: NodeJS.ErrnoException) => {
    if (!error) resolve(true);
    else if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR') resolve(false);
    else reject(error);
  }));
}

export function registryIcon(location: Registry['icons']): RequestHandler<{ filename: string }> {
  return async (req, res) => {
    const { filename } = req.params;
    const match = filenamePattern.exec(filename);
    if (!match || filename.includes('..')) { res.status(404).end(); return; }
    const type = types[match[1].toLowerCase() as keyof typeof types];
    // An SVG opened as a document must not execute script or inherit the app's origin.
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'");
    if ('directory' in location) {
      res.type(type).set('Cache-Control', cacheControl);
      if (await sendIcon(res, join(location.directory, filename))) return;
      res.removeHeader('Cache-Control'); res.removeHeader('Content-Type'); res.status(404).end();
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    try {
      const upstream = await fetch(new URL(filename, location.baseUrl), {
        redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
      });
      const upstreamType = upstream.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (upstream.status !== 200 || !upstream.body || (upstreamType && upstreamType !== type && upstreamType !== 'application/octet-stream')) {
        await upstream.body?.cancel();
        res.status(upstream.status === 404 ? 404 : 502).end(); return;
      }
      res.type(type).set('Cache-Control', cacheControl);
      if (req.method === 'HEAD') { await upstream.body.cancel(); res.end(); }
      else await pipeline(upstream.body, res);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        res.removeHeader('Cache-Control'); res.removeHeader('Content-Type'); res.status(502).end();
      }
      else if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
    } finally { res.off('close', abort); }
  };
}
