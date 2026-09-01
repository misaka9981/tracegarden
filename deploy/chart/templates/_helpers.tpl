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
