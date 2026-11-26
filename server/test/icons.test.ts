import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/app.js';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><rect width="12" height="12"/></svg>';

async function origin(t: TestContext, server: Server) {
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'nia-icons-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function hub(t: TestContext, registryUrl: string, stateDir: string) {
  return origin(t, createApp({ registryUrl, stateDir, baseUrl: 'http://127.0.0.1:3840' }).listen(0, '127.0.0.1'));
}

test('local registry preserves curated order and serves catalog icons with an isolated SVG policy', async t => {
  const dir = await fixture(t);
  const source = join(dir, 'catalog.json');
  const example = JSON.parse(await readFile('examples/catalog.json', 'utf8'));
  const [one, two] = example.connectors ?? example;
  const icon = 'icons/brand.svg';
  const examples = ['总结这周的项目进展。', '找出还没有负责人的任务。'];
  await Promise.all([
    writeFile(source, JSON.stringify({ connectors: [{ ...one, name: { zh: 'Z', en: 'Z' }, icon, examples, order: 1 }, { ...two, name: { zh: 'A', en: 'A' }, order: 2 }] })),
    mkdir(join(dir, 'icons')).then(() => writeFile(join(dir, icon), svg)),
  ]);
  const base = await hub(t, source, dir);
  const catalog = await (await fetch(`${base}/api/catalog`)).json();
  assert.deepEqual(catalog.connectors.map((item: { id: string }) => item.id), [one.id, two.id]);
  for (const item of [catalog.connectors[0], await (await fetch(`${base}/api/connectors/${one.id}`)).json()]) {
    assert.deepEqual([item.icon, item.examples, item.order], [icon, examples, 1]);
  }
  const image = await fetch(`${base}/${icon}`);
  assert.equal(image.status, 200);
  assert.match(image.headers.get('content-type') ?? '', /^image\/svg\+xml/);
  assert.match(image.headers.get('cache-control') ?? '', /max-age=/);
  assert.match(image.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(await image.text(), svg);
  assert.equal((await fetch(`${base}/${icon}`, { cache: 'force-cache', headers: { 'If-None-Match': image.headers.get('etag')! } })).status, 304);
  for (const invalid of ['missing.svg', 'catalog.json', '..%2fbrand.svg', 'dir%5cbrand.svg']) {
    assert.equal((await fetch(`${base}/icons/${invalid}`)).status, 404, invalid);
  }
});

test('HTTP registry proxies only allowed icon files relative to the catalog and does not follow redirects', async t => {
  const dir = await fixture(t);
  const seen: string[] = [];
  const remote = createServer((req, res) => {
    seen.push(req.url!);
    if (req.url === '/registry/icons/brand.svg') res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' }).end(svg);
    else if (req.url === '/registry/icons/fake.png') res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>Not an image</html>');
    else if (req.url === '/registry/icons/moved.webp') res.writeHead(302, { Location: '/private' }).end();
    else res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  const upstream = await origin(t, remote);
  const base = await hub(t, `${upstream}/registry/catalog.json?v=1`, dir);
  const image = await fetch(`${base}/icons/brand.svg`);
  assert.equal(image.status, 200);
  assert.match(image.headers.get('content-type') ?? '', /^image\/svg\+xml/);
  assert.match(image.headers.get('cache-control') ?? '', /max-age=/);
  assert.equal(await image.text(), svg);
  for (const [file, status] of [['fake.png', 502], ['moved.webp', 502], ['missing.png', 404], ['..%2fprivate.svg', 404]] as const) {
    assert.equal((await fetch(`${base}/icons/${file}`)).status, status);
  }
  assert.deepEqual(seen, ['/registry/icons/brand.svg', '/registry/icons/fake.png', '/registry/icons/moved.webp', '/registry/icons/missing.png']);
});
