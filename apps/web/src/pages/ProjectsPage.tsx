import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import { api, errorText } from "../api";
import { useI18n } from "../i18n";

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  kind: string;
  status: string;
  githubRepo: string | null;
  githubBranch: string | null;
  updatedAt: string;
}

const KIND_LABELS: Record<string, string> = {
  blank: "Blank",
  web: "Static web",
  node: "Node.js",
  "godot-2d-arena": "Godot 4 · 2D arena",
};

export function ProjectsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("blank");
  const [description, setDescription] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<{ projects: ProjectSummary[] }>("GET", "/api/projects");
    setProjects(res.projects);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(errorText(err)));
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ project: ProjectSummary }>("POST", "/api/projects", { name, kind, description });
      navigate(`/projects/${res.project.id}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const importRepo = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ project: ProjectSummary }>("POST", "/api/projects/import-github", { repoUrl });
      navigate(`/projects/${res.project.id}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: ProjectSummary) => {
    const typed = window.prompt(`${t("deleteConfirm")}\n\n${p.name}`);
    if (typed !== p.name) return;
    try {
      await api("DELETE", `/api/projects/${p.id}`, { confirm: typed });
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="grid-2">
      <section className="card" aria-labelledby="new-title">
        <h2 id="new-title">{t("newProject")}</h2>
        <form onSubmit={create} className="stack">
          <label>
            {t("projectName")}
            <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            {t("projectKind")}
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {["blank", "web", "node", "godot-2d-arena"].map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("description")}
            <textarea rows={3} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <button className="primary" disabled={busy} type="submit">
            {t("create")}
          </button>
        </form>
        <h3>{t("importGithub")}</h3>
        <form onSubmit={importRepo} className="stack">
          <label>
            {t("repoUrl")}
            <input type="url" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/owner/repo" />
          </label>
          <button disabled={busy || !repoUrl} type="submit">
            {t("import")}
          </button>
        </form>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </section>
      <section className="card" aria-labelledby="list-title">
        <h2 id="list-title">{t("projects")}</h2>
        {projects === null && <p className="muted">{t("loading")}</p>}
        {projects?.length === 0 && <p className="muted">{t("noProjects")}</p>}
        <ul className="project-list">
          {projects?.map((p) => (
            <li key={p.id} className="project-item">
              <div className="grow">
                <Link to={`/projects/${p.id}`} className="strong">
                  {p.name}
                </Link>
                <div className="muted small">
                  {KIND_LABELS[p.kind] ?? p.kind}
                  {p.githubRepo ? ` · ${p.githubRepo}` : ""} · {new Date(p.updatedAt).toLocaleString()}
                </div>
              </div>
              <div className="row">
                <Link className="button-like" to={`/projects/${p.id}`}>
                  {t("open")}
                </Link>
                <button className="danger small" onClick={() => remove(p)}>
                  {t("delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
