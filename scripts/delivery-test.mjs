import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createSign, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAll } from "js-yaml";
import {
  createPreviewDeclaration,
  createPromotionProposal,
  reconcilePreviewAdmissions,
  reconcilePreviewEnvironments as reconcilePreviewDeclarations,
  TRUSTED_PREVIEW_GITOPS_REPOSITORY,
} from "../dist/packages/delivery/src/index.js";
import {
  DEFAULT_PREVIEW_CAPACITY,
  reconcilePreviewEnvironments,
} from "./preview-lifecycle-controller.mjs";
import {
  cloudflareAccessIdentity,
  configuredCloudflareAccess,
  createIdentityAdapter,
  validateCloudflareAccessClaims,
} from "../dist/packages/identity/src/index.js";
import { APPLICATION_SET_CRD_RELEASE, APPLICATION_SET_CRD_SOURCE, readApplicationSetSchema } from "./applicationset-schema.mjs";

const read = (path) => readFile(path, "utf8");

function schemaError(path, message) {
  throw new Error(`${path}: ${message}`);
}

function validateSchema(value, schema, path = "$", root = schema, options = {}) {
  if (schema.$ref) {
    const reference = schema.$ref.replace(/^#\//, "").split("/").reduce((current, key) => current?.[key], root);
    if (!reference) schemaError(path, `missing schema reference ${schema.$ref}`);
    validateSchema(value, reference, path, root, options);
    return;
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) schemaError(path, `must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) schemaError(path, `must be one of ${schema.enum.join(", ")}`);
  for (const keyword of ["oneOf", "anyOf"]) if (schema[keyword] && !schema[keyword].some((candidate) => {
    try {
      validateSchema(value, candidate, path, root, options);
      return true;
    } catch {
      return false;
    }
  })) schemaError(path, `does not match any allowed ${keyword} schema`);
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) schemaError(path, "must be an object");
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) schemaError(path, `missing required property ${key}`);
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) schemaError(path, "has too few properties");
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key];
      if (!childSchema) {
        if (schema.additionalProperties === false || (options.strictProperties && Object.keys(schema.properties ?? {}).length > 0)) schemaError(`${path}.${key}`, "is not allowed");
        if (schema.additionalProperties && typeof schema.additionalProperties === "object") validateSchema(child, schema.additionalProperties, `${path}.${key}`, root, options);
      } else validateSchema(child, childSchema, `${path}.${key}`, root, options);
    }
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) schemaError(path, "must be an array");
    if (schema.minItems !== undefined && value.length < schema.minItems) schemaError(path, "has too few items");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) schemaError(path, "has too many items");
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`, root, options));
  }
  if (schema.type === "string") {
    if (typeof value !== "string") schemaError(path, "must be a string");
    if (schema.minLength !== undefined && value.length < schema.minLength) schemaError(path, "is too short");
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) schemaError(path, "does not match its pattern");
  }
  if (schema.type === "integer" && (!Number.isInteger(value))) schemaError(path, "must be an integer");
  if (schema.minimum !== undefined && value < schema.minimum) schemaError(path, `must be at least ${schema.minimum}`);
}

async function parseYaml(path) {
  const documents = [];
  loadAll(await read(path), (document) => documents.push(document));
  assert.equal(documents.length, 1, `${path} must contain exactly one YAML document`);
  return documents[0];
}

async function parseAndValidate(path, schemaPathOrSchema) {
  const [document, schema] = await Promise.all([
    parseYaml(path),
    typeof schemaPathOrSchema === "string" ? read(schemaPathOrSchema).then(JSON.parse) : schemaPathOrSchema,
  ]);
  validateSchema(document, schema, "$", schema, { strictProperties: typeof schemaPathOrSchema !== "string" });
  return document;
}

const applicationSetSchema = await readApplicationSetSchema();
assert.equal(APPLICATION_SET_CRD_RELEASE, "v3.4.6");
assert.equal(APPLICATION_SET_CRD_SOURCE, "https://raw.githubusercontent.com/argoproj/argo-cd/v3.4.6/manifests/crds/applicationset-crd.yaml");
const [applicationSet, appProject, promotion, lifecycle, desiredState, productionApp, previewValues, previewPriority, productionPriority, previewDigestValues, lifecycleController, lifecycleScript, previewDeployments] = await Promise.all([
  parseAndValidate("deploy/preview/applicationset.yaml", applicationSetSchema),
  parseAndValidate("deploy/preview/appproject.yaml", "deploy/preview/appproject.schema.json"),
  parseAndValidate("deploy/promotion/promotion.yaml", "deploy/promotion/promotion.schema.json"),
  parseYaml("deploy/preview/lifecycle-policy.yaml"),
  read("deploy/gitops/production/desired-state.yaml"),
  read("deploy/gitops/production/application.yaml"),
  read("deploy/preview/chart/values.yaml"),
  read("deploy/preview/priorityclass.yaml"),
  read("deploy/gitops/production/priorityclass.yaml"),
  parseAndValidate("deploy/preview/digests/pr-1.yaml", "deploy/preview/digest-values.schema.json"),
  read("deploy/preview/lifecycle-controller.yaml"),
  read("scripts/preview-lifecycle-controller.mjs"),
  read("deploy/preview/chart/templates/deployments.yaml"),
]);

assert.equal(applicationSet.spec.syncPolicy.preserveResourcesOnDeletion, false);
assert.equal("preserveResourcesOnDeletion" in applicationSetSchema.properties.spec.properties.syncPolicy.properties, true);
assert.equal("preserveResourcesOnDeletion" in applicationSetSchema.properties.spec.properties.template.properties.spec.properties.syncPolicy.properties, false);
assert.equal(applicationSet.spec.template.spec.source.targetRevision, "main");
assert.equal(applicationSet.spec.template.spec.source.repoURL, TRUSTED_PREVIEW_GITOPS_REPOSITORY);
assert.doesNotMatch(JSON.stringify(applicationSet), /head_sha|valuesObject|preview\.access|CreateNamespace/);
assert.equal(applicationSet.spec.template.spec.destination.namespace, "preview-pr-{{.number}}");
assert.equal(applicationSet.spec.template.spec.source.path, "environments/previews/chart");
assert.equal("preserveResourcesOnDeletion" in applicationSet.spec.template.spec.syncPolicy, false);
assert.deepEqual(applicationSet.spec.generators[0].pullRequest.github.labels, ["tracegarden.dev/preview"]);
assert.deepEqual(applicationSet.spec.template.spec.source.helm.parameters, [
  { name: "preview.number", value: "{{.number}}" },
  { name: "preview.host", value: "preview-pr-{{.number}}.tracegarden.example" },
]);
const invalidApplicationSet = structuredClone(applicationSet);
delete invalidApplicationSet.spec.syncPolicy;
invalidApplicationSet.spec.template.spec.syncPolicy.preserveResourcesOnDeletion = false;
assert.throws(() => validateSchema(invalidApplicationSet, applicationSetSchema, "$", applicationSetSchema, { strictProperties: true }), /preserveResourcesOnDeletion|is not allowed/);
assert.equal(applicationSet.spec.generators[0].pullRequest.github.tokenRef.secretName, "tracegarden-preview-github");
assert.equal(applicationSet.spec.generators[0].pullRequest.github.tokenRef.key, "token");
assert.equal(applicationSet.spec.generators[0].pullRequest.requeueAfterSeconds, 60);
assert.equal(applicationSet.spec.template.spec.syncPolicy.managedNamespaceMetadata.labels["tracegarden.dev/lifecycle"], "pull-request-preview");
assert.equal(applicationSet.spec.template.spec.syncPolicy.managedNamespaceMetadata.labels["tracegarden.dev/managed-by"], "tracegarden-preview-lifecycle");
assert.equal(applicationSet.spec.template.spec.source.helm.valueFiles[0], "../digests/pr-{{.number}}.yaml");
assert.equal(applicationSet.spec.template.spec.source.helm.ignoreMissingValueFiles, false);
assert.equal("valuesObject" in applicationSet.spec.template.spec.source.helm, false);
assert.equal("templatePatch" in applicationSet.spec, false);
assert.doesNotMatch(JSON.stringify(applicationSet), /\.state|\.draft/);
assert.doesNotMatch(JSON.stringify(applicationSet), /preview-(?:web|collector|migrate)-digest=/);
assert.equal(appProject.spec.sourceRepos.length, 1);
assert.equal(appProject.spec.sourceRepos[0], TRUSTED_PREVIEW_GITOPS_REPOSITORY);
assert.equal(appProject.spec.destinations[0].namespace, "preview-pr-*");
assert.deepEqual(appProject.spec.clusterResourceWhitelist, []);
assert.ok(appProject.spec.namespaceResourceWhitelist.some(({ group, kind }) => group === "apps" && kind === "Deployment"));
assert.ok(appProject.spec.namespaceResourceWhitelist.some(({ group, kind }) => group === "networking.k8s.io" && kind === "Ingress"));
assert.ok(appProject.spec.namespaceResourceWhitelist.some(({ group, kind }) => group === "networking.k8s.io" && kind === "NetworkPolicy"));
assert.ok(appProject.spec.namespaceResourceWhitelist.some(({ group, kind }) => group === "policy" && kind === "PodDisruptionBudget"));
assert.equal(appProject.spec.namespaceResourceWhitelist.some(({ kind }) => kind === "Secret"), false);
assert.equal(appProject.spec.namespaceResourceWhitelist.some(({ kind }) => kind === "ServiceAccount"), false);
assert.equal("preview" in previewDigestValues, false);
assert.ok(previewDigestValues.images);
for (const component of ["web", "collector", "migrate", "postgres"]) {
  assert.match(previewDigestValues.images[component].digest, /^sha256:[a-f0-9]{64}$/);
}
assert.equal(lifecycle.spec.cleanup.onPullRequestState.closed, "delete");
assert.equal(lifecycle.spec.cleanup.onPullRequestState.draft, "delete");
assert.equal(lifecycle.spec.cleanup.orphanReconciliation.enabled, true);
assert.equal(lifecycle.spec.cleanup.orphanReconciliation.namespacePrefix, "preview-pr-");
assert.equal(lifecycle.spec.cleanup.orphanReconciliation.namespacePattern, "^preview-pr-[1-9][0-9]{0,8}$");
assert.equal(lifecycle.spec.cleanup.managedNamespaceMetadata.labels["tracegarden.dev/lifecycle"], "pull-request-preview");
assert.equal(lifecycle.spec.cleanup.managedNamespaceMetadata.labels["tracegarden.dev/managed-by"], "tracegarden-preview-lifecycle");
assert.equal(lifecycle.spec.cleanup.controller.kind, "CronJob");
assert.equal(lifecycle.spec.cleanup.controller.name, "tracegarden-preview-lifecycle");
assert.equal(lifecycle.spec.cleanup.controller.reconciliationIntervalSeconds, 60);
assert.equal(lifecycle.spec.cleanup.controller.deletionRequestBoundSeconds, 120);
assert.equal(lifecycle.spec.imagePullAuthentication.serviceAccountName, "tracegarden-preview");
assert.equal(lifecycle.spec.imagePullAuthentication.imagePullSecrets[0].name, "tracegarden-preview-ghcr");
assert.equal(lifecycle.spec.imagePullAuthentication.sourceSecret.operatorManaged, true);
assert.equal(lifecycle.spec.imagePullAuthentication.sourceSecret.credentialsInGit, false);
assert.match(lifecycleController, /kind: CronJob/);
assert.match(lifecycleController, /resources: \[namespaces\]/);
assert.match(lifecycleController, /resources: \[secrets\]/);
assert.match(lifecycleController, /tracegarden-preview-ghcr/);
assert.match(lifecycleController, /GITHUB_TOKEN/);
assert.match(lifecycleController, /secretKeyRef/);
assert.match(lifecycleController, /setPreviewLabel/);
assert.match(lifecycleController, /aggregateCpu/);
assert.match(lifecycleController, /productionCpu/);
assert.match(lifecycleController, /missing-trusted-digest/);
assert.doesNotMatch(lifecycleController, /SOURCE_SECRET_NAME|SOURCE_SECRET_NAMESPACE/);
assert.match(lifecycleScript, /TRUSTED_GITOPS_REVISION = "main"/);
assert.match(lifecycleScript, /previewAdmissionDecisions/);
assert.match(lifecycleController, /issues\/.*labels/);
const lifecycleDocuments = [];
loadAll(lifecycleController, (document) => lifecycleDocuments.push(document));
assert.deepEqual(lifecycleDocuments.map(({ kind }) => kind), ["ConfigMap", "ServiceAccount", "Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding", "CronJob"]);
assert.equal(lifecycleDocuments[0].data["controller.mjs"], lifecycleScript);
assert.equal(lifecycle.spec.dataBoundary.productionData, false);
assert.equal(lifecycle.spec.dataBoundary.productionCredentials, false);
assert.equal(lifecycle.spec.capacity.aggregateAdmissionBudget.enabled, true);
assert.equal(lifecycle.spec.capacity.aggregateAdmissionBudget.onExhaustion, "reject-preview-without-preempting-production");
assert.equal(lifecycle.spec.capacity.aggregateAdmissionBudget.perPreview.pods, "8");
assert.equal(lifecycle.spec.capacity.productionReservation.pods, "20");
assert.equal(lifecycle.spec.capacity.productionReservation.protected, true);
assert.equal(lifecycle.spec.capacity.productionReservation.priorityClass, "tracegarden-production");
assert.match(previewPriority, /name: tracegarden-preview/);
assert.match(previewPriority, /value: -100/);
assert.match(previewPriority, /preemptionPolicy: Never/);
assert.match(productionPriority, /name: tracegarden-production/);
assert.match(productionPriority, /preemptionPolicy: PreemptLowerPriority/);
assert.equal(promotion.spec.releaseCommit.length, 40);
assert.equal(promotion.spec.protectedEnvironment.approvalRequired, true);
assert.equal(promotion.spec.gitOps.pullRequestRequired, true);
assert.equal(promotion.spec.gitOps.directClusterMutation, false);
assert.match(desiredState, /releaseCommit: [a-f0-9]{40}/);
assert.equal([...desiredState.matchAll(/@sha256:[a-f0-9]{64}/g)].length, 3);
assert.match(productionApp, /argocd-pull/);
assert.match(previewValues, /serviceAccount:\n  name: tracegarden-preview/);
assert.match(previewValues, /imagePullSecrets:\n  - name: tracegarden-preview-ghcr/);
assert.match(previewValues, /digest: ""/);
assert.doesNotMatch(previewDeployments, /secretKeyRef:/);
assert.match(previewDeployments, /CLOUDFLARE_ACCESS_JWT_PUBLIC_KEY/);

const commit = "a".repeat(40);
const trustedSource = { repository: TRUSTED_PREVIEW_GITOPS_REPOSITORY, revision: commit };
const declaration = createPreviewDeclaration({ number: 42, state: "open", draft: false }, trustedSource);
assert.equal(declaration?.namespace, "preview-pr-42");
assert.deepEqual(declaration?.source, trustedSource);
assert.deepEqual(declaration?.applications, ["web", "collector"]);
assert.equal(declaration?.database.temporary, true);
assert.equal(declaration?.database.productionData, false);
assert.equal(declaration?.database.productionCredentials, false);
assert.equal(declaration?.seed.dataSet, "non-production");
assert.equal(createPreviewDeclaration({ number: 42, state: "open", draft: true }, trustedSource), null);
assert.equal(createPreviewDeclaration({ number: 42, state: "closed", draft: false }, trustedSource), null);
assert.throws(() => createPreviewDeclaration({ number: 42, state: "open", draft: false }, { repository: "https://github.com/MISAKA3389/tracegarden.git", revision: commit }), /protected GitOps repository/);
assert.deepEqual(reconcilePreviewDeclarations(
  [{ number: 42, state: "open", draft: false }, { number: 7, state: "closed", draft: false }],
  ["preview-pr-7", "preview-pr-99"],
), [
  { namespace: "preview-pr-42", action: "create", reason: "eligible" },
  { namespace: "preview-pr-7", action: "delete", reason: "closed" },
  { namespace: "preview-pr-99", action: "delete", reason: "orphan" },
]);

const capacityCandidates = Array.from({ length: 10 }, (_, index) => ({ number: index + 1, state: "open", draft: false }));
const capacityDecisions = reconcilePreviewAdmissions([...capacityCandidates].reverse());
assert.deepEqual(capacityDecisions.filter(({ admitted }) => admitted).map(({ namespace }) => namespace), [
  "preview-pr-1", "preview-pr-2", "preview-pr-3", "preview-pr-4", "preview-pr-5", "preview-pr-6", "preview-pr-7",
]);
assert.equal(capacityDecisions[7]?.reason, "aggregate-cpu-budget");
const reservedCapacityDecisions = reconcilePreviewAdmissions(capacityCandidates, {
  maxPreviewEnvironments: 10,
  aggregate: { cpu: "2", memory: "8Gi", pods: "80" },
  cluster: { cpu: "4", memory: "16Gi", pods: "100" },
  productionReservation: { cpu: "3", memory: "4Gi", pods: "20" },
  perPreview: { cpu: "275m", memory: "704Mi", pods: "8" },
});
assert.equal(reservedCapacityDecisions.filter(({ admitted }) => admitted).length, 3);
const memoryCapacityDecisions = reconcilePreviewAdmissions(capacityCandidates, {
  maxPreviewEnvironments: 10,
  aggregate: { cpu: "4", memory: "8Gi", pods: "80" },
  cluster: { cpu: "6", memory: "16Gi", pods: "100" },
  productionReservation: { cpu: "2", memory: "4Gi", pods: "20" },
  perPreview: { cpu: "275m", memory: "3Gi", pods: "8" },
});
assert.equal(memoryCapacityDecisions.filter(({ admitted }) => admitted).length, 2);
assert.equal(memoryCapacityDecisions[2]?.reason, "aggregate-memory-budget");
assert.throws(() => reconcilePreviewAdmissions(capacityCandidates, {
  maxPreviewEnvironments: 10,
  aggregate: { cpu: "2", memory: "8Gi", pods: "80" },
  cluster: { cpu: "4", memory: "16Gi", pods: "100" },
  productionReservation: { cpu: "5", memory: "4Gi", pods: "20" },
  perPreview: { cpu: "275m", memory: "704Mi", pods: "8" },
}), /Production reservation exceeds cluster capacity/);
const podCapacityDecisions = reconcilePreviewAdmissions(capacityCandidates, {
  maxPreviewEnvironments: 10,
  aggregate: { cpu: "4", memory: "16Gi", pods: "16" },
  cluster: { cpu: "6", memory: "24Gi", pods: "20" },
  productionReservation: { cpu: "2", memory: "4Gi", pods: "4" },
  perPreview: { cpu: "275m", memory: "704Mi", pods: "8" },
});
assert.equal(podCapacityDecisions.filter(({ admitted }) => admitted).length, 2);
assert.equal(podCapacityDecisions[2]?.reason, "aggregate-pods-budget");

const lifecycleEvents = [];
const lifecycleGithub = {
  async listOpenPullRequests() {
    return [
      { number: 5, state: "open", draft: false },
      { number: 2, state: "open", draft: false },
      { number: 3, state: "open", draft: true },
      { number: 4, state: "open", draft: false },
    ];
  },
  async getPullRequest(number) {
    if (number === 7) return { number, state: "closed", draft: false };
    return null;
  },
  async hasTrustedDigest(number) { return number !== 4; },
  async setPreviewLabel(number, enabled) { lifecycleEvents.push(["github-label", number, enabled]); },
};
const lifecycleKubernetes = {
  async listPreviewNamespaces() { return [7, 9, 5].map((number) => ({ metadata: { name: `preview-pr-${number}` } })); },
  async ensureNamespace(namespace) { lifecycleEvents.push(["namespace", namespace]); },
  async getOperatorImagePullSecret() { lifecycleEvents.push(["source-secret"]); return { type: "kubernetes.io/dockerconfigjson", data: { ".dockerconfigjson": "operator-data" } }; },
  async ensureImagePullAuthentication(namespace) { lifecycleEvents.push(["pull-auth", namespace]); },
  async labelNamespace(namespace) { lifecycleEvents.push(["namespace-label", namespace]); },
  async deleteNamespace(namespace) { lifecycleEvents.push(["delete", namespace]); },
};
const lifecycleResult = await reconcilePreviewEnvironments({
  github: lifecycleGithub,
  kubernetes: lifecycleKubernetes,
  capacity: {
    ...DEFAULT_PREVIEW_CAPACITY,
    maxPreviewEnvironments: 1,
    aggregateCpu: "1",
    clusterCpu: "4",
    productionCpu: "2",
  },
});
assert.deepEqual(lifecycleResult.processed, [2, 3, 4, 5, 7, 9]);
assert.equal(lifecycleResult.decisions.get(2)?.admitted, true);
assert.equal(lifecycleResult.decisions.get(5)?.reason, "max-preview-environments");
assert.equal(lifecycleResult.decisions.get(4)?.reason, "missing-trusted-digest");
assert.equal(lifecycleResult.decisions.get(3)?.reason, "ineligible");
assert.equal(lifecycleResult.decisions.get(7)?.reason, "ineligible");
assert.equal(lifecycleResult.decisions.get(9)?.reason, "ineligible");
assert.deepEqual(lifecycleEvents.filter(([event]) => event === "pull-auth" || event === "namespace-label" || event === "github-label" || event === "namespace"), [
  ["namespace", "preview-pr-2"],
  ["pull-auth", "preview-pr-2"],
  ["namespace-label", "preview-pr-2"],
  ["github-label", 2, true],
  ["github-label", 3, false],
  ["github-label", 4, false],
  ["github-label", 5, false],
  ["github-label", 7, false],
  ["github-label", 9, false],
]);
assert.deepEqual(lifecycleEvents.filter(([event]) => event === "delete").map(([, namespace]) => namespace).sort(), ["preview-pr-5", "preview-pr-7", "preview-pr-9"]);
assert.ok(lifecycleEvents.some(([event, number, enabled]) => event === "github-label" && number === 4 && enabled === false));
const failClosedEvents = [];
await assert.rejects(() => reconcilePreviewEnvironments({
  github: {
    async listOpenPullRequests() { return [{ number: 8, state: "open", draft: false }]; },
    async getPullRequest() { return null; },
    async hasTrustedDigest() { return true; },
    async setPreviewLabel(number, enabled) { failClosedEvents.push(["github-label", number, enabled]); },
  },
  kubernetes: {
    async listPreviewNamespaces() { return []; },
    async getOperatorImagePullSecret() { throw new Error("operator-managed GHCR pull Secret is unavailable"); },
    async ensureNamespace(namespace) { failClosedEvents.push(["namespace", namespace]); },
  },
}), /operator-managed GHCR pull Secret is unavailable/);
assert.deepEqual(failClosedEvents, []);

const accessConfig = { issuer: "https://access.example.test", audience: "preview-audience" };
assert.equal(validateCloudflareAccessClaims({ iss: accessConfig.issuer, aud: accessConfig.audience, sub: "member", exp: 2_000 }, accessConfig, 1_000), true);
assert.equal(validateCloudflareAccessClaims({ iss: "https://attacker.example.test", aud: accessConfig.audience, sub: "member", exp: 2_000 }, accessConfig, 1_000), false);
assert.equal(validateCloudflareAccessClaims({ iss: accessConfig.issuer, aud: "other-audience", sub: "member", exp: 2_000 }, accessConfig, 1_000), false);
const base64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const accessHeader = base64url({ alg: "RS256", typ: "JWT" });
const accessPayload = base64url({ iss: accessConfig.issuer, aud: accessConfig.audience, sub: "member", email: "member@example.test", exp: 2_000 });
const accessSigningInput = `${accessHeader}.${accessPayload}`;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signer = createSign("RSA-SHA256");
signer.update(accessSigningInput);
signer.end();
const accessToken = `${accessSigningInput}.${signer.sign(privateKey).toString("base64url")}`;
const accessHeaders = new Headers({ "cf-access-jwt-assertion": accessToken });
const applicationPublicKey = publicKey.export({ format: "pem", type: "spki" }).toString();
assert.equal(cloudflareAccessIdentity(accessHeaders, { ...accessConfig, publicKey: applicationPublicKey }, 1_000)?.subject, "member");
assert.equal(cloudflareAccessIdentity(new Headers({ "cf-access-jwt-assertion": `${accessSigningInput}.bad-signature` }), { ...accessConfig, publicKey: applicationPublicKey }, 1_000), null);
assert.equal(cloudflareAccessIdentity(new Headers({ "x-user-email": "attacker@example.test" }), { ...accessConfig, publicKey: "unused" }, 1_000), null);
const applicationAccessConfig = configuredCloudflareAccess({
  CLOUDFLARE_ACCESS_JWT_ISSUER: accessConfig.issuer,
  CLOUDFLARE_ACCESS_JWT_AUDIENCE: accessConfig.audience,
  CLOUDFLARE_ACCESS_JWT_PUBLIC_KEY: applicationPublicKey,
});
assert.ok(applicationAccessConfig);
assert.equal(cloudflareAccessIdentity(accessHeaders, applicationAccessConfig, 1_000)?.subject, "member");
assert.equal(cloudflareAccessIdentity(new Headers({ "cf-access-authenticated-user-email": "attacker@example.test", "cf-access-jwt-assertion": accessToken }), applicationAccessConfig, 1_000), null);
assert.throws(() => configuredCloudflareAccess({ CLOUDFLARE_ACCESS_JWT_ISSUER: accessConfig.issuer }), /requires/);
assert.equal(createIdentityAdapter({ NODE_ENV: "preview", CLOUDFLARE_ACCESS_JWT_ISSUER: accessConfig.issuer, CLOUDFLARE_ACCESS_JWT_AUDIENCE: accessConfig.audience, CLOUDFLARE_ACCESS_JWT_PUBLIC_KEY: applicationPublicKey }).kind, "cloudflare");
assert.throws(() => createIdentityAdapter({ NODE_ENV: "preview" }), /requires/);

const images = {
  web: { repository: "example/web", digest: `sha256:${"1".repeat(64)}` },
  collector: { repository: "example/collector", digest: `sha256:${"2".repeat(64)}` },
  migrate: { repository: "example/migrate", digest: `sha256:${"3".repeat(64)}` },
};
const proposal = createPromotionProposal({
  releaseCommit: commit,
  images,
  approval: { environment: "production", approved: true, reviewer: "maintainer" },
  gitOps: { repository: "gitops", path: "production/values.yaml", pullRequestRequired: true },
});
assert.equal(proposal.clusterMutation, false);
assert.equal(proposal.review.mechanism, "gitops-pull-request");
assert.throws(() => createPromotionProposal({
  releaseCommit: commit,
  images,
  approval: { environment: "production", approved: false, reviewer: "" },
  gitOps: { repository: "gitops", path: "production/values.yaml", pullRequestRequired: true },
}), /protected production approval/);

const artifactDirectory = mkdtempSync(join(tmpdir(), "tracegarden-preview-"));
const artifactPath = join(artifactDirectory, "preview-image-declaration.yaml");
const valuePath = join(artifactDirectory, "environments/previews/digests/pr-42.yaml");
const artifactEnvironment = {
  ...process.env,
  PREVIEW_NUMBER: "42",
  PREVIEW_COMMIT: commit,
  WEB_REPOSITORY: "ghcr.io/misaka3389/tracegarden-web",
  WEB_DIGEST: `sha256:${"1".repeat(64)}`,
  COLLECTOR_REPOSITORY: "ghcr.io/misaka3389/tracegarden-collector",
  COLLECTOR_DIGEST: `sha256:${"2".repeat(64)}`,
  MIGRATE_REPOSITORY: "ghcr.io/misaka3389/tracegarden-migrate",
  MIGRATE_DIGEST: `sha256:${"3".repeat(64)}`,
};
const artifact = spawnSync(process.execPath, ["scripts/preview-artifact.mjs", artifactPath, valuePath], {
  encoding: "utf8",
  env: artifactEnvironment,
});
assert.equal(artifact.status, 0, artifact.stderr || "preview artifact generation failed");
const invalidArtifact = spawnSync(process.execPath, ["scripts/preview-artifact.mjs", join(artifactDirectory, "invalid.yaml"), join(artifactDirectory, "invalid-values.yaml")], {
  encoding: "utf8",
  env: { ...artifactEnvironment, WEB_REPOSITORY: "ghcr.io/attacker/tracegarden-web" },
});
assert.notEqual(invalidArtifact.status, 0, "preview artifact must reject an untrusted image repository");
const generatedValues = await parseYaml(valuePath);
const digestValuesSchema = JSON.parse(await read("deploy/preview/digest-values.schema.json"));
validateSchema(generatedValues, digestValuesSchema);
assert.equal(generatedValues.images.web.digest, `sha256:${"1".repeat(64)}`);
assert.equal(generatedValues.images.collector.digest, `sha256:${"2".repeat(64)}`);
assert.equal(generatedValues.images.migrate.digest, `sha256:${"3".repeat(64)}`);
assert.equal(generatedValues.images.postgres.digest, "sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7");
assert.equal("preview" in generatedValues, false);
const generatedMetadata = await parseYaml(artifactPath);
assert.equal(generatedMetadata.spec.handoff.mechanism, "application-set-helm-value-file");
assert.equal(generatedMetadata.spec.handoff.valueFile, "environments/previews/digests/pr-42.yaml");
assert.equal(generatedMetadata.spec.handoff.commitRequired, true);
assert.equal(generatedMetadata.spec.handoff.remoteWrite, false);
assert.equal("labels" in generatedMetadata.spec.handoff, false);
rmSync(artifactDirectory, { recursive: true, force: true });

const lifecycleCheck = spawnSync(process.execPath, ["scripts/preview-lifecycle-controller.mjs"], {
  encoding: "utf8",
  env: { ...process.env, PREVIEW_LIFECYCLE_OFFLINE: "true" },
});
assert.equal(lifecycleCheck.status, 0, lifecycleCheck.stderr || "preview lifecycle offline check failed");
assert.match(lifecycleCheck.stdout, /offline lifecycle controller check passed/);

if (process.env.DELIVERY_RENDER === "true") {
  const missingValues = spawnSync("helm", ["template", "tracegarden-preview", "deploy/preview/chart", "--namespace", "preview-pr-999", "--kube-version", "1.31.0", "--values", "deploy/preview/digests/pr-999.yaml"], {
    encoding: "utf8",
    env: { ...process.env, KUBECONFIG: "/dev/null" },
  });
  assert.notEqual(missingValues.status, 0, "missing committed preview digest values must fail closed");
  const render = spawnSync("helm", ["template", "tracegarden-preview", "deploy/preview/chart", "--namespace", "preview-pr-1", "--kube-version", "1.31.0", "--values", "deploy/preview/digests/pr-1.yaml"], {
    encoding: "utf8",
    env: { ...process.env, KUBECONFIG: "/dev/null" },
  });
  assert.equal(render.status, 0, render.stderr || "preview Helm render failed");
  const schemaDirectory = process.env.KUBECONFORM_SCHEMA_LOCATION?.trim()
    || `file://${process.cwd()}/.ci/kubeconform-schemas/v1.31.0-standalone-strict/`;
  const schemaLocation = `${schemaDirectory.replace(/\/?$/, "/")}{{ .ResourceKind }}{{ .KindSuffix }}.json`;
  const validation = spawnSync("kubeconform", [
    "-schema-location", schemaLocation,
    "-strict", "-kubernetes-version", "1.31.0", "-summary",
  ], {
    encoding: "utf8",
    input: render.stdout,
    env: { ...process.env, KUBECONFIG: "/dev/null" },
  });
  assert.equal(validation.status, 0, validation.stderr || validation.stdout || "preview kubeconform validation failed");
  const renderedDocuments = [];
  loadAll(render.stdout, (document) => { if (document?.apiVersion && document?.kind) renderedDocuments.push(document); });
  const admittedGVKs = new Set(appProject.spec.namespaceResourceWhitelist.map(({ group, kind }) => `${group}/${kind}`));
  for (const document of renderedDocuments) {
    const [group] = document.apiVersion.includes("/") ? document.apiVersion.split("/") : [""];
    assert.ok(admittedGVKs.has(`${group}/${document.kind}`), `rendered GVK ${document.apiVersion}/${document.kind} is not admitted by AppProject`);
  }
  assert.ok(renderedDocuments.length > 0);
  for (const document of renderedDocuments) {
    const podSpec = document.spec?.template?.spec;
    if (!podSpec) continue;
    assert.equal(podSpec.serviceAccountName, "tracegarden-preview");
    assert.deepEqual(podSpec.imagePullSecrets, [{ name: "tracegarden-preview-ghcr" }]);
    assert.equal(podSpec.volumes?.some(({ secret }) => secret), false);
    assert.equal(podSpec.containers?.some(({ env }) => env?.some(({ valueFrom }) => valueFrom?.secretKeyRef)), false);
  }
  assert.doesNotMatch(render.stdout, /kind: Namespace/);
  assert.doesNotMatch(render.stdout, /kind: Secret/);
  assert.match(render.stdout, /kind: ResourceQuota/);
  assert.match(render.stdout, /kind: LimitRange/);
  assert.match(render.stdout, /kind: StatefulSet/);
  assert.match(render.stdout, /kind: Job/);
  assert.match(render.stdout, /preemptionPolicy: Never/);
  assert.match(render.stdout, /serviceAccountName: tracegarden-preview/);
  assert.match(render.stdout, /imagePullSecrets:/);
  assert.match(render.stdout, /ghcr.io\/misaka3389\/tracegarden-web@sha256:b95ddd90e6a525915d68f81df1a42a4a5d1994a1d5c136ba1955a6508f76f843/);
  assert.doesNotMatch(render.stdout, /existingSecret|production-database|production-credentials: "true"/);
  assert.doesNotMatch(render.stdout, /secretName: tracegarden-preview-ghcr[\s\S]*mountPath/);
  console.log("offline preview lifecycle, Access identity, promotion, and Helm declaration checks passed");
} else {
  console.log("offline preview lifecycle, Access identity, and promotion declaration checks passed");
}
