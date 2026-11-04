import { activeOptions, type FieldDefinitionDto, type FieldMeta, type FieldValues, type TicketAnalysis } from '@kvitok/shared';
import type {
  ActionProposal,
  AgentQuestion,
  Channel,
  Customer,
  CustomerIdentity,
  Message,
  ReplyDraft,
  Ticket,
  User,
} from '../generated/prisma/client';
import type { LlmMessage, LlmTool } from '../llm/llm.types';
import { htmlToPlainText } from '../mail/html';
import { CHAT_TRIGGERS, PARTIAL_TRIGGERS, type AgentTrigger } from './agent-trigger.types';
import { IDENTIFY_CUSTOMER, MAX_TOOL_RESULT_CHARS, type IntegrationView } from './integration-runtime';
import type { AgentConfigSnapshot } from './config-snapshot.service';
import { corePrompt } from './core-prompt';
import { buildFindFieldOptionsTool, FIND_FIELD_OPTIONS, optionLine, optionsPresentation } from './field-options';
import {
  buildReadPlaybookTool,
  buildSubmitResultTool,
  READ_PLAYBOOK,
  SUBMIT_RESULT,
} from './submit-schema';

const KEEP_LAST_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 4000;
const MAX_QUESTIONS = 30;
const TAGS = ['customer_message', 'operator_reply', 'operator_message', 'automated_message', 'agent_question', 'integration_data'];
/** All stored facts together — no more than this; the agent requests the rest itself. */
const MAX_FACTS_CHARS = 40_000;

export type ContextTicket = Ticket & {
  channel: Channel | null;
  customer: (Customer & { identities: CustomerIdentity[] }) | null;
};

export interface AssembleInput {
  snapshot: AgentConfigSnapshot;
  ticket: ContextTicket;
  messages: Array<Message & { authorUser: User | null }>;
  questions: AgentQuestion[];
  mode: 'triage' | 'refine';
  triggers: AgentTrigger[];
  /** The current reply draft to the customer: the agent starts from it and changes it only when needed. */
  draft?: ReplyDraft | null;
  supportsTools: boolean;
  /** Integrations: the customer in an external system, the card, stored facts, tools. */
  integrations?: IntegrationView[];
  /** Service tools of the run, such as identify_customer. */
  serviceTools?: LlmTool[];
  /** Proposed actions (except replaced ones): awaiting decision, executed, rejected. */
  actions?: ActionProposal[];
}

export interface AssembledContext {
  messages: LlmMessage[];
  tools: LlmTool[];
  submitTool: string;
  /** A partial run: a reply to the operator and only the changed sections. */
  partial: boolean;
  /** A run on an operator message: the agent replies in the chat and replaces the draft without a "suggested version". */
  chat: boolean;
  /** Fields the agent may fill in during this run. */
  agentFields: FieldDefinitionDto[];
  playbookKeys: string[];
}

/**
 * Builds the agent input from the ticket anew on every run: instruction layers (stable ones first,
 * for prefix caching), then the ticket, the customer, the previous analysis, the conversation and the current task.
 */
export function assembleContext(input: AssembleInput): AssembledContext {
  const { snapshot, ticket } = input;
  const meta = ticket.fieldMeta as unknown as FieldMeta;
  const agentFields = snapshot.fields.filter(
    (f) =>
      f.entity === 'ticket' &&
      f.fillMode !== 'manual' &&
      !meta[f.key]?.locked &&
      (f.scopeDepartmentIds.length === 0 || (ticket.departmentId !== null && f.scopeDepartmentIds.includes(ticket.departmentId))),
  );
  const playbooks = snapshot.playbooks;
  const onDemand = input.supportsTools && snapshot.settings.playbookMode === 'on_demand' && playbooks.length > 0;
  // An operator message or an operator's action with "update the reply": the operator waits for the result in the chat.
  const chat = input.triggers.some((t) => PARTIAL_TRIGGERS.includes(t.type));
  // Partial only if an analysis exists and nothing new besides the operator's input (a new customer email needs a full analysis).
  const partial = chat && ticket.analysis !== null && input.triggers.every((t) => PARTIAL_TRIGGERS.includes(t.type) || t.type === 'stale_rerun');
  const submitTool = buildSubmitResultTool(snapshot.departments, agentFields, { partial });
  const searchedFields = agentFields.filter((f) => optionsPresentation(f) === 'search');
  // Without tools the options cannot be searched: list them all then.
  const listAll = !input.supportsTools;

  const system: string[] = [corePrompt(snapshot.locale)];
  if (snapshot.settings.policy.trim()) {
    system.push(`## Support policy\n${snapshot.settings.policy.trim()}`);
  }
  // Domain knowledge from the backend: how the data and mechanics work. The policy above sets the tone and promises.
  for (const integration of snapshot.integrations) {
    if (integration.instructions.trim()) {
      system.push(`## Integration knowledge: "${integration.title}"\n${integration.instructions.trim()}`);
    }
  }
  system.push(departmentsSection(snapshot));
  if (agentFields.length > 0) {
    system.push(fieldsSection(agentFields, listAll));
  }
  if (playbooks.length > 0) {
    system.push(
      onDemand
        ? `## Scenario (playbook) catalog\nFull text — via ${READ_PLAYBOOK}.\n${playbooks.map((p) => `- \`${p.key}\` — ${p.title}. When: ${p.when}`).join('\n')}`
        : `## Scenarios (playbooks)\n${playbooks.map((p) => `### ${p.title} (\`${p.key}\`)\nWhen: ${p.when}\n\n${p.body}`).join('\n\n')}`,
    );
  }
  const department = snapshot.departments.find((d) => d.id === ticket.departmentId);
  if (department?.instructions.trim()) {
    system.push(`## Department instructions: "${department.title}"\n${department.instructions.trim()}`);
  }
  if (!input.supportsTools) {
    system.push(
      `## Response format\nTools are unavailable. Reply with a single JSON object and no text around it, following the argument schema of ${SUBMIT_RESULT}:\n${JSON.stringify(submitTool.parameters)}`,
    );
  }

  const integrations = input.integrations ?? [];
  const canIdentify = (input.serviceTools ?? []).some((t) => t.name === IDENTIFY_CUSTOMER);
  const user = [
    ticketSection(input),
    customerSection(input),
    ...integrations.map((view) => integrationSection(view, canIdentify)),
    previousAnalysisSection(ticket, input.snapshot),
    factsSection(integrations),
    actionsSection(input.actions ?? []),
    conversationSection(input),
    questionsSection(input),
    draftSection(input),
    taskSection(input, partial),
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    messages: [
      { role: 'system', content: system.join('\n\n') },
      { role: 'user', content: user },
    ],
    tools: input.supportsTools
      ? [
          ...(onDemand ? [buildReadPlaybookTool(playbooks.map((p) => p.key))] : []),
          ...(searchedFields.length > 0 ? [buildFindFieldOptionsTool(searchedFields)] : []),
          ...(input.serviceTools ?? []),
          ...integrations.flatMap((i) => i.tools),
          submitTool,
        ]
      : [],
    submitTool: SUBMIT_RESULT,
    partial,
    chat,
    agentFields,
    playbookKeys: playbooks.map((p) => p.key),
  };
}

function departmentsSection(snapshot: AgentConfigSnapshot): string {
  if (snapshot.departments.length === 0) {
    return '## Departments\nThere are no departments — department is always null.';
  }
  const lines = snapshot.departments.map((d) => {
    const parts = [`- \`${d.key}\` — ${d.title}${d.isTriage ? ' (general triage queue)' : ''}`];
    if (d.description) parts.push(`  ${d.description}`);
    if (d.examples.length) parts.push(`  Examples: ${d.examples.map((e) => `"${e}"`).join('; ')}`);
    return parts.join('\n');
  });
  return `## Departments\n${lines.join('\n')}`;
}

/**
 * The fields the agent may fill in. Options of a select are listed one per line (value — label · group · hint) or,
 * when there are too many, only counted: the agent finds them with find_field_options.
 */
function fieldsSection(fields: FieldDefinitionDto[], listAll: boolean): string {
  const lines = fields.map((f) => {
    const head = `- \`${f.key}\` — ${f.label} (${f.type})${f.agentHint ? `. ${f.agentHint}` : ''}`;
    const presentation = optionsPresentation(f);
    if (presentation === null) return head;
    const options = activeOptions(f.options);
    const parts = [head];
    if (f.optionSet) {
      parts.push(`  Options come from the directory "${f.optionSet.title}"${f.optionSet.description ? `: ${f.optionSet.description}` : ''}`);
    }
    if (presentation === 'search' && !listAll) {
      parts.push(`  ${options.length} options, not listed here: find them with ${FIND_FIELD_OPTIONS}.`);
    } else {
      parts.push('  Options (value — label · group · description):', ...options.map((o) => `  - ${optionLine(o)}`));
    }
    return parts.join('\n');
  });
  return `## Fields you can fill in\n${lines.join('\n')}`;
}

const SOURCE_LABELS: Record<string, string> = {
  operator: 'operator',
  agent: 'agent',
  ingest: 'source',
  rule: 'rule',
  integration: 'integration',
};

function ticketSection({ ticket, snapshot }: AssembleInput): string {
  const fields = ticket.fields as FieldValues;
  const meta = ticket.fieldMeta as unknown as FieldMeta;
  const department = snapshot.departments.find((d) => d.id === ticket.departmentId);
  const lines = [
    `## Ticket T-${ticket.number}`,
    `Subject: ${ticket.subject}`,
    `Channel: ${ticket.channel ? `${ticket.channel.type === 'email' ? 'email' : 'API'} (${ticket.channel.name})` : '—'}`,
    `Status: ${ticket.status}; priority: ${ticket.priority}`,
    `Department: ${department ? `${department.key}${ticket.departmentLocked ? ' (locked by the operator)' : ''}` : 'not assigned'}`,
  ];
  if (ticket.tags.length) lines.push(`Tags: ${ticket.tags.join(', ')}`);
  const filled = Object.entries(fields);
  if (filled.length) {
    lines.push('Fields:');
    for (const [key, value] of filled) {
      const field = snapshot.fields.find((f) => f.entity === 'ticket' && f.key === key);
      const label = field?.label ?? key;
      const source = meta[key] ? ` (filled by: ${SOURCE_LABELS[meta[key].source] ?? meta[key].source}${meta[key].locked ? ', locked' : ''})` : '';
      lines.push(`- ${label} [${key}] = ${JSON.stringify(value)}${optionLabels(field, value)}${source}`);
    }
  }
  return lines.join('\n');
}

/** The labels of select values: ` (Tverskaya St, 12 · Moscow)`; archived options are marked. */
function optionLabels(field: FieldDefinitionDto | undefined, value: unknown): string {
  if (!field || (field.type !== 'select' && field.type !== 'multiselect')) return '';
  const labels = (Array.isArray(value) ? value : [value]).map((v) => {
    const option = field.options.find((o) => o.value === v);
    return option ? `${[option.label, option.group].filter(Boolean).join(' · ')}${option.archived ? ', retired' : ''}` : null;
  });
  return labels.some(Boolean) ? ` (${labels.map((l) => l ?? '?').join('; ')})` : '';
}

function customerSection({ ticket, snapshot }: AssembleInput): string {
  if (ticket.customer === null) {
    return '## Customer\nNot identified.';
  }
  const lines = ['## Customer', `Name: ${ticket.customer.name ?? '—'}`];
  for (const identity of ticket.customer.identities) {
    lines.push(`${identity.type}: ${identity.value}`);
  }
  for (const [key, value] of Object.entries(ticket.customer.fields as FieldValues)) {
    const field = snapshot.fields.find((f) => f.entity === 'customer' && f.key === key);
    lines.push(`${field?.label ?? key}: ${JSON.stringify(value)}${optionLabels(field, value)}`);
  }
  return lines.join('\n');
}

/** The customer in an external system: found or not, the card from /context, what to do if not. */
function integrationSection(view: IntegrationView, canIdentify: boolean): string {
  const lines = [`## Customer in "${view.title}"`];
  const c = view.customer;
  const identify = canIdentify
    ? `If the customer's messages contain an identity (a card number, a phone…), call ${IDENTIFY_CUSTOMER} with it before asking for anything. Who the customer is, the operator decides on the card in the timeline, not through your questions.`
    : null;
  if (c.status === 'found') {
    const how = c.source === 'manual' ? ' (linked by the operator)' : c.source === 'claim' ? ` (identified by ${c.matchedBy.join(', ') || 'data'} from the messages)` : '';
    lines.push(`Found: ${c.displayName ?? 'no name'}${how}. Customer data is in the card below and available through tools.`);
    if (!c.confirmed) {
      lines.push(
        view.pendingDecision === 'conflict'
          ? 'The messages point to another customer as well: the operator decides in the timeline who it is. Until then do not rely on this customer\'s data and do not propose actions.'
          : 'Not confirmed by the operator yet: the operator confirms the customer in the timeline, their actions are locked until then. Do not disclose their personal data in the draft before that.',
      );
    }
    if (view.context) {
      const card = { title: view.context.data.title, summary: view.context.data.summary, sections: view.context.data.sections.map((s) => ({ title: s.title, data: s.data })) };
      lines.push(`<integration_data kind="customer_card" fetched_at="${view.context.fetchedAt.toISOString()}">${escape(JSON.stringify(card))}</integration_data>`);
    } else if (view.contextError) {
      lines.push(`Could not get the card (${view.contextError}) — request what you need with tools.`);
    }
  } else if (c.status === 'not_found') {
    const tried = Object.entries(c.identities).map(([type, value]) => `${type} ${value}`).join(', ');
    lines.push(`${tried ? `Not found by contacts: ${tried}.` : 'No contacts the system looks customers up by.'} Tools with customer data are unavailable.`);
    if (view.pendingDecision) {
      lines.push('A customer found by data from the messages waits for the operator\'s decision in the timeline: do not ask the operator about it and do not ask the customer for an identity again.');
    } else {
      if (identify) lines.push(identify);
      lines.push('If there is none, ask in the draft reply for the phone or card number the account is linked to; tell the operator the customer was not found.');
    }
  } else if (c.status === 'ambiguous') {
    lines.push(`Several customers found by contacts: ${c.candidates.map((x) => `${x.displayName}${x.hint ? ` (${x.hint})` : ''}`).join('; ')}.`);
    if (identify && !view.pendingDecision) lines.push(identify);
    lines.push('Otherwise the operator picks the right one in the ticket card — tell them so; until then customer data is unavailable.');
  } else if (c.status === 'error') {
    lines.push(`The system is unavailable (${c.error}). Analyze without its data and note this for the operator.`);
  } else {
    lines.push('The ticket customer is not identified — customer data is unavailable.');
  }
  if (view.notFoundClaims.length > 0) {
    lines.push(`Nobody was found by these values from the messages: ${view.notFoundClaims.map((x) => `${x.type} ${x.value}`).join(', ')}. Do not try them again; ask the customer to check them.`);
  }
  return lines.join('\n');
}

/** Tool results from earlier runs that are still fresh: the agent has no reason to request them again. */
function factsSection(integrations: IntegrationView[]): string | null {
  const facts = integrations.flatMap((i) => i.facts).sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime());
  if (facts.length === 0) return null;
  const blocks: string[] = [];
  let total = 0;
  for (const fact of facts) {
    const raw = JSON.stringify(fact.result);
    const body = raw.length > MAX_TOOL_RESULT_CHARS ? `${raw.slice(0, MAX_TOOL_RESULT_CHARS)} [truncated]` : raw;
    if (total + body.length > MAX_FACTS_CHARS) break;
    total += body.length;
    blocks.push(
      `<integration_data tool="${fact.tool}" args="${escapeAttr(JSON.stringify(fact.args))}" fetched_at="${fact.fetchedAt.toISOString()}" valid_until="${fact.expiresAt.toISOString()}">${escape(body)}</integration_data>`,
    );
  }
  return [
    '## Already known from external systems',
    'This data was fetched in earlier runs and is still fresh. Do not call tools again with the same arguments unless the operator explicitly asks to refresh the data.',
    ...blocks,
  ].join('\n');
}

const ACTION_STATUS: Record<string, string> = {
  proposed: 'awaiting the operator',
  approved: 'approved, executing',
  executing: 'approved, executing',
  executed: 'executed',
  failed: 'execution failed',
  rejected: 'rejected by the operator',
};

/** The status line of an action: who proposed it and, for a replaced one, what the operator did instead. */
function actionStatus(action: ActionProposal, all: ActionProposal[]): string {
  const replacement = action.replacedById ? all.find((a) => a.id === action.replacedById) : undefined;
  if (action.status === 'rejected' && replacement) {
    return `rejected — replaced by the operator's action: ${replacement.title}${replacement.preview ? `, "${replacement.preview}"` : ''}`;
  }
  const status = ACTION_STATUS[action.status] ?? action.status;
  return action.source === 'operator' ? `${status}, proposed by the operator by hand` : status;
}

/** Actions on the ticket: the agent does not propose executed ones again and takes rejection reasons into account. */
function actionsSection(actions: ActionProposal[]): string | null {
  if (actions.length === 0) return null;
  const lines = ['## Actions on the ticket'];
  for (const action of actions) {
    const params = JSON.stringify(action.normalizedParams ?? action.params);
    const replaced = action.status === 'rejected' && action.replacedById !== null;
    const details = [
      action.preview ? `"${action.preview}"` : null,
      action.source === 'operator' && action.reason ? `operator's reason: "${action.reason}"` : null,
      action.status === 'rejected' && !replaced && action.decisionComment ? `reason: "${action.decisionComment}"` : null,
      action.status === 'failed' && action.error ? `error: ${action.error}` : null,
      action.status === 'executed' && action.result !== null ? `result: ${JSON.stringify(action.result)}` : null,
    ].filter(Boolean);
    lines.push(`- [${escape(actionStatus(action, actions))}] ${action.title} (${action.action}) ${escape(params)}${details.length ? ` — ${escape(details.join('; '))}` : ''}`);
  }
  lines.push(
    "Do not propose executed or rejected actions again, nor the operator's own proposals. Your proposals awaiting a decision are replaced if you propose actions anew; the operator's stay.",
  );
  return lines.join('\n');
}

function previousAnalysisSection(ticket: Ticket, snapshot: AgentConfigSnapshot): string | null {
  const analysis = ticket.analysis as unknown as TicketAnalysis | null;
  if (!analysis) return null;
  const lines = ['## Your previous analysis', `Department: ${analysis.department ?? 'not determined'} (confidence ${analysis.confidence})`, `Summary: ${analysis.summary}`];
  if (analysis.routingReason) lines.push(`Why this department: ${analysis.routingReason}`);
  if (analysis.findings.length) lines.push(`Findings:\n${analysis.findings.map((f) => `- ${f}`).join('\n')}`);
  if (analysis.needsHuman) lines.push('Needs a human decision: yes');
  // Candidates wait for the operator's choice: the operator may answer "the second one".
  const pending = Object.entries(analysis.fieldSuggestions ?? {}).filter(([, s]) => (s.candidates?.length ?? 0) > 0);
  if (pending.length) {
    lines.push('Field candidates waiting for the operator:');
    for (const [key, suggestion] of pending) {
      const field = snapshot.fields.find((f) => f.entity === 'ticket' && f.key === key);
      const options = [suggestion.value, ...(suggestion.candidates ?? [])].filter((v) => v !== null && v !== undefined);
      lines.push(`- ${key}: ${options.map((v) => `${JSON.stringify(v)}${optionLabels(field, v)}`).join(', ')}`);
    }
  }
  return lines.join('\n');
}

function draftSection({ draft }: AssembleInput): string | null {
  const text = draft ? htmlToPlainText(draft.bodyHtml).trim() : '';
  if (!draft || !text) return null;
  const by = draft.source === 'operator' ? 'edited by the operator' : 'your version';
  return `## Current draft reply to the customer (${by})\n${escape(truncate(text))}`;
}

function conversationSection(input: AssembleInput): string {
  const visible = input.messages;
  const first = visible[0];
  const tail = visible.slice(-KEEP_LAST_MESSAGES);
  const items: string[] = [];
  if (first && !tail.includes(first)) {
    items.push(renderMessage(first, input));
    items.push(`[… messages skipped: ${visible.length - tail.length - 1} …]`);
  }
  for (const message of tail) {
    items.push(renderMessage(message, input));
  }
  return `## Conversation\n${items.join('\n\n') || '(no messages)'}`;
}

const QUESTION_STATUS: Record<string, string> = { open: 'open', answered: 'answered', dismissed: 'closed without an answer' };

/** All questions the agent has asked on the ticket: without them it asks the closed ones again after every rerun. */
function questionsSection({ questions }: AssembleInput): string | null {
  if (questions.length === 0) return null;
  const lines = ['## Your questions to the operator'];
  for (const question of questions.slice(-MAX_QUESTIONS)) {
    lines.push(`<agent_question at="${question.createdAt.toISOString()}" status="${QUESTION_STATUS[question.status] ?? question.status}">${escape(question.text)}</agent_question>`);
  }
  lines.push('Answers are in the conversation (answers_question). Do not ask answered or closed questions again. questions_for_operator replaces the open ones: repeat an open question exactly to keep it.');
  return lines.join('\n');
}

function renderMessage(message: Message & { authorUser: User | null }, input: AssembleInput): string {
  const at = message.createdAt.toISOString();
  const body = escape(truncate(message.authorType === 'customer' ? (message.bodyClean ?? message.bodyText) : message.bodyText));
  if (message.isAutomated) {
    return `<automated_message at="${at}">${truncate(body, 500)}</automated_message>`;
  }
  if (message.authorType === 'customer') {
    const from = escapeAttr(message.fromName ?? message.fromEmail ?? 'customer');
    return `<customer_message from="${from}" at="${at}">\n${body}\n</customer_message>`;
  }
  const author = escapeAttr(message.authorUser?.name ?? 'operator');
  if (message.visibility === 'internal') {
    const question = message.answersQuestionId ? input.questions.find((q) => q.id === message.answersQuestionId) : undefined;
    const answers = question ? ` answers_question="${escapeAttr(question.text)}"` : '';
    return `<operator_message author="${author}" at="${at}"${answers}>\n${body}\n</operator_message>`;
  }
  return `<operator_reply author="${author}" at="${at}">\n${body}\n</operator_reply>`;
}

function taskSection(input: AssembleInput, partial: boolean): string {
  const lines: string[] = ['## Task'];
  const operatorMessages = input.triggers
    .filter((t) => CHAT_TRIGGERS.includes(t.type) && t.messageId)
    .map((t) => input.messages.find((m) => m.id === t.messageId))
    .filter((m): m is NonNullable<typeof m> => Boolean(m));

  if (operatorMessages.length > 0) {
    lines.push(
      partial
        ? 'The operator wrote to you. Reply in message_to_operator briefly: what you understood and what you changed. Pass only the sections their message affects; leave the rest out and it stays as is. If they ask to change the reply to the customer, return reply_body with the whole new text, based on the current draft. If they just ask a question, answer and change nothing. The operator\'s instruction outweighs your earlier conclusions.'
        : 'The operator wrote to you. Reply in message_to_operator and do a full analysis that takes their message into account. The operator\'s instruction outweighs your earlier conclusions.',
    );
    for (const message of operatorMessages) {
      lines.push(`<operator_message author="${escapeAttr(message.authorUser?.name ?? 'operator')}">\n${escape(truncate(message.bodyText))}\n</operator_message>`);
    }
  } else if (input.triggers.some((t) => t.type === 'action_executed') && !input.triggers.some((t) => t.type === 'customer_message')) {
    const done = input.triggers
      .filter((t) => t.type === 'action_executed' && t.actionId)
      .map((t) => input.actions?.find((a) => a.id === t.actionId))
      .filter((a): a is NonNullable<typeof a> => Boolean(a));
    lines.push(
      partial
        ? 'The operator performed an action by hand (see "Actions on the ticket") and asked you to bring the reply in line with it. Return reply_body with the whole updated text, based on the current draft, and say briefly in message_to_operator what you changed. Pass only the sections the action affects. Do not propose this action again.'
        : 'The operator performed an action by hand (see "Actions on the ticket"). Do a full analysis that takes it into account and update the draft reply to match what was done. Do not propose this action again.',
    );
    for (const action of done) {
      lines.push(`- ${escape(action.title)}: ${action.status === 'executed' ? 'executed' : `failed${action.error ? ` (${escape(action.error)})` : ''}`}${action.preview ? ` — "${escape(action.preview)}"` : ''}`);
    }
  } else if (input.triggers.some((t) => t.type === 'customer_message')) {
    lines.push('The customer sent a new message (the last one in the conversation). Update the analysis, the fields and the draft reply.');
  } else if (input.triggers.some((t) => t.type === 'customer_linked')) {
    lines.push('The operator linked the customer in the external system — their data is now available. Rebuild the analysis, actions and draft with this data.');
  } else if (input.triggers.some((t) => t.type === 'manual')) {
    lines.push('The operator asked to analyze the ticket again.');
  } else if (input.triggers.some((t) => t.type === 'stale_rerun')) {
    lines.push('The ticket changed while the previous analysis was running. Analyze the ticket again.');
  } else {
    lines.push('Analyze the new request.');
  }
  lines.push(`Finish with a ${SUBMIT_RESULT} call.`);
  return lines.join('\n');
}

function truncate(text: string, max = MAX_MESSAGE_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}… [cut]` : text;
}

/** Keep the content from closing our tag and posing as an operator instruction. */
function escape(text: string): string {
  let result = text;
  for (const tag of TAGS) {
    result = result.replace(new RegExp(`<(/?)(${tag})`, 'gi'), '‹$1$2');
  }
  return result;
}

/** For other places that show untrusted text to a model, such as the MCP server. */
export const escapeUntrusted = escape;

function escapeAttr(text: string): string {
  return text.replace(/"/g, "'").replace(/[<>]/g, '');
}
