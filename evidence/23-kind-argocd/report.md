# Ticket 23: kind Argo CD reconciliation evidence

Run: `tracegarden-argocd-23-20260902t1055z`

## Boundary and approvals

- The run used only the authorized VM SSH identity and host: `ssh -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes -i "$HOME/.ssh/priv_keys/oci-instance.key" ubuntu@161.33.30.111`.
- Every Kubernetes command supplied `--context kind-k8s-cluster-v137`; no other context, namespace, Secret, or ConfigMap contents were enumerated.
- Exact preflight checks found no run-conflicting Argo namespace or CRDs and no pre-existing `tracegarden-preview` PriorityClass. No unowned Argo installation was present.
- The only public dependency fetched was the approved official Argo CD v3.4.6 declaration: `https://raw.githubusercontent.com/argoproj/argo-cd/v3.4.6/manifests/install.yaml` (SHA-256 `752b5a2681f2522fc78ea12ba2d23be44a4523cfa5d9a55cf1907909cc23fc5d`).
- Approved exact Argo images were `quay.io/argoproj/argocd:v3.4.6` / `quay.io/argoproj/argocd@sha256:6e9f4f1d646d9056c8e285495d0c8043b5f553c784181b3522ef324dcefdcc82`, `ghcr.io/dexidp/dex:v2.45.0` / `ghcr.io/dexidp/dex@sha256:b8469881d3cb3a73001506f0d3aaefecb9c45d2311c1e0f405d8ac538316c59d`, and `public.ecr.aws/docker/library/redis:8.2.3-alpine` / `public.ecr.aws/docker/library/redis@sha256:08ad0b1d280850169a790dba1393ff7a90aef951fc19632cf4d3ce4f78e679ba`. These were pulled and loaded into both authorized kind nodes; workloads used `IfNotPresent`.

## Live reconciliation proof

- The disposable Argo namespace was `tg23-1055`; the Preview namespace was `preview-pr-23092026`; run ownership was labelled `tracegarden.run=tracegarden-argocd-23-20260902t1055z`.
- The trusted disposable Git source was `git://172.18.0.1:9418/tracegarden-gitops.git`, served by a bounded run-local git daemon. Final desired-state revision: `4d23394da7fcaaf229741f8db08ec2ad7e9df7e4`.
- The Application reached `sync=Synced`, `health=Healthy`, `phase=Succeeded`, revision `4d23394da7fcaaf229741f8db08ec2ad7e9df7e4`.
- The live Preview pod proof used the exact approved local values: web `ghcr.io/misaka3389/tracegarden-web@sha256:21c10b4d65934d8814416be349c9e53cc0f640f3806f8287823e318bd486d0dc`, Postgres `postgres@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7`; migration completed successfully with its fixed migrate digest. No Preview Ingress existed (`ingress-count=0`).
- The fixture disabled only the optional collector in `live-values.yaml`, because this credential-free fixture has no configured cluster observation scope; chart default remains enabled. The production lifecycle controller defaults to the real GitHub adapter and rejects fake mode when `NODE_ENV=production`.

## Admission and lifecycle proof

- Eight trusted open PR records (`23093001` through `23093008`) were reconciled live. PRs `23093001`–`23093007` were admitted; `23093008` was rejected with the executable `aggregate-cpu-budget` path. The existing production reservation was included before eligibility.
- Draft transition removed only `preview-pr-23093001`; other admitted namespaces remained.
- Close transition removed only `preview-pr-23093002`.
- Missed-event orphan transition removed only `preview-pr-23093007` when the bounded fake API omitted it.
- Final bounded cleanup removed the remaining run Preview namespaces. Exact checks confirmed all run Preview namespaces, the run Application, and run Argo namespace were absent.

## Credential and cleanup proof

- No real GitHub, GHCR, Cloudflare, repository, or Kubernetes credentials were used. The fake GitHub adapter accepts at most 100 validated records and is fail-closed in production. CI/no-kubeconfig and production GitOps source/auth assertions passed locally.
- Exact cleanup checks confirmed absence of `tg23-1055`, all run Preview namespaces, `tracegarden-preview`, run Argo CRDs, and run Argo ClusterRoles/ClusterRoleBindings. The run-local git daemon and temporary directory were removed.

## Sol-medium ApplicationSet follow-up

Follow-up run: `tracegarden-argocd-23-appset-20260903t1130z`; Argo namespace: `tg23-as-1130`; fixture PR number: `23094001`.

- Preflight again verified the authorized context `kind-k8s-cluster-v137`, no existing `argocd` namespace, and no existing `applications.argoproj.io`, `applicationsets.argoproj.io`, or `appprojects.argoproj.io` CRDs. No run-owned process was active before mutation.
- The real Argo CD v3.4.6 `applicationset-controller` reconciled a run-only `ApplicationSet` using the supported `list` generator. This was a fixture-only generator: it substituted a bounded local list for the production GitHub generator solely to avoid GitHub credentials. The production declaration remains unchanged and still requires its operator-managed token reference.
- The fixture reused the trusted local Git source `git://172.18.0.1:9418/tracegarden-gitops.git`, protected `main`, `preview/chart`, `../digests/pr-23094001.yaml`, `../live-values.yaml`, and the same fixed image-digest contract. The fixture `ApplicationSet` status reported `ParametersGenerated=True`, `ResourcesUpToDate=True`, and `All applications have been generated successfully`.
- The generated Application had owner reference `ApplicationSet/tracegarden-as-fixture`, source `targetRevision=main`, the trusted local repo URL, path `preview/chart`, and destination `preview-pr-23094001`. The real Argo application controller reconciled it to `Synced`, `Healthy`, `Succeeded`, revision `715b8527e8eb06d9c8f70e4c881504d8074877d2`.
- Replacing the fixture generator elements with `[]` caused the real ApplicationSet controller to remove the generated Application on the first bounded check (`check-1=absent`). The destination Preview namespace was also absent after the bounded lifecycle reconciliation; no hand-created Application was used for this proof.

## Sol-medium container preservation follow-up

The original Ticket 22 pre-run record is retained and supplies the permitted pre-state. The new follow-up post-run read used only exact container names and `docker inspect`; it did not stop, restart, delete, or otherwise mutate Caddy or either kind node:

```text
pre (Ticket 22):
railgun-caddy                    26e35e579600473cee8faa08c2fcf4cb8856f6f5b37b77a6c301d44714884f75 running
k8s-cluster-v137-control-plane   d5f3759062bfbd5d96e1a8e4e401be488a3f156d14348feaa5dea95a20b7f2dc running
k8s-cluster-v137-worker          ab79985d801cb252c6ce5e6da5629314f59f1d485d5c21b077dfa350f1c1251e running

post (ApplicationSet follow-up):
/railgun-caddy                    26e35e579600473cee8faa08c2fcf4cb8856f6f5b37b77a6c301d44714884f75 running
/k8s-cluster-v137-control-plane   d5f3759062bfbd5d96e1a8e4e401be488a3f156d14348feaa5dea95a20b7f2dc running
/k8s-cluster-v137-worker          ab79985d801cb252c6ce5e6da5629314f59f1d485d5c21b077dfa350f1c1251e running
```

IDs and running states are identical pre/post. No host-side image tags or archives were created by the follow-up; shared kind-node image caches were not altered because doing so would touch the existing kind node containers.

The hardened validator rerun compared the exact fixed pre-run IDs and `.State.Running` values, not merely presence:

```text
railgun-caddy 26e35e579600473cee8faa08c2fcf4cb8856f6f5b37b77a6c301d44714884f75 true
k8s-cluster-v137-control-plane d5f3759062bfbd5d96e1a8e4e401be488a3f156d14348feaa5dea95a20b7f2dc true
k8s-cluster-v137-worker ab79985d801cb252c6ce5e6da5629314f59f1d485d5c21b077dfa350f1c1251e true
```

Any missing container, inspect error, ID mismatch, or non-`true` running state exits nonzero before the validator can print `followup-cleanup-and-preservation=passed`.

## Sol-medium bounded command matrix and post-cleanup rerun

The reviewable read-only validator is `evidence/23-kind-argocd/validate-followup-cleanup.sh`. It contains no credentials, fixes `CTX=kind-k8s-cluster-v137`, uses the approved SSH flags/key/host, starts its shell-level 60-second watchdog before the body’s first external command, and caps every remote `kubectl`, `docker`, `ss`, and `/proc` read at 5 seconds. The normal supervisor streams output and stops its watchdog with shell builtins; it has no top-level output staging or post-processing outside the deadline. `run_body` records the SSH PID before waiting; the interrupt handler TERM-kills and waits for that PID before cleanup, and the supervisor TERM handler TERM-kills and waits for the body before stopping and reaping the watchdog. Internal per-command capture files are tracked by an interrupt/exit cleanup trap. Kubernetes checks use `kubectl get <exact-type> <exact-name> --ignore-not-found -o name`; only exit 0 with empty stdout and empty stderr is absence, while a present result must exactly equal the requested target. Every other absence classifier likewise captures status and requires an exact target-specific result; timeout 124, permission/API/daemon errors, parse errors, mixed output, and wrong targets fail closed. The local `--self-test` passed all `found`, `absent`, `timeout`, and `operational-error` fixtures, including wrong-target, mixed-error, and same-class-other-object cases. Its PATH-injected sleeping `stat` and `mktemp` fixtures each returned exact `rc=124` within 1..4 seconds; its blocking fake `ssh` wrote its PID, returned exact `rc=124` within 1..4 seconds, and `kill -0` returned exactly 1 after reaping. It was rerun after teardown and passed:

```text
self-test-slow-stat=passed rc=124 elapsed=1s
self-test-slow-mktemp=passed rc=124 elapsed=1s
self-test-fake-ssh=passed rc=124 elapsed=1s pid-kill-0=1
classifier-self-test=passed (found absent timeout operational-error; wrong-target mixed-error same-class and slow stat/mktemp/fake-ssh deadlines)
namespace/tg23-as-1130=absent
namespace/preview-pr-23094001=absent
customresourcedefinition.apiextensions.k8s.io/applications.argoproj.io=absent
customresourcedefinition.apiextensions.k8s.io/applicationsets.argoproj.io=absent
customresourcedefinition.apiextensions.k8s.io/appprojects.argoproj.io=absent
application.argoproj.io/tracegarden-preview-pr-23094001=absent (run namespace and run-owned CRDs absent)
clusterrole.rbac.authorization.k8s.io/tg23-as-1130-application-controller=absent
clusterrole.rbac.authorization.k8s.io/tg23-as-1130-applicationset-controller=absent
clusterrole.rbac.authorization.k8s.io/tg23-as-1130-server=absent
clusterrole.rbac.authorization.k8s.io/tg23-as-1130-repo-server=absent
clusterrole.rbac.authorization.k8s.io/tg23-as-1130-dex-server=absent
clusterrole.rbac.authorization.k8s.io/tg23-as-1130-notifications-controller=absent
clusterrolebinding.rbac.authorization.k8s.io/tg23-as-1130-application-controller=absent
clusterrolebinding.rbac.authorization.k8s.io/tg23-as-1130-applicationset-controller=absent
clusterrolebinding.rbac.authorization.k8s.io/tg23-as-1130-server=absent
clusterrolebinding.rbac.authorization.k8s.io/tg23-as-1130-repo-server=absent
clusterrolebinding.rbac.authorization.k8s.io/tg23-as-1130-dex-server=absent
clusterrolebinding.rbac.authorization.k8s.io/tg23-as-1130-notifications-controller=absent
priorityclass.scheduling.k8s.io/tracegarden-preview=absent
/tmp/tracegarden-argocd-23-appset-20260903t1130z=absent
/tmp/tracegarden-argocd-23-appset-20260903t1130z/git-daemon.pid=absent
/tmp/tracegarden-argocd-23-appset-20260903t1130z/install-run.yaml=absent
/tmp/tracegarden-argocd-23-appset-20260903t1130z/lifecycle-run.yaml=absent
/tmp/tracegarden-argocd-23-appset-20260903t1130z/priorityclass.yaml=absent
/tmp/tracegarden-argocd-23-appset-20260903t1130z-git.tar.gz=absent
run-local-git-listener=:9418-absent
run-local-git-process=absent
run-tagged-images=absent
followup-cleanup-and-preservation=passed
```

The follow-up live command modes and bounds were:

| proof step | command mode | per-step bound | polling and total deadline |
| --- | --- | --- | --- |
| Argo controller readiness | exact `kubectl --context "$CTX" get pods -n "$NS" -o custom-columns=...` after a fixed 25-second settle | SSH `ConnectTimeout=10`; outer SSH command timeout 120s | one readiness read; no unbounded rollout/log wait |
| lifecycle open/readiness | exact `kubectl --context "$CTX" wait --for=condition=complete job/tracegarden-preview-lifecycle-open-as -n "$NS" --timeout=60s` | 60s | Kubernetes watch; 60s total |
| ApplicationSet generation | exact `kubectl --context "$CTX" get application.argoproj.io/tracegarden-preview-pr-23094001 -n "$NS"` loop | 5s poll cadence; 10s SSH connect bound | 12 polls, 5s interval, 60s total |
| Application sync/health | exact status `get` and `Synced:Healthy:Succeeded` comparison | 5s poll cadence; each SSH command had explicit finite outer timeout | 24 polls, 5s interval, 120s total |
| hard refresh/readiness settle | exact `annotate ... argocd.argoproj.io/refresh=hard --overwrite`, then status `get` | fixed 20s settle; no unbounded wait | one refresh and one read |
| ApplicationSet deletion | exact JSON patch replacing `/spec/generators/0/list/elements` with `[]`, then exact Application `get` | 5s poll cadence; finite SSH command timeout | 24 polls, 5s interval, 120s total; `check-1=absent` |
| Preview orphan cleanup check | exact lifecycle job `wait --timeout=60s` when created, then exact namespace `get` loop | 60s job wait; 2s poll | 18 polls, 2s interval, 36s total; namespace was absent, and no missing-job log was claimed |
| teardown and cleanup | exact run manifest/namespace/CRD deletes with `--wait=true --timeout=60s`, followed by the validator | 60s maximum per Kubernetes wait; validator remote calls 5s | validator hard deadline 60s; no shared resource deletion |

The standard CRDs were proven run-owned by the exact preflight absence check, then created and labelled by this run before teardown; the validator only checks those exact names are absent and never deletes an unowned CRD. The validator also checks the exact local fixture directory and archive, remote temporary directory/files, PID/process/listener, and the only run-prefixed host image tag candidates. Local fixture files were removed by exact path before the validator run.
