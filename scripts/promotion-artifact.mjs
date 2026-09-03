import { writeFile } from "node:fs/promises";
import { dump } from "js-yaml";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const digest = (name) => {
  const value = required(name);
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a sha256 image digest`);
  return value;
};
const releaseCommit = required("RELEASE_COMMIT");
if (!/^[a-f0-9]{40}$/.test(releaseCommit)) throw new Error("RELEASE_COMMIT must be a full Git commit SHA");
const runId = required("GITHUB_RUN_ID");
const output = process.argv[2] ?? "desired-state.patch.yaml";
const artifact = {
  apiVersion: "delivery.tracegarden.dev/v1alpha1",
  kind: "ProductionDesiredState",
  metadata: {
    name: "tracegarden-production",
    annotations: {
      "tracegarden.dev/live-behavior": "artifact-only-until-gitops-pull-request",
      "tracegarden.dev/approval-ref": `github-actions-environment/production/${runId}`,
    },
  },
  spec: {
    releaseCommit,
    images: {
      web: `ghcr.io/${required("GHCR_NAMESPACE")}/tracegarden-web@${digest("WEB_DIGEST")}`,
      collector: `ghcr.io/${required("GHCR_NAMESPACE")}/tracegarden-collector@${digest("COLLECTOR_DIGEST")}`,
      migrate: `ghcr.io/${required("GHCR_NAMESPACE")}/tracegarden-migrate@${digest("MIGRATE_DIGEST")}`,
      backup: `ghcr.io/${required("GHCR_NAMESPACE")}/tracegarden-backup@${digest("BACKUP_DIGEST")}`,
    },
    approval: { protectedEnvironment: "production", required: true, workflowRun: runId },
    change: { mechanism: "pull-request", directClusterMutation: false },
  },
};
await writeFile(output, dump(artifact, { noRefs: true, sortKeys: false }));
