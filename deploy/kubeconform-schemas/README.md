# Kubernetes schema bundle

`kubernetes-v1.31.0-standalone-strict.tar.gz` contains the strict schemas required by the rendered Tracegarden chart and preview, including ResourceQuota, LimitRange, and PodDisruptionBudget, for Kubernetes 1.31.0. The core schemas are sourced from the `yannh/kubernetes-json-schema` commit `14355cdd490a43d21e05985668815a36a6f97da6`; the preview-only schemas are checked in beside them. `SHA256SUMS` is the required integrity check before extraction.

The CI workflow extracts the archive into a local workspace directory and passes that directory explicitly to kubeconform. The kubeconform container runs with networking disabled, so validation cannot silently fall back to remote schemas.
