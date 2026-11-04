import type { ActionProposalDto } from '@kvitok/shared';
import type { InjectionKey } from 'vue';

/** What the manual action form opens with: an action from the menu, an agent proposal to correct or a manual card to edit. */
export interface ActionFormPrefill {
  integrationId: string;
  action: string;
  params?: Record<string, unknown>;
  reason?: string;
  refreshDraft?: boolean;
  /** A pending manual card being edited: it is superseded by the new one. */
  replaces?: string;
}

/** The ticket page provides it: the chat input and the action cards open the form, the cards see the other actions. */
export interface ActionFormContext {
  open: (prefill: ActionFormPrefill) => void;
  actions: Ref<ActionProposalDto[]>;
}

const KEY: InjectionKey<ActionFormContext> = Symbol('action-form');

export function provideActionForm(context: ActionFormContext): void {
  provide(KEY, context);
}

export function useActionForm(): ActionFormContext | null {
  return inject(KEY, null);
}
