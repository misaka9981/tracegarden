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
  membershipTitle: string;
  members: string;
  invitations: string;
  inviteEmail: string;
  createInvitation: string;
  revokeInvitation: string;
  revoked: string;
  accepted: string;
  pending: string;
  role: string;
  saveRole: string;
  membershipDenied: string;
  invitationCreated: string;
  invitationRevoked: string;
  roleChanged: string;
  invalidRequest: string;
  clusterTitle: string;
  clusterDescription: string;
  clusterNotConfigured: string;
  clusterName: string;
  clusterEndpoint: string;
  approvedNamespaces: string;
  approvedResourceKinds: string;
  supportedResourceKinds: string;
  saveCluster: string;
  clusterSaved: string;
  clusterConfigurationDenied: string;
  clusterConfigurationUnavailable: string;
  clusterConfigurationInvalid: string;
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
    membershipTitle: "成员管理",
    members: "成员",
    invitations: "Invitations",
    inviteEmail: "邮箱地址",
    createInvitation: "创建 Invitation",
    revokeInvitation: "撤销 Invitation",
    revoked: "已撤销",
    accepted: "已接受",
    pending: "待使用",
    role: "角色",
    saveRole: "保存角色",
    membershipDenied: "你没有管理成员和 Invitation 的权限。",
    invitationCreated: "Invitation 已创建。",
    invitationRevoked: "Invitation 已撤销。",
    roleChanged: "角色已更新。",
    invalidRequest: "请求无效。",
    clusterTitle: "Cluster 观测范围",
    clusterDescription: "Owner 可以配置一个 Cluster，并明确批准可观测的命名空间和资源类型。",
    clusterNotConfigured: "尚未配置 Cluster。",
    clusterName: "Cluster 名称",
    clusterEndpoint: "Kubernetes API 地址",
    approvedNamespaces: "批准的命名空间（每行一个）",
    approvedResourceKinds: "批准的资源类型",
    supportedResourceKinds: "支持：Deployment、StatefulSet、DaemonSet、ReplicaSet、Pod、Job、CronJob、Event",
    saveCluster: "保存 Cluster 范围",
    clusterSaved: "Cluster 观测范围已保存。",
    clusterConfigurationDenied: "你没有配置 Cluster 观测范围的 Capability。",
    clusterConfigurationUnavailable: "Cluster 配置存储当前不可用。",
    clusterConfigurationInvalid: "Cluster 配置无效，请检查输入。"
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
    membershipTitle: "Membership management",
    members: "Members",
    invitations: "Invitations",
    inviteEmail: "Email address",
    createInvitation: "Create Invitation",
    revokeInvitation: "Revoke Invitation",
    revoked: "Revoked",
    accepted: "Accepted",
    pending: "Pending",
    role: "Role",
    saveRole: "Save role",
    membershipDenied: "You do not have permission to manage Members and Invitations.",
    invitationCreated: "Invitation created.",
    invitationRevoked: "Invitation revoked.",
    roleChanged: "Role updated.",
    invalidRequest: "Invalid request.",
    clusterTitle: "Cluster observation scope",
    clusterDescription: "The owner can configure one Cluster and explicitly approve namespaces and resource kinds to observe.",
    clusterNotConfigured: "No Cluster is configured.",
    clusterName: "Cluster name",
    clusterEndpoint: "Kubernetes API endpoint",
    approvedNamespaces: "Approved namespaces (one per line)",
    approvedResourceKinds: "Approved resource kinds",
    supportedResourceKinds: "Supported: Deployment, StatefulSet, DaemonSet, ReplicaSet, Pod, Job, CronJob, Event",
    saveCluster: "Save Cluster scope",
    clusterSaved: "Cluster observation scope saved.",
    clusterConfigurationDenied: "You do not have the Capability to configure the Cluster observation scope.",
    clusterConfigurationUnavailable: "Cluster configuration storage is unavailable.",
    clusterConfigurationInvalid: "Cluster configuration is invalid. Check the inputs."
  },
};

export function parseLanguage(value: string | null | undefined): Language {
  return value === "en" ? "en" : "zh-CN";
}

export function messagesFor(value: string | null | undefined): Messages {
  return catalogs[parseLanguage(value)];
}
