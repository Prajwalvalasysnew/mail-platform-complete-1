{{/*
Expand the name of the chart.
*/}}
{{- define "mail-platform.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "mail-platform.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s" (include "mail-platform.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/*
Resolve the image tag (component-level tag overrides global tag).
*/}}
{{- define "mail-platform.imageTag" -}}
{{- $tag := .componentTag | default .globalTag }}
{{- $tag | default "latest" }}
{{- end }}

{{/*
Common labels applied to every resource.
*/}}
{{- define "mail-platform.labels" -}}
helm.sh/chart: {{ include "mail-platform.name" . }}-{{ .Chart.Version }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Selector labels for a given component (e.g. api, worker, tracker).
*/}}
{{- define "mail-platform.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mail-platform.name" . }}
app.kubernetes.io/component: {{ .component }}
{{- end }}
