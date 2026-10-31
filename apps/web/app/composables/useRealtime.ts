import type { RealtimeEvent } from '@kvitok/shared';

/**
 * Subscription to the workspace SSE stream. EventSource reconnects by itself;
 * the handler is called for every event, and the subscription is dropped when the page is left.
 */
export function useRealtime(handler: (event: RealtimeEvent) => void): void {
  const { workspaceId } = useWorkspace();
  let source: EventSource | null = null;
  const types: RealtimeEvent['type'][] = ['ticket.created', 'ticket.updated', 'message.created', 'delivery.updated'];

  const connect = () => {
    source?.close();
    if (!workspaceId.value) return;
    source = new EventSource(`/api/workspaces/${workspaceId.value}/events`, { withCredentials: true });
    for (const type of types) {
      source.addEventListener(type, (message) => {
        try {
          handler(JSON.parse((message as MessageEvent<string>).data) as RealtimeEvent);
        } catch {
          // skip a malformed event
        }
      });
    }
  };

  onMounted(connect);
  watch(workspaceId, connect);
  onBeforeUnmount(() => source?.close());
}

/** At most once per `ms`: several events in a row → one refresh. */
export function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: T) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
