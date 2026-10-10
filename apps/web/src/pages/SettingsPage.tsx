import { useEffect, useState, type FormEvent } from "react";
import { api, errorText } from "../api";
import { useI18n, type Lang, type Theme } from "../i18n";

interface Settings {
  providerId: string | null;
  modelId: string | null;
  hasApiKey: boolean;
  autoApproveEdits: boolean;
  language: Lang;
  theme: Theme;
  providerConfigured: boolean;
}
interface CatalogModel {
  id: string;
  name: string;
  reportedFree: boolean;
}
interface Provider {
  id: string;
  name: string;
  envVars: string[];
  models: CatalogModel[];
}
interface GithubStatus {
  configured: boolean;
  connected: boolean;
  login: string | null;
  scopes: string[];
  note: string;
}
interface Repo {
  fullName: string;
  private: boolean;
  defaultBranch?: string;
}

export function SettingsPage() {
  const { t, setLang, setTheme } = useI18n();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [gh, setGh] = useState<GithubStatus | null>(null);
  const [repos, setRepos] = useState<Repo[] | null>(null);

  useEffect(() => {
    api<{ settings: Settings }>("GET", "/api/settings")
      .then((res) => {
        setSettings(res.settings);
        setProviderId(res.settings.providerId ?? "");
        setModelId(res.settings.modelId ?? "");
        setAutoApprove(res.settings.autoApproveEdits);
      })
      .catch((err) => setError(errorText(err)));
    api<{ providers: Provider[] }>("GET", "/api/providers")
      .then((res) => setProviders(res.providers))
      .catch((err) => setCatalogError(errorText(err)));
    api<GithubStatus>("GET", "/api/github/status")
      .then(setGh)
      .catch(() => setGh(null));
  }, []);

  const models = providers.find((p) => p.id === providerId)?.models ?? [];

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const res = await api<{ settings: Settings }>("PUT", "/api/settings", {
        providerId,
        modelId,
        apiKey: apiKey || undefined,
        clearApiKey: clearKey,
        autoApproveEdits: autoApprove,
        language: settings?.language ?? "en",
        theme: settings?.theme ?? "midnight",
      });
      setSettings(res.settings);
      setApiKey("");
      setClearKey(false);
      setMessage(t("saved"));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const savePreferences = async (language: Lang, theme: Theme) => {
    setLang(language);
    setTheme(theme);
    if (!settings?.providerId || !settings.modelId) return; // server copy needs a configured provider
    try {
      const res = await api<{ settings: Settings }>("PUT", "/api/settings", {
        providerId: settings.providerId ?? "",
        modelId: settings.modelId ?? "",
        clearApiKey: false,
        autoApproveEdits: settings.autoApproveEdits,
        language,
        theme,
      });
      setSettings(res.settings);
    } catch {
      /* preferences still apply locally; the server copy is best-effort */
    }
  };

  const test = async () => {
    setTestResult(null);
    try {
      const res = await api<{ ok: boolean; message: string; keyRecognized: boolean; modelFound: boolean }>("POST", "/api/providers/test");
      setTestResult(`${res.ok ? "OK" : "Not ready"} — ${res.message} (key ${res.keyRecognized ? "recognised" : "not recognised"}, model ${res.modelFound ? "found" : "not found"})`);
    } catch (err) {
      setTestResult(errorText(err));
    }
  };

  const loadRepos = async () => {
    try {
      const res = await api<{ repos: Repo[] }>("GET", "/api/github/repos");
      setRepos(res.repos);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const disconnect = async () => {
    await api("DELETE", "/api/github/connection");
    setGh(await api<GithubStatus>("GET", "/api/github/status"));
    setRepos(null);
  };

  return (
    <div className="stack-lg">
      <section className="card" aria-labelledby="prov-title">
        <h1 id="prov-title">{t("providerSettings")}</h1>
        {catalogError && (
          <p className="error" role="alert">
            {catalogError}
          </p>
        )}
        <form onSubmit={save} className="stack">
          <div className="grid-2">
            <label>
              {t("provider")}
              <select
                value={providerId}
                onChange={(e) => {
                  setProviderId(e.target.value);
                  setModelId("");
                }}
              >
                <option value="">—</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.id})
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("model")}
              <select value={modelId} onChange={(e) => setModelId(e.target.value)} disabled={!providerId}>
                <option value="">—</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.id}
                    {m.reportedFree ? ` (${t("reportedFree")})` : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted small">{t("catalogNotice")}</p>
          <label>
            {t("apiKey")}
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={settings?.hasApiKey ? "••••••••" : ""}
              maxLength={500}
            />
          </label>
          {settings?.hasApiKey && <p className="muted small">{t("keyStored")}</p>}
          {settings?.hasApiKey && (
            <label className="row">
              <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />
              {t("clearKey")}
            </label>
          )}
          <label className="row">
            <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
            {t("autoApprove")}
          </label>
          <div className="row">
            <button className="primary" type="submit" disabled={!providerId || !modelId}>
              {t("save")}
            </button>
            <button type="button" onClick={test} disabled={!settings?.providerConfigured}>
              {t("testProvider")}
            </button>
          </div>
          {message && <p role="status">{message}</p>}
          {testResult && <p className="small" role="status">{testResult}</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </form>
      </section>

      <section className="card" aria-labelledby="pref-title">
        <h2 id="pref-title">{t("language")} / {t("theme")}</h2>
        <div className="row">
          <button onClick={() => savePreferences("en", settings?.theme ?? "midnight")} aria-pressed={settings?.language !== "ar"}>
            English
          </button>
          <button onClick={() => savePreferences("ar", settings?.theme ?? "midnight")} aria-pressed={settings?.language === "ar"}>
            العربية
          </button>
          <button onClick={() => savePreferences(settings?.language ?? "en", "midnight")}>{t("darkTheme")}</button>
          <button onClick={() => savePreferences(settings?.language ?? "en", "light")}>{t("lightTheme")}</button>
        </div>
      </section>

      <section className="card" aria-labelledby="gh-title">
        <h2 id="gh-title">{t("githubConnection")}</h2>
        {gh && <p className="muted small">{gh.note}</p>}
        {gh?.connected ? (
          <div className="stack">
            <p>
              @{gh.login} · {gh.scopes.join(", ") || "—"}
            </p>
            <div className="row">
              <button onClick={loadRepos}>{t("repositories")}</button>
              <button className="danger" onClick={disconnect}>
                {t("disconnect")}
              </button>
            </div>
            {repos && (
              <ul className="repo-list">
                {repos.map((r) => (
                  <li key={r.fullName}>
                    <span>{r.fullName}</span>
                    {r.private && <span className="badge">private</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : gh?.configured ? (
          <a className="button-like primary" href="/api/github/oauth/start">
            {t("connectGithub")}
          </a>
        ) : (
          <p className="muted">{t("notConnected")}</p>
        )}
      </section>
    </div>
  );
}
