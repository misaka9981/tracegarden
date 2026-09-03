import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const errors = [];
const immutableDigest = /@sha256:[a-f0-9]{64}/;
const bunImage = "docker.io/oven/bun:1.4.0-distroless@sha256:76caa97ddc0e01333d98c6ab5499539dad4bbceae6237eac83e7853d3826b981";
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
  if (!source.split("\n").some((line) => line.trim() === "contents: read")) errors.push(`${path}: a read-only contents permission is required`);
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
for (const required of ["GITHUB_SHA", "packages: write", "attestations: write"]) {
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
if (!workflowText.includes('"$BUN_IMAGE" scripts/migrate-bun-smoke.mjs')) errors.push("workflow suite must run the Bun migration smoke");
if (!workflowText.includes('"$BUN_IMAGE" scripts/backup-test.mjs')) errors.push("workflow suite must run the backup test under Bun");
const ciWorkflow = workflows.find(([path]) => path === ".github/workflows/ci.yml")?.[1] ?? "";
const proofFile = workflows.find(([path]) => path === ".github/workflows/attestation-proof.yml")?.[1] ?? "";
if (!proofFile.includes("on:\n  workflow_dispatch:") || !proofFile.includes("packages: write") || !proofFile.includes("actions/attest@59d89421af93a897026c735860bf21b6eb4f7b26") || !proofFile.includes("sbom-path: .scratch/tracegarden-proof-sbom/web.spdx.json") || !proofFile.includes("docker pull --platform linux/arm64 \"$TRIVY_IMAGE\"") || !proofFile.includes("test -s \"$sbom_dir/web.spdx.json\"")) {
  errors.push("workflow suite must retain the bounded standalone SBOM attestation proof");
}
const publishStart = ciWorkflow.indexOf("\n  publish:");
const publishEnd = ciWorkflow.indexOf("\n  promotion-proposal:", publishStart);
const publishWorkflow = publishStart >= 0 && publishEnd > publishStart ? ciWorkflow.slice(publishStart, publishEnd) : "";
const exactReleaseSmoke = publishWorkflow.indexOf("Smoke-test exact published digests");
const exactReleaseScan = publishWorkflow.indexOf("Scan exact published digests before attestation");
const releaseSbomGeneration = publishWorkflow.indexOf("Generate SBOMs for exact published digests");
const releaseProvenance = publishWorkflow.indexOf("actions/attest-build-provenance@");
const releaseSbom = publishWorkflow.indexOf("actions/attest@");
if (exactReleaseSmoke < 0 || exactReleaseScan < 0 || !publishWorkflow.includes("CONTAINER_SMOKE_NO_BUILD: \"1\"")) {
  errors.push("release publication must smoke-test the exact pushed immutable digests without rebuilding");
}
if (exactReleaseSmoke < 0 || exactReleaseScan <= exactReleaseSmoke || releaseSbomGeneration < 0 || releaseProvenance < 0 || releaseSbom < 0 || exactReleaseScan > releaseSbomGeneration || exactReleaseScan > releaseProvenance || exactReleaseScan > releaseSbom) {
  errors.push("release publication must scan pushed digests before SBOM and provenance attestation");
}
const releasePreGate = publishWorkflow.slice(0, Math.max(releaseSbomGeneration, 0));
if (/--provenance=(?!false\b)|--sbom=(?!false\b)|actions\/attest-(?:sbom|build-provenance)@/.test(releasePreGate)) {
  errors.push("release publication must not produce or attach provenance/SBOM before exact-digest gates");
}
const releaseBuilds = [...publishWorkflow.matchAll(/docker buildx build[^\n]*/g)].map(([line]) => line);
if (releaseBuilds.length !== 4 || releaseBuilds.some((line) => !line.includes("--provenance=false") || !line.includes("--sbom=false"))) {
  errors.push("web, collector, migrate, and backup release builds must disable Buildx provenance and SBOM before gates");
}
if (releaseBuilds.some((line) => !line.includes("--network none") || !line.includes("--pull=false"))) {
  errors.push("release builds must disable network access and base-image pulls");
}
const releasePostGate = publishWorkflow.slice(Math.max(releaseSbomGeneration, 0));
const releaseStepBlock = (name) => {
  const start = releasePostGate.indexOf("- name: " + name);
  if (start < 0) return "";
  const end = releasePostGate.indexOf("\n      - ", start + 1);
  return releasePostGate.slice(start, end < 0 ? releasePostGate.length : end);
};
for (const service of ["web", "collector", "migrate", "backup"]) {
  const subjectName = "subject-name: ${{ env.IMAGE_PREFIX }}-" + service;
  const subjectDigest = "subject-digest: ${{ steps." + service + ".outputs.digest }}";
  const sbomStep = releaseStepBlock("Attest " + service + " SBOM");
  const provenanceStep = releaseStepBlock("Attest " + service + " provenance");
  if (!sbomStep.includes("uses: actions/attest@") || !sbomStep.includes(subjectName) || !sbomStep.includes(subjectDigest) || !sbomStep.includes("sbom-path: .scratch/tracegarden-release-sbom/" + service + ".spdx.json")) {
    errors.push(`release SBOM attestation is missing the exact ${service} digest or SBOM`);
  }
  if (!provenanceStep.includes("uses: actions/attest-build-provenance@") || !provenanceStep.includes(subjectName) || !provenanceStep.includes(subjectDigest)) {
    errors.push(`release provenance attestation is missing the exact ${service} digest`);
  }
  if (releasePostGate.indexOf("Attest " + service + " SBOM") > releasePostGate.indexOf("Attest " + service + " provenance")) {
    errors.push(`release attestations are out of order for ${service}`);
  }
}
if ((publishWorkflow.match(/uses: actions\/attest@[0-9a-f]{40}/g) ?? []).length !== 4 || (publishWorkflow.match(/uses: actions\/attest-build-provenance@[0-9a-f]{40}/g) ?? []).length !== 4) {
  errors.push("release publication must attach both SBOM and provenance for all four images");
}
if (!releasePostGate.includes("--format spdx-json") || !releasePostGate.includes("tracegarden-release-sbom")) {
  errors.push("release publication must generate SBOMs for exact pushed digests after the gates");
}
if (!releasePostGate.includes('sbom_dir=".scratch/tracegarden-release-sbom"') || !releasePostGate.includes('test -s "$sbom_dir/${service}.spdx.json"') || !releasePostGate.includes("jq -e 'type == \"object\" and has(\"spdxVersion\") and has(\"SPDXID\")'")) {
  errors.push("release publication must stat, parse, and retain each SBOM before attestation");
}
for (const required of [
  "backup_digest: ${{ steps.backup.outputs.digest }}",
  "backup_ref=\"${IMAGE_PREFIX}-backup@${{ steps.backup.outputs.digest }}\"",
  "CONTAINER_SMOKE_BACKUP: \"1\"",
]) {
  if (!workflowText.includes(required)) errors.push(`release backup gate is missing ${required}`);
}
const previewStart = ciWorkflow.indexOf("\n  preview-publish:");
const previewEnd = ciWorkflow.indexOf("\n  security:", previewStart);
const previewWorkflow = previewStart >= 0 && previewEnd > previewStart ? ciWorkflow.slice(previewStart, previewEnd) : "";
const previewBuilds = [...previewWorkflow.matchAll(/docker buildx build[^\n]*/g)].map(([line]) => line);
const previewSmoke = previewWorkflow.indexOf("Smoke-test exact preview digests");
const previewScan = previewWorkflow.indexOf("Scan exact preview digests before attestation");
const previewSbom = previewWorkflow.indexOf("Generate SBOMs for exact preview digests");
if (previewBuilds.length !== 4 || previewBuilds.some((line) => !line.includes("--provenance=false") || !line.includes("--sbom=false") || !line.includes("--network none") || !line.includes("--pull=false"))) {
  errors.push("preview publication must build all four images once with pre-gate attestations disabled");
}
if (previewSmoke < 0 || previewScan <= previewSmoke || previewSbom <= previewScan || !previewWorkflow.includes("CONTAINER_SMOKE_NO_BUILD: \"1\"")) {
  errors.push("preview publication must smoke-test exact digests without a second build and CVE-scan before SBOM generation");
}
const previewPreGate = previewWorkflow.slice(0, Math.max(previewSbom, 0));
if (/actions\/attest-(?:sbom|build-provenance)@/.test(previewPreGate) || previewPreGate.includes("--provenance=mode") || previewPreGate.includes("--sbom=true")) {
  errors.push("preview publication must not attach or generate attestations before exact-digest gates");
}
const previewPostGate = previewWorkflow.slice(Math.max(previewSbom, 0));
for (const service of ["web", "collector", "migrate", "backup"]) {
  if (!previewPostGate.includes("Attest preview " + service + " SBOM") || !previewPostGate.includes("Attest preview " + service + " provenance") || !previewPostGate.includes("subject-digest: ${{ steps." + service + ".outputs.digest }}")) {
    errors.push(`preview publication is missing post-gate attestations for ${service}`);
  }
  if (previewPostGate.indexOf("Attest preview " + service + " SBOM") > previewPostGate.indexOf("Attest preview " + service + " provenance")) {
    errors.push(`preview attestations are out of order for ${service}`);
  }
}
if (!previewWorkflow.includes("backup_digest: ${{ steps.backup.outputs.digest }}") || !previewWorkflow.includes("BACKUP_REPOSITORY=\"${IMAGE_PREFIX}-backup\"") || !previewWorkflow.includes("BACKUP_DIGEST=\"${{ steps.backup.outputs.digest }}\"")) {
  errors.push("preview publication must carry the exact backup digest into its artifact outputs");
}
if (!previewPostGate.includes('sbom_dir=".scratch/tracegarden-preview-sbom"') || !previewPostGate.includes('test -s "$sbom_dir/${service}.spdx.json"') || !previewPostGate.includes("jq -e 'type == \"object\" and has(\"spdxVersion\") and has(\"SPDXID\")'")) {
  errors.push("preview publication must stat and parse each SBOM before attestation");
}
if (/--platform linux\/arm64/.test(workflowText) && !workflowText.includes("runs-on: ubuntu-24.04-arm")) {
  errors.push("ARM64 builds require a native ARM runner or immutable-pinned QEMU setup");
}
if (/:latest\b|:main\b|:master\b|:edge\b/.test(workflowText)) errors.push("workflow suite must not publish mutable image tags");
if (workflowText.includes("NODE_IMAGE") || workflowText.includes("node:26-bookworm")) errors.push("production container workflow must not require a Node runtime image");

for (const path of ["deploy/docker/web.Dockerfile", "deploy/docker/collector.Dockerfile", "deploy/docker/migrate.Dockerfile", "deploy/docker/backup.Dockerfile"]) {
  const source = await readFile(path, "utf8");
  const bases = [...source.matchAll(/^FROM\s+(\S+)/gm)].map(([, image]) => image);
  if (!bases.length || bases.some((image) => !immutableDigest.test(image))) errors.push(`${path}: every base image must be digest-pinned`);
  const bunBases = bases.filter((image) => image === bunImage);
  if (bunBases.length !== 1) errors.push(`${path}: exactly one shared pinned Bun base is required`);
  if (/^FROM\s+node:|(?:CMD|ENTRYPOINT)\s+\["node"/im.test(source)) errors.push(`${path}: Node cannot remain a production runtime`);
}
const collectorDockerfile = await readFile("deploy/docker/collector.Dockerfile", "utf8");
if (!collectorDockerfile.startsWith(`FROM ${bunImage}\n`)) errors.push("collector Dockerfile must use the pinned Bun 1.4.0 distroless base");
if (!collectorDockerfile.includes('USER nonroot') || !collectorDockerfile.includes('CMD ["dist/apps/collector/src/main.js"]')) errors.push("collector Dockerfile must run as Bun without a Node entrypoint");
if (/^FROM\s+node:/m.test(collectorDockerfile) || /CMD \["node"/.test(collectorDockerfile)) errors.push("collector Dockerfile must not retain a Node runtime");
const migrateDockerfile = await readFile("deploy/docker/migrate.Dockerfile", "utf8");
if (!migrateDockerfile.startsWith(`FROM ${bunImage}\n`) || !migrateDockerfile.includes('USER nonroot') || !migrateDockerfile.includes('CMD ["dist/apps/migrate/src/main.js"]') || /^FROM\s+node:/m.test(migrateDockerfile) || /CMD \["node"/.test(migrateDockerfile)) {
  errors.push("migration Dockerfile must use the pinned Bun runtime and no Node entrypoint");
}
const backupDockerfile = await readFile("deploy/docker/backup.Dockerfile", "utf8");
const backupScript = await readFile("scripts/backup.mjs", "utf8");
if (/apt-get|awscli|spawn\(\s*["']aws["']/.test(backupDockerfile) || !backupDockerfile.includes("COPY --from=postgres-runtime /usr/local/bin/pg_dump") || !backupDockerfile.includes("COPY --from=postgres-runtime /usr/local/bin/pg_restore")) {
  errors.push("backup image must use the pinned PostgreSQL runtime and no mutable apt/awscli dependency");
}
if (!backupDockerfile.includes(`FROM ${bunImage}`) || !backupDockerfile.includes('USER nonroot') || !backupDockerfile.includes('ENTRYPOINT ["bun", "/app/backup.mjs"]') || /^FROM\s+node:/m.test(backupDockerfile) || /ENTRYPOINT \["node"/.test(backupDockerfile)) {
  errors.push("backup Dockerfile must use the pinned Bun runtime without a Node fallback");
}
if (/spawn\(\s*["']aws["']/.test(backupScript) || !backupScript.includes("createHmac") || !backupScript.includes("fetch(endpointUrl")) {
  errors.push("backup uploader must use the owned native SigV4 fetch path");
}
const compose = await readFile("docker-compose.yml", "utf8");
if (!/DATABASE_URL:\s+\$\{MIGRATION_DATABASE_URL:-/.test(compose)) errors.push("docker-compose migration DATABASE_URL must be parameterized");
const webCompose = compose.slice(compose.indexOf("  web:\n"), compose.indexOf("  collector:\n"));
if (!/\n    user: nonroot\n/.test(webCompose)) errors.push("docker-compose web service must run as the Bun image user");
const migrateCompose = compose.slice(compose.indexOf("  migrate:\n"), compose.indexOf("  web:\n"));
if (!/\n    user: nonroot\n/.test(migrateCompose)) errors.push("docker-compose migration service must run as the Bun image user");
for (const image of [...compose.matchAll(/^\s+image:\s+(\S+)/gm)].map(([, value]) => value)) {
  if (!immutableDigest.test(image)) errors.push(`docker-compose.yml: image is not digest-pinned (${image})`);
}
const migrationSmoke = await readFile("scripts/container-smoke.mjs", "utf8");
for (const required of ["not-a-postgresql-url", "tracegarden_schema_migrations", "invalid-URL", "schema-failure"]) {
  if (!migrationSmoke.includes(required)) errors.push(`container smoke is missing migration failure assertion ${required}`);
}
if (!migrationSmoke.includes("build\", \"--pull=false\"") || !migrationSmoke.includes("up\", \"-d\", \"--pull\", \"never\", \"--no-build")) {
  errors.push("migration failure smoke must build offline and start with pull-never/no-build");
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
const kubeconformAdapter = await readFile("scripts/kubeconform.mjs", "utf8");
if (!chartPackage.scripts["chart:validate"]?.includes("kubeconform.mjs") || !kubeconformAdapter.includes("-schema-location")) errors.push("chart validation must pass an explicit schema location");
const chartTest = await readFile("scripts/chart-test.mjs", "utf8");
if (!chartTest.includes("kubeconform.mjs") || !kubeconformAdapter.includes("-schema-location")) errors.push("chart tests must pass an explicit schema location");
const chartValues = await readFile("deploy/chart/values.yaml", "utf8");
const chartHelpers = await readFile("deploy/chart/templates/_helpers.tpl", "utf8");
const backupValues = chartValues.slice(chartValues.indexOf("  backup:\n"), chartValues.indexOf("  postgres:\n"));
if (!chartValues.includes("enabled: false") || !backupValues.includes('digest: ""')) {
  errors.push("backup chart defaults must omit the image and contain no sentinel digest");
}
if (!chartHelpers.includes("images.backup.digest is required when backup.enabled is true")) {
  errors.push("backup chart must fail closed when enabled without an immutable digest");
}
const chartDigests = [...chartValues.matchAll(/^\s+digest:\s+(\S+)/gm)].map(([, digest]) => digest).filter((digest) => digest !== '""');
if (chartDigests.length !== 4 || !chartDigests.every((digest) => /^sha256:[a-f0-9]{64}$/.test(digest))) {
  errors.push("deploy/chart/values.yaml: configured image digests must be immutable");
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
for (const required of ["preview-publish", "github.event.pull_request.draft == false", "PREVIEW_COMMIT", "preview-artifact.mjs", "preview-image-declaration.yaml", "environments/previews/digests/pr-", "preview-digests", "steps.web.outputs.digest", "steps.collector.outputs.digest", "steps.migrate.outputs.digest", "steps.backup.outputs.digest", "BACKUP_REPOSITORY=", "BACKUP_DIGEST="]) {
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
if (!applicationSet.includes("repoURL: https://github.com/misaka9981/tracegarden-gitops.git") || !applicationSet.includes("targetRevision: main") || applicationSet.includes("head_sha")) {
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
