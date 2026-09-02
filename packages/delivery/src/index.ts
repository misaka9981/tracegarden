const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const BACKUP_DIGEST_PLACEHOLDER = "sha256:4444444444444444444444444444444444444444444444444444444444444444";
const GIT_COMMIT = /^[a-f0-9]{40}$/;
const PREVIEW_NUMBER = /^[1-9][0-9]{0,8}$/;
export const TRUSTED_PREVIEW_GITOPS_REPOSITORY = "https://github.com/MISAKA3389/tracegarden-gitops.git";

export type PreviewPullRequest = Readonly<{
  number: number;
  state: "open" | "closed";
  draft: boolean;
}>;

export type TrustedPreviewSource = Readonly<{
  repository: string;
  revision: string;
}>;

export type PreviewResources = Readonly<{
  requests: Readonly<{ cpu: string; memory: string }>;
  limits: Readonly<{ cpu: string; memory: string }>;
}>;

export type PreviewDeclaration = Readonly<{
  pullRequest: number;
  source: TrustedPreviewSource;
  namespace: string;
  applications: readonly ["web", "collector"];
  database: Readonly<{
    name: string;
    secretName: string;
    temporary: true;
    productionData: false;
    productionCredentials: false;
  }>;
  seed: Readonly<{
    jobName: string;
    dataSet: "non-production";
  }>;
  resources: Readonly<{
    web: PreviewResources;
    collector: PreviewResources;
    postgres: PreviewResources;
  }>;
  capacity: Readonly<{
    quotaName: string;
    admission: "resource-quota";
    preemption: "never";
  }>;
}>;

export function previewNamespace(number: number): string {
  if (!Number.isSafeInteger(number) || number < 1 || number > 999_999_999) {
    throw new Error("Preview pull request number must be a positive integer");
  }
  return `preview-pr-${number}`;
}

function assertDigest(value: string, name: string): void {
  if (!SHA256_DIGEST.test(value)) throw new Error(`${name} must be a sha256 image digest`);
}

export function createPreviewDeclaration(input: PreviewPullRequest, source: TrustedPreviewSource): PreviewDeclaration | null {
  if (input.state !== "open" || input.draft) return null;
  if (!Number.isSafeInteger(input.number) || !PREVIEW_NUMBER.test(String(input.number))) {
    throw new Error("Preview pull request number must be a positive integer with at most nine digits");
  }
  if (source.repository !== TRUSTED_PREVIEW_GITOPS_REPOSITORY || !GIT_COMMIT.test(source.revision)) {
    throw new Error("Preview source must be the protected GitOps repository and a full Git commit SHA");
  }
  const namespace = previewNamespace(input.number);
  const resources: PreviewDeclaration["resources"] = {
    web: { requests: { cpu: "50m", memory: "128Mi" }, limits: { cpu: "250m", memory: "256Mi" } },
    collector: { requests: { cpu: "50m", memory: "128Mi" }, limits: { cpu: "250m", memory: "256Mi" } },
    postgres: { requests: { cpu: "100m", memory: "256Mi" }, limits: { cpu: "500m", memory: "512Mi" } },
  };
  return {
    pullRequest: input.number,
    source,
    namespace,
    applications: ["web", "collector"],
    database: {
      name: `${namespace}-postgres`,
      secretName: `${namespace}-database`,
      temporary: true,
      productionData: false,
      productionCredentials: false,
    },
    seed: { jobName: `${namespace}-seed`, dataSet: "non-production" },
    resources,
    capacity: { quotaName: `${namespace}-quota`, admission: "resource-quota", preemption: "never" },
  };
}

export type PreviewReconciliation = Readonly<{
  namespace: string;
  action: "create" | "delete";
  reason: "closed" | "draft" | "orphan" | "eligible";
}>;

export type PreviewCapacity = Readonly<{
  maxPreviewEnvironments: number;
  aggregate: Readonly<{ cpu: string; memory: string; pods: string }>;
  cluster: Readonly<{ cpu: string; memory: string; pods: string }>;
  productionReservation: Readonly<{ cpu: string; memory: string; pods: string }>;
  perPreview: Readonly<{ cpu: string; memory: string; pods: string }>;
}>;

export const DEFAULT_PREVIEW_CAPACITY: PreviewCapacity = {
  maxPreviewEnvironments: 10,
  aggregate: { cpu: "2", memory: "8Gi", pods: "80" },
  cluster: { cpu: "4", memory: "16Gi", pods: "100" },
  productionReservation: { cpu: "2", memory: "4Gi", pods: "20" },
  perPreview: { cpu: "275m", memory: "704Mi", pods: "8" },
};

export type PreviewAdmissionCandidate = Readonly<Pick<PreviewPullRequest, "number" | "state" | "draft">>;
export type PreviewAdmission = Readonly<{
  namespace: string;
  admitted: boolean;
  reason: "admitted" | "ineligible" | "max-preview-environments" | "aggregate-cpu-budget" | "aggregate-memory-budget" | "aggregate-pods-budget";
}>;

function parseCpu(value: string): number {
  const match = value.trim().match(/^(\d+)(m)?$/);
  if (!match) throw new Error(`Invalid CPU quantity: ${value}`);
  return Number(match[2] ? match[1] : Number(match[1]) * 1000);
}

function parseMemory(value: string): number {
  const match = value.trim().match(/^(\d+)(Ki|Mi|Gi|Ti)$/);
  if (!match) throw new Error(`Invalid memory quantity: ${value}`);
  const multipliers: Readonly<Record<string, number>> = { Ki: 1, Mi: 1024, Gi: 1024 ** 2, Ti: 1024 ** 3 };
  const unit = match[2];
  return Number(match[1]) * (unit ? multipliers[unit] ?? 0 : 0);
}

function parsePods(value: string): number {
  const pods = Number(value.trim());
  if (!Number.isSafeInteger(pods) || pods < 1) throw new Error(`Invalid pod quantity: ${value}`);
  return pods;
}

export function reconcilePreviewAdmissions(
  candidates: readonly PreviewAdmissionCandidate[],
  capacity: PreviewCapacity = DEFAULT_PREVIEW_CAPACITY,
): readonly PreviewAdmission[] {
  if (!Number.isSafeInteger(capacity.maxPreviewEnvironments) || capacity.maxPreviewEnvironments < 1) {
    throw new Error("Preview maxPreviewEnvironments must be a positive integer");
  }
  const clusterCpu = parseCpu(capacity.cluster.cpu);
  const clusterMemory = parseMemory(capacity.cluster.memory);
  const reservedCpu = parseCpu(capacity.productionReservation.cpu);
  const reservedMemory = parseMemory(capacity.productionReservation.memory);
  const aggregateCpu = Math.min(parseCpu(capacity.aggregate.cpu), clusterCpu - reservedCpu);
  const aggregateMemory = Math.min(parseMemory(capacity.aggregate.memory), clusterMemory - reservedMemory);
  const clusterPods = parsePods(capacity.cluster.pods);
  const reservedPods = parsePods(capacity.productionReservation.pods);
  const aggregatePods = Math.min(parsePods(capacity.aggregate.pods), clusterPods - reservedPods);
  if (aggregateCpu < 0 || aggregateMemory < 0 || aggregatePods < 0) throw new Error("Production reservation exceeds cluster capacity");
  const perPreviewCpu = parseCpu(capacity.perPreview.cpu);
  const perPreviewMemory = parseMemory(capacity.perPreview.memory);
  const perPreviewPods = parsePods(capacity.perPreview.pods);
  const ordered = [...candidates].sort((left, right) => left.number - right.number);
  let admittedCount = 0;
  let usedCpu = 0;
  let usedMemory = 0;
  let usedPods = 0;
  return ordered.map((candidate) => {
    const namespace = previewNamespace(candidate.number);
    if (candidate.state !== "open" || candidate.draft) return { namespace, admitted: false, reason: "ineligible" };
    if (admittedCount >= capacity.maxPreviewEnvironments) return { namespace, admitted: false, reason: "max-preview-environments" };
    if (usedCpu + perPreviewCpu > aggregateCpu) return { namespace, admitted: false, reason: "aggregate-cpu-budget" };
    if (usedMemory + perPreviewMemory > aggregateMemory) return { namespace, admitted: false, reason: "aggregate-memory-budget" };
    if (usedPods + perPreviewPods > aggregatePods) return { namespace, admitted: false, reason: "aggregate-pods-budget" };
    admittedCount += 1;
    usedCpu += perPreviewCpu;
    usedMemory += perPreviewMemory;
    usedPods += perPreviewPods;
    return { namespace, admitted: true, reason: "admitted" };
  });
}

export function reconcilePreviewEnvironments(
  pullRequests: readonly PreviewPullRequest[],
  existingNamespaces: readonly string[],
): readonly PreviewReconciliation[] {
  const eligible = new Set<string>();
  const observed = new Set<string>();
  const results: PreviewReconciliation[] = [];
  for (const pullRequest of pullRequests) {
    const namespace = previewNamespace(pullRequest.number);
    observed.add(namespace);
    if (pullRequest.state === "open" && !pullRequest.draft) {
      eligible.add(namespace);
      if (!existingNamespaces.includes(namespace)) results.push({ namespace, action: "create", reason: "eligible" });
    } else if (existingNamespaces.includes(namespace)) {
      results.push({ namespace, action: "delete", reason: pullRequest.state === "closed" ? "closed" : "draft" });
    }
  }
  for (const namespace of existingNamespaces) {
    if (namespace.startsWith("preview-pr-") && !eligible.has(namespace) && !observed.has(namespace)) results.push({ namespace, action: "delete", reason: "orphan" });
  }
  return results;
}

export type PromotionInput = Readonly<{
  releaseCommit: string;
  images: Readonly<Record<"web" | "collector" | "migrate" | "backup", Readonly<{ repository: string; digest: string }>>>;
  approval: Readonly<{
    environment: "production";
    approved: boolean;
    reviewer: string;
  }>;
  gitOps: Readonly<{
    repository: string;
    path: string;
    pullRequestRequired: true;
  }>;
}>;

export type PromotionProposal = Readonly<{
  releaseCommit: string;
  desiredState: Readonly<Record<"web" | "collector" | "migrate" | "backup", string>>;
  review: Readonly<{ environment: "production"; approvedBy: string; mechanism: "gitops-pull-request" }>;
  clusterMutation: false;
}>;

export function createPromotionProposal(input: PromotionInput): PromotionProposal {
  if (!GIT_COMMIT.test(input.releaseCommit)) throw new Error("Promotion releaseCommit must be a full Git commit SHA");
  if (input.approval.environment !== "production" || !input.approval.approved || !input.approval.reviewer.trim()) {
    throw new Error("Promotion requires protected production approval");
  }
  if (!input.gitOps.pullRequestRequired || !input.gitOps.repository.trim() || !input.gitOps.path.trim()) {
    throw new Error("Promotion requires a reviewable GitOps pull request");
  }
  for (const component of ["web", "collector", "migrate", "backup"] as const) {
    const reference = input.images[component];
    if (!reference) throw new Error(`images.${component} is required`);
    if (!reference.repository.trim()) throw new Error(`images.${component}.repository is required`);
    assertDigest(reference.digest, `images.${component}.digest`);
    if (component === "backup" && reference.digest === BACKUP_DIGEST_PLACEHOLDER) {
      throw new Error("images.backup.digest must be replaced with the attested release digest");
    }
  }
  const desiredState = {
    web: `${input.images.web.repository}@${input.images.web.digest}`,
    collector: `${input.images.collector.repository}@${input.images.collector.digest}`,
    migrate: `${input.images.migrate.repository}@${input.images.migrate.digest}`,
    backup: `${input.images.backup.repository}@${input.images.backup.digest}`,
  };
  return {
    releaseCommit: input.releaseCommit,
    desiredState,
    review: { environment: "production", approvedBy: input.approval.reviewer.trim(), mechanism: "gitops-pull-request" },
    clusterMutation: false,
  };
}
