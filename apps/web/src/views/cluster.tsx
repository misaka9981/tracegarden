import { hasClusterConfigureCapability, SUPPORTED_RESOURCE_KINDS, type ClusterScope } from "../../../../packages/cluster/src/index.js";
import { type AuthenticatedSession } from "../../../../packages/identity/src/index.js";
import { type Messages } from "../../../../packages/i18n/src/index.js";

export type ClusterFeedback = Readonly<{ saved?: boolean | undefined; error?: string | undefined }>;

export function ClusterSection({ language, messages, member, scope, feedback }: {
  language: "zh-CN" | "en";
  messages: Messages;
  member: AuthenticatedSession["member"];
  scope: ClusterScope | null;
  feedback?: ClusterFeedback | undefined;
}) {
  const selectedKinds = new Set(scope?.resourceKinds ?? []);
  return <section aria-labelledby="cluster-scope-title">
    <h2 id="cluster-scope-title">{messages.clusterTitle}</h2>
    <p>{messages.clusterDescription}</p>
    {feedback?.saved ? <p role="status">{messages.clusterSaved}</p> : null}
    {feedback?.error ? <p class="error" role="alert">{feedback.error}</p> : null}
    {scope
      ? <dl>
        <dt>{messages.clusterName}</dt><dd>{scope.name}</dd>
        <dt>{messages.clusterEndpoint}</dt><dd>{scope.endpoint}</dd>
        <dt>{messages.approvedNamespaces}</dt><dd>{scope.namespaces.join(", ") || messages.clusterNotConfigured}</dd>
        <dt>{messages.approvedResourceKinds}</dt><dd>{scope.resourceKinds.join(", ") || messages.clusterNotConfigured}</dd>
      </dl>
      : <p>{messages.clusterNotConfigured}</p>}
    {hasClusterConfigureCapability(member)
      ? <form method="post" action={`/cluster/configure?lang=${language}`}>
        <input type="hidden" name="clusterId" value={scope?.clusterId ?? ""} />
        <label for="cluster-name">{messages.clusterName}</label>
        <input id="cluster-name" name="name" required maxlength={100} value={scope?.name ?? ""} />
        <label for="cluster-endpoint">{messages.clusterEndpoint}</label>
        <input id="cluster-endpoint" name="endpoint" type="url" required value={scope?.endpoint ?? ""} />
        <label for="cluster-namespaces">{messages.approvedNamespaces}</label>
        <textarea id="cluster-namespaces" name="namespaces" rows={4}>{scope?.namespaces.join("\n") ?? ""}</textarea>
        <fieldset>
          <legend>{messages.approvedResourceKinds}</legend>
          <p class="hint">{messages.supportedResourceKinds}</p>
          {SUPPORTED_RESOURCE_KINDS.map((kind) => <label>
            <input type="checkbox" name="resourceKinds" value={kind} checked={selectedKinds.has(kind)} /> {kind}
          </label>)}
        </fieldset>
        <button type="submit">{messages.saveCluster}</button>
      </form>
      : <p class="error" role="alert">{messages.clusterConfigurationDenied}</p>}
  </section>;
}
