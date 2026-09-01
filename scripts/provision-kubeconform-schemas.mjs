import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const archivePath = "deploy/kubeconform-schemas/kubernetes-v1.31.0-standalone-strict.tar.gz";
const checksumPath = "deploy/kubeconform-schemas/SHA256SUMS";
const schemaDirectory = ".ci/kubeconform-schemas/v1.31.0-standalone-strict";
const schemaFiles = [
  "configmap-v1.json",
  "cronjob-batch-v1.json",
  "deployment-apps-v1.json",
  "limitrange-v1.json",
  "ingress-networking-v1.json",
  "job-batch-v1.json",
  "networkpolicy-networking-v1.json",
  "poddisruptionbudget-policy-v1.json",
  "resourcequota-v1.json",
  "role-rbac-v1.json",
  "rolebinding-rbac-v1.json",
  "service-v1.json",
  "serviceaccount-v1.json",
  "statefulset-apps-v1.json",
];

const checksumLine = (await readFile(checksumPath, "utf8")).trim().split(/\s+/);
assert.equal(checksumLine[1], archivePath, `${checksumPath} must name ${archivePath}`);
const actualChecksum = createHash("sha256").update(await readFile(archivePath)).digest("hex");
assert.equal(actualChecksum, checksumLine[0], `${archivePath} failed its SHA-256 integrity check`);

await rm(schemaDirectory, { recursive: true, force: true });
await mkdir(schemaDirectory, { recursive: true });
execFileSync("tar", ["-xzf", archivePath, "-C", schemaDirectory], { stdio: "inherit" });
for (const file of schemaFiles) {
  JSON.parse(await readFile(`${schemaDirectory}/${file}`, "utf8"));
}
console.log(`provisioned ${schemaFiles.length} checked-in Kubernetes schemas for offline kubeconform validation`);
