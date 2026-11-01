import type { RealtimeEvent } from '@kvitok/shared';

/**
 * Subscription to the workspace SSE stream: events of the tickets the user may see. EventSource reconnects by itself;
 * the handler is called for every event, and the subscription is dropped when the page is left.
 * A change of the user's own access reloads it before the handler runs.
 */
export function useRealtime(handler: (event: RealtimeEvent) => void): void {
  const { workspaceId } = useWorkspace();
  const { fetchMe } = useAuth();
  let source: EventSource | null = null;
  const types: RealtimeEvent['type'][] = ['ticket.created', 'ticket.updated', 'ticket.moved', 'message.created', 'delivery.updated', 'access.changed'];

  const connect = () => {
    source?.close();
    if (!workspaceId.value) return;
    source = new EventSource(`/api/workspaces/${workspaceId.value}/events`, { withCredentials: true });
    for (const type of types) {
      source.addEventListener(type, async (message) => {
        let event: RealtimeEvent;
        try {
          event = JSON.parse((message as MessageEvent<string>).data) as RealtimeEvent;
        } catch {
          return; // skip a malformed event
        }
        if (event.type === 'access.changed') await fetchMe().catch(() => {});
        handler(event);
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
