import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Android shell for NEXUS. The app loads the deployed NEXUS server (NEXUS_APP_URL, https) so that
 * same-origin /api calls, cookies and CSRF checks work unchanged. Without NEXUS_APP_URL the shell
 * falls back to the bundled web build, which cannot reach the API and is only useful for layout checks.
 */
const appUrl = process.env.NEXUS_APP_URL?.trim();
if (appUrl && !/^https:\/\//.test(appUrl)) {
  throw new Error("NEXUS_APP_URL must be an https:// URL");
}

const config: CapacitorConfig = {
  appId: "app.nexus.builder",
  appName: "NEXUS",
  webDir: "dist",
  server: appUrl
    ? { url: appUrl, cleartext: false, androidScheme: "https" }
    : { androidScheme: "https" },
  android: { allowMixedContent: false },
};

export default config;
