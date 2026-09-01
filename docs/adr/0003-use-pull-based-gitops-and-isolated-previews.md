# Use pull-based GitOps and isolated pull-request previews

GitHub Actions builds immutable images, while Argo CD pulls declared state from a private GitOps repository instead of receiving a cluster credential from CI. Every non-draft pull request receives a disposable namespace and database protected by Cloudflare Access; the extra resource cost is accepted because preview isolation and reviewable deployment behavior are explicit project goals, while resource limits protect production on the four-core VM.
