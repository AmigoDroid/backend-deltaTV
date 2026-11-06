' ============================================================
' Delta TV - HTTP/sessao/gateway compartilhados entre as Tasks
' (extraido de ContentTask.brs sem alterar o comportamento)
' Use apenas dentro de Tasks: roUrlTransfer sincrono nao pode rodar na thread de render.
' Requer: Utils.brs (ToText) e Config.brs.
' ============================================================

function GatewayPath(path as String) as String
    if path = "" then return ""
    if Left(path, 1) = "/" then return DeltaServerOrigin() + path
    return path
end function

function GatewayUrl(path as String, token as String, xfer = invalid as Dynamic) as String
    if xfer = invalid then xfer = invalid ' parametro mantido por compatibilidade com os chamadores
    if path = "" then return ""
    url = path
    if token <> "" then
        sep = "?"
        if Instr(1, url, "?") > 0 then sep = "&"
        url = url + sep + "t=" + UrlEscape(token)
    end if
    return url
end function

function RefreshSession(id as Object, refreshToken as String) as Object
    result = { ok: false, message: "Não foi possível renovar a sessão.", clearAuth: false }
    body = DeltaJson([["refreshToken", refreshToken], ["installationId", id.installationId]])
    req = HttpJson(DeltaRefreshUrl(), "POST", body, "")
    if req.status <> 200 or req.data = invalid or type(req.data) <> "roAssociativeArray" then
        if req.message <> "" then result.message = req.message
        result.clearAuth = (req.status = 401 or req.status = 403)
        return result
    end if

    tokens = req.data.tokens
    if req.data.allowed <> true or tokens = invalid or type(tokens) <> "roAssociativeArray" then
        if req.data.message <> invalid then result.message = ToText(req.data.message)
        result.clearAuth = true
        return result
    end if

    result.accessToken = ToText(tokens.accessToken)
    result.refreshToken = ToText(tokens.refreshToken)
    if result.accessToken = "" or result.refreshToken = "" then
        result.message = "O servidor não retornou os novos tokens da sessão."
        result.clearAuth = true
        return result
    end if
    result.ok = true
    result.message = ""
    result.clearAuth = false
    return result
end function

function HttpJson(url as String, method as String, body as String, accessToken as String, timeoutMs = 15000 as Integer) as Object
    result = { status: -1, data: invalid, message: "" }
    xfer = CreateObject("roUrlTransfer")
    port = CreateObject("roMessagePort")
    xfer.SetMessagePort(port)
    xfer.SetUrl(url)
    xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    xfer.AddHeader("Accept", "application/json")
    if accessToken <> "" then xfer.AddHeader("Authorization", "Bearer " + accessToken)
    if method = "POST" then xfer.AddHeader("Content-Type", "application/json")
    xfer.RetainBodyOnError(true)
    xfer.EnableEncodings(true)

    started = false
    if method = "POST" then
        started = xfer.AsyncPostFromString(body)
    else
        started = xfer.AsyncGetToString()
    end if
    if not started then
        result.message = "Não foi possível iniciar a requisição ao servidor."
        return result
    end if

    ev = wait(timeoutMs, port)
    if type(ev) <> "roUrlEvent" then
        xfer.AsyncCancel()
        result.message = "Tempo esgotado. Verifique a conexão com o servidor."
        return result
    end if

    result.status = ev.GetResponseCode()
    result.data = ParseJson(ev.GetString())
    if result.data <> invalid and type(result.data) = "roAssociativeArray" then
        if result.data.message <> invalid then result.message = ToText(result.data.message)
    end if
    if result.status < 0 and result.message = "" then result.message = "Sem conexão com o servidor."
    return result
end function
