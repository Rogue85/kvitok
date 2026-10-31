<script setup lang="ts">
import type { ChannelDto, ChannelSecretsDto, MailTransport } from '@kvitok/shared';

interface MailboxTestResult {
  smtp: { ok: boolean; error?: string };
  imap: { ok: boolean; error?: string } | null;
}

const toast = useToast();
const { workspaceId, can } = useWorkspace();
const { channels } = useWorkspaceData();
const isAdmin = computed(() => can('admin'));
const origin = import.meta.client ? window.location.origin : '';

function notifyError(e: unknown, fallback: string): void {
  const details = e instanceof ApiError && Array.isArray(e.details) ? (e.details as Array<{ path: string; message: string }>).map((d) => `${d.path}: ${d.message}`).join('; ') : '';
  toast.add({ color: 'error', title: e instanceof ApiError ? e.message : fallback, description: details || undefined });
}

/* Secrets are shown once — right after creation or rotation. */
const secrets = ref<ChannelSecretsDto | null>(null);
const curlExample = computed(() =>
  secrets.value?.apiKey
    ? `curl -X POST ${origin}/api/v1/ingest/${secrets.value.channel.id} \\
  -H 'Authorization: Bearer ${secrets.value.apiKey}' \\
  -H 'Content-Type: application/json' \\
  -d '{"external_id":"req-1","customer":{"name":"John","identities":{"email":"john@example.com"}},"subject":"Subject","body":"Request text"}'`
    : '',
);

/* API channel */
const apiOpen = ref(false);
const apiForm = reactive({ id: null as string | null, name: '', webhookUrl: '', mapping: [] as Array<{ path: string; field: string }> });

function editApi(channel: ChannelDto | null): void {
  Object.assign(apiForm, {
    id: channel?.id ?? null,
    name: channel?.name ?? '',
    webhookUrl: channel?.webhookUrl ?? '',
    mapping: Object.entries(channel?.metadataMapping ?? {}).map(([path, field]) => ({ path, field })),
  });
  apiOpen.value = true;
}

async function saveApi(): Promise<void> {
  const body = {
    name: apiForm.name,
    webhookUrl: apiForm.webhookUrl.trim() || null,
    metadataMapping: Object.fromEntries(apiForm.mapping.filter((m) => m.path && m.field).map((m) => [m.path, m.field])),
  };
  try {
    const result = apiForm.id
      ? await api<ChannelSecretsDto>(`/workspaces/${workspaceId.value}/channels/${apiForm.id}`, { method: 'PATCH', body })
      : await api<ChannelSecretsDto>(`/workspaces/${workspaceId.value}/channels`, { method: 'POST', body: { type: 'api', ...body } });
    apiOpen.value = false;
    if (result.apiKey || result.webhookSecret) secrets.value = result;
    await channels.refresh();
  } catch (e) {
    notifyError(e, t('channels.saveFailed'));
  }
}

/* Mailbox */
const mailOpen = ref(false);
const mailForm = reactive({
  id: null as string | null,
  transport: 'smtp' as MailTransport,
  name: '',
  address: '',
  displayName: '',
  signatureHtml: '',
  smtp: { host: '', port: 465, secure: true, user: '', password: '' },
  imapEnabled: true,
  imap: { host: '', port: 993, secure: true, user: '', password: '', folder: 'INBOX', importExisting: false },
});

function editMail(channel: ChannelDto | null, transport: MailTransport = 'smtp'): void {
  Object.assign(mailForm, {
    id: channel?.id ?? null,
    transport: channel?.transport ?? transport,
    name: channel?.name ?? (transport === 'sandbox' ? t('channels.sandbox') : ''),
    address: channel?.address ?? '',
    displayName: channel?.displayName ?? '',
    signatureHtml: channel?.signatureHtml ?? '',
    smtp: { host: channel?.smtp?.host ?? '', port: channel?.smtp?.port ?? 465, secure: channel?.smtp?.secure ?? true, user: channel?.smtp?.user ?? '', password: '' },
    imapEnabled: channel ? channel.imap !== null : transport === 'smtp',
    imap: {
      host: channel?.imap?.host ?? '',
      port: channel?.imap?.port ?? 993,
      secure: channel?.imap?.secure ?? true,
      user: channel?.imap?.user ?? '',
      password: '',
      folder: channel?.imap?.folder ?? 'INBOX',
      importExisting: channel?.imap?.importExisting ?? false,
    },
  });
  mailOpen.value = true;
}

function withoutEmptyPassword<T extends { password: string }>(value: T): Omit<T, 'password'> & { password?: string } {
  const { password, ...rest } = value;
  return password ? { ...rest, password } : rest;
}

const mailTitle = computed(() => {
  if (mailForm.transport === 'sandbox') return mailForm.id ? t('channels.sandbox') : t('channels.newSandbox');
  return mailForm.id ? t('channels.mailbox') : t('channels.newMailbox');
});

async function saveMail(): Promise<void> {
  const sandbox = mailForm.transport === 'sandbox';
  const body = {
    name: mailForm.name,
    displayName: mailForm.displayName,
    signatureHtml: mailForm.signatureHtml,
    // A test mailbox has no servers: emails stay in the system.
    ...(sandbox
      ? {}
      : { smtp: withoutEmptyPassword(mailForm.smtp), imap: mailForm.imapEnabled ? withoutEmptyPassword(mailForm.imap) : null }),
  };
  try {
    if (mailForm.id) {
      await api(`/workspaces/${workspaceId.value}/channels/${mailForm.id}`, { method: 'PATCH', body });
    } else {
      await api(`/workspaces/${workspaceId.value}/channels`, {
        method: 'POST',
        body: { type: 'email', transport: mailForm.transport, address: mailForm.address, ...body },
      });
    }
    mailOpen.value = false;
    await channels.refresh();
    toast.add({ color: 'success', title: t('channels.mailboxSaved') });
  } catch (e) {
    notifyError(e, t('channels.mailboxSaveFailed'));
  }
}

/* Actions */
const testing = ref<string | null>(null);
async function testMailbox(channel: ChannelDto): Promise<void> {
  testing.value = channel.id;
  try {
    const result = await api<MailboxTestResult>(`/workspaces/${workspaceId.value}/channels/${channel.id}/test`, { method: 'POST' });
    const parts = [`SMTP: ${result.smtp.ok ? t('channels.ok') : result.smtp.error}`, result.imap ? `IMAP: ${result.imap.ok ? t('channels.ok') : result.imap.error}` : null].filter(Boolean);
    toast.add({ color: result.smtp.ok && (result.imap?.ok ?? true) ? 'success' : 'error', title: t('channels.connectionCheck'), description: parts.join('\n') });
  } catch (e) {
    notifyError(e, t('channels.checkFailed'));
  } finally {
    testing.value = null;
  }
}

async function action(channel: ChannelDto, path: string, message: string): Promise<void> {
  try {
    const result = await api<ChannelSecretsDto | ChannelDto>(`/workspaces/${workspaceId.value}/channels/${channel.id}/${path}`, { method: 'POST' });
    if ('apiKey' in result || 'webhookSecret' in result) secrets.value = result as ChannelSecretsDto;
    await channels.refresh();
    toast.add({ color: 'success', title: message });
  } catch (e) {
    notifyError(e, t('common.actionFailed'));
  }
}

async function toggle(channel: ChannelDto): Promise<void> {
  try {
    await api(`/workspaces/${workspaceId.value}/channels/${channel.id}`, { method: 'PATCH', body: { enabled: !channel.enabled } });
    await channels.refresh();
  } catch (e) {
    notifyError(e, t('channels.updateFailed'));
  }
}

async function copy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  toast.add({ title: t('common.copied'), icon: 'i-lucide-copy' });
}
</script>

<template>
  <UDashboardPanel id="channels">
    <template #header>
      <UDashboardNavbar :title="t('nav.channels')">
        <template #right>
          <template v-if="isAdmin">
            <UButton icon="i-lucide-flask-conical" :label="t('channels.sandbox')" variant="soft" color="neutral" @click="editMail(null, 'sandbox')" />
            <UButton icon="i-lucide-mail-plus" :label="t('channels.mailbox')" variant="soft" @click="editMail(null)" />
            <UButton icon="i-lucide-webhook" :label="t('channels.apiChannel')" @click="editApi(null)" />
          </template>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <p class="mb-4 max-w-2xl text-sm text-(--ui-text-muted)">
        {{ t('channels.intro') }}
      </p>

      <div class="grid gap-4 lg:grid-cols-2">
        <UCard v-for="channel in channels.data.value" :key="channel.id" :class="channel.enabled ? '' : 'opacity-60'">
          <template #header>
            <div class="flex items-center gap-2">
              <UIcon :name="channel.type === 'api' ? 'i-lucide-webhook' : channel.transport === 'sandbox' ? 'i-lucide-flask-conical' : 'i-lucide-mail'" class="size-5" />
              <span class="font-medium">{{ channel.name }}</span>
              <UBadge v-if="channel.transport === 'sandbox'" color="warning" variant="subtle" size="sm">{{ t('channels.sandboxBadge') }}</UBadge>
              <UBadge v-if="channel.isDefaultMailbox" color="primary" variant="subtle" size="sm">{{ t('channels.defaultMailbox') }}</UBadge>
              <UBadge v-if="!channel.enabled" color="neutral" variant="subtle" size="sm">{{ t('common.disabled') }}</UBadge>
            </div>
          </template>

          <dl class="space-y-1 text-sm">
            <template v-if="channel.type === 'api'">
              <div class="flex gap-2"><dt class="w-32 text-(--ui-text-muted)">{{ t('channels.channelId') }}</dt><dd class="truncate font-mono text-xs">{{ channel.id }}</dd></div>
              <div class="flex gap-2"><dt class="w-32 text-(--ui-text-muted)">{{ t('common.key') }}</dt><dd class="font-mono text-xs">{{ channel.apiKeyPrefix }}…</dd></div>
              <div class="flex gap-2"><dt class="w-32 text-(--ui-text-muted)">Webhook</dt><dd class="truncate">{{ channel.webhookUrl ?? '—' }}</dd></div>
              <div v-if="Object.keys(channel.metadataMapping ?? {}).length" class="flex gap-2">
                <dt class="w-32 text-(--ui-text-muted)">{{ t('channels.metadataToFields') }}</dt>
                <dd class="font-mono text-xs">{{ Object.entries(channel.metadataMapping ?? {}).map(([k, v]) => `${k} → ${v}`).join(', ') }}</dd>
              </div>
            </template>
            <template v-else>
              <div class="flex gap-2"><dt class="w-32 text-(--ui-text-muted)">{{ t('integrations.address') }}</dt><dd>{{ channel.address }}</dd></div>
              <div v-if="channel.transport === 'sandbox'" class="flex gap-2">
                <dt class="w-32 text-(--ui-text-muted)">{{ t('channels.sending') }}</dt>
                <dd>{{ t('channels.sandboxSending') }}</dd>
              </div>
              <template v-else>
                <div class="flex gap-2"><dt class="w-32 text-(--ui-text-muted)">SMTP</dt><dd>{{ channel.smtp?.host }}:{{ channel.smtp?.port }}</dd></div>
                <div class="flex gap-2"><dt class="w-32 text-(--ui-text-muted)">IMAP</dt><dd>{{ channel.imap ? `${channel.imap.host}:${channel.imap.port}, ${channel.imap.folder}` : t('channels.noInbound') }}</dd></div>
                <div v-if="channel.imap" class="flex gap-2">
                  <dt class="w-32 text-(--ui-text-muted)">{{ t('channels.sync') }}</dt>
                  <dd>{{ channel.lastSyncAt ? formatRelative(channel.lastSyncAt) : t('channels.never') }}</dd>
                </div>
              </template>
            </template>
          </dl>
          <UAlert v-if="channel.lastSyncError" class="mt-3" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="channel.lastSyncError" />

          <template v-if="isAdmin || channel.transport === 'sandbox'" #footer>
            <div class="flex flex-wrap gap-2">
              <UButton v-if="channel.transport === 'sandbox'" size="xs" icon="i-lucide-inbox" :to="`/w/${workspaceId}/settings/channels/${channel.id}/outbox`">{{ t('outbox.title') }}</UButton>
              <template v-if="isAdmin">
                <UButton size="xs" variant="soft" icon="i-lucide-pencil" @click="channel.type === 'api' ? editApi(channel) : editMail(channel)">{{ t('common.edit') }}</UButton>
                <template v-if="channel.type === 'api'">
                  <UButton size="xs" variant="soft" color="neutral" icon="i-lucide-key-round" @click="action(channel, 'rotate-key', t('channels.keyRotated'))">{{ t('channels.newKey') }}</UButton>
                  <UButton v-if="channel.webhookUrl" size="xs" variant="soft" color="neutral" icon="i-lucide-shield" @click="action(channel, 'rotate-webhook-secret', t('channels.webhookSecretRotated'))">{{ t('channels.newWebhookSecret') }}</UButton>
                </template>
                <template v-else>
                  <UButton v-if="channel.transport !== 'sandbox'" size="xs" variant="soft" color="neutral" icon="i-lucide-plug-zap" :loading="testing === channel.id" @click="testMailbox(channel)">{{ t('channels.testConnection') }}</UButton>
                  <UButton v-if="channel.imap" size="xs" variant="soft" color="neutral" icon="i-lucide-refresh-cw" @click="action(channel, 'poll', t('channels.pollStarted'))">{{ t('channels.poll') }}</UButton>
                  <UButton v-if="!channel.isDefaultMailbox" size="xs" variant="soft" color="neutral" icon="i-lucide-star" @click="action(channel, 'default-mailbox', t('channels.defaultChosen'))">{{ t('channels.makeDefault') }}</UButton>
                </template>
                <UButton size="xs" variant="ghost" color="neutral" @click="toggle(channel)">{{ channel.enabled ? t('common.disable') : t('common.enable') }}</UButton>
              </template>
            </div>
          </template>
        </UCard>
      </div>
      <UEmpty v-if="channels.data.value.length === 0" icon="i-lucide-webhook" :title="t('channels.empty.title')" :description="t('channels.empty.description')" />

      <UModal v-model:open="apiOpen" :title="apiForm.id ? t('channels.apiChannel') : t('channels.newApiChannel')" :ui="{ content: 'max-w-xl' }">
        <template #body>
          <form id="api-form" class="space-y-4" @submit.prevent="saveApi">
            <UFormField :label="t('common.name')" required><UInput v-model="apiForm.name" :placeholder="t('channels.apiNamePlaceholder')" class="w-full" /></UFormField>
            <UFormField :label="t('channels.webhook')" :help="t('channels.webhookHelp')">
              <UInput v-model="apiForm.webhookUrl" placeholder="https://your-service/support-webhook" class="w-full" />
            </UFormField>
            <div class="space-y-2">
              <p class="text-sm font-medium">{{ t('channels.metadataToTicketFields') }}</p>
              <div v-for="(row, index) in apiForm.mapping" :key="index" class="flex gap-2">
                <UInput v-model="row.path" placeholder="form.category" size="sm" class="flex-1" />
                <UInput v-model="row.field" placeholder="category" size="sm" class="flex-1" />
                <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="sm" @click="apiForm.mapping.splice(index, 1)" />
              </div>
              <UButton icon="i-lucide-plus" size="xs" variant="soft" @click="apiForm.mapping.push({ path: '', field: '' })">{{ t('rules.rule') }}</UButton>
            </div>
          </form>
        </template>
        <template #footer>
          <UButton color="neutral" variant="ghost" @click="apiOpen = false">{{ t('common.cancel') }}</UButton>
          <UButton type="submit" form="api-form">{{ t('common.save') }}</UButton>
        </template>
      </UModal>

      <UModal v-model:open="mailOpen" :title="mailTitle" :ui="{ content: 'max-w-2xl' }">
        <template #body>
          <form id="mail-form" class="space-y-4" @submit.prevent="saveMail">
            <div class="grid grid-cols-3 gap-3">
              <UFormField :label="t('common.name')" required><UInput v-model="mailForm.name" class="w-full" /></UFormField>
              <UFormField :label="t('integrations.address')" required><UInput v-model="mailForm.address" type="email" :disabled="Boolean(mailForm.id)" class="w-full" /></UFormField>
              <UFormField :label="t('channels.senderName')"><UInput v-model="mailForm.displayName" :placeholder="t('channels.senderNamePlaceholder')" class="w-full" /></UFormField>
            </div>
            <UAlert
              v-if="mailForm.transport === 'sandbox'"
              color="warning"
              variant="subtle"
              icon="i-lucide-flask-conical"
              :title="t('channels.sandboxAlert.title')"
              :description="t('channels.sandboxAlert.description')"
            />
            <template v-else>
              <fieldset class="space-y-3 rounded-md border border-(--ui-border) p-3">
                <legend class="px-1 text-sm font-medium">{{ t('channels.smtpLegend') }}</legend>
                <div class="grid grid-cols-4 gap-3">
                  <UFormField :label="t('channels.server')" class="col-span-2"><UInput v-model="mailForm.smtp.host" placeholder="smtp.yandex.ru" class="w-full" /></UFormField>
                  <UFormField :label="t('channels.port')"><UInputNumber v-model="mailForm.smtp.port" class="w-full" /></UFormField>
                  <UFormField label="SSL/TLS"><USwitch v-model="mailForm.smtp.secure" /></UFormField>
                  <UFormField :label="t('channels.login')" class="col-span-2"><UInput v-model="mailForm.smtp.user" class="w-full" /></UFormField>
                  <UFormField :label="t('auth.password')" class="col-span-2" :help="mailForm.id ? t('agentSettings.keepCurrent') : undefined">
                    <UInput v-model="mailForm.smtp.password" type="password" autocomplete="new-password" class="w-full" />
                  </UFormField>
                </div>
              </fieldset>
              <fieldset class="space-y-3 rounded-md border border-(--ui-border) p-3">
                <legend class="px-1 text-sm font-medium"><UCheckbox v-model="mailForm.imapEnabled" :label="t('channels.imapLegend')" /></legend>
                <div v-if="mailForm.imapEnabled" class="grid grid-cols-4 gap-3">
                  <UFormField :label="t('channels.server')" class="col-span-2"><UInput v-model="mailForm.imap.host" placeholder="imap.yandex.ru" class="w-full" /></UFormField>
                  <UFormField :label="t('channels.port')"><UInputNumber v-model="mailForm.imap.port" class="w-full" /></UFormField>
                  <UFormField label="SSL/TLS"><USwitch v-model="mailForm.imap.secure" /></UFormField>
                  <UFormField :label="t('channels.login')" class="col-span-2"><UInput v-model="mailForm.imap.user" class="w-full" /></UFormField>
                  <UFormField :label="t('auth.password')" class="col-span-2" :help="mailForm.id ? t('agentSettings.keepCurrent') : undefined">
                    <UInput v-model="mailForm.imap.password" type="password" autocomplete="new-password" class="w-full" />
                  </UFormField>
                  <UFormField :label="t('channels.folder')" class="col-span-2"><UInput v-model="mailForm.imap.folder" class="w-full" /></UFormField>
                  <UCheckbox v-model="mailForm.imap.importExisting" :label="t('channels.importExisting')" class="col-span-2 self-end" />
                </div>
              </fieldset>
            </template>
            <UFormField :label="t('channels.signature')" :help="t('channels.signatureHelp')">
              <UTextarea v-model="mailForm.signatureHtml" autoresize :rows="2" class="w-full font-mono text-xs" />
            </UFormField>
          </form>
        </template>
        <template #footer>
          <UButton color="neutral" variant="ghost" @click="mailOpen = false">{{ t('common.cancel') }}</UButton>
          <UButton type="submit" form="mail-form">{{ t('common.save') }}</UButton>
        </template>
      </UModal>

      <UModal :open="secrets !== null" :title="t('channels.secrets.title')" :description="t('channels.secrets.description')" :ui="{ content: 'max-w-2xl' }" @update:open="(v: boolean) => !v && (secrets = null)">
        <template #body>
          <div v-if="secrets" class="space-y-4 text-sm">
            <div v-if="secrets.apiKey" class="space-y-1">
              <p class="font-medium">{{ t('channels.secrets.apiKey') }}</p>
              <div class="flex gap-2">
                <UInput :model-value="secrets.apiKey" readonly class="flex-1 font-mono" />
                <UButton icon="i-lucide-copy" color="neutral" variant="soft" @click="copy(secrets.apiKey!)" />
              </div>
            </div>
            <div v-if="secrets.webhookSecret" class="space-y-1">
              <p class="font-medium">{{ t('channels.secrets.webhookSecret') }}</p>
              <div class="flex gap-2">
                <UInput :model-value="secrets.webhookSecret" readonly class="flex-1 font-mono" />
                <UButton icon="i-lucide-copy" color="neutral" variant="soft" @click="copy(secrets.webhookSecret!)" />
              </div>
              <p class="text-(--ui-text-muted)">{{ t('channels.secrets.verification') }} <code>X-Support-Signature = sha256=HMAC_SHA256(secret, "&lt;X-Support-Timestamp&gt;.&lt;body&gt;")</code></p>
            </div>
            <div v-if="curlExample" class="space-y-1">
              <p class="font-medium">{{ t('channels.secrets.example') }}</p>
              <pre class="overflow-x-auto rounded-md bg-(--ui-bg-muted) p-3 text-xs">{{ curlExample }}</pre>
            </div>
          </div>
        </template>
        <template #footer>
          <UButton @click="secrets = null">{{ t('channels.secrets.saved') }}</UButton>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
