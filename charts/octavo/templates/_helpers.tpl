{{- define "octavo.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "octavo.fullname" -}}
{{- printf "%s" (include "octavo.name" .) -}}
{{- end -}}

{{- define "octavo.labels" -}}
app.kubernetes.io/name: {{ include "octavo.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "octavo.selectorLabels" -}}
app.kubernetes.io/name: {{ include "octavo.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "octavo.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}
