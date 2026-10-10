import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api, setCsrfToken } from "./api";
import { useI18n } from "./i18n";
import { AuthPage } from "./pages/AuthPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ProjectPage } from "./pages/ProjectPage";
import { SettingsPage } from "./pages/SettingsPage";

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "user";
}

interface AuthValue {
  user: User;
  setSession: (user: User | null, csrf: string | null) => void;
}

const AuthContext = createContext<AuthValue | null>(null);
export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth outside provider");
  return v;
}

export function App() {
  const { t, lang, setLang, theme, setTheme } = useI18n();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const navigate = useNavigate();

  const setSession = useCallback((u: User | null, csrf: string | null) => {
    setUser(u);
    setCsrfToken(csrf);
  }, []);

  useEffect(() => {
    api<{ user: User | null; csrfToken: string | null }>("GET", "/api/auth/me")
      .then((res) => setSession(res.user, res.csrfToken))
      .catch(() => setSession(null, null))
      .finally(() => setReady(true));
  }, [setSession]);

  const logout = async () => {
    try {
      await api("POST", "/api/auth/logout");
    } finally {
      setSession(null, null);
      navigate("/");
    }
  };

  if (!ready) return <div className="center muted">{t("loading")}</div>;

  return (
    <AuthContext.Provider value={user ? { user, setSession } : { user: { id: "", email: "", displayName: "", role: "user" }, setSession }}>
      <div className="shell" dir={lang === "ar" ? "rtl" : "ltr"}>
        <header className="topbar">
          <Link to="/" className="brand" aria-label={t("appName")}>
            <span className="logo" aria-hidden="true">N</span>
            <span>{t("appName")}</span>
          </Link>
          {user && (
            <nav className="nav" aria-label="Main">
              <Link to="/">{t("projects")}</Link>
              <Link to="/settings">{t("settings")}</Link>
            </nav>
          )}
          <div className="spacer" />
          <div className="toolbar">
            <button className="ghost small" onClick={() => setLang(lang === "en" ? "ar" : "en")} aria-label={t("language")}>
              {lang === "en" ? "العربية" : "English"}
            </button>
            <button
              className="ghost small"
              onClick={() => setTheme(theme === "midnight" ? "light" : "midnight")}
              aria-label={t("theme")}
            >
              {theme === "midnight" ? t("lightTheme") : t("darkTheme")}
            </button>
            {user && (
              <button className="ghost small" onClick={logout}>
                {t("logout")}
              </button>
            )}
          </div>
        </header>
        <main className="content">
          <Routes>
            <Route path="/" element={user ? <ProjectsPage /> : <AuthPage />} />
            <Route path="/projects/:id" element={user ? <ProjectPage /> : <Navigate to="/" replace />} />
            <Route path="/settings" element={user ? <SettingsPage /> : <Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </AuthContext.Provider>
  );
}
