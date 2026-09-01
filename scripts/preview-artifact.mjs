import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { dump } from "js-yaml";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const repository = (name, component) => {
  const value = required(name);
  const expected = `ghcr.io/misaka3389/tracegarden-${component}`;
  if (value !== expected) throw new Error(`${name} must equal ${expected}`);
  return value;
};
const digest = (name) => {
  const value = required(name);
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a sha256 image digest`);
  return value;
};
const number = Number(required("PREVIEW_NUMBER"));
if (!Number.isSafeInteger(number) || number < 1) throw new Error("PREVIEW_NUMBER must be a positive integer");
const commit = required("PREVIEW_COMMIT");
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("PREVIEW_COMMIT must be a full Git commit SHA");
const output = process.argv[2] ?? "preview-image-declaration.yaml";
const valueOutput = process.argv[3] ?? `environments/previews/digests/pr-${number}.yaml`;
const valueFile = `environments/previews/digests/pr-${number}.yaml`;
const images = {
  web: { repository: repository("WEB_REPOSITORY", "web"), digest: digest("WEB_DIGEST") },
  collector: { repository: repository("COLLECTOR_REPOSITORY", "collector"), digest: digest("COLLECTOR_DIGEST") },
  migrate: { repository: repository("MIGRATE_REPOSITORY", "migrate"), digest: digest("MIGRATE_DIGEST") },
  postgres: { repository: "postgres", digest: "sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7" },
};
const declaration = {
  apiVersion: "delivery.tracegarden.dev/v1alpha1",
  kind: "PreviewImageDeclaration",
  metadata: {
    name: `tracegarden-preview-pr-${number}`,
    annotations: {
      "tracegarden.dev/source": "ci-build-digest-output",
      "tracegarden.dev/live-behavior": "artifact-only-until-committed-to-protected-source",
    },
  },
  spec: {
    pullRequest: number,
    commit,
    images,
    handoff: {
      mechanism: "application-set-helm-value-file",
      valueFile,
      commitRequired: true,
      remoteWrite: false,
    },
  },
};
await mkdir(dirname(output), { recursive: true });
await mkdir(dirname(valueOutput), { recursive: true });
await writeFile(output, dump(declaration, { noRefs: true, sortKeys: false }));
await writeFile(valueOutput, dump({ images }, { noRefs: true, sortKeys: false }));
