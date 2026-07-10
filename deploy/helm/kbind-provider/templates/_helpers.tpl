{{/*
Expand the name of the chart.
*/}}
{{- define "platform-mesh-kbind-provider.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
Truncate at 63 chars because some Kubernetes name fields are limited to this.
If release name contains the chart name it will be used as-is.
*/}}
{{- define "platform-mesh-kbind-provider.fullname" -}}
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

{{/*
Create chart label value (name + version).
*/}}
{{- define "platform-mesh-kbind-provider.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "platform-mesh-kbind-provider.labels" -}}
helm.sh/chart: {{ include "platform-mesh-kbind-provider.chart" . }}
{{ include "platform-mesh-kbind-provider.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "platform-mesh-kbind-provider.selectorLabels" -}}
app.kubernetes.io/name: {{ include "platform-mesh-kbind-provider.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
ServiceAccount name.
*/}}
{{- define "platform-mesh-kbind-provider.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "platform-mesh-kbind-provider.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Kubeconfig mount path derived from the configured key.
*/}}
{{- define "platform-mesh-kbind-provider.kubeconfigPath" -}}
{{- printf "/etc/kbind/%s" .Values.kcpKubeconfigKey }}
{{- end }}
