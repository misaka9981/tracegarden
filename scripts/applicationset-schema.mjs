import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { load } from "js-yaml";

export const APPLICATION_SET_CRD_RELEASE = "v3.4.6";
export const APPLICATION_SET_CRD_SOURCE = "https://raw.githubusercontent.com/argoproj/argo-cd/v3.4.6/manifests/crds/applicationset-crd.yaml";

export async function readApplicationSetSchema() {
  const crd = load(await readFile(new URL("../deploy/preview/applicationset-crd.yaml", import.meta.url), "utf8"));
  assert.equal(crd?.kind, "CustomResourceDefinition", "vendored ApplicationSet source must be a CRD");
  assert.equal(crd?.metadata?.name, "applicationsets.argoproj.io", "vendored CRD must define ApplicationSet");
  assert.equal(crd?.spec?.group, "argoproj.io", "vendored CRD must define the Argo CD API group");
  const version = crd.spec.versions?.find(({ name }) => name === "v1alpha1");
  assert.ok(version?.schema?.openAPIV3Schema, "vendored CRD must contain the v1alpha1 OpenAPI schema");
  return version.schema.openAPIV3Schema;
}
