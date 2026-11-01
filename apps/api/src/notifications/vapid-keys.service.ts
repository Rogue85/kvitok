import { Inject, Injectable, Logger } from '@nestjs/common';
import webpush from 'web-push';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { SecretBox } from '../crypto/secret-box';
import { PrismaService } from '../prisma/prisma.service';

const SECRET_KEY = 'vapid';
/** Sent when nothing better is known: Chrome and Firefox accept it, Apple rejects it with `BadJwtToken`. */
const FALLBACK_SUBJECT = 'mailto:admin@localhost';

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
  private readonly logger = new Logger(VapidKeysService.name);
  private keys: Promise<VapidKeys> | null = null;
  private resolvedSubject: string | null = null;

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

  /**
   * The contact push services see in every request. Apple accepts only a real one, so: VAPID_SUBJECT, else WEB_ORIGIN
   * on a public https domain, else the email of the first superadmin. Kept once found; the fallback is looked up again.
   */
  async subject(): Promise<string> {
    if (this.config.vapidSubject !== null) return this.config.vapidSubject;
    if (this.resolvedSubject !== null) return this.resolvedSubject;
    const superadmin = await this.prisma.user.findFirst({
      where: { isSuperadmin: true, disabledAt: null },
      orderBy: { createdAt: 'asc' },
      select: { email: true },
    });
    const subject = vapidSubject(this.config.webOrigin, superadmin?.email ?? null);
    if (subject === null) {
      this.logger.warn('No public contact for web push, Safari will reject notifications: set VAPID_SUBJECT to mailto:you@example.com');
      return FALLBACK_SUBJECT;
    }
    this.resolvedSubject = subject;
    return subject;
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

/** WEB_ORIGIN when it is https on a public domain, else the email when its domain is public; null when neither is. */
export function vapidSubject(webOrigin: string, email: string | null): string | null {
  const origin = URL.parse(webOrigin);
  if (origin?.protocol === 'https:' && isPublicHost(origin.hostname)) return origin.origin;
  const domain = email?.split('@')[1];
  return domain && isPublicHost(domain) ? `mailto:${email}` : null;
}

const LOCAL_SUFFIXES = ['.localhost', '.local', '.test', '.internal', '.lan', '.home.arpa'];

/** A domain name push services would take for real: not localhost, not an address, not a local zone. */
function isPublicHost(host: string): boolean {
  const name = host.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]+$/.test(name)) return false;
  return !LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
