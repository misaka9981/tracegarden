import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
assert.match(packageJson.scripts["chart:render"], /KUBECONFIG=\/dev\/null helm template/);
assert.match(packageJson.scripts["chart:validate"], /helm template/);
assert.match(packageJson.scripts["chart:validate"], /kubeconform/);

const schema = JSON.parse(await readFile(new URL("../deploy/chart/values.schema.json", import.meta.url)));
const values = await readFile(new URL("../deploy/chart/values.yaml", import.meta.url), "utf8");
const templates = await Promise.all([
  "deployments.yaml",
  "migration-job.yaml",
  "networkpolicies.yaml",
  "rbac.yaml",
  "serviceaccounts.yaml",
].map((name) => readFile(new URL(`../deploy/chart/templates/${name}`, import.meta.url), "utf8")));
const [deployments, migration, networkPolicies, rbac, serviceAccounts] = templates;
const webSource = await readFile(new URL("../apps/web/src/server.ts", import.meta.url), "utf8");
const collectorSource = await readFile(new URL("../apps/collector/src/main.ts", import.meta.url), "utf8");
const migrationSource = await readFile(new URL("../apps/migrate/src/main.ts", import.meta.url), "utf8");
const postgres = await readFile(new URL("../deploy/chart/templates/postgres.yaml", import.meta.url), "utf8");
const helpers = await readFile(new URL("../deploy/chart/templates/_helpers.tpl", import.meta.url), "utf8");

assert.ok(schema.required.includes("rbac"));
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
assert.match(rbac, /range \.Values\.rbac\.namespaces/);
assert.match(rbac, /\.Values\.rbac\.resourceKinds/);
assert.match(serviceAccounts, /automountServiceAccountToken: true/);
assert.match(deployments, /automountServiceAccountToken: true/);
assert.match(deployments, /serviceAccountName: .*logsServiceAccount/);
assert.match(deployments, /serviceAccountName: .*observationServiceAccount/);

function renderAndValidate(extraArgs = []) {
  const render = spawnSync("helm", [
    "template", "tracegarden", "deploy/chart", "--namespace", "tracegarden", "--kube-version", "1.31.0", ...extraArgs,
  ], {
    encoding: "utf8",
    env: { ...process.env, KUBECONFIG: "/dev/null" },
  });
  assert.equal(render.status, 0, render.stderr || "helm template failed");
  const validation = spawnSync("kubeconform", ["-strict", "-kubernetes-version", "1.31.0", "-summary"], {
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
assert.equal((freshRender.match(/^kind:/gm) ?? []).length, 19);
assert.equal((upgradeRender.match(/^kind:/gm) ?? []).length, 19);
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
