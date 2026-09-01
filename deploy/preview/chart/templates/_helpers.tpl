{{/* Preview chart names are intentionally derived from the PR namespace. */}}
{{- define "tracegarden-preview.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end }}
{{- define "tracegarden-preview.fullname" -}}
{{- printf "tracegarden-preview-pr-%d" (int .Values.preview.number) | trunc 63 | trimSuffix "-" -}}
{{- end }}
{{- define "tracegarden-preview.labels" -}}
app.kubernetes.io/name: {{ include "tracegarden-preview.name" . | quote }}
app.kubernetes.io/instance: {{ include "tracegarden-preview.fullname" . | quote }}
app.kubernetes.io/managed-by: argocd
tracegarden.dev/lifecycle: pull-request-preview
tracegarden.dev/pull-request: {{ .Values.preview.number | quote }}
{{- end }}
{{- define "tracegarden-preview.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tracegarden-preview.name" . | quote }}
app.kubernetes.io/instance: {{ include "tracegarden-preview.fullname" . | quote }}
{{- end }}
{{- define "tracegarden-preview.image" -}}
{{- $image := index .root.Values.images .component -}}
{{- printf "%s@%s" $image.repository $image.digest -}}
{{- end }}
{{- define "tracegarden-preview.postgresService" -}}
{{- printf "%s-postgres" (include "tracegarden-preview.fullname" .) -}}
{{- end }}
