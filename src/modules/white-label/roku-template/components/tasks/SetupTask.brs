' Device registration, authenticated status, and pairing completion polling.
sub init()
    m.top.functionName = "runSetup"
end sub

sub runSetup()
    p = m.top.params
    action = ToText(p.action)
    identity = DeltaGetIdentity()
    result = {
        ok: false,
        action: action,
        message: "",
        status: "",
        configured: false,
        terminal: false,
        accessToken: ToText(p.accessToken),
        refreshToken: ToText(p.refreshToken)
    }
    if not DeltaServerConfigured() then
        result.message = "Servidor não configurado (edite source/Config.brs)."
        m.top.result = result
        return
    end if

    if action = "register" then
        body = DeltaJson([["mac", identity.mac], ["installationId", identity.installationId]])
        response = SetupRequest(DeltaClientUrl("/register"), "POST", body, "")
        if response.status < 200 or response.status >= 300 then
            CopyRequestError(result, response, "Não foi possível registrar o dispositivo.", [])
            m.top.result = result
            return
        end if
        data = response.data
        if data = invalid or type(data) <> "roAssociativeArray" then
            result.message = "O servidor retornou uma resposta de registro inválida."
            result.terminal = true
            m.top.result = result
            return
        end if

        result.ok = true
        CopySetupState(result, data)
        pairing = data.pairing
        if result.status = "session_required" and (pairing = invalid or type(pairing) <> "roAssociativeArray") then
            result.ok = false
            if result.accessToken <> "" then
                result = AuthenticatedStatus(result, identity.installationId)
            else if result.refreshToken <> "" then
                result = RefreshThenStatus(result, identity.installationId)
            else
                result.message = "Este dispositivo precisa de uma sessão. Use a ativação direta ou tente novamente."
                result.terminal = true
            end if
        else if result.status = "awaiting_configuration" then
            if pairing = invalid or type(pairing) <> "roAssociativeArray" then
                result.ok = false
                result.terminal = true
                result.message = "O servidor não retornou os dados temporários do pareamento."
            else
                result.pairingUrl = ToText(pairing.url)
                result.registrationToken = ToText(pairing.registrationToken)
                if not IsHttpUrl(result.pairingUrl) or result.registrationToken = "" then
                    result.ok = false
                    result.terminal = true
                    result.message = "O servidor retornou dados de pareamento inválidos."
                end if
            end if
        else
            ReadSessionTokens(result, data)
        end if
        m.top.result = result
        return
    end if

    if action = "poll" then
        registrationToken = ToText(p.registrationToken)
        p.registrationToken = ""
        if registrationToken = "" then
            result.message = "O pareamento expirou. Gere um novo QR Code."
            result.status = "expired"
            result.terminal = true
            m.top.result = result
            return
        end if
        body = DeltaJson([["mac", identity.mac], ["installationId", identity.installationId], ["registrationToken", registrationToken]])
        response = SetupRequest(DeltaClientUrl("/register/status"), "POST", body, "")
        body = ""
        if response.status < 200 or response.status >= 300 then
            CopyRequestError(result, response, "Não foi possível consultar o pareamento.", [registrationToken])
            registrationToken = ""
            result.terminal = response.status >= 400 and response.status < 500 and response.status <> 429
            m.top.result = result
            return
        end if
        registrationToken = ""
        data = response.data
        if data = invalid or type(data) <> "roAssociativeArray" then
            result.message = "O servidor retornou uma resposta de pareamento inválida."
            result.terminal = true
            m.top.result = result
            return
        end if
        result.ok = true
        CopySetupState(result, data)
        ' Um MAC pode ter varios parceiros: o servidor emite uma sessao por lista liberada (data.activations[].tokens).
        result.lists = ReadServerLists(data)
        usePick = false
        if result.status <> "configured_partner" and result.status <> "configured_playlist" then
            ' a lista "principal" do servidor pode nao ser a configurada: usa a primeira configurada que veio com sessao
            pick = FirstConfiguredWithTokens(result.lists)
            if pick <> invalid then
                usePick = true
                result.status = pick.status
                result.configurationStatus = pick.status
                result.configured = true
                result.allowed = true
                result.activationId = pick.activationId
                result.listName = pick.listName
                result.mode = pick.kind
                result.accessToken = pick.accessToken
                result.refreshToken = pick.refreshToken
            end if
        end if
        if result.status = "configured_partner" or result.status = "configured_playlist" then
            if not usePick then ReadSessionTokens(result, data)
            if result.accessToken = "" or result.refreshToken = "" then
                result.ok = false
                result.terminal = true
                result.message = "A configuração foi concluída, mas o servidor não retornou uma sessão."
            end if
        else if result.status = "expired" or result.status = "disabled" or result.status = "deactivated" then
            result.terminal = true
        else if result.status = "session_required" then
            result.terminal = true
            result.ok = false
            result.message = "É necessária uma sessão válida para concluir a configuração."
        else if result.status <> "awaiting_configuration" then
            result.terminal = true
            result.ok = false
            result.message = "O servidor retornou um estado de pareamento desconhecido."
        end if
        m.top.result = result
        return
    end if

    if action = "status" then
        result = AuthenticatedStatus(result, identity.installationId)
        m.top.result = result
        return
    end if

    result.message = "Operação de configuração inválida."
    result.terminal = true
    m.top.result = result
end sub

function AuthenticatedStatus(result as Object, installationId as String) as Object
    result.action = "status"
    accessToken = ToText(result.accessToken)
    refreshToken = ToText(result.refreshToken)
    response = SetupRequest(DeltaClientUrl("/status"), "GET", "", accessToken)
    if response.status = 401 and refreshToken <> "" then
        refreshed = RefreshSetupSession(installationId, refreshToken)
        if not refreshed.ok then
            result.ok = false
            result.message = refreshed.message
            result.clearAuth = refreshed.clearAuth
            result.terminal = refreshed.clearAuth
            return result
        end if
        result.accessToken = refreshed.accessToken
        result.refreshToken = refreshed.refreshToken
        response = SetupRequest(DeltaClientUrl("/status"), "GET", "", result.accessToken)
    end if
    if response.status < 200 or response.status >= 300 then
        result.ok = false
        CopyRequestError(result, response, "Não foi possível consultar o estado do dispositivo.", [accessToken, result.accessToken, result.refreshToken])
        result.clearAuth = (response.status = 401)
        result.terminal = result.clearAuth
        return result
    end if
    if response.data = invalid or type(response.data) <> "roAssociativeArray" then
        result.ok = false
        result.message = "O servidor retornou um estado de dispositivo inválido."
        result.terminal = true
        return result
    end if
    result.ok = true
    CopySetupState(result, response.data)
    if result.status = "" and response.data.allowed = true then result.status = "configured"
    if response.data.allowed = true then result.configured = true
    if response.data.configured <> invalid then result.configured = response.data.configured
    if result.status = "expired" or result.status = "disabled" or result.status = "deactivated" then result.terminal = true
    return result
end function

function RefreshThenStatus(result as Object, installationId as String) as Object
    refreshed = RefreshSetupSession(installationId, result.refreshToken)
    if not refreshed.ok then
        result.ok = false
        result.message = refreshed.message
        result.clearAuth = refreshed.clearAuth
        result.terminal = true
        return result
    end if
    result.accessToken = refreshed.accessToken
    result.refreshToken = refreshed.refreshToken
    return AuthenticatedStatus(result, installationId)
end function

function RefreshSetupSession(installationId as String, refreshToken as String) as Object
    result = { ok: false, message: "Não foi possível renovar a sessão.", clearAuth: false }
    body = DeltaJson([["refreshToken", refreshToken], ["installationId", installationId]])
    response = SetupRequest(DeltaRefreshUrl(), "POST", body, "")
    if response.status <> 200 or response.data = invalid or type(response.data) <> "roAssociativeArray" then
        CopyRequestError(result, response, result.message, [refreshToken])
        result.clearAuth = (response.status = 401)
        return result
    end if
    tokens = response.data.tokens
    if response.data.allowed <> true or tokens = invalid or type(tokens) <> "roAssociativeArray" then
        result.message = SafeErrorText(response.message, "A sessão expirou. Ative o dispositivo novamente.", [refreshToken])
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
    return result
end function

sub CopySetupState(result as Object, data as Object)
    result.trialActive = false
    result.trialExpiresAt = ""
    if data.trial <> invalid and type(data.trial) = "roAssociativeArray" then
        result.trialActive = (data.trial.active = true)
        result.trialExpiresAt = ToText(data.trial.expiresAt)
    end if
    result.status = ToText(data.status)
    if result.status = "" then result.status = ToText(data.configurationStatus)
    result.configured = (data.configured = true)
    result.configurationStatus = ToText(data.configurationStatus)
    if result.configurationStatus = "" and (result.status = "configured_partner" or result.status = "configured_playlist") then
        result.configurationStatus = result.status
    end if
    result.activationId = ToText(data.activationId)
    result.configurationVersion = ToText(data.configurationVersion)
    result.mode = ToText(data.mode)
    if result.mode = "" then result.mode = ToText(data.kind)
    result.listName = ToText(data.listName)
    result.allowed = (data.allowed = true)
    result.message = ToText(data.message)
    result.code = ToText(data.code)
    result.expiresAt = ToText(data.expiresAt)
    if result.status = "" then
        normalizedCode = LCase(result.code)
        if Instr(1, normalizedCode, "awaiting_configuration") > 0 then
            result.status = "awaiting_configuration"
        else if Instr(1, normalizedCode, "session_required") > 0 then
            result.status = "session_required"
        else if Instr(1, normalizedCode, "expired") > 0 then
            result.status = "expired"
        else if Instr(1, normalizedCode, "disabled") > 0 then
            result.status = "disabled"
        else if Instr(1, normalizedCode, "deactivated") > 0 then
            result.status = "deactivated"
        else if result.allowed then
            result.status = "configured"
        end if
    end if
    if result.status = "configured_partner" or result.status = "configured_playlist" or result.status = "configured" then result.configured = true
end sub

' Listas (ativacoes) devolvidas pelo servidor no pareamento: [{ activationId, kind, status, listName, allowed, configured, accessToken, refreshToken }]
function ReadServerLists(data as Object) as Object
    out = []
    arr = data.activations
    if arr = invalid or type(arr) <> "roArray" then return out
    for each l in arr
        if type(l) = "roAssociativeArray" then
            item = {
                activationId: ToText(l.activationId),
                kind: ToText(l.kind),
                status: ToText(l.status),
                listName: ToText(l.listName),
                allowed: (l.allowed = true),
                configured: (l.configured = true),
                accessToken: "",
                refreshToken: ""
            }
            t = l.tokens
            if t <> invalid and type(t) = "roAssociativeArray" then
                item.accessToken = ToText(t.accessToken)
                item.refreshToken = ToText(t.refreshToken)
            end if
            out.push(item)
        end if
    end for
    return out
end function

function FirstConfiguredWithTokens(lists as Object) as Dynamic
    for each l in lists
        isCfg = (l.status = "configured_partner" or l.status = "configured_playlist")
        if isCfg and l.accessToken <> "" and l.refreshToken <> "" then return l
    end for
    return invalid
end function

sub ReadSessionTokens(result as Object, data as Object)
    tokens = data.tokens
    if tokens = invalid or type(tokens) <> "roAssociativeArray" then return
    newAccessToken = ToText(tokens.accessToken)
    newRefreshToken = ToText(tokens.refreshToken)
    if newAccessToken <> "" then result.accessToken = newAccessToken
    if newRefreshToken <> "" then result.refreshToken = newRefreshToken
end sub

sub CopyRequestError(result as Object, response as Object, fallback as String, sensitiveValues as Object)
    result.message = fallback
    if response.message <> invalid then result.message = SafeErrorText(response.message, fallback, sensitiveValues)
    if response.requestId <> invalid and response.requestId <> "" then
        result.requestId = response.requestId
        result.message = result.message + " (referência: " + response.requestId + ")"
    end if
    if response.data <> invalid and type(response.data) = "roAssociativeArray" then
        if response.data.code <> invalid then result.code = ToText(response.data.code)
    end if
end sub

function SetupRequest(url as String, method as String, body as String, accessToken as String) as Object
    result = { status: -1, data: invalid, message: "", requestId: "" }
    transfer = CreateObject("roUrlTransfer")
    port = CreateObject("roMessagePort")
    transfer.SetMessagePort(port)
    transfer.SetUrl(url)
    transfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    transfer.AddHeader("Accept", "application/json")
    if method = "POST" then transfer.AddHeader("Content-Type", "application/json")
    if accessToken <> "" then transfer.AddHeader("Authorization", "Bearer " + accessToken)
    transfer.RetainBodyOnError(true)
    transfer.EnableEncodings(true)

    started = false
    if method = "POST" then
        started = transfer.AsyncPostFromString(body)
    else
        started = transfer.AsyncGetToString()
    end if
    if not started then
        result.message = "Não foi possível iniciar a requisição ao servidor."
        return result
    end if
    event = wait(15000, port)
    if type(event) <> "roUrlEvent" then
        transfer.AsyncCancel()
        result.message = "Tempo esgotado. Verifique a conexão com o servidor."
        return result
    end if
    result.status = event.GetResponseCode()
    result.data = ParseJson(event.GetString())
    if result.data <> invalid and type(result.data) = "roAssociativeArray" then
        result.message = ToText(result.data.message)
        result.requestId = ToText(result.data.requestId)
    end if
    if result.status < 0 and result.message = "" then result.message = "Sem conexão com o servidor."
    return result
end function
