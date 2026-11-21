import type { SeedKeyMaterial, SeedKeyProvider } from './types.js';

function parseKeyMap(value: string | undefined): Readonly<Record<string, string>> {
  if (value === undefined || value.trim().length === 0) {
    throw new Error('SEED_ENCRYPTION_KEYS must be configured');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('SEED_ENCRYPTION_KEYS must contain a JSON object', { cause: error });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('SEED_ENCRYPTION_KEYS must be a JSON object');
  }

  const result: Record<string, string> = {};
  for (const [version, encoded] of Object.entries(parsed)) {
    if (version.trim().length === 0 || typeof encoded !== 'string') {
      throw new TypeError('Each seed key must map a non-empty version to a hex string');
    }
    if (!/^[a-f0-9]{64}$/i.test(encoded)) {
      throw new RangeError(`Seed encryption key ${version} must be 64 hex characters`);
    }
    result[version] = encoded;
  }

  return Object.freeze(result);
}

export class EnvironmentSeedKeyProvider implements SeedKeyProvider {
  readonly #keys: Readonly<Record<string, string>>;
  readonly #activeVersion: string;

  constructor(env: Readonly<Record<string, string | undefined>> = process.env) {
    this.#keys = parseKeyMap(env['SEED_ENCRYPTION_KEYS']);
    const activeVersion = env['SEED_ENCRYPTION_ACTIVE_KEY_VERSION'];
    if (activeVersion === undefined || activeVersion.trim().length === 0) {
      throw new Error('SEED_ENCRYPTION_ACTIVE_KEY_VERSION must be configured');
    }
    if (this.#keys[activeVersion] === undefined) {
      throw new Error(`Active seed encryption key version ${activeVersion} is not configured`);
    }
    this.#activeVersion = activeVersion;
  }

  async getActiveKey(): Promise<SeedKeyMaterial> {
    return {
      version: this.#activeVersion,
      key: await this.getKey(this.#activeVersion),
    };
  }

  async getKey(version: string): Promise<Buffer> {
    const encoded = this.#keys[version];
    if (encoded === undefined) {
      throw new Error(`Seed encryption key version ${version} is unavailable`);
    }
    return Buffer.from(encoded, 'hex');
  }
}
