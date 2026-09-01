{{/* Expand the chart name. */}}
{{- define "tracegarden.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Expand the release-qualified name. */}}
{{- define "tracegarden.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/* Shared labels. */}}
{{- define "tracegarden.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | quote }}
app.kubernetes.io/name: {{ include "tracegarden.name" . | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
{{- end }}

{{/* Selector labels. */}}
{{- define "tracegarden.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tracegarden.name" . | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
{{- end }}

{{/* Immutable image reference. */}}
{{- define "tracegarden.image" -}}
{{- $image := index .root.Values.images .component -}}
{{- printf "%s@%s" $image.repository $image.digest -}}
{{- end }}

{{/* Backup configuration is fail-closed; an incomplete path stays suspended. */}}
{{- define "tracegarden.validateBackup" -}}
{{- $endpointPattern := "^https://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(:([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?(/[^\\s?#]*)?$" }}
{{- $numericHostEndpointPattern := "^https://[0-9]+(\\.[0-9]+)*(:([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?(/[^\\s?#]*)?$" }}
{{- $ipv4EndpointPattern := "^https://((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(:([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?(/[^\\s?#]*)?$" }}
{{- $ipv4CidrPattern := "^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])/(0|[12][0-9]|3[0-2])$" }}
{{- $ipv6CidrPattern := "^(([0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|([0-9A-Fa-f]{1,4}:){1,7}:|([0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|([0-9A-Fa-f]{1,4}:){1,5}(:[0-9A-Fa-f]{1,4}){1,2}|([0-9A-Fa-f]{1,4}:){1,4}(:[0-9A-Fa-f]{1,4}){1,3}|([0-9A-Fa-f]{1,4}:){1,3}(:[0-9A-Fa-f]{1,4}){1,4}|([0-9A-Fa-f]{1,4}:){1,2}(:[0-9A-Fa-f]{1,4}){1,5}|[0-9A-Fa-f]{1,4}:((:[0-9A-Fa-f]{1,4}){1,6})|:((:[0-9A-Fa-f]{1,4}){1,7}|:))/(0|[1-9][0-9]|1[01][0-9]|12[0-8])$" }}
{{- if .Values.backup.endpoint }}
{{- $endpoint := .Values.backup.endpoint }}
{{- if not (regexMatch $endpointPattern $endpoint) }}{{ fail "backup.endpoint must be a semantic HTTPS URL without credentials, query parameters, or fragments" }}{{ end }}
{{- if and (regexMatch $numericHostEndpointPattern $endpoint) (not (regexMatch $ipv4EndpointPattern $endpoint)) }}{{ fail "backup.endpoint must contain a valid IPv4 address or DNS hostname" }}{{ end }}
{{- end }}
{{- range .Values.backup.endpointCIDRs }}
{{- if not (or (regexMatch $ipv4CidrPattern .) (regexMatch $ipv6CidrPattern .)) }}{{ fail "backup.endpointCIDRs must contain valid IPv4 or IPv6 CIDRs" }}{{ end }}
{{- end }}
{{- if .Values.backup.enabled }}
{{- $_ := required "backup.endpoint is required when backup.enabled is true" .Values.backup.endpoint }}
{{- range .Values.backup.endpointCIDRs }}
{{- $cidr := lower . }}
{{- if or (hasPrefix "192.0.2." $cidr) (hasPrefix "198.51.100." $cidr) (hasPrefix "203.0.113." $cidr) (hasPrefix "2001:db8:" $cidr) }}{{ fail "backup.endpointCIDRs must not use TEST-NET or documentation-only CIDRs when backup.enabled is true" }}{{ end }}
{{- end }}
{{- $_ := required "backup.bucket is required when backup.enabled is true" .Values.backup.bucket }}
{{- $_ := required "backup.schedule is required when backup.enabled is true" .Values.backup.schedule }}
{{- if le (int .Values.backup.retentionDays) 0 }}{{ fail "backup.retentionDays must be positive when backup.enabled is true" }}{{ end }}
{{- if not .Values.backup.offVm }}{{ fail "backup.offVm must remain true; same-VM copies are not disaster recovery" }}{{ end }}
{{- if ne .Values.backup.encryption.mechanism "aes-256-gcm" }}{{ fail "backup.encryption.mechanism must be aes-256-gcm" }}{{ end }}
{{- $_ := required "backup.encryption.keySecret.existingSecret is required when backup.enabled is true" .Values.backup.encryption.keySecret.existingSecret }}
{{- $_ := required "backup.encryption.keySecret.key is required when backup.enabled is true" .Values.backup.encryption.keySecret.key }}
{{- $_ := required "backup.credentials.existingSecret is required when backup.enabled is true" .Values.backup.credentials.existingSecret }}
{{- $_ := required "backup.credentials.accessKeyIdKey is required when backup.enabled is true" .Values.backup.credentials.accessKeyIdKey }}
{{- $_ := required "backup.credentials.secretAccessKeyKey is required when backup.enabled is true" .Values.backup.credentials.secretAccessKeyKey }}
{{- end }}
{{- end }}

{{/* Revision for the regular migration Job; changes create a new immutable Job. */}}
{{- define "tracegarden.migrationRevision" -}}
{{- printf "%s|%d|%d|%d|%d" .Values.images.migrate.digest .Values.migration.backoffLimit .Values.migration.activeDeadlineSeconds .Values.migration.databaseReadyTimeoutSeconds .Values.migration.databaseReadyRetrySeconds | sha256sum | trunc 12 }}
{{- end }}

{{/* Name the regular migration Job within Kubernetes' 63-character limit. */}}
{{- define "tracegarden.migrationJobName" -}}
{{- printf "%s-migration-%s" (include "tracegarden.fullname" . | trunc 40 | trimSuffix "-") (include "tracegarden.migrationRevision" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Wait only for the expected schema; this script never invokes the migration runner. */}}
{{- define "tracegarden.schemaWaitScript" -}}
import { PostgresDatabase, waitForMigrations } from "./dist/packages/db/src/index.js";
const database = new PostgresDatabase(process.env.DATABASE_URL);
try {
  await waitForMigrations(
    database,
    Number(process.env.MIGRATION_SCHEMA_READY_TIMEOUT_SECONDS) * 1000,
    Number(process.env.MIGRATION_SCHEMA_READY_RETRY_SECONDS) * 1000,
  );
} finally {
  await database.close();
}
{{- end }}

{{/* Database secret name. */}}
{{- define "tracegarden.databaseSecret" -}}
{{- required "secrets.database.existingSecret is required" .Values.secrets.database.existingSecret -}}
{{- end }}

{{/* Application secret name. */}}
{{- define "tracegarden.applicationSecret" -}}
{{- required "secrets.application.existingSecret is required" .Values.secrets.application.existingSecret -}}
{{- end }}

{{/* Reject one Kubernetes identity being used for both access paths. */}}
{{- define "tracegarden.validateServiceAccounts" -}}
{{- if eq (include "tracegarden.observationServiceAccount" .) (include "tracegarden.logsServiceAccount" .) -}}
{{- fail "serviceAccount.observationName and serviceAccount.logsName must identify different ServiceAccounts" -}}
{{- end -}}
{{- end }}

{{/* Observation ServiceAccount name. */}}
{{- define "tracegarden.observationServiceAccount" -}}
{{- if .Values.serviceAccount.observationName }}{{ .Values.serviceAccount.observationName }}{{ else }}{{ printf "%s-observation" (include "tracegarden.fullname" . | trunc 50 | trimSuffix "-") | trunc 63 | trimSuffix "-" }}{{ end }}
{{- end }}

{{/* Recent Log Window ServiceAccount name. */}}
{{- define "tracegarden.logsServiceAccount" -}}
{{- if .Values.serviceAccount.logsName }}{{ .Values.serviceAccount.logsName }}{{ else }}{{ printf "%s-logs-reader" (include "tracegarden.fullname" . | trunc 50 | trimSuffix "-") | trunc 63 | trimSuffix "-" }}{{ end }}
{{- end }}
