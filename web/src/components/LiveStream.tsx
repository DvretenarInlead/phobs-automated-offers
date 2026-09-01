import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

/**
 * Shared EventSource lifecycle for the live pages. Distinguishes a transient
 * reconnect (browser will retry) from a permanent close (browser gives up on
 * non-200, e.g. 401 after idle timeout or 429 too many streams) and offers a
 * manual reconnect for the latter.
 */
export type StreamStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export function useLiveStream<T>(url: string, cap: number): {
  events: T[];
  status: StreamStatus;
  clear: () => void;
  reconnect: () => void;
} {
  const [events, setEvents] = useState<T[]>([]);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [gen, setGen] = useState(0);

  useEffect(() => {
    setEvents([]);
    setStatus('connecting');
    const es = new EventSource(url, { withCredentials: true });
    es.onopen = () => setStatus('connected');
    es.onerror = () => {
      setStatus(es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    };
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data as string) as T;
        setEvents((prev) => [parsed, ...prev].slice(0, cap));
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => es.close();
  }, [url, cap, gen]);

  return {
    events,
    status,
    clear: () => setEvents([]),
    reconnect: () => setGen((g) => g + 1),
  };
}

export function StreamStatusBadge({
  status,
  onReconnect,
}: {
  status: StreamStatus;
  onReconnect: () => void;
}): ReactElement {
  switch (status) {
    case 'connected':
      return <span className="text-emerald-400">● Connected</span>;
    case 'connecting':
      return <span className="text-slate-400">● Connecting…</span>;
    case 'reconnecting':
      return <span className="text-amber-400">● Reconnecting…</span>;
    case 'closed':
      return (
        <span className="text-rose-400">
          ● Disconnected — session expired or too many streams open.{' '}
          <button
            type="button"
            className="underline hover:text-rose-300"
            onClick={onReconnect}
          >
            Reconnect
          </button>
        </span>
      );
  }
}
