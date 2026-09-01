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
  timelineTitle: string;
  timelineDescription: string;
  noTimelineEntries: string;
  podObservation: string;
  resourceIdentity: string;
  observedAt: string;
  timelineUnknownState: string;
  observationChange: string;
  attentionItem: string;
  recovery: string;
  attentionReason: string;
  attentionReasonLabels: Readonly<Record<string, string>>;
  ownership: string;
  revision: string;
  resourceKindDeployment: string;
  resourceKindStatefulSet: string;
  resourceKindDaemonSet: string;
  resourceKindReplicaSet: string;
  resourceKindPod: string;
  resourceKindJob: string;
  resourceKindCronJob: string;
  resourceKindEvent: string;
  recentLogsTitle: string;
  recentLogsDescription: string;
  logCluster: string;
  logNamespace: string;
  logPod: string;
  logContainer: string;
  logTail: string;
  requestLogs: string;
  logsReadDenied: string;
  recentLogsInvalid: string;
  recentLogsUnavailable: string;
  recentLogsEmpty: string;
  recentLogsMetadata: string;
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
    clusterConfigurationInvalid: "Cluster 配置无效，请检查输入。",
    timelineTitle: "Timeline",
    timelineDescription: "已提交的 Kubernetes Observation 会出现在这里。",
    noTimelineEntries: "暂无 Timeline Entry。",
    podObservation: "Pod 观测",
    resourceIdentity: "资源身份",
    observedAt: "观测时间",
    timelineUnknownState: "状态未知",
    observationChange: "变更",
    attentionItem: "待关注项",
    recovery: "恢复",
    attentionReason: "需要关注的原因",
    attentionReasonLabels: {
      condition_failed: "条件状态异常",
      pod_not_ready: "Pod 未就绪",
      deployment_replicas_unavailable: "Deployment 副本不可用",
      statefulset_replicas_not_ready: "StatefulSet 副本未就绪",
      daemonset_nodes_not_ready: "DaemonSet 节点未就绪",
      replicaset_replicas_not_ready: "ReplicaSet 副本未就绪",
      job_failed: "Job 执行失败",
      cronjob_suspended: "CronJob 已暂停",
      event_warning: "警告 Event",
    },
    ownership: "所属关系",
    revision: "修订版本",
    resourceKindDeployment: "Deployment",
    resourceKindStatefulSet: "StatefulSet",
    resourceKindDaemonSet: "DaemonSet",
    resourceKindReplicaSet: "ReplicaSet",
    resourceKindPod: "Pod",
    resourceKindJob: "Job",
    resourceKindCronJob: "CronJob",
    resourceKindEvent: "Event",
    recentLogsTitle: "Recent Log Window",
    recentLogsDescription: "Owner 可以通过独立的 Kubernetes 身份查看一个 Pod 容器的有限近期日志。日志不会被 Tracegarden 保存。",
    logCluster: "Cluster ID",
    logNamespace: "命名空间",
    logPod: "Pod",
    logContainer: "容器",
    logTail: "行数（最多 200）",
    requestLogs: "请求近期日志",
    logsReadDenied: "你没有读取 Recent Log Window 的 Capability。",
    recentLogsInvalid: "Recent Log Window 请求无效，请检查 Cluster、命名空间、Pod、容器和行数。",
    recentLogsUnavailable: "Recent Log Window 当前不可用。",
    recentLogsEmpty: "没有可显示的近期日志。",
    recentLogsMetadata: "结果限制：最多 200 行或 1 MiB；此响应不会被保存。"
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
    clusterConfigurationInvalid: "Cluster configuration is invalid. Check the inputs.",
    timelineTitle: "Timeline",
    timelineDescription: "Committed Kubernetes Observations appear here.",
    noTimelineEntries: "No Timeline Entries yet.",
    podObservation: "Pod Observation",
    resourceIdentity: "Resource identity",
    observedAt: "Observed at",
    timelineUnknownState: "State unknown",
    observationChange: "Change",
    attentionItem: "Attention Item",
    recovery: "Recovery",
    attentionReason: "Review reason",
    attentionReasonLabels: {
      condition_failed: "Condition requires review",
      pod_not_ready: "Pod is not ready",
      deployment_replicas_unavailable: "Deployment replicas are unavailable",
      statefulset_replicas_not_ready: "StatefulSet replicas are not ready",
      daemonset_nodes_not_ready: "DaemonSet nodes are not ready",
      replicaset_replicas_not_ready: "ReplicaSet replicas are not ready",
      job_failed: "Job failed",
      cronjob_suspended: "CronJob is suspended",
      event_warning: "Warning Event",
    },
    ownership: "Ownership",
    revision: "Revision",
    resourceKindDeployment: "Deployment",
    resourceKindStatefulSet: "StatefulSet",
    resourceKindDaemonSet: "DaemonSet",
    resourceKindReplicaSet: "ReplicaSet",
    resourceKindPod: "Pod",
    resourceKindJob: "Job",
    resourceKindCronJob: "CronJob",
    resourceKindEvent: "Event",
    recentLogsTitle: "Recent Log Window",
    recentLogsDescription: "The owner can view a bounded recent window for one Pod container through a separate Kubernetes identity. Tracegarden never saves log bodies.",
    logCluster: "Cluster ID",
    logNamespace: "Namespace",
    logPod: "Pod",
    logContainer: "Container",
    logTail: "Lines (maximum 200)",
    requestLogs: "Request recent logs",
    logsReadDenied: "You do not have the Capability to read the Recent Log Window.",
    recentLogsInvalid: "The Recent Log Window request is invalid. Check the Cluster, namespace, Pod, container, and tail.",
    recentLogsUnavailable: "The Recent Log Window is currently unavailable.",
    recentLogsEmpty: "No recent logs are available.",
    recentLogsMetadata: "Bounded to 200 lines or 1 MiB; this response is not saved."
  },
};

export function parseLanguage(value: string | null | undefined): Language {
  return value === "en" ? "en" : "zh-CN";
}

export function messagesFor(value: string | null | undefined): Messages {
  return catalogs[parseLanguage(value)];
}
