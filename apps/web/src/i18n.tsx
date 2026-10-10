import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Lang = "en" | "ar";
export type Theme = "midnight" | "light";

const en = {
  appName: "NEXUS",
  tagline: "Describe a project. An agent builds, runs and repairs it in an isolated workspace.",
  signIn: "Sign in",
  register: "Create account",
  email: "Email",
  password: "Password",
  displayName: "Display name",
  noAccount: "New here? Create an account",
  haveAccount: "Already have an account? Sign in",
  logout: "Sign out",
  projects: "Projects",
  settings: "Settings",
  newProject: "New project",
  projectName: "Project name",
  projectKind: "Template",
  description: "Description",
  create: "Create",
  open: "Open",
  delete: "Delete",
  deleteConfirm: "Type the project name to delete it permanently.",
  cancel: "Cancel",
  save: "Save",
  saved: "Saved",
  unsaved: "Unsaved changes",
  confirmDiscard: "Discard them and open the other file?",
  loading: "Loading…",
  noProjects: "No projects yet. Create one or import a GitHub repository.",
  importGithub: "Import from GitHub",
  repoUrl: "Repository URL (https://github.com/owner/repo)",
  import: "Import",
  files: "Files",
  editor: "Editor",
  selectFile: "Select a file to edit it.",
  agent: "Agent",
  terminal: "Terminal",
  changes: "Changes",
  github: "GitHub",
  artifacts: "Export",
  send: "Send",
  message: "Message to the agent",
  mode: "Mode",
  build: "Build (may edit files)",
  plan: "Plan (read-only advice)",
  cancelAgent: "Stop agent",
  newConversation: "New conversation",
  engineRunning: "Engine running",
  engineStopped: "Engine stopped",
  notConfigured: "No model configured yet. Open Settings to add a provider and key.",
  approvals: "Approvals",
  approve: "Approve",
  deny: "Deny",
  noApprovals: "Nothing waiting for approval.",
  command: "Command",
  network: "Allow network (needs approval)",
  run: "Run",
  jobs: "Jobs",
  emergencyStop: "Emergency stop",
  noJobs: "No commands yet.",
  output: "Output",
  status: "Status",
  policy: "Policy",
  diff: "Diff",
  noChanges: "No changes since the last checkpoint.",
  checkpoint: "Commit checkpoint",
  commitMessage: "Commit message",
  exportZip: "Export ZIP",
  download: "Download",
  noArtifacts: "No exports yet.",
  pushBranch: "Push to a new branch",
  pushHint: "Creates a new branch on GitHub. It never pushes to the default branch.",
  confirmPublish: "I reviewed the changes and want to publish them to GitHub.",
  branchName: "Branch name (optional)",
  prTitle: "Pull request title",
  prBody: "Pull request description",
  openPr: "Open pull request",
  notConnected: "GitHub is not connected. Connect it in Settings.",
  notGithubProject: "This project was not imported from GitHub.",
  detect: "Detect project",
  providerSettings: "Model provider",
  provider: "Provider",
  model: "Model",
  apiKey: "API key (write-only, stored encrypted)",
  keyStored: "A key is stored. Enter a new one to replace it.",
  clearKey: "Remove stored key",
  autoApprove: "Auto-approve file edits (commands still need approval)",
  language: "Language",
  theme: "Theme",
  testProvider: "Test configuration",
  reportedFree: "reported free",
  catalogNotice: "Costs and free status come from the engine's catalog. Verify the provider's current terms and quotas.",
  githubConnection: "GitHub connection",
  connectGithub: "Connect GitHub",
  disconnect: "Disconnect",
  repositories: "Your repositories",
  error: "Something went wrong",
  quota: "Quota today",
  emptyOutput: "No output yet.",
  confirmEmergency: "Stop all running commands and the agent engine for this project?",
  confirmDelete: "Delete this project and its workspace?",
  darkTheme: "Midnight",
  lightTheme: "Light",
  yes: "Yes",
  no: "No",
};

type Dict = typeof en;
const ar: Dict = {
  appName: "نيكسوس",
  tagline: "صف مشروعك، وسيبنيه الوكيل ويشغّله ويصلحه داخل مساحة عمل معزولة.",
  signIn: "تسجيل الدخول",
  register: "إنشاء حساب",
  email: "البريد الإلكتروني",
  password: "كلمة المرور",
  displayName: "الاسم المعروض",
  noAccount: "جديد هنا؟ أنشئ حسابًا",
  haveAccount: "لديك حساب؟ سجّل الدخول",
  logout: "تسجيل الخروج",
  projects: "المشاريع",
  settings: "الإعدادات",
  newProject: "مشروع جديد",
  projectName: "اسم المشروع",
  projectKind: "القالب",
  description: "الوصف",
  create: "إنشاء",
  open: "فتح",
  delete: "حذف",
  deleteConfirm: "اكتب اسم المشروع لحذفه نهائيًا.",
  cancel: "إلغاء",
  save: "حفظ",
  saved: "تم الحفظ",
  unsaved: "تغييرات غير محفوظة",
  confirmDiscard: "هل تريد تجاهلها وفتح الملف الآخر؟",
  loading: "جارٍ التحميل…",
  noProjects: "لا توجد مشاريع بعد. أنشئ مشروعًا أو استورد مستودع GitHub.",
  importGithub: "استيراد من GitHub",
  repoUrl: "رابط المستودع (https://github.com/owner/repo)",
  import: "استيراد",
  files: "الملفات",
  editor: "المحرر",
  selectFile: "اختر ملفًا للتحرير.",
  agent: "الوكيل",
  terminal: "الطرفية",
  changes: "التغييرات",
  github: "GitHub",
  artifacts: "التصدير",
  send: "إرسال",
  message: "رسالة إلى الوكيل",
  mode: "الوضع",
  build: "بناء (قد يعدّل الملفات)",
  plan: "تخطيط (للقراءة فقط)",
  cancelAgent: "إيقاف الوكيل",
  newConversation: "محادثة جديدة",
  engineRunning: "المحرك يعمل",
  engineStopped: "المحرك متوقف",
  notConfigured: "لم يُضبط نموذج بعد. افتح الإعدادات لإضافة مزوّد ومفتاح.",
  approvals: "الموافقات",
  approve: "موافقة",
  deny: "رفض",
  noApprovals: "لا يوجد ما ينتظر الموافقة.",
  command: "الأمر",
  network: "السماح بالشبكة (يتطلب موافقة)",
  run: "تشغيل",
  jobs: "المهام",
  emergencyStop: "إيقاف طارئ",
  noJobs: "لا توجد أوامر بعد.",
  output: "المخرجات",
  status: "الحالة",
  policy: "السياسة",
  diff: "الفرق",
  noChanges: "لا توجد تغييرات منذ آخر نقطة حفظ.",
  checkpoint: "حفظ نقطة (commit)",
  commitMessage: "رسالة الحفظ",
  exportZip: "تصدير ZIP",
  download: "تنزيل",
  noArtifacts: "لا توجد صادرات بعد.",
  pushBranch: "الدفع إلى فرع جديد",
  pushHint: "ينشئ فرعًا جديدًا على GitHub، ولا يدفع أبدًا إلى الفرع الافتراضي.",
  confirmPublish: "راجعت التغييرات وأريد نشرها على GitHub.",
  branchName: "اسم الفرع (اختياري)",
  prTitle: "عنوان طلب الدمج",
  prBody: "وصف طلب الدمج",
  openPr: "فتح طلب دمج",
  notConnected: "GitHub غير متصل. اتصل به من الإعدادات.",
  notGithubProject: "لم يُستورد هذا المشروع من GitHub.",
  detect: "اكتشاف المشروع",
  providerSettings: "مزوّد النموذج",
  provider: "المزوّد",
  model: "النموذج",
  apiKey: "مفتاح API (للكتابة فقط، يُخزَّن مشفرًا)",
  keyStored: "يوجد مفتاح محفوظ. أدخل مفتاحًا جديدًا للاستبدال.",
  clearKey: "إزالة المفتاح المحفوظ",
  autoApprove: "الموافقة التلقائية على تعديلات الملفات (الأوامر تحتاج موافقة)",
  language: "اللغة",
  theme: "المظهر",
  testProvider: "اختبار الإعداد",
  reportedFree: "مُبلَّغ كمجاني",
  catalogNotice: "التكاليف وحالة المجانية تأتي من فهرس المحرك. تحقّق من شروط المزوّد وحصصه الحالية.",
  githubConnection: "اتصال GitHub",
  connectGithub: "ربط GitHub",
  disconnect: "فصل الاتصال",
  repositories: "مستودعاتك",
  error: "حدث خطأ",
  quota: "الحصة اليوم",
  emptyOutput: "لا توجد مخرجات بعد.",
  confirmEmergency: "إيقاف كل الأوامر الجارية ومحرك الوكيل لهذا المشروع؟",
  confirmDelete: "حذف هذا المشروع ومساحة عمله؟",
  darkTheme: "ليلي",
  lightTheme: "فاتح",
  yes: "نعم",
  no: "لا",
};

export type TKey = keyof Dict;
const dictionaries: Record<Lang, Dict> = { en, ar };

interface I18nValue {
  lang: Lang;
  theme: Theme;
  setLang: (l: Lang) => void;
  setTheme: (t: Theme) => void;
  t: (key: TKey) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function initialLang(): Lang {
  const saved = localStorage.getItem("nexus.lang");
  return saved === "ar" ? "ar" : "en";
}

function initialTheme(): Theme {
  return localStorage.getItem("nexus.theme") === "light" ? "light" : "midnight";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const [theme, setThemeState] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    localStorage.setItem("nexus.lang", lang);
  }, [lang]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("nexus.theme", theme);
  }, [theme]);

  const setLang = useCallback((l: Lang) => setLangState(l), []);
  const setTheme = useCallback((t: Theme) => setThemeState(t), []);
  const t = useCallback((key: TKey) => dictionaries[lang][key] ?? en[key], [lang]);

  const value = useMemo(() => ({ lang, theme, setLang, setTheme, t }), [lang, theme, setLang, setTheme, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) throw new Error("useI18n must be used inside I18nProvider");
  return v;
}
