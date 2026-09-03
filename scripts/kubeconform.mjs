import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { dump, loadAll } from "js-yaml";

const schemaDirectory = process.argv[2] ?? ".ci/kubeconform-schemas/v1.31.0-standalone-strict";
const schemaFiles = {
  "ConfigMap/v1": "configmap-v1.json",
  "CronJob/batch/v1": "cronjob-batch-v1.json",
  "Deployment/apps/v1": "deployment-apps-v1.json",
  "Ingress/networking.k8s.io/v1": "ingress-networking-v1.json",
  "Job/batch/v1": "job-batch-v1.json",
  "LimitRange/v1": "limitrange-v1.json",
  "NetworkPolicy/networking.k8s.io/v1": "networkpolicy-networking-v1.json",
  "PodDisruptionBudget/policy/v1": "poddisruptionbudget-policy-v1.json",
  "ResourceQuota/v1": "resourcequota-v1.json",
  "Role/rbac.authorization.k8s.io/v1": "role-rbac-v1.json",
  "RoleBinding/rbac.authorization.k8s.io/v1": "rolebinding-rbac-v1.json",
  "Service/v1": "service-v1.json",
  "ServiceAccount/v1": "serviceaccount-v1.json",
  "StatefulSet/apps/v1": "statefulset-apps-v1.json",
};

assert.ok(process.argv.length <= 3, "usage: node scripts/kubeconform.mjs [SCHEMA_DIRECTORY]");
const input = await new Promise((resolveInput, reject) => {
  const chunks = [];
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => resolveInput(chunks.join("")));
  process.stdin.on("error", reject);
});
const documents = [];
loadAll(input, (document) => {
  if (document != null) documents.push(document);
});

let failed = false;
for (const document of documents) {
  const apiVersion = document.apiVersion;
  const key = `${document.kind}/${apiVersion}`;
  const schemaFile = schemaFiles[key];
  assert.ok(schemaFile, `no checked-in schema for ${key}`);
  const schemaPath = join(schemaDirectory, schemaFile);
  const validation = spawnSync("kubeconform", [
    "-schema-location", schemaPath,
    "-strict",
    "-kubernetes-version", "1.31.0",
    "-summary",
  ], {
    encoding: "utf8",
    input: dump(document),
    env: { ...process.env, KUBECONFIG: "/dev/null" },
  });
  if (validation.stdout) process.stdout.write(validation.stdout);
  if (validation.stderr) process.stderr.write(validation.stderr);
  if (validation.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
