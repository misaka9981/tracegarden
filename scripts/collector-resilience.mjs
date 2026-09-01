import assert from "node:assert/strict";
import {
  CollectorRecoveryError,
  createCollectorRuntime,
} from "../dist/apps/collector/src/main.js";
import {
  ConfiguredKubernetesAdapter,
  DeterministicKubernetesAdapter,
  KubernetesWatchGoneError,
  compareResourceVersions,
  parseKubernetesWatchEvent,
} from "../dist/packages/cluster/src/index.js";
import { MemoryObservationStore } from "../dist/packages/db/src/index.js";
import { CoreV1Api, Watch } from "@kubernetes/client-node";

const scope = {
  workspaceId: "workspace-single",
  clusterId: "resilience-cluster",
  name: "resilience",
  endpoint: "https://cluster.example.test",
  namespaces: ["tracegarden"],
  resourceKinds: ["Pod"],
};
const pod = (resourceVersion, phase = "Running", namespace = "tracegarden", name = "api-0") => ({
  kind: "Pod",
  metadata: { name, namespace, uid: `${namespace}-${name}-uid`, resourceVersion },
  status: { phase, conditions: [{ type: "Ready", status: phase === "Running" ? "True" : "False" }] },
});

const adapter = new DeterministicKubernetesAdapter([], {
  listResults: [
    { resources: [pod("10")], resourceVersion: "10" },
    { resources: [pod("20", "Pending")], resourceVersion: "20" },
  ],
  watchPlans: [
    {
      events: [
        { type: "MODIFIED", resource: pod("11"), resourceVersion: "11", observedAt: "2026-01-01T00:00:01.000Z" },
        { type: "MODIFIED", resource: pod("11"), resourceVersion: "11", observedAt: "2026-01-01T00:00:01.000Z" },
        { type: "ERROR", resource: { kind: "Status", code: 410, reason: "Gone" } },
      ],
    },
    {
      events: [{ type: "MODIFIED", resource: pod("21", "Running"), resourceVersion: "21", observedAt: "2026-01-01T00:00:01.000Z" }],
      error: new Error("deterministic disconnect"),
    },
  ],
});
const store = new MemoryObservationStore();
const controller = new AbortController();
let sleepCalls = 0;
const runtime = await createCollectorRuntime({
  port: 43301,
  host: "127.0.0.1",
  scope,
  adapter,
  observationStore: store,
  sleep: async (delay) => {
    assert.equal(delay, 100);
    sleepCalls += 1;
    controller.abort();
  },
  now: () => new Date("2026-01-01T00:00:02.000Z"),
});
try {
  await runtime.runWatch({ signal: controller.signal });
  assert.deepEqual(adapter.watchRequests.map(({ resourceVersion }) => resourceVersion), ["10", "20"]);
  assert.equal((await store.getIngestionCheckpoint(scope.workspaceId, scope.clusterId, "Pod", "tracegarden"))?.resourceVersion, "21");
  assert.equal(await store.countObservations(scope.workspaceId), 4);
  assert.equal(await store.countTimelineEntries(scope.workspaceId), 4);
  assert.equal(sleepCalls, 1);
  assert.equal(runtime.signals().relists, 1);
  assert.equal(runtime.signals().reconnects, 1);
  assert.deepEqual(runtime.signals().backoffDelaysMs, [100]);
  assert.equal(runtime.signals().normalizationFailures, 0);
  assert.equal(runtime.signals().persistenceFailures, 0);
  assert.equal(runtime.signals().lagSeconds, 1);
  assert.equal((await (await fetch("http://127.0.0.1:43301/health/readiness")).json()).signals.relists, 1);
} finally {
  await runtime.close();
}

const restartController = new AbortController();
const restartAdapter = new DeterministicKubernetesAdapter([], {
  watchPlans: [{ events: [{ type: "BOOKMARK", resourceVersion: "22" }], error: new Error("restart disconnect") }],
});
const restarted = await createCollectorRuntime({
  port: 43305,
  host: "127.0.0.1",
  scope,
  adapter: restartAdapter,
  observationStore: store,
  sleep: async () => restartController.abort(),
});
try {
  await restarted.runWatch({ signal: restartController.signal });
  assert.deepEqual(restartAdapter.requests, []);
  assert.deepEqual(restartAdapter.watchRequests.map(({ resourceVersion }) => resourceVersion), ["21"]);
  assert.equal((await store.getIngestionCheckpoint(scope.workspaceId, scope.clusterId, "Pod", "tracegarden"))?.resourceVersion, "22");
} finally {
  await restarted.close();
}

const boundedAdapter = new DeterministicKubernetesAdapter([], {
  listResults: [{ resources: [], resourceVersion: "1" }],
  watchPlans: [{ error: new Error("disconnect") }, { error: new Error("disconnect") }, { error: new Error("unexpected third retry") }],
});
const bounded = await createCollectorRuntime({
  port: 43302,
  host: "127.0.0.1",
  scope,
  adapter: boundedAdapter,
  observationStore: new MemoryObservationStore(),
  backoff: { maxReconnectAttempts: 2 },
  sleep: async () => {},
});
try {
  await assert.rejects(bounded.runWatch(), (error) => error instanceof CollectorRecoveryError && /bounded Kubernetes watch reconnect/.test(error.message));
  assert.equal(bounded.signals().reconnects, 2);
  assert.deepEqual(bounded.signals().backoffDelaysMs, [100, 200]);
} finally {
  await bounded.close();
}

const malformedAdapter = new DeterministicKubernetesAdapter([], {
  listResults: [{ resources: [], resourceVersion: "5" }],
  watchPlans: [{ events: [{ type: "ADDED", resource: { kind: "Pod", metadata: { name: "api-0", namespace: "tracegarden", resourceVersion: "6" } }, resourceVersion: "6" }] }],
});
const malformedStore = new MemoryObservationStore();
const malformed = await createCollectorRuntime({
  port: 43303,
  host: "127.0.0.1",
  scope,
  adapter: malformedAdapter,
  observationStore: malformedStore,
  sleep: async () => {},
});
try {
  await assert.rejects(malformed.runWatch(), (error) => error instanceof CollectorRecoveryError && /normalization failed/.test(error.message));
  assert.equal((await malformedStore.getIngestionCheckpoint(scope.workspaceId, scope.clusterId, "Pod", "tracegarden"))?.resourceVersion, "5");
  assert.equal(malformed.signals().normalizationFailures, 1);
} finally {
  await malformed.close();
}

class FailingCheckpointStore extends MemoryObservationStore {
  async recordObservationsAndCheckpoint() {
    throw new Error("transaction failed");
  }
}
const failingStore = new FailingCheckpointStore();
const failing = await createCollectorRuntime({
  port: 43304,
  host: "127.0.0.1",
  scope,
  adapter: new DeterministicKubernetesAdapter([], { listResults: [{ resources: [pod("30")], resourceVersion: "30" }] }),
  observationStore: failingStore,
});
try {
  await assert.rejects(failing.runWatch(), (error) => error instanceof CollectorRecoveryError && /observation and checkpoint persistence failed/.test(error.message));
  assert.equal(await failingStore.countObservations(scope.workspaceId), 0);
  assert.equal(await failingStore.getIngestionCheckpoint(scope.workspaceId, scope.clusterId, "Pod", "tracegarden"), null);
  assert.equal(failing.signals().persistenceFailures, 1);
} finally {
  await failing.close();
}

assert.deepEqual(parseKubernetesWatchEvent(JSON.stringify({
  type: "ERROR",
  object: { kind: "Status", code: 410, reason: "Gone" },
})), {
  type: "ERROR",
  resource: { kind: "Status", code: 410, reason: "Gone" },
  statusCode: 410,
  reason: "Gone",
});
assert.equal(compareResourceVersions("9007199254740993", "9007199254740992"), 1);
assert.equal(compareResourceVersions("opaque-new", "opaque-old"), 0);

const prefixedScope = { ...scope, endpoint: "https://cluster.example.test/environment" };
const configuredAdapter = new ConfiguredKubernetesAdapter({ endpoint: "https://cluster.example.test", token: "test-token" });
const originalWatch = Watch.prototype.watch;
let capturedWatchPath;
Watch.prototype.watch = async (path, _query, _callback, done) => {
  capturedWatchPath = path;
  done(null);
  return new AbortController();
};
try {
  const stream = await configuredAdapter.watch(prefixedScope, "1");
  assert.equal(capturedWatchPath, "/api/v1/namespaces/tracegarden/pods");
  assert.equal((await stream[Symbol.asyncIterator]().next()).done, true);
} finally {
  Watch.prototype.watch = originalWatch;
}

const originalList = CoreV1Api.prototype.listNamespacedPod;
let capturedListSignal;
CoreV1Api.prototype.listNamespacedPod = async (_request, options) => {
  const context = { setSignal: (signal) => { capturedListSignal = signal; } };
  await options.middleware[0].pre(context).toPromise();
  await new Promise((_, reject) => {
    if (capturedListSignal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    capturedListSignal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  return { metadata: { resourceVersion: "1" }, items: [] };
};
const listController = new AbortController();
try {
  const pendingList = configuredAdapter.list(prefixedScope, listController.signal);
  while (!capturedListSignal) await Promise.resolve();
  listController.abort();
  await assert.rejects(pendingList, /aborted/);
  assert.equal(capturedListSignal.aborted, true);
} finally {
  CoreV1Api.prototype.listNamespacedPod = originalList;
}

const crossNamespaceStore = new MemoryObservationStore();
const crossNamespace = await createCollectorRuntime({
  port: 43310,
  host: "127.0.0.1",
  scope: { ...scope, clusterId: "cross-namespace-cluster", namespaces: ["alpha"] },
  adapter: new DeterministicKubernetesAdapter([], {
    listResults: [{ resources: [pod("1", "Running", "alpha")], resourceVersion: "1" }],
    watchPlans: [{ events: [{ type: "MODIFIED", resource: pod("2", "Pending", "beta"), resourceVersion: "2" }] }],
  }),
  observationStore: crossNamespaceStore,
});
try {
  await assert.rejects(crossNamespace.runWatch(), (error) => error instanceof CollectorRecoveryError && /normalization failed/.test(error.message));
  assert.equal(await crossNamespaceStore.countObservations(scope.workspaceId), 1);
  assert.equal((await crossNamespaceStore.getIngestionCheckpoint(scope.workspaceId, "cross-namespace-cluster", "Pod", "alpha"))?.resourceVersion, "1");
} finally {
  await crossNamespace.close();
}

const opaqueScope = { ...scope, clusterId: "opaque-resource-version-cluster" };
const opaqueStore = new MemoryObservationStore();
const opaqueController = new AbortController();
const opaqueAdapter = new DeterministicKubernetesAdapter([], {
  listResults: [{ resources: [pod("opaque-1")], resourceVersion: "opaque-1" }],
  watchPlans: [{ events: [{ type: "MODIFIED", resource: pod("opaque-2", "Pending"), resourceVersion: "opaque-2" }], error: new Error("opaque disconnect") }],
});
const opaque = await createCollectorRuntime({
  port: 43311,
  host: "127.0.0.1",
  scope: opaqueScope,
  adapter: opaqueAdapter,
  observationStore: opaqueStore,
  sleep: async () => opaqueController.abort(),
});
try {
  await opaque.runWatch({ signal: opaqueController.signal });
  assert.equal((await opaqueStore.getIngestionCheckpoint(opaqueScope.workspaceId, opaqueScope.clusterId, "Pod", "tracegarden"))?.resourceVersion, "opaque-2");
} finally {
  await opaque.close();
}

const multiScope = {
  ...scope,
  clusterId: "multi-namespace-cluster",
  namespaces: ["alpha", "beta"],
};
const multiAdapter = new DeterministicKubernetesAdapter([], {
  listResults: [
    { resources: [pod("10", "Running", "alpha")], resourceVersion: "10" },
    { resources: [pod("20", "Running", "beta")], resourceVersion: "20" },
    { resources: [pod("12", "Pending", "alpha")], resourceVersion: "12" },
  ],
  watchPlans: [
    { error: new KubernetesWatchGoneError() },
    { events: [{ type: "MODIFIED", resource: pod("21", "Pending", "beta"), resourceVersion: "21" }], error: new Error("beta disconnect") },
    { events: [{ type: "MODIFIED", resource: pod("13", "Running", "alpha"), resourceVersion: "13" }] },
  ],
});
const multiStore = new MemoryObservationStore();
const multiController = new AbortController();
const multi = await createCollectorRuntime({
  port: 43306,
  host: "127.0.0.1",
  scope: multiScope,
  adapter: multiAdapter,
  observationStore: multiStore,
  sleep: async () => {
    while ((await multiStore.getIngestionCheckpoint(multiScope.workspaceId, multiScope.clusterId, "Pod", "alpha"))?.resourceVersion !== "13") await Promise.resolve();
    multiController.abort();
  },
});
try {
  await multi.runWatch({ signal: multiController.signal });
  assert.deepEqual(multiAdapter.watchRequests.map(({ scope: requestScope, resourceVersion }) => [requestScope.namespaces[0], resourceVersion]), [["alpha", "10"], ["beta", "20"], ["alpha", "12"]]);
  assert.equal((await multiStore.getIngestionCheckpoint(multiScope.workspaceId, multiScope.clusterId, "Pod", "alpha"))?.resourceVersion, "13");
  assert.equal((await multiStore.getIngestionCheckpoint(multiScope.workspaceId, multiScope.clusterId, "Pod", "beta"))?.resourceVersion, "21");
} finally {
  await multi.close();
}

const isolatedScope = { ...scope, clusterId: "isolated-retry-cluster", namespaces: ["alpha", "beta"] };
const isolatedStore = new MemoryObservationStore();
const isolatedController = new AbortController();
const isolatedAdapter = new DeterministicKubernetesAdapter([], {
  listResults: [
    { resources: [pod("1", "Running", "alpha")], resourceVersion: "1" },
    { resources: [pod("1", "Running", "beta")], resourceVersion: "1" },
  ],
  watchPlans: [
    { error: new Error("alpha first disconnect") },
    { events: [{ type: "MODIFIED", resource: pod("2", "Pending", "beta"), resourceVersion: "2" }], error: new Error("beta disconnect") },
    { error: new Error("alpha second disconnect") },
  ],
});
let isolatedSleepCalls = 0;
let isolated;
isolated = await createCollectorRuntime({
  port: 43312,
  host: "127.0.0.1",
  scope: isolatedScope,
  adapter: isolatedAdapter,
  observationStore: isolatedStore,
  backoff: { maxReconnectAttempts: 1 },
  sleep: async () => {
    isolatedSleepCalls += 1;
    if (isolatedSleepCalls === 1) return;
    while (!isolated.signals().failedNamespaces.includes("alpha")) await Promise.resolve();
    isolatedController.abort();
  },
});
try {
  await isolated.runWatch({ signal: isolatedController.signal });
  assert.deepEqual(isolated.signals().failedNamespaces, ["alpha"]);
  assert.equal((await isolatedStore.getIngestionCheckpoint(isolatedScope.workspaceId, isolatedScope.clusterId, "Pod", "alpha"))?.resourceVersion, "1");
  assert.equal((await isolatedStore.getIngestionCheckpoint(isolatedScope.workspaceId, isolatedScope.clusterId, "Pod", "beta"))?.resourceVersion, "2");
  assert.equal(isolatedSleepCalls, 2);
} finally {
  await isolated.close();
}

const repeatedGoneAdapter = new DeterministicKubernetesAdapter([], {
  listResults: [
    { resources: [], resourceVersion: "1" },
    { resources: [], resourceVersion: "2" },
    { resources: [], resourceVersion: "3" },
  ],
  watchPlans: [{ error: new KubernetesWatchGoneError() }, { error: new KubernetesWatchGoneError() }, { error: new KubernetesWatchGoneError() }],
});
const repeatedGone = await createCollectorRuntime({
  port: 43307,
  host: "127.0.0.1",
  scope,
  adapter: repeatedGoneAdapter,
  observationStore: new MemoryObservationStore(),
  backoff: { maxReconnectAttempts: 2 },
});
try {
  await assert.rejects(repeatedGone.runWatch(), (error) => error instanceof CollectorRecoveryError && /bounded Kubernetes watch reconnect/.test(error.message));
  assert.equal(repeatedGone.signals().relists, 2);
  assert.equal(repeatedGoneAdapter.requests.length, 3);
} finally {
  await repeatedGone.close();
}

const missingRelistVersionStore = new MemoryObservationStore();
const missingRelistVersion = await createCollectorRuntime({
  port: 43308,
  host: "127.0.0.1",
  scope,
  adapter: new DeterministicKubernetesAdapter([], {
    listResults: [{ resources: [], resourceVersion: "1" }, { resources: [] }],
    watchPlans: [{ error: new KubernetesWatchGoneError() }],
  }),
  observationStore: missingRelistVersionStore,
});
try {
  await assert.rejects(missingRelistVersion.runWatch(), /Kubernetes list did not return a resourceVersion/);
  assert.equal(await missingRelistVersionStore.getIngestionCheckpoint(scope.workspaceId, scope.clusterId, "Pod", "tracegarden"), null);
} finally {
  await missingRelistVersion.close();
}

let cancellationSignal;
const cancellationAdapter = {
  kind: "deterministic",
  contacted: false,
  listResult: async () => ({ resources: [], resourceVersion: "1" }),
  watch: async (_scope, _resourceVersion, signal) => {
    cancellationSignal = signal;
    return (async function* () {
      if (signal.aborted) return;
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    })();
  },
};
const cancellation = await createCollectorRuntime({
  port: 43309,
  host: "127.0.0.1",
  scope,
  adapter: cancellationAdapter,
  observationStore: new MemoryObservationStore(),
});
const cancellationController = new AbortController();
try {
  const running = cancellation.runWatch({ signal: cancellationController.signal });
  while (!cancellationSignal) await Promise.resolve();
  cancellationController.abort();
  await running;
  assert.equal(cancellationSignal.aborted, true);
} finally {
  await cancellation.close();
}

let listCancellationSignal;
const listCancellationAdapter = {
  kind: "deterministic",
  contacted: false,
  listResult: async (_scope, signal) => {
    listCancellationSignal = signal;
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    return { resources: [], resourceVersion: "1" };
  },
  watch: async (_scope, _resourceVersion, signal) => {
    signal.throwIfAborted();
    return (async function* () {})();
  },
};
const listCancellation = await createCollectorRuntime({
  port: 43313,
  host: "127.0.0.1",
  scope,
  adapter: listCancellationAdapter,
  observationStore: new MemoryObservationStore(),
});
const listCancellationController = new AbortController();
try {
  const running = listCancellation.runWatch({ signal: listCancellationController.signal });
  while (!listCancellationSignal) await Promise.resolve();
  listCancellationController.abort();
  await running;
  assert.equal(listCancellationSignal.aborted, true);
} finally {
  await listCancellation.close();
}

console.log("collector checkpoint, per-namespace ordering, streamed-410, cancellation, huge-RV, bounded-backoff, and failure-path checks passed");
