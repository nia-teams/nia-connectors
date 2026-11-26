import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { missing, writePrivate } from './files.js';

export interface OAuthState {
  broker?: true;
  registration: { issuer: string; redirectUri: string; clientId: string; clientSecret?: string; authMethod: 'none' | 'client_secret_basic' | 'client_secret_post' };
  tokens?: { tokenEndpoint: string; resource?: string; accessToken: string; refreshToken?: string; expiresAt?: number; authorizedAt: number };
}
export interface ConnectorState { enabled: boolean; credentials: Record<string, string>; disabledTools: string[]; binding?: string; oauth?: OAuthState }
type State = Record<string, ConnectorState>;
const context = Buffer.from('nia-connectors/state/v1');
export const blankState = (): ConnectorState => ({ enabled: false, credentials: {}, disabledTools: [] });

export class CredentialStore {
  private readonly stateFile: string;
  private readonly keyFile: string;
  private master?: Promise<Buffer>;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {
    this.stateFile = join(dir, 'state.enc.json');
    this.keyFile = join(dir, '.master.key');
  }

  private async key() {
    this.master ??= this.readOrCreateKey();
    return this.master;
  }

  private async readOrCreateKey() {
    const load = async () => {
      const key = await readFile(this.keyFile);
      if (key.length !== 32) throw new Error('Invalid master key');
      await chmod(this.keyFile, 0o600);
      return key;
    };
    try { return await load(); } catch (e) { if (!missing(e)) throw e; }
    // Never replace a key if encrypted state already exists.
    try { await readFile(this.stateFile); throw new Error('Master key missing for existing state'); } catch (e) { if (!missing(e)) throw e; }
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    const tmp = `${this.keyFile}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, key, { mode: 0o600, flag: 'wx' });
      // Publish the complete file atomically, and never overwrite an existing key.
      await link(tmp, this.keyFile);
      return key;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      return load();
    } finally { await unlink(tmp).catch(() => {}); }
  }

  async snapshot(): Promise<State> {
    let raw: string;
    try { raw = await readFile(this.stateFile, 'utf8'); } catch (e) { if (missing(e)) return Object.create(null); throw e; }
    const data = JSON.parse(raw);
    if (data.version !== 1) throw new Error('Unsupported encrypted state format');
    const key = Buffer.from(hkdfSync('sha256', await this.key(), Buffer.from(data.salt, 'base64'), context, 32));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(context);
    decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
    const text = Buffer.concat([decipher.update(Buffer.from(data.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    return Object.assign(Object.create(null), JSON.parse(text));
  }

  update(id: string, apply: (state: ConnectorState) => ConnectorState): Promise<ConnectorState> {
    const pending = this.writes.then(async () => {
      const next = await this.snapshot();
      next[id] = apply(next[id] ?? blankState());
      const salt = randomBytes(32), iv = randomBytes(12);
      const key = Buffer.from(hkdfSync('sha256', await this.key(), salt, context, 32));
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(context);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(next), 'utf8'), cipher.final()]);
      const b64 = (value: Buffer) => value.toString('base64');
      await writePrivate(this.stateFile, JSON.stringify({ version: 1, salt: b64(salt), iv: b64(iv), tag: b64(cipher.getAuthTag()), ciphertext: b64(ciphertext) }));
      return next[id];
    });
    this.writes = pending.catch(() => {});
    return pending;
  }
}
