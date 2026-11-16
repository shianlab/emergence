import { createHash } from 'node:crypto';
import { catalogJson, catalogSha256 } from '../assets/catalog.ts';
import { catalogSchema, type CoreCatalog } from '../domain/contracts.ts';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export function loadCoreCatalog(json = catalogJson, expectedHash = catalogSha256): CoreCatalog {
  if (createHash('sha256').update(json).digest('hex') !== expectedHash)
    throw new Error('CORE_ASSET_DIGEST_MISMATCH');
  try {
    return freeze(catalogSchema.parse(JSON.parse(json)));
  } catch {
    throw new Error('CORE_ASSET_SCHEMA_INVALID');
  }
}
