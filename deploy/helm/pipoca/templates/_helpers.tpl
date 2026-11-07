{{- define "pipoca.labels" -}}
app.kubernetes.io/name: pipoca
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "pipoca.secretName" -}}
{{- .Values.existingSecret | default (printf "%s-secret-key" .Release.Name) }}
{{- end }}

{{- /*
The first pipoca.json. A server that starts runner pods gets a template for
them unless the config names its own, so its first person can pick the
cluster in setup (ADR 0049).
*/ -}}
{{- define "pipoca.config" -}}
{{- $config := deepCopy (.Values.config | default dict) }}
{{- if and .Values.runnerPods.enabled (not (hasKey $config "templates")) }}
{{- $pods := dict "workspace" "pod" }}
{{- with .Values.runnerPods.labels }}{{ $_ := set $pods "labels" . }}{{ end }}
{{- with .Values.runnerPods.annotations }}{{ $_ := set $pods "annotations" . }}{{ end }}
{{- $_ := set $config "templates" (list (dict "id" "kubernetes-pods" "name" "Kubernetes pods" "isolation" "process" "kubernetes" $pods)) }}
{{- end }}
{{- if $config }}{{ toPrettyJson $config }}{{ end }}
{{- end }}
