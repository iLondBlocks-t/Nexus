import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, errorText } from "../api";
import { useI18n } from "../i18n";

interface Job {
  id: string;
  kind: string;
  status: string;
  command: string | null;
  network: boolean;
  policy: string;
  policyReason: string | null;
  exitCode: number | null;
  createdAt: string;
}
interface JobDetail {
  job: Job;
  output: Array<{ seq: number; stream: string; text: string }>;
}

const ACTIVE = new Set(["awaiting_approval", "queued", "running"]);

export function TerminalPanel({ projectId, tick }: { projectId: string; tick: number }) {
  const { t } = useI18n();
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [command, setCommand] = useState("");
  const [network, setNetwork] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ jobs: Job[] }>("GET", `${base}/jobs`);
      setJobs(res.jobs);
    } catch (err) {
      setError(errorText(err));
    }
  }, [base]);

  useEffect(() => {
    void refresh();
  }, [refresh, tick]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    api<JobDetail>("GET", `${base}/jobs/${encodeURIComponent(selected)}`)
      .then(setDetail)
      .catch((err) => setError(errorText(err)));
  }, [base, selected, tick]);

  const run = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<{ job: Job }>("POST", `${base}/commands`, { command, network });
      setSelected(res.job.id);
      setCommand("");
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const cancel = async (id: string) => {
    try {
      await api("POST", `${base}/jobs/${encodeURIComponent(id)}/cancel`);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const emergency = async () => {
    if (!window.confirm(t("confirmEmergency"))) return;
    try {
      await api("POST", `${base}/emergency-stop`);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="panel terminal">
      <form onSubmit={run} className="stack">
        <label>
          {t("command")}
          <input
            dir="ltr"
            className="mono"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            maxLength={2000}
            placeholder="npm test"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="row">
          <label className="row small">
            <input type="checkbox" checked={network} onChange={(e) => setNetwork(e.target.checked)} />
            {t("network")}
          </label>
          <span className="grow" />
          <button className="danger small" type="button" onClick={emergency}>
            {t("emergencyStop")}
          </button>
          <button className="primary small" type="submit" disabled={!command.trim()}>
            {t("run")}
          </button>
        </div>
      </form>

      <h3>{t("jobs")}</h3>
      {jobs.length === 0 && <p className="muted small">{t("noJobs")}</p>}
      <ul className="job-list">
        {jobs.map((j) => (
          <li key={j.id} className={selected === j.id ? "job selected" : "job"}>
            <button className="job-main" onClick={() => setSelected(j.id)} aria-pressed={selected === j.id}>
              <span dir="ltr" className="mono small">{j.command ?? j.kind}</span>
              <span className={`badge status-${j.status}`}>{j.status.replace("_", " ")}</span>
            </button>
            <div className="small muted">
              {t("policy")}: {j.policy}
              {j.policyReason ? ` — ${j.policyReason}` : ""}
              {j.exitCode !== null ? ` · exit ${j.exitCode}` : ""}
              {ACTIVE.has(j.status) && (
                <button className="link small" onClick={() => cancel(j.id)}>
                  {t("cancel")}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {detail && (
        <section aria-label={t("output")}>
          <h3>{t("output")}</h3>
          <pre className="output mono" dir="ltr">
            {detail.output.length === 0 ? t("emptyOutput") : detail.output.map((o) => (o.stream === "stderr" ? `\u001b[stderr] ${o.text}` : o.text)).join("")}
          </pre>
        </section>
      )}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
