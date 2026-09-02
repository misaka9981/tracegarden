import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
assert.match(packageJson.scripts["chart:render"], /KUBECONFIG=\/dev\/null helm template/);
assert.match(packageJson.scripts["chart:validate"], /helm template/);
assert.match(packageJson.scripts["chart:validate"], /kubeconform/);
assert.match(packageJson.scripts["chart:validate"], /schema-location/);
assert.match(packageJson.scripts["chart:validate"], /KUBECONFORM_SCHEMA_LOCATION/);

const schema = JSON.parse(await readFile(new URL("../deploy/chart/values.schema.json", import.meta.url)));
const values = await readFile(new URL("../deploy/chart/values.yaml", import.meta.url), "utf8");
const templates = await Promise.all([
  "deployments.yaml",
  "backup-cronjob.yaml",
  "migration-job.yaml",
  "networkpolicies.yaml",
  "rbac.yaml",
  "serviceaccounts.yaml",
].map((name) => readFile(new URL(`../deploy/chart/templates/${name}`, import.meta.url), "utf8")));
const [deployments, backup, migration, networkPolicies, rbac, serviceAccounts] = templates;
const webSource = await readFile(new URL("../apps/web/src/server.ts", import.meta.url), "utf8");
const collectorSource = await readFile(new URL("../apps/collector/src/main.ts", import.meta.url), "utf8");
const migrationSource = await readFile(new URL("../apps/migrate/src/main.ts", import.meta.url), "utf8");
const postgres = await readFile(new URL("../deploy/chart/templates/postgres.yaml", import.meta.url), "utf8");
const helpers = await readFile(new URL("../deploy/chart/templates/_helpers.tpl", import.meta.url), "utf8");

assert.ok(schema.required.includes("rbac"));
assert.ok(schema.required.includes("backup"));
assert.ok(schema.properties.images.required.includes("backup"));
assert.match(values, /enabled: false/);
assert.match(backup, /kind: CronJob/);
assert.match(backup, /suspend: \{\{ not \.Values\.backup\.enabled \}\}/);
assert.match(backup, /BACKUP_ENCRYPTION_MECHANISM/);
assert.match(backup, /BACKUP_CREDENTIALS_SOURCE/);
assert.match(backup, /secretKeyRef:/);
assert.doesNotMatch(backup, /kind: ConfigMap/);
assert.ok(schema.properties.migration.required.includes("databaseReadyTimeoutSeconds"));
assert.ok(schema.properties.migration.required.includes("databaseReadyRetrySeconds"));
assert.ok(schema.properties.migration.required.includes("schemaReadyTimeoutSeconds"));
assert.ok(schema.properties.migration.required.includes("schemaReadyRetrySeconds"));
assert.deepEqual(schema.properties.networkPolicy.required, [
  "controlPlaneCIDRs",
  "controlPlanePort",
  "googleOAuthCIDRs",
  "ingressNamespace",
  "dnsNamespace",
  "dnsPodSelector",
]);
assert.equal("enabled" in schema.properties.networkPolicy.properties, false);
assert.match(values, /controlPlanePort: 6443/);
assert.match(values, /databaseReadyTimeoutSeconds: 120/);
assert.match(values, /databaseReadyRetrySeconds: 2/);
assert.match(values, /schemaReadyTimeoutSeconds: 600/);
assert.match(values, /schemaReadyRetrySeconds: 2/);
assert.match(values, /limits:\n      cpu: "1"\n      memory: 1Gi/);
assert.ok(schema.properties.serviceAccount.allOf.some(({ if: condition }) => condition.properties.create.const === false));
assert.match(helpers, /must identify different ServiceAccounts/);
assert.match(helpers, /define "tracegarden.migrationJobName"/);
assert.match(helpers, /define "tracegarden.schemaWaitScript"/);
assert.doesNotMatch(helpers, /\.migrate\(\)/);
assert.doesNotMatch(migration, /helm\.sh\/hook/);
assert.match(migration, /argocd\.argoproj\.io\/sync-wave: "0"/);
assert.match(migration, /MIGRATION_DATABASE_READY_TIMEOUT_SECONDS/);
assert.match(migration, /MIGRATION_DATABASE_READY_RETRY_SECONDS/);
assert.match(migration, /databaseReadyTimeoutSeconds/);
assert.match(migration, /databaseReadyRetrySeconds/);
assert.match(deployments, /initContainers:/);
assert.match(deployments, /wait-for-schema/);
assert.match(deployments, /MIGRATION_SCHEMA_READY_TIMEOUT_SECONDS/);
assert.match(deployments, /MIGRATION_SCHEMA_READY_RETRY_SECONDS/);
assert.match(helpers, /waitForMigrations/);
assert.doesNotMatch(helpers, /\.migrate\(\)/);
assert.doesNotMatch(deployments, /\.migrate\(\)/);
assert.match(deployments, /argocd\.argoproj\.io\/sync-wave: "1"/);
assert.match(postgres, /argocd\.argoproj\.io\/sync-wave: "-2"/);
assert.match(postgres, /kind: Service/);
assert.match(postgres, /kind: StatefulSet/);
assert.doesNotMatch(postgres, /helm\.sh\/hook/);
assert.match(webSource, /verifyMigrations/);
assert.match(collectorSource, /verifyMigrations/);
assert.ok(migrationSource.indexOf("await waitForDatabase(database)") < migrationSource.indexOf("await database.migrate()"));
assert.match(migrationSource, /waitForDatabase/);
assert.match(migrationSource, /MIGRATION_DATABASE_READY_TIMEOUT_SECONDS/);
assert.match(migrationSource, /MIGRATION_DATABASE_READY_RETRY_SECONDS/);
assert.doesNotMatch(deployments, /KUBERNETES_(?:OBSERVATION|LOG)_TOKEN/);
assert.doesNotMatch(values, /KUBERNETES_(?:OBSERVATION|LOG)_TOKEN/);
assert.match(networkPolicies, /googleOAuthCIDRs/);
assert.match(networkPolicies, /controlPlanePort/);
assert.match(networkPolicies, /app\.kubernetes\.io\/component: backup/);
assert.match(networkPolicies, /endpointCIDRs/);
assert.match(rbac, /range \.Values\.rbac\.namespaces/);
assert.match(rbac, /\.Values\.rbac\.resourceKinds/);
assert.match(serviceAccounts, /automountServiceAccountToken: true/);
assert.match(deployments, /automountServiceAccountToken: true/);
assert.match(deployments, /serviceAccountName: .*logsServiceAccount/);
assert.match(deployments, /serviceAccountName: .*observationServiceAccount/);

const schemaDirectory = process.env.KUBECONFORM_SCHEMA_LOCATION?.trim()
  || `${pathToFileURL(`${process.cwd()}/.ci/kubeconform-schemas/v1.31.0-standalone-strict`).href}/`;
const schemaLocation = `${schemaDirectory}{{ .ResourceKind }}{{ .KindSuffix }}.json`;

function renderChart(extraArgs = []) {
  return spawnSync("helm", [
    "template", "tracegarden", "deploy/chart", "--namespace", "tracegarden", "--kube-version", "1.31.0", ...extraArgs,
  ], {
    encoding: "utf8",
    env: { ...process.env, KUBECONFIG: "/dev/null" },
  });
}

function renderAndValidate(extraArgs = []) {
  const render = renderChart(extraArgs);
  assert.equal(render.status, 0, render.stderr || "helm template failed");
  const validation = spawnSync("kubeconform", ["-schema-location", schemaLocation, "-strict", "-kubernetes-version", "1.31.0", "-summary"], {
    encoding: "utf8",
    input: render.stdout,
    env: { ...process.env, KUBECONFIG: "/dev/null" },
  });
  assert.equal(validation.status, 0, validation.stderr || validation.stdout || "kubeconform failed");
  return render.stdout;
}

const freshRender = renderAndValidate();
const upgradeDigest = `sha256:${"1".repeat(64)}`;
const upgradeRender = renderAndValidate(["--set", `images.migrate.digest=${upgradeDigest}`]);
const failureRender = renderAndValidate(["--set", "migration.backoffLimit=0"]);
const migrationName = (render) => render.match(/name: ([a-z0-9-]+-migration-[a-f0-9]{12})\n/)?.[1];
assert.ok(migrationName(freshRender));
assert.notEqual(migrationName(freshRender), migrationName(upgradeRender));
assert.equal((freshRender.match(/^kind:/gm) ?? []).length, 21);
assert.equal((upgradeRender.match(/^kind:/gm) ?? []).length, 21);
assert.match(freshRender, /kind: CronJob/);
assert.match(freshRender, /suspend: true/);
assert.doesNotMatch(freshRender, /name: BACKUP_ENDPOINT/);
const disabledEndpointRender = renderAndValidate(["--set", "backup.endpoint=https://storage.example.test"]);
assert.doesNotMatch(disabledEndpointRender, /name: BACKUP_ENDPOINT/);
const disabledIpv4EndpointRender = renderAndValidate(["--set", "backup.endpoint=https://1.1.1.1"]);
assert.doesNotMatch(disabledIpv4EndpointRender, /name: BACKUP_ENDPOINT/);
const completeEnabledBackupArgs = [
  "--set", `images.backup.digest=sha256:${"5".repeat(64)}`,
  "--set", "backup.enabled=true",
  "--set", "backup.endpoint=https://storage.example.test",
  "--set", "backup.endpointCIDRs[0]=1.1.1.0/24",
  "--set", "backup.bucket=tracegarden-backups",
  "--set", "backup.schedule=0 2 * * *",
  "--set", "backup.retentionDays=30",
  "--set", "backup.encryption.mechanism=aes-256-gcm",
  "--set", "backup.encryption.keySecret.existingSecret=tracegarden-backup-encryption",
  "--set", "backup.encryption.keySecret.key=BACKUP_ENCRYPTION_KEY",
  "--set", "backup.credentials.existingSecret=tracegarden-backup-storage",
  "--set", "backup.credentials.accessKeyIdKey=AWS_ACCESS_KEY_ID",
  "--set", "backup.credentials.secretAccessKeyKey=AWS_SECRET_ACCESS_KEY",
];
const enabledRender = renderAndValidate(completeEnabledBackupArgs);
assert.match(enabledRender, /suspend: false/);
assert.match(enabledRender, /backup-status: "configured"/);
assert.match(enabledRender, /tracegarden-backup@sha256:5555555555555555555555555555555555555555555555555555555555555555/);
const placeholderEnabledRender = renderChart([
  ...completeEnabledBackupArgs,
  "--set", "images.backup.digest=sha256:4444444444444444444444444444444444444444444444444444444444444444",
]);
assert.notEqual(placeholderEnabledRender.status, 0, "enabled backup must reject the digest placeholder");
const enabledIpv4Render = renderAndValidate([...completeEnabledBackupArgs, "--set", "backup.endpoint=https://1.1.1.1"]);
assert.match(enabledIpv4Render, /suspend: false/);
const placeholderRender = renderChart(completeEnabledBackupArgs.map((argument) => argument.replace("1.1.1.0/24", "192.0.2.0/24")));
assert.notEqual(placeholderRender.status, 0, "backup must reject placeholder endpoint CIDRs when enabled");
for (const endpoint of [
  "https://:",
  "https://storage.example.test/?token=secret",
  "https://storage.example.test#fragment",
  "https://user:secret@storage.example.test",
]) {
  const unsafeEndpointRender = renderChart(["--set", "backup.enabled=true", "--set", `backup.endpoint=${endpoint}`]);
  assert.notEqual(unsafeEndpointRender.status, 0, `backup must reject unsafe endpoint ${endpoint}`);
  const disabledUnsafeEndpointRender = renderChart(["--set", "backup.enabled=false", "--set", `backup.endpoint=${endpoint}`]);
  assert.notEqual(disabledUnsafeEndpointRender.status, 0, `disabled backup must reject unsafe endpoint ${endpoint}`);
  const skipSchemaUnsafeEndpointRender = renderChart(["--skip-schema-validation", "--set", `backup.endpoint=${endpoint}`]);
  assert.notEqual(skipSchemaUnsafeEndpointRender.status, 0, `Helm validation must reject unsafe endpoint ${endpoint}`);
}
const invalidNumericEndpoint = "https://256.256.256.256";
const disabledInvalidNumericEndpointRender = renderChart(["--set", `backup.endpoint=${invalidNumericEndpoint}`]);
assert.notEqual(disabledInvalidNumericEndpointRender.status, 0, "disabled backup must reject invalid numeric endpoints");
assert.equal(disabledInvalidNumericEndpointRender.stdout, "", "invalid disabled endpoint must fail before manifest rendering");
const enabledInvalidNumericEndpointRender = renderChart([...completeEnabledBackupArgs, "--set", `backup.endpoint=${invalidNumericEndpoint}`]);
assert.notEqual(enabledInvalidNumericEndpointRender.status, 0, "enabled backup must reject invalid numeric endpoints");
assert.equal(enabledInvalidNumericEndpointRender.stdout, "", "invalid enabled endpoint must fail before manifest rendering");
const skipSchemaInvalidNumericEndpointRender = renderChart(["--skip-schema-validation", "--set", `backup.endpoint=${invalidNumericEndpoint}`]);
assert.notEqual(skipSchemaInvalidNumericEndpointRender.status, 0, "Helm validation must reject invalid numeric endpoints without schema validation");
const skipSchemaEnabledInvalidNumericEndpointRender = renderChart(["--skip-schema-validation", ...completeEnabledBackupArgs, "--set", `backup.endpoint=${invalidNumericEndpoint}`]);
assert.notEqual(skipSchemaEnabledInvalidNumericEndpointRender.status, 0, "enabled Helm validation must reject invalid numeric endpoints without schema validation");
for (const cidr of ["999.1.1.0/24", "1.1.1.0/33", "1.1.1/24"]) {
  const invalidCidrRender = renderChart(["--set", `backup.endpointCIDRs[0]=${cidr}`]);
  assert.notEqual(invalidCidrRender.status, 0, `disabled backup must reject invalid endpoint CIDR ${cidr}`);
  const enabledInvalidCidrRender = renderChart([...completeEnabledBackupArgs, "--set", `backup.endpointCIDRs[0]=${cidr}`]);
  assert.notEqual(enabledInvalidCidrRender.status, 0, `backup must reject invalid endpoint CIDR ${cidr}`);
  const skipSchemaInvalidCidrRender = renderChart(["--skip-schema-validation", "--set", `backup.endpointCIDRs[0]=${cidr}`]);
  assert.notEqual(skipSchemaInvalidCidrRender.status, 0, `Helm validation must reject invalid endpoint CIDR ${cidr}`);
}
assert.match(enabledRender, /BACKUP_DESTINATION_SCOPE/);
assert.match(enabledRender, /aes-256-gcm/);
assert.match(freshRender, /argocd\.argoproj\.io\/sync-wave: "-2"/);
assert.match(freshRender, /argocd\.argoproj\.io\/sync-wave: "0"/);
assert.match(freshRender, /argocd\.argoproj\.io\/sync-wave: "1"/);
assert.match(freshRender, /kind: StatefulSet/);
assert.match(freshRender, /kind: Deployment/);
assert.match(freshRender, /MIGRATION_DATABASE_READY_TIMEOUT_SECONDS/);
assert.match(freshRender, /MIGRATION_SCHEMA_READY_TIMEOUT_SECONDS/);
assert.doesNotMatch(freshRender, /helm\.sh\/hook/);
assert.match(failureRender, /backoffLimit: 0/);
assert.match(failureRender, /activeDeadlineSeconds: 600/);
assert.match(failureRender, /waitForMigrations/);

console.log("offline chart render, upgrade, failure-gate, and policy checks passed");
