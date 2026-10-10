import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, errorText } from "../api";
import { useI18n } from "../i18n";

interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  mode: string;
  content: string;
  status: string;
  error: string | null;
  createdAt: string;
}
interface AgentState {
  session: { id: string; status: string; lastError: string | null } | null;
  messages: AgentMessage[];
  engine: { displayName: string; running: boolean };
  quota: { agentMessagesToday: number; agentMessagesPerDay: number };
}
interface Approval {
  id: string;
  kind: string;
  title: string;
  detail: string;
  status: string;
  jobId: string | null;
}

export function AgentPanel({ projectId, tick }: { projectId: string; tick: number }) {
  const { t } = useI18n();
  const [state, setState] = useState<AgentState | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"build" | "plan">("build");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const base = `/api/projects/${encodeURIComponent(projectId)}`;

  const refresh = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([
        api<AgentState>("GET", `${base}/agent`),
        api<{ approvals: Approval[] }>("GET", `${base}/approvals`),
      ]);
      setState(s);
      setApprovals(a.approvals.filter((x) => x.status === "pending"));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [base]);

  useEffect(() => {
    void refresh();
  }, [refresh, tick]);

  useEffect(() => {
    api<{ settings: { providerConfigured: boolean } }>("GET", "/api/settings")
      .then((r) => setConfigured(r.settings.providerConfigured))
      .catch(() => setConfigured(null));
  }, []);

  // While the agent is busy, poll the persisted state (events alone can be missed across reconnects).
  const busy = state?.session?.status === "busy" || state?.session?.status === "retry";
  useEffect(() => {
    if (!busy) return;
    const h = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(h);
  }, [busy, refresh]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [state?.messages.length]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    setError(null);
    try {
      await api("POST", `${base}/agent/messages`, { text, mode });
      setText("");
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  };

  const decide = async (approval: Approval, decision: "approve" | "deny") => {
    try {
      await api("POST", `${base}/approvals/${encodeURIComponent(approval.id)}/decision`, { decision });
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="panel agent">
      {configured === false && (
        <p className="notice">
          {t("notConfigured")} <Link to="/settings">{t("settings")}</Link>
        </p>
      )}
      <div className="row small muted">
        <span className={`dot ${state?.engine.running ? "ok" : ""}`} aria-hidden="true" />
        <span>{state?.engine.running ? t("engineRunning") : t("engineStopped")}</span>
        <span className="grow" />
        <span>
          {t("quota")}: {state?.quota.agentMessagesToday ?? 0}/{state?.quota.agentMessagesPerDay ?? "—"}
        </span>
      </div>

      <div className="log" ref={logRef} aria-live="polite" aria-label={t("agent")}>
        {state?.messages.length === 0 && <p className="muted small">—</p>}
        {state?.messages.map((m) => (
          <article key={m.id} className={`msg ${m.role}`}>
            <div className="msg-meta small muted">
              {m.role === "user" ? "You" : "Agent"} · {m.mode} · {new Date(m.createdAt).toLocaleTimeString()}
              {m.status !== "complete" && <span className="badge">{m.status}</span>}
            </div>
            {m.content && <pre className="msg-body">{m.content}</pre>}
            {m.error && (
              <p className="error small" role="alert">
                {m.error}
              </p>
            )}
          </article>
        ))}
        {busy && <p className="muted small">Working…</p>}
      </div>

      {state?.session?.lastError && <p className="error small">{state.session.lastError}</p>}

      {approvals.length > 0 && (
        <section className="approvals" aria-label={t("approvals")}>
          <h3>{t("approvals")}</h3>
          {approvals.map((a) => (
            <div key={a.id} className="approval">
              <div>
                <strong>{a.title}</strong>
                <pre className="small">{a.detail}</pre>
              </div>
              <div className="row">
                <button className="primary small" onClick={() => decide(a, "approve")}>
                  {t("approve")}
                </button>
                <button className="danger small" onClick={() => decide(a, "deny")}>
                  {t("deny")}
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <form onSubmit={send} className="composer">
        <label className="sr-only" htmlFor="agent-text">
          {t("message")}
        </label>
        <textarea id="agent-text" rows={3} maxLength={20000} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("message")} />
        <div className="row">
          <label className="row small">
            {t("mode")}
            <select value={mode} onChange={(e) => setMode(e.target.value as "build" | "plan")}>
              <option value="build">{t("build")}</option>
              <option value="plan">{t("plan")}</option>
            </select>
          </label>
          <span className="grow" />
          {busy && (
            <button type="button" className="danger small" onClick={() => api("POST", `${base}/agent/cancel`).then(refresh)}>
              {t("cancelAgent")}
            </button>
          )}
          <button type="button" className="ghost small" onClick={() => api("POST", `${base}/agent/new-conversation`).then(refresh)} disabled={busy}>
            {t("newConversation")}
          </button>
          <button className="primary small" type="submit" disabled={sending || busy || !text.trim()}>
            {t("send")}
          </button>
        </div>
      </form>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
