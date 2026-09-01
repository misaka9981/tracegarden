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
  },
};

export function parseLanguage(value: string | null | undefined): Language {
  return value === "en" ? "en" : "zh-CN";
}

export function messagesFor(value: string | null | undefined): Messages {
  return catalogs[parseLanguage(value)];
}
