import { Inject, Injectable } from '@nestjs/common';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { newId } from '../common/ids';

/** Attachment files. Local disk for now; an S3-compatible driver will sit behind the same interface. */
@Injectable()
export class StorageService {
  private readonly root: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.root = resolve(config.storageDir);
  }

  async put(workspaceId: string, filename: string, content: Buffer): Promise<string> {
    const now = new Date();
    const safeName = filename.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(-120) || 'file';
    const key = [workspaceId, now.getUTCFullYear(), String(now.getUTCMonth() + 1).padStart(2, '0'), `${newId()}-${safeName}`].join('/');
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    return key;
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.pathOf(key));
  }

  stream(key: string): ReadStream {
    return createReadStream(this.pathOf(key));
  }

  private pathOf(key: string): string {
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) {
      throw new Error('Invalid storage key');
    }
    return path;
  }
}
