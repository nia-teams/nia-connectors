import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { Registry } from '../src/registry.js';
import { CredentialStore } from '../src/store.js';
import { inject, injectMap, MissingCredential } from '../src/template.js';
import { cliStatus } from '../src/cli-manager.js';

async function temp(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'nia-connectors-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('encrypted state round-trips after restart and rejects tampering', async t => {
  const dir = await temp(t);
  const store = new CredentialStore(dir);
  const secret = 'test-credential-never-plaintext';
  await Promise.all([
    store.update('docs', state => ({ ...state, enabled: true, credentials: { KEY: secret }, disabledTools: ['write'] })),
    store.update('map', state => ({ ...state, enabled: true })),
  ]);
  const stateFile = join(dir, 'state.enc.json');
  const encrypted = await readFile(stateFile, 'utf8');
  assert.ok(!encrypted.includes(secret));
  assert.equal((await stat(join(dir, '.master.key'))).mode & 0o777, 0o600);
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  const plaintext = await new CredentialStore(dir).snapshot();
  assert.deepEqual(plaintext.docs, { enabled: true, credentials: { KEY: secret }, disabledTools: ['write'] });
  assert.equal(plaintext.map.enabled, true);
  const altered = JSON.parse(encrypted);
  const tag = Buffer.from(altered.tag, 'base64'); tag[0] ^= 1; altered.tag = tag.toString('base64');
  await writeFile(stateFile, JSON.stringify(altered));
  await assert.rejects(store.snapshot());
});

test('placeholder replacement is literal, one-pass, and does not inherit properties or read the process environment', () => {
  assert.equal(inject('https://host/${A}/${A}', { A: 'value' }), 'https://host/value/value');
  assert.deepEqual(injectMap({ Authorization: 'Bearer ${KEY}', 'X-Other': '${NESTED}' }, { KEY: '$&', NESTED: '${KEY}' }),
    { Authorization: 'Bearer $&', 'X-Other': '${KEY}' });
  assert.throws(() => inject('${PATH}', {}), MissingCredential);
  assert.throws(() => inject('${constructor}', {}), MissingCredential);
});

test('registry accepts an absolute path and a file URL', async t => {
  const dir = await temp(t);
  const source = resolve('examples/catalog.json');
  for (const path of [source, pathToFileURL(source).href]) {
    const data = await new Registry(path, dir).get();
    assert.equal(data.entries.length, 3);
    assert.equal(data.stale, false);
  }
});

test('HTTP registry uses TTL and If-None-Match, with a source-scoped disk fallback', async t => {
  const dir = await temp(t);
  const catalog = await readFile(resolve('examples/catalog.json'), 'utf8');
  const requests: (string | undefined)[] = [];
  let fail = false;
  const remote = createServer((req, res) => {
    requests.push(req.headers['if-none-match']);
    if (fail) { res.writeHead(503).end(); return; }
    if (req.headers['if-none-match'] === '"catalog-v1"') { res.writeHead(304).end(); return; }
    res.writeHead(200, { 'ETag': '"catalog-v1"', 'Content-Type': 'application/json' }).end(catalog);
  }).listen(0, '127.0.0.1');
  await once(remote, 'listening');
  t.after(() => { remote.closeAllConnections(); remote.close(); });
  const address = remote.address(); assert(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/catalog.json`;
  const registry = new Registry(url, dir);
  assert.equal((await registry.get()).entries.length, 3);
  await registry.get();
  assert.deepEqual(requests, [undefined]);
  assert.equal((await registry.get(true)).stale, false);
  assert.deepEqual(requests, [undefined, '"catalog-v1"']);
  fail = true;
  const prior = await new Registry(url, dir).get();
  assert.equal(prior.stale, true);
  assert.equal(prior.entries.length, 3);
  await assert.rejects(new Registry(`${url}?other`, dir).get(), /Registry unavailable/);
});

test('CLI detection does not interpret shell instructions', async () => {
  assert.deepEqual(await cliStatus({ binary: './node', versionCommand: './node --version' }), { installed: false, version: null });
  assert.deepEqual(await cliStatus({ binary: 'not-a-real-cli-07d63e54' }), { installed: false, version: null });
  if (process.platform !== 'win32') {
    assert.deepEqual(await cliStatus({ binary: 'node', versionCommand: 'node --version; ignored' }), { installed: true, version: null });
    assert.match((await cliStatus({ binary: 'node', versionCommand: 'node --version' })).version!, /^v\d+\.\d+\.\d+/);
  }
});
