{{- define "pipoca.labels" -}}
app.kubernetes.io/name: pipoca
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "pipoca.secretName" -}}
{{- .Values.existingSecret | default (printf "%s-secret-key" .Release.Name) }}
{{- end }}

{{- define "pipoca.url" -}}
{{- if .Values.url }}{{ .Values.url }}
{{- else if .Values.apiRule.enabled }}https://{{ required "apiRule.host is required" .Values.apiRule.host }}
{{- end }}
{{- end }}

{{- /*
The first pipoca.json. A server that starts runner pods gets a template for
them unless the config names its own, so its first person can pick the
cluster in setup (ADR 0049).
*/ -}}
{{- define "pipoca.config" -}}
{{- $config := deepCopy (.Values.config | default dict) }}
{{- if and .Values.runnerPods.enabled (not (hasKey $config "templates")) }}
{{- $_ := set $config "templates" (list (dict "id" "kubernetes-pods" "name" "Kubernetes pods" "isolation" "process" "kubernetes" (dict "workspace" "pod"))) }}
{{- end }}
{{- if $config }}{{ toPrettyJson $config }}{{ end }}
{{- end }}
