import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, errorText } from "../api";
import { useI18n } from "../i18n";
import { useProjectEvents } from "../events";
import { FilesEditor } from "../panels/FilesEditor";
import { AgentPanel } from "../panels/AgentPanel";
import { TerminalPanel } from "../panels/TerminalPanel";
import { ChangesPanel } from "../panels/ChangesPanel";
import { GithubPanel } from "../panels/GithubPanel";
import type { ProjectSummary } from "./ProjectsPage";

interface ProjectDetail {
  project: ProjectSummary;
  git: unknown;
  engine: { displayName: string; running: boolean };
  sandbox: { mode: string };
}

type Tab = "agent" | "terminal" | "changes" | "github";

export function ProjectPage() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("agent");
  const [openFile, setOpenFile] = useState<string | null>(null);
  const { tick, connected } = useProjectEvents(id);

  const load = useCallback(async () => {
    try {
      setDetail(await api<ProjectDetail>("GET", `/api/projects/${encodeURIComponent(id)}`));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "agent", label: t("agent") },
    { id: "terminal", label: t("terminal") },
    { id: "changes", label: t("changes") },
    { id: "github", label: t("github") },
  ];

  if (error) {
    return (
      <div className="card">
        <p role="alert" className="error">
          {error}
        </p>
        <Link to="/">{t("projects")}</Link>
      </div>
    );
  }
  if (!detail) return <p className="muted">{t("loading")}</p>;

  const project = detail.project;
  return (
    <div className="workspace">
      <header className="workspace-head">
        <div>
          <Link to="/" className="small muted">
            ← {t("projects")}
          </Link>
          <h1>{project.name}</h1>
          <p className="muted small">
            <span className={`dot ${detail.engine.running ? "ok" : ""}`} aria-hidden="true" />{" "}
            {detail.engine.running ? t("engineRunning") : t("engineStopped")} · {connected ? "live" : "reconnecting…"} · sandbox: {detail.sandbox.mode}
          </p>
        </div>
      </header>
      <div className="workspace-body">
        <section className="pane editor-pane" aria-label={t("files")}>
          <FilesEditor projectId={id} tick={tick} openFile={openFile} onOpen={setOpenFile} />
        </section>
        <section className="pane side-pane" aria-label={t("agent")}>
          <div className="tabs" role="tablist">
            {tabs.map((tb) => (
              <button
                key={tb.id}
                role="tab"
                aria-selected={tab === tb.id}
                className={tab === tb.id ? "tab active" : "tab"}
                onClick={() => setTab(tb.id)}
              >
                {tb.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" className="tabpanel">
            {tab === "agent" && <AgentPanel projectId={id} tick={tick} />}
            {tab === "terminal" && <TerminalPanel projectId={id} tick={tick} />}
            {tab === "changes" && <ChangesPanel projectId={id} tick={tick} />}
            {tab === "github" && <GithubPanel project={project} tick={tick} onChanged={load} />}
          </div>
        </section>
      </div>
    </div>
  );
}
