import { Inject, Injectable } from '@nestjs/common';
import webpush from 'web-push';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { SecretBox } from '../crypto/secret-box';
import { PrismaService } from '../prisma/prisma.service';

const SECRET_KEY = 'vapid';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * VAPID keys of the installation: from the environment, or generated on first use and stored encrypted,
 * so web push works without setup. The API and the worker may race to create them; the first stored pair wins.
 */
@Injectable()
export class VapidKeysService {
  private keys: Promise<VapidKeys> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly box: SecretBox,
  ) {}

  get(): Promise<VapidKeys> {
    this.keys ??= this.load().catch((error: unknown) => {
      this.keys = null;
      throw error;
    });
    return this.keys;
  }

  get subject(): string {
    return this.config.vapidSubject;
  }

  private async load(): Promise<VapidKeys> {
    if (this.config.vapid !== null) return this.config.vapid;
    const stored = await this.prisma.installationSecret.findUnique({ where: { key: SECRET_KEY } });
    if (stored !== null) return this.box.decrypt<VapidKeys>(stored.value);

    const generated = webpush.generateVAPIDKeys();
    await this.prisma.installationSecret.createMany({ data: [{ key: SECRET_KEY, value: this.box.encrypt(generated) }], skipDuplicates: true });
    const winner = await this.prisma.installationSecret.findUniqueOrThrow({ where: { key: SECRET_KEY } });
    return this.box.decrypt<VapidKeys>(winner.value);
  }
}
