import { useEffect, useRef, useState } from "react";

/** Every event type the API persists for a project. Clients refetch state on these (never trust a stream as the source of truth). */
export const PROJECT_EVENT_TYPES = [
  "agent.engine",
  "agent.error",
  "agent.file_edited",
  "agent.message",
  "agent.patch",
  "agent.status",
  "agent.text",
  "agent.todos",
  "agent.tool",
  "agent.user_message",
  "approval.decided",
  "approval.requested",
  "artifact.created",
  "file.changed",
  "git.committed",
  "git.pull_request",
  "git.pushed",
  "job.updated",
  "system.emergency_stop",
  "system.error",
] as const;

/**
 * Subscribes to a project's SSE stream and returns a counter that changes on every event.
 * The browser reconnects automatically and resends Last-Event-ID, so the API replays what was missed.
 */
export function useProjectEvents(projectId: string | undefined): { tick: number; connected: boolean; lastType: string | null } {
  const [tick, setTick] = useState(0);
  const [connected, setConnected] = useState(false);
  const [lastType, setLastType] = useState<string | null>(null);
  const scheduled = useRef<number | null>(null);

  useEffect(() => {
    if (!projectId) return;
    const es = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events`, { withCredentials: true });
    const bump = (type: string) => {
      setLastType(type);
      // Coalesce bursts of events into one refresh.
      if (scheduled.current !== null) return;
      scheduled.current = window.setTimeout(() => {
        scheduled.current = null;
        setTick((n) => n + 1);
      }, 120);
    };
    const onOpen = () => setConnected(true);
    const onError = () => setConnected(false);
    es.addEventListener("open", onOpen);
    es.addEventListener("error", onError);
    const handlers = PROJECT_EVENT_TYPES.map((type) => {
      const h = () => bump(type);
      es.addEventListener(type, h);
      return [type, h] as const;
    });
    return () => {
      if (scheduled.current !== null) window.clearTimeout(scheduled.current);
      scheduled.current = null;
      for (const [type, h] of handlers) es.removeEventListener(type, h);
      es.removeEventListener("open", onOpen);
      es.removeEventListener("error", onError);
      es.close();
    };
  }, [projectId]);

  return { tick, connected, lastType };
}
