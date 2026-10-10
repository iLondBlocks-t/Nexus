import { useState, type FormEvent } from "react";
import { api, errorText } from "../api";
import { useAuth, type User } from "../app";
import { useI18n } from "../i18n";

export function AuthPage() {
  const { t } = useI18n();
  const { setSession } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body = mode === "login" ? { email, password } : { email, password, displayName };
      const res = await api<{ user: User; csrfToken: string }>("POST", path, body);
      setSession(res.user, res.csrfToken);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="auth card" aria-labelledby="auth-title">
      <h1 id="auth-title">{mode === "login" ? t("signIn") : t("register")}</h1>
      <p className="muted">{t("tagline")}</p>
      <form onSubmit={submit} className="stack">
        <label>
          {t("email")}
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode === "register" && (
          <label>
            {t("displayName")}
            <input required maxLength={80} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
        )}
        <label>
          {t("password")}
          <input
            type="password"
            required
            minLength={mode === "register" ? 10 : 1}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {mode === "login" ? t("signIn") : t("register")}
        </button>
      </form>
      <button className="link" onClick={() => setMode(mode === "login" ? "register" : "login")}>
        {mode === "login" ? t("noAccount") : t("haveAccount")}
      </button>
    </section>
  );
}
