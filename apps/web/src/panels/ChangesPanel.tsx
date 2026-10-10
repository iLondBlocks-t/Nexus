import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, errorText } from "../api";
import { useI18n } from "../i18n";

interface FileChange {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
  truncated: boolean;
}
interface Artifact {
  id: string;
  kind: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  source: string;
  license: string | null;
}

export function ChangesPanel({ projectId, tick }: { projectId: string; tick: number }) {
  const { t } = useI18n();
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const [branch, setBranch] = useState<string | null>(null);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState("Checkpoint");
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([
        api<{ branch: string | null; changes: FileChange[] }>("GET", `${base}/changes`),
        api<{ artifacts: Artifact[] }>("GET", `${base}/artifacts`),
      ]);
      setBranch(c.branch);
      setChanges(c.changes);
      setArtifacts(a.artifacts);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [base]);

  useEffect(() => {
    void refresh();
  }, [refresh, tick]);

  const checkpoint = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<{ sha: string }>("POST", `${base}/checkpoint`, { message });
      setStatus(`${res.sha.slice(0, 7)}`);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const exportZip = async () => {
    setError(null);
    try {
      await api("POST", `${base}/artifacts/export`, {});
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="panel changes">
      <p className="small muted">
        {branch ? `branch: ${branch}` : ""} · {changes.length} file(s)
      </p>
      {changes.length === 0 && <p className="muted small">{t("noChanges")}</p>}
      <ul className="change-list">
        {changes.map((c) => (
          <li key={c.path}>
            <button className="change-row" onClick={() => setOpen(open === c.path ? null : c.path)} aria-expanded={open === c.path}>
              <span className="badge">{c.status}</span>
              <span dir="ltr" className="mono grow">{c.path}</span>
              <span className="add">+{c.additions}</span>
              <span className="del">−{c.deletions}</span>
            </button>
            {open === c.path && (
              <pre className="diff mono" dir="ltr" aria-label={`${t("diff")}: ${c.path}`}>
                {c.patch.split("\n").map((line, i) => (
                  <span key={i} className={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : ""}>
                    {line}
                    {"\n"}
                  </span>
                ))}
                {c.truncated && "\n… truncated"}
              </pre>
            )}
          </li>
        ))}
      </ul>
      {changes.length > 0 && (
        <form onSubmit={checkpoint} className="row">
          <label className="grow">
            <span className="sr-only">{t("commitMessage")}</span>
            <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={200} aria-label={t("commitMessage")} />
          </label>
          <button className="primary small" type="submit">
            {t("checkpoint")}
          </button>
        </form>
      )}
      {status && <p className="small" role="status">{status}</p>}

      <h3>{t("artifacts")}</h3>
      <button className="small" onClick={exportZip}>
        {t("exportZip")}
      </button>
      {artifacts.length === 0 && <p className="muted small">{t("noArtifacts")}</p>}
      <ul className="artifact-list">
        {artifacts.map((a) => (
          <li key={a.id}>
            <span dir="ltr">{a.name}</span> <span className="muted small">{Math.round(a.sizeBytes / 1024)} KB · sha256 {a.sha256.slice(0, 12)}…</span>{" "}
            <a className="button-like small" href={`${base}/artifacts/${encodeURIComponent(a.id)}/download`}>
              {t("download")}
            </a>
          </li>
        ))}
      </ul>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
