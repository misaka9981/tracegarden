#!/usr/bin/env bash
set -euo pipefail

# Read-only post-cleanup proof for follow-up run tg23-as-1130.
# The top-level shell supervisor starts its watchdog before launching the body;
# output is streamed, with no staging file. --remote is sent over SSH.
readonly CTX='kind-k8s-cluster-v137'
readonly RUN='tracegarden-argocd-23-appset-20260903t1130z'
readonly ARGO_NS='tg23-as-1130'
readonly PREVIEW_NS='preview-pr-23094001'
readonly TMP='/tmp/tracegarden-argocd-23-appset-20260903t1130z'
readonly REMOTE_TAR='/tmp/tracegarden-argocd-23-appset-20260903t1130z-git.tar.gz'
readonly LOCAL_TMP='/tmp/tracegarden-argocd-23-appset-20260903t1130z-git'
readonly LOCAL_TAR='/tmp/tracegarden-argocd-23-appset-20260903t1130z-git.tar.gz'
readonly DEADLINE="${VALIDATOR_DEADLINE:-60}"
readonly SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes -i "$HOME/.ssh/priv_keys/oci-instance.key" ubuntu@161.33.30.111)
readonly CADDY_ID='26e35e579600473cee8faa08c2fcf4cb8856f6f5b37b77a6c301d44714884f75'
readonly CONTROL_PLANE_ID='d5f3759062bfbd5d96e1a8e4e401be488a3f156d14348feaa5dea95a20b7f2dc'
readonly WORKER_ID='ab79985d801cb252c6ce5e6da5629314f59f1d485d5c21b077dfa350f1c1251e'
CAPTURE_FILES=()
CAPTURE_COMMAND_PID=''
TEMP_COUNTER=0

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

# Capture one command without accepting any failed status as absence.
new_temp_file() {
  local marker path fd read_rc extra_rc rc rm_rc
  TEMP_COUNTER=$((TEMP_COUNTER + 1))
  marker="${TMPDIR:-/tmp}/tracegarden-validator-${BASHPID}-${TEMP_COUNTER}"
  set +e
  (set -C; : >"$marker") 2>/dev/null
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then fail "temp-marker=create-error:$marker"; fi
  CAPTURE_FILES+=("$marker")
  coproc MAKE_TEMP { mktemp; }
  fd="${MAKE_TEMP[0]}"
  CAPTURE_COMMAND_PID="$MAKE_TEMP_PID"
  set +e
  IFS= read -r path <&"$fd"
  read_rc=$?
  IFS= read -r <&"$fd"
  extra_rc=$?
  wait "$CAPTURE_COMMAND_PID"
  rc=$?
  exec {fd}<&-
  set -e
  CAPTURE_COMMAND_PID=''
  if [ "$rc" -ne 0 ] || [ "$read_rc" -ne 0 ] || [ "$extra_rc" -eq 0 ] || [ -z "$path" ]; then
    fail "mktemp=unexpected-output:$path"
  fi
  case "$path" in
    /*) ;;
    *) fail "mktemp=non-path-output:$path";;
  esac
  rm -f "$marker"
  rm_rc=$?
  if [ "$rm_rc" -ne 0 ]; then fail "temp-marker=remove-error:$marker"; fi
  CAPTURE_NEW_PATH="$path"
  CAPTURE_FILES+=("$path")
}

capture() {
  local mode="$1" out_file err_file rc out_rc err_rc rm_rc command_pid
  shift
  new_temp_file
  out_file="$CAPTURE_NEW_PATH"
  new_temp_file
  err_file="$CAPTURE_NEW_PATH"
  set +e
  if [ "$mode" = bounded ]; then
    timeout --foreground 5s "$@" >"$out_file" 2>"$err_file" &
  else
    "$@" >"$out_file" 2>"$err_file" &
  fi
  command_pid=$!
  CAPTURE_COMMAND_PID="$command_pid"
  wait "$command_pid"
  rc=$?
  CAPTURE_COMMAND_PID=''
  out_rc=0
  err_rc=0
  CAPTURE_STDOUT=$(<"$out_file") || out_rc=$?
  CAPTURE_STDERR=$(<"$err_file") || err_rc=$?
  rm -f "$out_file" "$err_file"
  rm_rc=$?
  set -e
  if [ "$out_rc" -ne 0 ] || [ "$err_rc" -ne 0 ] || [ "$rm_rc" -ne 0 ]; then
    return 1
  fi
  CAPTURE_FILES=()
  CAPTURE_RC="$rc"
}

cleanup_capture_files() {
  local file
  for file in "${CAPTURE_FILES[@]}"; do
    rm -f "$file"
  done
  CAPTURE_FILES=()
}

handle_interrupt() {
  local command_pid="$CAPTURE_COMMAND_PID"
  if [ -n "$command_pid" ]; then
    kill -TERM "$command_pid" 2>/dev/null || true
    set +e
    wait "$command_pid" 2>/dev/null
    set -e
    CAPTURE_COMMAND_PID=''
  fi
  cleanup_capture_files
  exit 124
}

classify_k8s() {
  local expected="$1" rc="$2" stdout="$3" stderr="$4"
  if [ "$rc" -eq 124 ]; then
    printf '%s\n' timeout
  elif [ "$rc" -ne 0 ] || [ -n "$stderr" ]; then
    printf '%s\n' operational-error
  elif [ -z "$stdout" ]; then
    printf '%s\n' absent
  elif [ "$stdout" = "$expected" ]; then
    printf '%s\n' found
  else
    printf '%s\n' target-mismatch
  fi
}

classify_file() {
  local path="$1" platform="$2" rc="$3" stdout="$4" stderr="$5"
  local absent_local="stat: $path: stat: No such file or directory"
  local absent_remote_x="stat: cannot statx '$path': No such file or directory"
  local absent_remote="stat: cannot stat '$path': No such file or directory"
  if [ "$rc" -eq 124 ]; then
    printf '%s\n' timeout
  elif [ "$rc" -eq 0 ] && [ -z "$stderr" ] && [ "$stdout" = "$path" ]; then
    printf '%s\n' found
  elif [ "$rc" -eq 1 ] && [ -z "$stdout" ] && [ "$platform" = local ] && [ "$stderr" = "$absent_local" ]; then
    printf '%s\n' absent
  elif [ "$rc" -eq 1 ] && [ -z "$stdout" ] && [ "$platform" = remote ] && { [ "$stderr" = "$absent_remote_x" ] || [ "$stderr" = "$absent_remote" ]; }; then
    printf '%s\n' absent
  else
    printf '%s\n' operational-error
  fi
}

classify_pgrep() {
  local rc="$1" stdout="$2" stderr="$3"
  if [ "$rc" -eq 124 ]; then
    printf '%s\n' timeout
  elif [ "$rc" -eq 1 ] && [ -z "$stdout" ] && [ -z "$stderr" ]; then
    printf '%s\n' absent
  elif [ "$rc" -eq 0 ] && [ -n "$stdout" ] && [ -z "$stderr" ]; then
    printf '%s\n' found
  else
    printf '%s\n' operational-error
  fi
}

classify_process_records() {
  local target="$1" rc="$2" stdout="$3" stderr="$4" line pid arg
  if [ "$rc" -eq 124 ]; then
    printf '%s\n' timeout
    return
  fi
  if [ "$rc" -eq 1 ] && [ -z "$stdout" ] && [ -z "$stderr" ]; then
    printf '%s\n' absent
    return
  fi
  if [ "$rc" -ne 0 ] || [ -n "$stderr" ]; then
    printf '%s\n' operational-error
    return
  fi
  while IFS= read -r line; do
    if [ -z "$line" ]; then continue; fi
    pid="${line%%|*}"
    arg="${line#*|}"
    case "$pid" in *[!0-9]*|'') printf '%s\n' operational-error; return;; esac
    if [ "$arg" = "$target" ]; then
      printf '%s\n' found
      return
    fi
  done <<<"$stdout"
  printf '%s\n' absent
}

classify_listener() {
  local rc="$1" stdout="$2" stderr="$3" line endpoint found=0
  local -a fields
  if [ "$rc" -eq 124 ]; then
    printf '%s\n' timeout
    return
  fi
  if [ "$rc" -ne 0 ] || [ -n "$stderr" ]; then
    printf '%s\n' operational-error
    return
  fi
  if [ -z "$stdout" ]; then
    printf '%s\n' absent
    return
  fi
  while IFS= read -r line; do
    if [ -z "$line" ]; then continue; fi
    read -r -a fields <<<"$line"
    if [ "${#fields[@]}" -lt 4 ]; then
      printf '%s\n' operational-error
      return
    fi
    endpoint="${fields[3]}"
    if [[ "$endpoint" =~ ^([^:]+|\[[^]]*\]):9418$ ]]; then
      found=1
    else
      printf '%s\n' operational-error
      return
    fi
  done <<<"$stdout"
  if [ "$found" -eq 1 ]; then printf '%s\n' found; else printf '%s\n' operational-error; fi
}

classify_image() {
  local image="$1" rc="$2" stdout="$3" stderr="$4"
  local absent="Error response from daemon: No such image: $image:latest"
  local absent_object="Error response from daemon: No such object: $image"
  if [ "$rc" -eq 124 ]; then
    printf '%s\n' timeout
  elif [ "$rc" -eq 0 ] && [ -n "$stdout" ] && [ -z "$stderr" ]; then
    printf '%s\n' found
  elif [ "$rc" -eq 1 ] && [ -z "$stdout" ] && { [ "$stderr" = "$absent" ] || [ "$stderr" = "$absent_object" ]; }; then
    printf '%s\n' absent
  else
    printf '%s\n' operational-error
  fi
}

classify_container() {
  local expected="$1" rc="$2" stdout="$3" stderr="$4"
  if [ "$rc" -eq 124 ]; then
    printf '%s\n' timeout
  elif [ "$rc" -eq 0 ] && [ -z "$stderr" ] && [ "$stdout" = "$expected true" ]; then
    printf '%s\n' found
  elif [ "$rc" -eq 0 ] && [ -z "$stderr" ]; then
    printf '%s\n' target-mismatch
  else
    printf '%s\n' operational-error
  fi
}

self_expect() {
  local label="$1" expected="$2" actual
  shift 2
  actual=$("$@")
  if [ "$actual" != "$expected" ]; then
    printf 'classifier-self-test=%s expected=%s actual=%s\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
}

run_self_test() {
  self_expect k8s-found found classify_k8s namespace/x 0 namespace/x ''
  self_expect k8s-absent absent classify_k8s namespace/x 0 '' ''
  self_expect k8s-timeout timeout classify_k8s namespace/x 124 '' ''
  self_expect k8s-wrong-target target-mismatch classify_k8s namespace/x 0 namespace/other ''
  self_expect k8s-mixed-error operational-error classify_k8s namespace/x 0 namespace/x warning
  self_expect k8s-operational-error operational-error classify_k8s namespace/x 1 '' 'Error from server (Forbidden): denied'

  self_expect file-found found classify_file /tmp/x local 0 /tmp/x ''
  self_expect file-absent absent classify_file /tmp/x local 1 '' 'stat: /tmp/x: stat: No such file or directory'
  self_expect file-timeout timeout classify_file /tmp/x local 124 '' ''
  self_expect file-wrong-target operational-error classify_file /tmp/x local 0 /tmp/other ''
  self_expect file-mixed-error operational-error classify_file /tmp/x local 0 /tmp/x warning
  self_expect file-operational-error operational-error classify_file /tmp/x local 1 '' 'stat: /tmp/x: stat: Permission denied'

  self_expect process-found found classify_process_records "$TMP/git" 0 '123|/tmp/tracegarden-argocd-23-appset-20260903t1130z/git' ''
  self_expect process-absent absent classify_process_records "$TMP/git" 1 '' ''
  self_expect process-timeout timeout classify_process_records "$TMP/git" 124 '' ''
  self_expect process-other-object-absent absent classify_process_records "$TMP/git" 0 '123|/tmp/other-git' ''
  self_expect process-wrong-target operational-error classify_process_records "$TMP/git" 0 'not-a-pid|/tmp/other-git' ''
  self_expect process-operational-error operational-error classify_process_records "$TMP/git" 2 '' 'pgrep: invalid pattern'

  self_expect listener-found found classify_listener 0 'LISTEN 0 128 0.0.0.0:9418 0.0.0.0:*' ''
  self_expect listener-absent absent classify_listener 0 '' ''
  self_expect listener-timeout timeout classify_listener 124 '' ''
  self_expect listener-wrong-target operational-error classify_listener 0 'LISTEN 0 128 0.0.0.0:9419 0.0.0.0:*' ''
  self_expect listener-mixed-error operational-error classify_listener 0 '' warning

  self_expect image-found found classify_image "$RUN/argocd" 0 sha256:abc ''
  self_expect image-absent absent classify_image "$RUN/argocd" 1 '' "Error response from daemon: No such image: $RUN/argocd:latest"
  self_expect image-timeout timeout classify_image "$RUN/argocd" 124 '' ''
  self_expect image-wrong-target operational-error classify_image "$RUN/argocd" 1 '' 'Error response from daemon: No such image: other/image:latest'
  self_expect image-mixed-error operational-error classify_image "$RUN/argocd" 1 '' 'Error response from daemon: No such image: wrong-target:latest'
  self_expect image-operational-error operational-error classify_image "$RUN/argocd" 1 '' 'Cannot connect to the Docker daemon'

  self_expect container-found found classify_container "$CADDY_ID" 0 "$CADDY_ID true" ''
  self_expect container-mismatch target-mismatch classify_container "$CADDY_ID" 0 'deadbeef false' ''
  self_expect container-timeout timeout classify_container "$CADDY_ID" 124 '' ''
  self_expect container-error operational-error classify_container "$CADDY_ID" 1 '' 'No such container'

  local fixture start rc elapsed command_name fake_pid_file fake_pid alive_rc
  for command_name in stat mktemp; do
    fixture=$(mktemp -d)
    printf '#!/bin/sh\nexec sleep 5\n' >"$fixture/$command_name"
    chmod +x "$fixture/$command_name"
    start=$SECONDS
    set +e
    VALIDATOR_DEADLINE=1 PATH="$fixture:$PATH" "$0"
    rc=$?
    set -e
    elapsed=$((SECONDS - start))
    rm -rf "$fixture"
    if [ "$rc" -ne 124 ] || [ "$elapsed" -lt 1 ] || [ "$elapsed" -gt 4 ]; then
      printf 'self-test-slow-%s=failed rc=%s elapsed=%ss\n' "$command_name" "$rc" "$elapsed" >&2
      exit 1
    fi
    printf 'self-test-slow-%s=passed rc=%s elapsed=%ss\n' "$command_name" "$rc" "$elapsed"
  done

  fixture=$(mktemp -d)
  fake_pid_file="$fixture/ssh.pid"
  cat >"$fixture/ssh" <<'EOF'
#!/bin/sh
printf '%s\n' "$$" >"$FAKE_SSH_PID_FILE"
exec sleep 5
EOF
  chmod +x "$fixture/ssh"
  start=$SECONDS
  set +e
  VALIDATOR_DEADLINE=1 FAKE_SSH_PID_FILE="$fake_pid_file" PATH="$fixture:$PATH" "$0"
  rc=$?
  set -e
  elapsed=$((SECONDS - start))
  if [ "$rc" -ne 124 ] || [ "$elapsed" -lt 1 ] || [ "$elapsed" -gt 4 ] || [ ! -s "$fake_pid_file" ]; then
    printf 'self-test-fake-ssh=failed rc=%s elapsed=%ss pid-file=%s\n' "$rc" "$elapsed" "$fake_pid_file" >&2
    rm -rf "$fixture"
    exit 1
  fi
  fake_pid=$(<"$fake_pid_file")
  case "$fake_pid" in *[!0-9]*|'') rm -rf "$fixture"; printf '%s\n' 'self-test-fake-ssh=failed invalid pid' >&2; exit 1;; esac
  set +e
  kill -0 "$fake_pid" 2>/dev/null
  alive_rc=$?
  set -e
  rm -rf "$fixture"
  if [ "$alive_rc" -ne 1 ]; then
    printf 'self-test-fake-ssh=failed kill-0=%s pid=%s\n' "$alive_rc" "$fake_pid" >&2
    exit 1
  fi
  printf 'self-test-fake-ssh=passed rc=%s elapsed=%ss pid-kill-0=%s\n' "$rc" "$elapsed" "$alive_rc"
  printf '%s\n' 'classifier-self-test=passed (found absent timeout operational-error; wrong-target mixed-error same-class and slow stat/mktemp/fake-ssh deadlines)'
}

local_absent_file() {
  local path="$1" classification
  capture direct stat -f '%N' "$path" || fail "local-stat=capture-error:$path"
  classification=$(classify_file "$path" local "$CAPTURE_RC" "$CAPTURE_STDOUT" "$CAPTURE_STDERR")
  if [ "$classification" != absent ]; then
    printf 'local-file=%s:%s\n%s\n' "$path" "$classification" "$CAPTURE_STDERR" >&2
    exit 1
  fi
  printf '%s=absent\n' "$path"
}

check_k8s_absent() {
  local type="$1" name="$2" expected="$3" namespace="${4:-}" classification
  if [ -n "$namespace" ]; then
    capture bounded kubectl --context "$CTX" get "$type" "$name" -n "$namespace" --ignore-not-found -o name || fail "kubernetes=capture-error:$type/$name"
  else
    capture bounded kubectl --context "$CTX" get "$type" "$name" --ignore-not-found -o name || fail "kubernetes=capture-error:$type/$name"
  fi
  classification=$(classify_k8s "$expected" "$CAPTURE_RC" "$CAPTURE_STDOUT" "$CAPTURE_STDERR")
  if [ "$classification" != absent ]; then
    printf 'kubernetes=%s/%s:%s\nstdout=%s\nstderr=%s\n' "$type" "$name" "$classification" "$CAPTURE_STDOUT" "$CAPTURE_STDERR" >&2
    exit 1
  fi
  printf '%s/%s=absent\n' "$type" "$name"
}

check_remote_file_absent() {
  local path="$1" classification
  capture bounded stat --printf='%n' -- "$path" || fail "remote-stat=capture-error:$path"
  classification=$(classify_file "$path" remote "$CAPTURE_RC" "$CAPTURE_STDOUT" "$CAPTURE_STDERR")
  if [ "$classification" != absent ]; then
    printf 'remote-file=%s:%s\n%s\n' "$path" "$classification" "$CAPTURE_STDERR" >&2
    exit 1
  fi
  printf '%s=absent\n' "$path"
}

check_process_absent() {
  local comm="$1" target="$2" classification pid target_found=0
  capture bounded pgrep -x "$comm" || fail "pgrep=capture-error:$comm"
  classification=$(classify_pgrep "$CAPTURE_RC" "$CAPTURE_STDOUT" "$CAPTURE_STDERR")
  case "$classification" in
    absent) return;;
    timeout|operational-error) printf 'process=%s:%s\n%s\n' "$comm" "$classification" "$CAPTURE_STDERR" >&2; exit 1;;
  esac
  while IFS= read -r pid; do
    if [ -z "$pid" ]; then continue; fi
    case "$pid" in *[!0-9]*) fail "process=invalid-pid:$pid";; esac
    # shellcheck disable=SC2016 # $1 is expanded by the nested bash command.
    capture bounded bash -c 'tr "\\0" "\\n" < "$1"' bash "/proc/$pid/cmdline" || fail "process=proc-capture-error:$pid"
    if [ "$CAPTURE_RC" -ne 0 ] || [ -n "$CAPTURE_STDERR" ]; then
      printf 'process=%s:operational-error\n%s\n' "$pid" "$CAPTURE_STDERR" >&2
      exit 1
    fi
    while IFS= read -r arg; do
      if [ "$arg" = "$target" ] || [ "$arg" = "--base-path=$target" ] || [ "$arg" = "--pid-file=$TMP/git-daemon.pid" ]; then
        target_found=1
      fi
    done <<<"$CAPTURE_STDOUT"
  done <<<"$CAPTURE_STDOUT"
  if [ "$target_found" -eq 1 ]; then
    printf 'process=%s:target-present\n' "$comm" >&2
    exit 1
  fi
}

check_listener_absent() {
  local classification
  capture bounded ss -ltnH 'sport = :9418' || fail 'listener=capture-error'
  classification=$(classify_listener "$CAPTURE_RC" "$CAPTURE_STDOUT" "$CAPTURE_STDERR")
  if [ "$classification" != absent ]; then
    printf 'listener=:9418:%s\nstdout=%s\nstderr=%s\n' "$classification" "$CAPTURE_STDOUT" "$CAPTURE_STDERR" >&2
    exit 1
  fi
  printf '%s\n' 'run-local-git-listener=:9418-absent'
}

check_image_absent() {
  local image="$1" classification
  capture bounded docker image inspect --format='{{.Id}}' "$image" || fail "image=capture-error:$image"
  classification=$(classify_image "$image" "$CAPTURE_RC" "$CAPTURE_STDOUT" "$CAPTURE_STDERR")
  if [ "$classification" != absent ]; then
    printf 'image=%s:%s\nstdout=%s\nstderr=%s\n' "$image" "$classification" "$CAPTURE_STDOUT" "$CAPTURE_STDERR" >&2
    exit 1
  fi
}

check_container() {
  local name="$1" expected="$2" classification
  capture bounded docker inspect --format='{{.Id}} {{.State.Running}}' "$name" || fail "container=capture-error:$name"
  classification=$(classify_container "$expected" "$CAPTURE_RC" "$CAPTURE_STDOUT" "$CAPTURE_STDERR")
  if [ "$classification" != found ]; then
    printf 'container=%s:%s\nstdout=%s\nstderr=%s\n' "$name" "$classification" "$CAPTURE_STDOUT" "$CAPTURE_STDERR" >&2
    exit 1
  fi
  printf '%s %s\n' "$name" "$CAPTURE_STDOUT"
}

run_remote() {
  trap 'cleanup_capture_files' EXIT
  trap 'handle_interrupt' TERM INT
  local started=$SECONDS
  budget() {
    if (( SECONDS - started >= DEADLINE )); then fail deadline=exceeded; fi
  }
  budget
  check_k8s_absent namespace "$ARGO_NS" "namespace/$ARGO_NS"
  check_k8s_absent namespace "$PREVIEW_NS" "namespace/$PREVIEW_NS"
  check_k8s_absent customresourcedefinition.apiextensions.k8s.io applications.argoproj.io "customresourcedefinition.apiextensions.k8s.io/applications.argoproj.io"
  check_k8s_absent customresourcedefinition.apiextensions.k8s.io applicationsets.argoproj.io "customresourcedefinition.apiextensions.k8s.io/applicationsets.argoproj.io"
  check_k8s_absent customresourcedefinition.apiextensions.k8s.io appprojects.argoproj.io "customresourcedefinition.apiextensions.k8s.io/appprojects.argoproj.io"
  printf '%s\n' 'application.argoproj.io/tracegarden-preview-pr-23094001=absent (run namespace and run-owned CRDs absent)'
  for kind in clusterrole.rbac.authorization.k8s.io clusterrolebinding.rbac.authorization.k8s.io; do
    for name in "$ARGO_NS-application-controller" "$ARGO_NS-applicationset-controller" "$ARGO_NS-server" "$ARGO_NS-repo-server" "$ARGO_NS-dex-server" "$ARGO_NS-notifications-controller"; do
      check_k8s_absent "$kind" "$name" "$kind/$name"
    done
  done
  check_k8s_absent priorityclass.scheduling.k8s.io tracegarden-preview priorityclass.scheduling.k8s.io/tracegarden-preview
  check_remote_file_absent "$TMP"
  check_remote_file_absent "$TMP/git-daemon.pid"
  check_remote_file_absent "$TMP/install-run.yaml"
  check_remote_file_absent "$TMP/lifecycle-run.yaml"
  check_remote_file_absent "$TMP/priorityclass.yaml"
  check_remote_file_absent "$REMOTE_TAR"
  check_listener_absent
  check_process_absent git "$TMP/git"
  check_process_absent git-daemon "$TMP/git"
  printf '%s\n' run-local-git-process=absent
  for image in "$RUN/argocd" "$RUN/dex" "$RUN/redis" "$RUN/git-fixture"; do
    check_image_absent "$image"
  done
  printf '%s\n' run-tagged-images=absent
  check_container railgun-caddy "$CADDY_ID"
  check_container k8s-cluster-v137-control-plane "$CONTROL_PLANE_ID"
  check_container k8s-cluster-v137-worker "$WORKER_ID"
  printf '%s\n' followup-cleanup-and-preservation=passed
}

run_body() {
  trap 'cleanup_capture_files' EXIT
  trap 'handle_interrupt' TERM INT
  local_absent_file "$LOCAL_TMP"
  local_absent_file "$LOCAL_TAR"
  "${SSH[@]}" bash -s -- --remote <"$0" &
  CAPTURE_COMMAND_PID=$!
  set +e
  wait "$CAPTURE_COMMAND_PID"
  local ssh_rc=$?
  set -e
  CAPTURE_COMMAND_PID=''
  return "$ssh_rc"
}

# This supervisor is the only production deadline wrapper. It starts the
# watchdog first, launches the body second, then uses only shell builtins to
# stop the watchdog and exit; no output post-processing or staging occurs.
run_supervised() {
  local child_arg="$1" supervisor
  (
    local body watchdog rc supervisor_pid
    supervisor_pid="$BASHPID"
    # shellcheck disable=SC2329 # invoked indirectly by the TERM trap below.
    supervisor_term() {
      local body_pid="${body:-}" watchdog_pid="${watchdog:-}"
      set +e
      if [ -n "$body_pid" ]; then
        kill -TERM "$body_pid" 2>/dev/null || true
        wait "$body_pid" 2>/dev/null || true
      fi
      if [ -n "$watchdog_pid" ]; then
        kill -TERM "$watchdog_pid" 2>/dev/null || true
        wait "$watchdog_pid" 2>/dev/null || true
      fi
      exit 124
    }
    trap supervisor_term TERM
    (
      sleep "$DEADLINE"
      kill -TERM "$supervisor_pid" 2>/dev/null || true
    ) &
    watchdog=$!
    "$0" "$child_arg" &
    body=$!
    set +e
    wait "$body"
    rc=$?
    set -e
    kill -TERM "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
    trap - TERM
    exit "$rc"
  ) &
  supervisor=$!
  wait "$supervisor"
}

case "${1:-}" in
  --self-test) run_supervised --self-test-body;;
  --self-test-body) run_self_test;;
  --sleep-fixture) local_absent_file "$LOCAL_TMP";;
  --remote) run_remote;;
  --body) run_body;;
  '') run_supervised --body;;
  *) printf '%s\n' 'usage: validate-followup-cleanup.sh [--self-test]' >&2; exit 2;;
esac
