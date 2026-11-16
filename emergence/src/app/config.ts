import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { configSchema, defaultConfig, type AppConfig } from '../core/domain/configuration.ts';
import { canonicalDirectory, withLease } from '../core/storage/lease.ts';
import { readJsonFile, replaceJsonFile } from '../core/storage/safe-json-file.ts';
export function homeDirectory(explicit?: string) {
  return resolve(explicit ?? process.env.EMERGENCE_HOME ?? join(homedir(), '.emergence'));
}
export async function loadConfig(home: string): Promise<AppConfig> {
  try {
    return configSchema.parse(
      await readJsonFile(join(home, 'config.json'), 4 * 1024 * 1024, '配置文件无效或过大'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return withLease(`config:${await canonicalDirectory(home)}`, '模型配置', async () => {
      try {
        return configSchema.parse(
          await readJsonFile(join(home, 'config.json'), 4 * 1024 * 1024, '配置文件无效或过大'),
        );
      } catch (second) {
        if ((second as NodeJS.ErrnoException).code !== 'ENOENT') throw second;
      }
      await writeConfig(home, defaultConfig);
      return structuredClone(defaultConfig);
    });
  }
}
export async function saveConfig(home: string, value: z.input<typeof configSchema>) {
  return withLease(`config:${await canonicalDirectory(home)}`, '模型配置', () =>
    writeConfig(home, configSchema.parse(value)),
  );
}
export async function updateConfig(home: string, change: (value: AppConfig) => void) {
  return withLease(`config:${await canonicalDirectory(home)}`, '模型配置', async () => {
    let value: AppConfig;
    try {
      value = configSchema.parse(
        await readJsonFile(join(home, 'config.json'), 4 * 1024 * 1024, '配置文件无效或过大'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      value = structuredClone(defaultConfig);
    }
    change(value);
    await writeConfig(home, value);
    return value;
  });
}
/** Explicit migration keeps a byte-for-byte backup and never replaces invalid/future schemas. */
export async function migrateConfig(home: string) {
  return withLease(`config:${await canonicalDirectory(home)}`, '配置迁移', async () => {
    const path = join(home, 'config.json'),
      raw = await readFile(path, 'utf8');
    const original = JSON.parse(raw),
      config = configSchema.parse(original);
    if (JSON.stringify(original) === JSON.stringify(config))
      return { changed: false, version: config.version };
    const backup = join(home, `config.backup-${randomUUID()}.json`);
    await writeFile(backup, raw, { flag: 'wx', mode: 0o600 });
    await writeConfig(home, config);
    return { changed: true, version: config.version, backup };
  });
}
async function writeConfig(home: string, value: AppConfig) {
  const config = configSchema.parse(value);
  await mkdir(home, { recursive: true });
  await replaceJsonFile(join(home, 'config.json'), config, {
    invalidMessage: '配置文件无效',
    maxBytes: 4 * 1024 * 1024,
    pretty: true,
    newline: true,
  });
}
