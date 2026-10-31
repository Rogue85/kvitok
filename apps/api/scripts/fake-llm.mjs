// A fake OpenAI-compatible server for local development without a model key.
// Answers by simple rules: reads the first playbook, picks a department by keywords,
// extracts the receipt number from the text, writes a polite draft. Reads the sections of the agent prompt
// ("## Task"); customer texts may be in English or Russian. Not for production.
//
//   node apps/api/scripts/fake-llm.mjs            # http://localhost:3999/v1
//   PORT=4000 node apps/api/scripts/fake-llm.mjs
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 3999);
let counter = 0;

function call(name, args) {
  counter += 1;
  return { id: `call_${counter}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function pickDepartment(text, keys) {
  const rules = [
    [/балл|кешб|кэшб|купон|акци|point|cashback|coupon|promo/i, ['loyalty']],
    [/приложени|войти|вход|код|смс|push|\bapp\b|log ?in|sms|code/i, ['app']],
    [/кофейн|бариста|заказ|обслуж|coffee shop|barista|order|service/i, ['stores']],
    [/принтер|ноутбук|доступ|vpn|пароль|printer|laptop|access|password/i, ['it']],
  ];
  for (const [re, candidates] of rules) {
    const key = candidates.find((c) => keys.includes(c));
    if (key && re.test(text)) return key;
  }
  return null;
}

function respond(body) {
  const messages = body.messages ?? [];
  const tools = (body.tools ?? []).map((t) => t.function);
  const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  const usedTools = messages.filter((m) => m.role === 'tool').length;

  const read = tools.find((t) => t.name === 'read_playbook');
  if (read && usedTools === 0) {
    const key = read.parameters?.properties?.key?.enum?.[0];
    if (key) return { tool_calls: [call('read_playbook', { key })] };
  }

  const submit = tools.find((t) => t.name === 'submit_result');
  const departmentKeys = (submit?.parameters?.properties?.department?.enum ?? []).filter(Boolean);
  const fieldKeys = Object.keys(submit?.parameters?.properties?.fields?.properties ?? {});
  const conversation = user.split('## Task')[0];
  const department = pickDepartment(conversation, departmentKeys);
  const receipt = /(?:чек[ауе]?|receipt)\s*(?:№|номер|#|no\.?)?\s*(\d{3,})/i.exec(conversation)?.[1];
  const sum = /(\d{2,6})\s*(?:₽|руб|rub)/i.exec(conversation)?.[1];
  const fields = {};
  if (receipt && fieldKeys.includes('receipt_number')) fields.receipt_number = { value: receipt, confidence: 0.93, evidence: `receipt ${receipt}` };
  if (sum && fieldKeys.includes('receipt_total')) fields.receipt_total = { value: Number(sum), confidence: 0.9, evidence: `${sum} ₽` };
  const note = /<operator_message[^>]*>\n([\s\S]*?)\n<\/operator_message>/.exec(user.split('## Task')[1] ?? '')?.[1];
  const partial = JSON.stringify(submit?.parameters?.required ?? []) === '["message_to_operator"]';

  const result = {
    department,
    confidence: department ? 0.86 : 0.35,
    routing_reason: department ? `keywords in the request point to "${department}"` : 'could not determine the topic',
    alternative_department: null,
    summary: `The customer wrote: ${conversation.match(/<customer_message[^>]*>\n([\s\S]*?)\n<\/customer_message>/)?.[1]?.slice(0, 160) ?? 'unclear'}`,
    findings: [receipt ? `The request names receipt ${receipt}` : 'The request names no receipt number', ...(note ? [`Operator clarification: ${note.slice(0, 120)}`] : [])],
    fields,
    reply_body: receipt
      ? `Hello!\n\nThank you for reaching out. We will check the purchase on receipt ${receipt} and get back to you.`
      : 'Hello!\n\nThank you for reaching out. Could you tell us the receipt number and the date of purchase? That will help us sort it out faster.',
    needs_human: false,
    questions_for_operator: receipt ? [] : ['Does the guest have a loyalty card in the app?'],
    playbooks_used: usedTools > 0 ? [read?.parameters?.properties?.key?.enum?.[0]].filter(Boolean) : [],
  };
  if (note) result.message_to_operator = `Got it: "${note.slice(0, 80)}". Took it into account and updated the reply to the customer.`;
  // A partial run: a reply to the operator, findings and the draft — the rest stays as it was.
  const payload = partial ? { message_to_operator: result.message_to_operator, findings: result.findings, reply_body: result.reply_body } : result;
  if (!submit) {
    return { content: JSON.stringify(payload) };
  }
  return { tool_calls: [call('submit_result', payload)] };
}

createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const message = respond(body);
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: `fake-${Date.now()}`,
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls }, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: Math.round(raw.length / 4), completion_tokens: 120 },
        }),
      );
    }, 600);
  });
}).listen(port, () => console.log(`fake LLM on http://localhost:${port}/v1`));
