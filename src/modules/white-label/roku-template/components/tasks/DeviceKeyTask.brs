' ============================================================
' Pede ao servidor uma chave de 6 digitos (POST /client/device-key). So funciona com sessao valida.
' A chave NUNCA e gravada no registro nem em log: vive so na tela, por poucos minutos.
' Sessao: mesma regra da CatalogApiTask (reaproveita token renovado por outra Task; refresh uma unica vez).
' ============================================================
sub init()
    m.top.functionName = "runRequest"
end sub

sub runRequest()
    out = { ok: false, status: -1, message: "", key: "", ttlSeconds: 0, clearAuth: false }

    if not DeltaServerConfigured() then
        out.message = "Servidor não configurado."
        m.top.result = out
        return
    end if

    token = RegRead("auth_token")
    if token = "" then
        out.message = "Conecte o dispositivo antes de gerar uma chave."
        m.top.result = out
        return
    end if

    url = DeltaDeviceKeyUrl()
    r = HttpJson(url, "POST", "{}", token)
    if r.status = 401 then
        current = RegRead("auth_token")
        if current <> "" and current <> token then
            r = HttpJson(url, "POST", "{}", current)
        else
            refreshToken = RegRead("refresh_token")
            if refreshToken <> "" then
                refreshed = RefreshSession(DeltaGetIdentity(), refreshToken)
                if refreshed.ok then
                    RegWrite("auth_token", refreshed.accessToken)
                    RegWrite("refresh_token", refreshed.refreshToken)
                    r = HttpJson(url, "POST", "{}", refreshed.accessToken)
                else
                    out.message = refreshed.message
                    out.clearAuth = refreshed.clearAuth
                    m.top.result = out
                    return
                end if
            end if
        end if
    end if

    out.status = r.status
    out.message = r.message
    if r.status = 200 and r.data <> invalid and type(r.data) = "roAssociativeArray" then
        key = ToText(r.data.key)
        if Len(key) = 6 then
            out.ok = true
            out.key = key
            out.ttlSeconds = Int(Val(ToText(r.data.ttlSeconds)))
            out.message = ""
        end if
    end if
    if not out.ok and out.message = "" then out.message = "Não foi possível gerar a chave."
    m.top.result = out
end sub
