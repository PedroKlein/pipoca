{{- define "pipoca-kyma.host" -}}
{{- .Values.apiRule.host | default (urlParse (required "pipoca.url is required, such as https://pipoca.<cluster domain>" .Values.pipoca.url)).hostname }}
{{- end }}
