import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, errorText } from "../api";
import { useI18n } from "../i18n";
import type { ProjectSummary } from "../pages/ProjectsPage";

interface Detection {
  languages: string[];
  frameworks: string[];
  packageManager: string | null;
  scripts: Record<string, string>;
  testCommand: string | null;
  buildCommand: string | null;
}

export function GithubPanel({ project, tick, onChanged }: { project: ProjectSummary; tick: number; onChanged: () => void }) {
  const { t } = useI18n();
  const base = `/api/projects/${encodeURIComponent(project.id)}`;
  const [connected, setConnected] = useState<boolean | null>(null);
  const [detection, setDetection] = useState<Detection | null>(null);
  const [message, setMessage] = useState("Update from NEXUS");
  const [branch, setBranch] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ connected: boolean }>("GET", "/api/github/status")
      .then((r) => setConnected(r.connected))
      .catch(() => setConnected(false));
    api<{ detection: Detection }>("GET", `${base}/detect`)
      .then((r) => setDetection(r.detection))
      .catch(() => setDetection(null));
  }, [base, tick]);

  const push = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<{ branch: string; sha: string }>("POST", `${base}/github/push`, {
        message,
        branch: branch || undefined,
        confirmPublish: true,
      });
      setResult(`${res.branch} @ ${res.sha.slice(0, 7)}`);
      setConfirmed(false);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const openPr = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<{ url: string; number: number }>("POST", `${base}/github/pull-request`, {
        title: prTitle,
        body: prBody,
        confirmPublish: true,
      });
      setResult(`#${res.number}: ${res.url}`);
      setConfirmed(false);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="panel github stack">
      {!project.githubRepo && <p className="muted">{t("notGithubProject")}</p>}
      {project.githubRepo && (
        <p className="small" dir="ltr">
          {project.githubRepo} {project.githubBranch ? `· ${project.githubBranch}` : ""}
        </p>
      )}
      {connected === false && (
        <p className="notice">
          {t("notConnected")} <Link to="/settings">{t("settings")}</Link>
        </p>
      )}

      <section aria-label={t("detect")}>
        <h3>{t("detect")}</h3>
        {detection ? (
          <ul className="small">
            <li>Languages: {detection.languages.join(", ") || "—"}</li>
            <li>Frameworks: {detection.frameworks.join(", ") || "—"}</li>
            <li>Package manager: {detection.packageManager ?? "—"}</li>
            <li dir="ltr" className="mono">Test: {detection.testCommand ?? "—"}</li>
            <li dir="ltr" className="mono">Build: {detection.buildCommand ?? "—"}</li>
          </ul>
        ) : (
          <p className="muted small">—</p>
        )}
      </section>

      {project.githubRepo && connected && (
        <>
          <form onSubmit={push} className="stack" aria-label={t("pushBranch")}>
            <h3>{t("pushBranch")}</h3>
            <p className="muted small">{t("pushHint")}</p>
            <label>
              {t("commitMessage")}
              <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={200} required />
            </label>
            <label>
              {t("branchName")}
              <input value={branch} onChange={(e) => setBranch(e.target.value)} maxLength={120} pattern="[A-Za-z0-9._/-]+" dir="ltr" />
            </label>
            <label className="row small">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              {t("confirmPublish")}
            </label>
            <button className="primary" type="submit" disabled={!confirmed}>
              {t("pushBranch")}
            </button>
          </form>
          <form onSubmit={openPr} className="stack" aria-label={t("openPr")}>
            <h3>{t("openPr")}</h3>
            <label>
              {t("prTitle")}
              <input value={prTitle} onChange={(e) => setPrTitle(e.target.value)} maxLength={200} required />
            </label>
            <label>
              {t("prBody")}
              <textarea value={prBody} onChange={(e) => setPrBody(e.target.value)} rows={3} maxLength={5000} />
            </label>
            <label className="row small">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              {t("confirmPublish")}
            </label>
            <button type="submit" disabled={!confirmed || !prTitle.trim()}>
              {t("openPr")}
            </button>
          </form>
        </>
      )}
      {result && <p className="small" role="status">{result}</p>}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
