sub init()
    m.top.functionName = "runWhiteLabelAuth"
end sub

sub runWhiteLabelAuth()
    p = m.top.params
    result = { ok: false, clearAuth: false, message: "Não foi possível verificar sua assinatura." }
    if not DeltaWhiteLabelMode() then
        m.top.result = result
        return
    end if
    action = ToText(p.action)
    current = RegRead("wl_session")
    if action = "session" and current <> "" then
        response = HttpJson(DeltaWhiteLabelPlayerUrl("session"), "POST", DeltaJson([["sessionToken", current]]), "")
        if response.status = 200 and type(response.data) = "roAssociativeArray" and response.data.authorized = true then
            RegWrite("wl_session", ToText(response.data.sessionToken))
            RegWrite("wl_last_authorized", CreateObject("roDateTime").AsSeconds().toStr())
            result.ok = true
            result.message = ""
            m.top.result = result
            return
        end if
        if response.status <> 401 then
            result.message = response.message
            if result.message = "" then result.message = "Conexão indisponível. Tentando novamente."
            result.clearAuth = response.status = 403
            m.top.result = result
            return
        end if
        ' Expired tokens can be reauthenticated from this device's own Xtream login.
    end if

    user = ToText(p.username)
    password = ToText(p.password)
    if user = "" or password = "" then
        saved = ParseJson(RegRead("wl_cfg"))
        if type(saved) = "roAssociativeArray" then
            user = ToText(saved.username)
            password = ToText(saved.password)
        end if
    end if
    if user = "" or password = "" then
        result.clearAuth = true
        result.message = "Informe seu usuário e senha IPTV."
        m.top.result = result
        return
    end if
    payload = DeltaJson([
        ["installationId", DeltaGetIdentity().installationId],
        ["platform", "roku"], ["username", user], ["password", password]
    ])
    response = HttpJson(DeltaWhiteLabelPlayerUrl("activate"), "POST", payload, "")
    payload = ""
    if response.status <> 200 or type(response.data) <> "roAssociativeArray" then
        result.message = response.message
        if result.message = "" then result.message = "Falha de autenticação. Verifique as credenciais e a conexão."
        result.clearAuth = response.status = 401 or response.status = 403 or response.status = 409
        m.top.result = result
        return
    end if
    url = ToText(response.data.selectedBaseUrl)
    token = ToText(response.data.sessionToken)
    if url = "" or token = "" then
        result.message = "Resposta de autenticação incompleta."
        m.top.result = result
        return
    end if
    old = ParseJson(RegRead("wl_cfg"))
    if type(old) = "roAssociativeArray" then
        if ToText(old.baseUrl) <> url or ToText(old.username) <> user then XtClearCatalogCache()
    end if
    ' Credentials remain on the Roku only; no playlist/secret goes into the Delta database.
    RegWrite("wl_cfg", FormatJson({baseUrl:url,username:user,password:password,userAgent:"Mozilla/5.0",at:CreateObject("roDateTime").AsSeconds()}))
    RegWrite("wl_session", token)
    RegWrite("wl_last_authorized", CreateObject("roDateTime").AsSeconds().toStr())
    user = "" : password = ""
    result.ok = true
    result.message = ""
    m.top.result = result
end sub
