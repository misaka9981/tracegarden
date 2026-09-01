export type Language = "zh-CN" | "en";

export type Messages = Readonly<{
  appName: string;
  statusTitle: string;
  statusDescription: string;
  webProcess: string;
  database: string;
  collectorProcess: string;
  ready: string;
  notReady: string;
  language: string;
  chinese: string;
  english: string;
  noConfiguration: string;
  loginTitle: string;
  loginDescription: string;
  localIdentity: string;
  signIn: string;
  googleSignIn: string;
  workspaceTitle: string;
  welcome: string;
  signedInAs: string;
  capabilities: string;
  signOut: string;
  rejectionTitle: string;
  rejectionDescription: string;
  admissionRequired: string;
}>;

export const catalogs: Readonly<Record<Language, Messages>> = {
  "zh-CN": {
    appName: "Tracegarden",
    statusTitle: "应用状态",
    statusDescription: "本地运行基础已就绪。配置值不会显示在此页面。",
    webProcess: "Web 进程",
    database: "PostgreSQL 数据库",
    collectorProcess: "Collector 进程",
    ready: "就绪",
    notReady: "未就绪",
    language: "语言",
    chinese: "简体中文",
    english: "English",
    noConfiguration: "配置值不会显示。",
    loginTitle: "登录 Tracegarden",
    loginDescription: "请先完成身份验证，然后由 Workspace admission 决定是否允许进入。",
    localIdentity: "本地测试身份",
    signIn: "登录",
    googleSignIn: "使用 Google 登录",
    workspaceTitle: "共享 Workspace",
    welcome: "欢迎回来",
    signedInAs: "当前身份",
    capabilities: "Capabilities",
    signOut: "退出登录",
    rejectionTitle: "无法进入 Workspace",
    rejectionDescription: "此身份已完成身份验证，但没有有效的 Workspace admission。请联系 owner 获取 Invitation。",
    admissionRequired: "需要有效的 Invitation 才能加入。",
  },
  en: {
    appName: "Tracegarden",
    statusTitle: "Application status",
    statusDescription: "The local runtime foundation is ready. Configuration values are never shown here.",
    webProcess: "Web process",
    database: "PostgreSQL database",
    collectorProcess: "Collector process",
    ready: "Ready",
    notReady: "Not ready",
    language: "Language",
    chinese: "简体中文",
    english: "English",
    noConfiguration: "Configuration values are never shown.",
    loginTitle: "Sign in to Tracegarden",
    loginDescription: "Authenticate first; Workspace admission then decides whether access is allowed.",
    localIdentity: "Local test identity",
    signIn: "Sign in",
    googleSignIn: "Sign in with Google",
    workspaceTitle: "Shared Workspace",
    welcome: "Welcome back",
    signedInAs: "Signed in as",
    capabilities: "Capabilities",
    signOut: "Sign out",
    rejectionTitle: "Workspace access denied",
    rejectionDescription: "This identity was authenticated but has no valid Workspace admission. Ask the owner for an Invitation.",
    admissionRequired: "A valid Invitation is required to join.",
  },
};

export function parseLanguage(value: string | null | undefined): Language {
  return value === "en" ? "en" : "zh-CN";
}

export function messagesFor(value: string | null | undefined): Messages {
  return catalogs[parseLanguage(value)];
}
