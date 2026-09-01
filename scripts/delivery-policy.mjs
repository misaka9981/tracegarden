import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const errors = [];
const immutableDigest = /@sha256:[a-f0-9]{64}/;
const actionFiles = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (path.endsWith(".yml") || path.endsWith(".yaml")) actionFiles.push(path);
  }
}

await visit(".github/workflows");
assert.ok(actionFiles.length, "at least one GitHub Actions workflow is required");
const workflows = await Promise.all(actionFiles.map(async (path) => [path, await readFile(path, "utf8")]));
const workflowText = workflows.map(([, source]) => source).join("\n");

for (const [path, source] of workflows) {
  if (!source.includes("permissions: {}")) errors.push(`${path}: top-level permissions must default to none`);
  if (!/permissions:[ \t]*\n(?:[ \t]+[^\n]+\n)*[ \t]+contents:[ \t]+read\b/.test(source)) errors.push(`${path}: a read-only contents permission is required`);
  for (const line of source.split("\n")) {
    const action = line.match(/uses:\s*([^\s#]+)/)?.[1];
    if (action && !/^([^/@]+\/[^/@]+)@[0-9a-f]{40}$/.test(action)) errors.push(`${path}: action is not pinned to a full commit SHA (${action})`);
    if (/\bKUBECONFIG\b/i.test(line) && !/\/dev\/null/.test(line)) errors.push(`${path}: KUBECONFIG must not come from a credential`);
  }
  if (/\b(?:kubectl|kubeadm)\b|helm\s+(?:install|upgrade)/i.test(source)) errors.push(`${path}: direct Cluster mutation is not allowed`);
  if (/secrets\.(?:KUBE|K8S|KUBERNETES)|KUBERNETES_[A-Z_]*(?:TOKEN|CONFIG)|KUBE_CONFIG/i.test(source)) errors.push(`${path}: Cluster credentials are not allowed`);
}

for (const command of [
  "pnpm install --frozen-lockfile",
  "pnpm format:check",
  "pnpm lint",
  "pnpm typecheck",
  "pnpm test",
  "pnpm test:backup",
  "pnpm test:postgres",
  "pnpm test:browser",
  "pnpm test:container",
  "pnpm test:chart",
  "pnpm chart:validate",
  "pnpm preview:validate",
  "pnpm audit --audit-level=high",
]) {
  if (!workflowText.includes(command)) errors.push(`workflow suite is missing ${command}`);
}
for (const required of ["GITHUB_SHA", "--sbom=true", "--provenance=mode=max", "packages: write", "attestations: write"]) {
  if (!workflowText.includes(required)) errors.push(`workflow suite is missing immutable publication control ${required}`);
}
for (const tool of ["HELM_IMAGE", "KUBECONFORM_IMAGE", "TRIVY_IMAGE"]) {
  const declaration = workflows.map(([, source]) => source.match(new RegExp(`${tool}:\\s+\\S+`))?.[0]).find(Boolean);
  if (!declaration || !immutableDigest.test(declaration)) errors.push(`workflow suite is missing a digest-pinned ${tool}`);
}
if (!workflowText.includes("actions/upload-artifact@") || !workflowText.includes("tracegarden-supply-chain-evidence") || !workflowText.includes("attestation-evidence.json")) {
  errors.push("workflow suite must persist digest, SBOM, and provenance evidence as an artifact");
}
if (!workflowText.includes("Install digest-pinned offline manifest tools") || !workflowText.includes("--network none") || !workflowText.includes("SHA256SUMS") || !workflowText.includes("delivery:schema")) {
  errors.push("workflow suite must provision checked-in schemas before offline validation");
}
if (!workflowText.includes("KUBECONFORM_SCHEMA_LOCATION")) {
  errors.push("workflow suite must pass an explicit local schema location");
}
if (!workflowText.includes("--exit-code 1") || !workflowText.includes("--severity HIGH,CRITICAL")) errors.push("workflow suite must fail on actionable image CVEs");
const exactReleaseSmoke = workflowText.indexOf("Smoke-test exact published digests");
const exactReleaseScan = workflowText.indexOf("Scan exact published digests before attestation");
const releaseAttestation = workflowText.indexOf("actions/attest-build-provenance@");
if (exactReleaseSmoke < 0 || exactReleaseScan < 0 || !workflowText.includes("CONTAINER_SMOKE_NO_BUILD: \"1\"")) {
  errors.push("release publication must smoke-test the exact pushed immutable digests without rebuilding");
}
if (exactReleaseScan < 0 || releaseAttestation < 0 || exactReleaseScan > releaseAttestation) {
  errors.push("release publication must scan pushed digests before attestation");
}
if (/--platform linux\/arm64/.test(workflowText) && !workflowText.includes("runs-on: ubuntu-24.04-arm")) {
  errors.push("ARM64 builds require a native ARM runner or immutable-pinned QEMU setup");
}
if (/:latest\b|:main\b|:master\b|:edge\b/.test(workflowText)) errors.push("workflow suite must not publish mutable image tags");

for (const path of ["deploy/docker/web.Dockerfile", "deploy/docker/collector.Dockerfile", "deploy/docker/migrate.Dockerfile", "deploy/docker/backup.Dockerfile"]) {
  const source = await readFile(path, "utf8");
  const bases = [...source.matchAll(/^FROM\s+(\S+)/gm)].map(([, image]) => image);
  if (!bases.length || bases.some((image) => !immutableDigest.test(image))) errors.push(`${path}: every base image must be digest-pinned`);
}
const compose = await readFile("docker-compose.yml", "utf8");
if (!/DATABASE_URL:\s+\$\{MIGRATION_DATABASE_URL:-/.test(compose)) errors.push("docker-compose migration DATABASE_URL must be parameterized");
for (const image of [...compose.matchAll(/^\s+image:\s+(\S+)/gm)].map(([, value]) => value)) {
  if (!immutableDigest.test(image)) errors.push(`docker-compose.yml: image is not digest-pinned (${image})`);
}
const migrationSmoke = await readFile("scripts/container-smoke.mjs", "utf8");
for (const required of ["not-a-postgresql-url", "tracegarden_schema_migrations", "invalid-URL", "schema-failure"]) {
  if (!migrationSmoke.includes(required)) errors.push(`container smoke is missing migration failure assertion ${required}`);
}
if (/\{\{\.Config\.Image\}\}@\{\{\.Image\}\}/.test(migrationSmoke) || !migrationSmoke.includes("imageIds") || !migrationSmoke.includes("^sha256:[a-f0-9]{64}$") || !migrationSmoke.includes("CONTAINER_SMOKE_IMAGE_FILE")) {
  errors.push("container smoke must keep local image IDs separate from registry digests");
}
if (!workflowText.includes("imagetools inspect --raw") || !workflowText.includes("-manifest.json")) {
  errors.push("publication must retain registry manifest evidence separately from local image IDs");
}
const schemaArchive = "deploy/kubeconform-schemas/kubernetes-v1.31.0-standalone-strict.tar.gz";
const schemaChecksums = await readFile("deploy/kubeconform-schemas/SHA256SUMS", "utf8");
if (!new RegExp(`^[a-f0-9]{64}\\s+${schemaArchive}$`, "m").test(schemaChecksums)) {
  errors.push("Kubernetes schema bundle must have a matching SHA-256 checksum");
}
const chartPackage = JSON.parse(await readFile("package.json", "utf8"));
if (!chartPackage.scripts["chart:validate"]?.includes("schema-location")) errors.push("chart validation must pass an explicit schema location");
const chartTest = await readFile("scripts/chart-test.mjs", "utf8");
if (!chartTest.includes("schemaLocation") || !chartTest.includes("-schema-location")) errors.push("chart tests must pass an explicit schema location");
const chartValues = await readFile("deploy/chart/values.yaml", "utf8");
const chartDigests = [...chartValues.matchAll(/^\s+digest:\s+(\S+)/gm)].map(([, digest]) => digest);
if (!chartDigests.length || !chartDigests.every((digest) => /^sha256:[a-f0-9]{64}$/.test(digest))) {
  errors.push("deploy/chart/values.yaml: every deployment digest must be immutable");
}

const deliveryDeclarations = {
  applicationSet: await readFile("deploy/preview/applicationset.yaml", "utf8"),
  applicationSetCrd: await readFile("deploy/preview/applicationset-crd.yaml", "utf8"),
  appProject: await readFile("deploy/preview/appproject.yaml", "utf8"),
  lifecycle: await readFile("deploy/preview/lifecycle-policy.yaml", "utf8"),
  previewValues: await readFile("deploy/preview/chart/values.yaml", "utf8"),
  promotion: await readFile("deploy/promotion/promotion.yaml", "utf8"),
  desiredState: await readFile("deploy/gitops/production/desired-state.yaml", "utf8"),
  productionApplication: await readFile("deploy/gitops/production/application.yaml", "utf8"),
  identity: await readFile("packages/identity/src/index.ts", "utf8"),
  lifecycleController: await readFile("deploy/preview/lifecycle-controller.yaml", "utf8"),
  previewArtifact: await readFile("scripts/preview-artifact.mjs", "utf8"),
  previewDeployments: await readFile("deploy/preview/chart/templates/deployments.yaml", "utf8"),
};
for (const [name, source] of Object.entries(deliveryDeclarations)) {
  if (source.includes("TODO")) errors.push(`${name}: delivery declaration cannot contain TODO placeholders`);
}
for (const path of Object.keys(deliveryDeclarations)) {
  if (!deliveryDeclarations[path].trim()) errors.push(`${path}: delivery declaration cannot be empty`);
}
if (!workflowText.includes("promotion-proposal") || !workflowText.includes("environment: production") || /git push|kubectl|kubeadm/i.test(workflowText)) {
  errors.push("promotion workflow must be protected, reviewable, and free of direct Cluster or Git pushes");
}
for (const required of ["preview-publish", "github.event.pull_request.draft == false", "PREVIEW_COMMIT", "preview-artifact.mjs", "preview-image-declaration.yaml", "environments/previews/digests/pr-", "preview-digests", "steps.web.outputs.digest", "steps.collector.outputs.digest", "steps.migrate.outputs.digest"]) {
  if (!workflowText.includes(required)) errors.push(`preview publication is missing ${required}`);
}
const applicationSet = deliveryDeclarations.applicationSet;
const applicationSetCrd = deliveryDeclarations.applicationSetCrd;
const appProject = deliveryDeclarations.appProject;
if (!applicationSetCrd.includes("name: applicationsets.argoproj.io") || !applicationSetCrd.includes("name: v1alpha1") || !applicationSetCrd.includes("openAPIV3Schema:")) {
  errors.push("preview ApplicationSet validation must use the vendored v1alpha1 Argo CD CRD schema");
}
const previewReadme = await readFile("deploy/preview/README.md", "utf8");
if (!previewReadme.includes("release `v3.4.6`") || !previewReadme.includes("https://raw.githubusercontent.com/argoproj/argo-cd/v3.4.6/manifests/crds/applicationset-crd.yaml")) {
  errors.push("preview ApplicationSet CRD provenance must name the pinned release and official source path");
}
if (!appProject.includes("group: networking.k8s.io\n      kind: NetworkPolicy") || !appProject.includes("group: policy\n      kind: PodDisruptionBudget")) {
  errors.push("preview AppProject must whitelist NetworkPolicy and PodDisruptionBudget in their API groups");
}
if (applicationSet.includes(".state") || applicationSet.includes(".draft") || applicationSet.includes("templatePatch")) {
  errors.push("ApplicationSet must use supported PR parameters without state/draft template assumptions");
}
if (!applicationSet.includes("repoURL: https://github.com/MISAKA3389/tracegarden-gitops.git") || !applicationSet.includes("targetRevision: main") || applicationSet.includes("head_sha")) {
  errors.push("preview chart and values must come from the protected GitOps repository main, not a PR head");
}
if (!applicationSet.includes("syncPolicy:\n    preserveResourcesOnDeletion: false") || applicationSet.includes("template.spec.syncPolicy.preserveResourcesOnDeletion")) {
  errors.push("preserveResourcesOnDeletion must be on the ApplicationSet spec.syncPolicy");
}
if (applicationSet.includes("valuesObject") || applicationSet.includes("preview.access")) {
  errors.push("preview workload and Cloudflare configuration must not be PR-selected Helm overrides");
}
if (applicationSet.includes("CreateNamespace") || !deliveryDeclarations.lifecycle.includes("provisionBeforeEligibility: true")) {
  errors.push("preview namespaces and pull authentication must be provisioned before eligibility");
}
if (/preview-(?:web|collector|migrate)-digest=/.test(applicationSet) || applicationSet.includes("pull-request-digest-label")) {
  errors.push("preview image handoff must not use GitHub labels");
}
for (const required of ["valueFiles", "../digests/pr-{{.number}}.yaml", "ignoreMissingValueFiles: false", "kind: CronJob", "resources: [namespaces]", "deleteNamespace", "setPreviewLabel", "imagePullSecrets", "serviceAccountName: {{ .Values.serviceAccount.name }}", "aggregateCpu", "productionCpu", "missing-trusted-digest", "remoteWrite: false"]) {
  if (!workflowText.includes(required) && !Object.values(deliveryDeclarations).some((source) => source.includes(required))) {
    errors.push(`delivery declaration is missing ${required}`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`offline delivery policy passed: ${actionFiles.length} workflow(s), pinned bases, images, permissions, and credential boundary`);
}
