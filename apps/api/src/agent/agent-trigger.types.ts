export type AgentTriggerType =
  | 'ticket_created'
  | 'customer_message'
  | 'operator_message'
  | 'question_answer'
  | 'manual'
  | 'stale_rerun'
  /** An operator linked the customer in an external system. */
  | 'customer_linked';

export interface AgentTrigger {
  type: AgentTriggerType;
  messageId?: string;
  userId?: string;
}

/** Triggers accumulated for a ticket while the agent is busy or waiting for debounce. */
export interface AgentPending {
  mode: 'triage' | 'refine';
  triggers: AgentTrigger[];
}

export const AUTOMATIC_TRIGGERS: AgentTriggerType[] = ['ticket_created', 'customer_message'];
/** An operator wrote to the agent: the agent replies in the chat and updates only what is affected. */
export const CHAT_TRIGGERS: AgentTriggerType[] = ['operator_message', 'question_answer'];
