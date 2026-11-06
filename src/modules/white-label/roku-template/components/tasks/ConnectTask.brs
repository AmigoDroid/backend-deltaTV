' Direct activation for partner accounts and Delta licenses.
sub init()
    m.top.functionName = "activateDevice"
end sub

sub activateDevice()
    res = { ok: false, sessionOk: false, message: "" }
    p = m.top.params
    mode = ToText(p.mode)
    activationCode = TrimText(ToText(p.code))
    username = TrimText(ToText(p.username))
    password = ToText(p.password)
    listName = TrimText(ToText(p.listName))
    playlistUrl = TrimText(ToText(p.playlistUrl))
    accessToken = ToText(p.accessToken)
    refreshToken = ToText(p.refreshToken)
    identity = DeltaGetIdentity()

    ' Do not leave credentials in the task's public parameter field.
    p.username = ""
    p.password = ""
    p.playlistUrl = ""

    if mode <> "partner" and mode <> "license" and mode <> "configurePlaylist" then
        res.message = "Selecione um modo de configuração válido."
        m.top.result = res
        return
    end if
    if not DeltaServerConfigured() then
        res.message = "Servidor não configurado (edite source/Config.brs)."
        m.top.result = res
        return
    end if

    if mode = "configurePlaylist" then
        if listName = "" or Len(listName) > 80 then
            res.message = "Informe o nome da lista (até 80 caracteres)."
            m.top.result = res
            return
        end if
        if not IsHttpUrl(playlistUrl) or Len(playlistUrl) > 2048 then
            res.message = "Informe uma URL HTTP ou HTTPS válida (até 2048 caracteres)."
            m.top.result = res
            return
        end if
    else
        if activationCode = "" or Len(activationCode) > 64 then
            res.message = "Informe um código de ativação válido (até 64 caracteres)."
            m.top.result = res
            return
        end if
        if mode = "partner" and (username = "" or TrimText(password) = "") then
            res.message = "Informe o usuário e a senha do provedor IPTV."
            m.top.result = res
            return
        end if
        if mode = "license" then
            if listName = "" or Len(listName) > 80 then
                res.message = "Informe o nome da lista (até 80 caracteres)."
                m.top.result = res
                return
            end if
            if not IsHttpUrl(playlistUrl) or Len(playlistUrl) > 2048 then
                res.message = "Informe uma URL HTTP ou HTTPS válida (até 2048 caracteres)."
                m.top.result = res
                return
            end if
        end if

        requestBody = {
            code: activationCode,
            mac: identity.mac,
            "installationId": identity.installationId
        }
        if mode = "partner" then
            requestBody.username = username
            requestBody.password = password
        end if

        activationSensitiveValues = [activationCode, username, password]
        pairs = [["code", activationCode], ["mac", identity.mac], ["installationId", identity.installationId]]
        if mode = "partner" then
            pairs.push(["username", username])
            pairs.push(["password", password])
        end if
        request = SendJson(DeltaActivationUrl(mode), "POST", DeltaJson(pairs), "")
        pairs = []
        if mode = "partner" then
            requestBody.password = ""
            requestBody.username = ""
        end if
        password = ""
        username = ""
        if request.status <> 200 and request.status <> 201 then
            res.message = ErrorMessage(request, "Não foi possível ativar o dispositivo.", activationSensitiveValues)
            activationSensitiveValues = []
            res.requestId = request.requestId
            m.top.result = res
            return
        end if
        activationSensitiveValues = []

        response = request.data
        if response = invalid or type(response) <> "roAssociativeArray" then
            res.message = "O servidor retornou uma resposta de ativação inválida."
            m.top.result = res
            return
        end if
        tokens = response.tokens
        if tokens = invalid or type(tokens) <> "roAssociativeArray" then
            res.message = "O servidor não retornou a sessão do dispositivo."
            m.top.result = res
            return
        end if
        accessToken = ToText(tokens.accessToken)
        refreshToken = ToText(tokens.refreshToken)
        if accessToken = "" or refreshToken = "" then
            res.message = "O servidor não retornou os tokens da sessão."
            m.top.result = res
            return
        end if

        res.sessionOk = true
        res.tokens = {
            accessToken: accessToken,
            refreshToken: refreshToken,
            expiresIn: tokens.expiresIn
        }
        res.activationId = ToText(response.activationId)
        res.activationKind = ToText(response.kind)
        res.configurationStatus = ToText(response.configurationStatus)
    end if

    if mode = "partner" then
        res.ok = true
        res.configurationStatus = "configured_partner"
        res.message = "Dispositivo configurado com a parceria."
        res.listName = ""
        m.top.result = res
        return
    end if

    if accessToken = "" then
        res.message = "A sessão da licença não está disponível. Ative a licença novamente."
        m.top.result = res
        return
    end if
    res.sessionOk = true

    submittedPlaylistUrl = playlistUrl
    if mode = "license" then
        listBody = FormatJson({ name: listName, url: playlistUrl })
        request = SendJson(DeltaClientUrl("/configure/playlist"), "POST", listBody, accessToken)
        playlistUrl = ""
        if request.status = 401 and refreshToken <> "" then
            refreshed = RefreshSetupSession(identity.installationId, refreshToken)
            if refreshed.ok then
                accessToken = refreshed.accessToken
                refreshToken = refreshed.refreshToken
                res.tokens = { accessToken: accessToken, refreshToken: refreshToken }
                request = SendJson(DeltaClientUrl("/configure/playlist"), "POST", listBody, accessToken)
            else
                res.message = SafeErrorText(refreshed.message, "A sessão da licença expirou. Tente novamente.", [refreshToken, submittedPlaylistUrl])
                res.clearAuth = refreshed.clearAuth
                listBody = ""
                submittedPlaylistUrl = ""
                m.top.result = res
                return
            end if
        end if
    else
        listBody = FormatJson({ name: listName, url: playlistUrl })
        request = SendJson(DeltaClientUrl("/configure/playlist"), "POST", listBody, accessToken)
        playlistUrl = ""
        if request.status = 401 and refreshToken <> "" then
            identity = DeltaGetIdentity()
            refreshed = RefreshSetupSession(identity.installationId, refreshToken)
            if refreshed.ok then
                accessToken = refreshed.accessToken
                refreshToken = refreshed.refreshToken
                res.tokens = { accessToken: accessToken, refreshToken: refreshToken }
                request = SendJson(DeltaClientUrl("/configure/playlist"), "POST", listBody, accessToken)
            else
                res.message = SafeErrorText(refreshed.message, "A sessão da licença expirou. Tente novamente.", [refreshToken, submittedPlaylistUrl])
                res.clearAuth = refreshed.clearAuth
                listBody = ""
                submittedPlaylistUrl = ""
                m.top.result = res
                return
            end if
        end if
        listBody = ""
    end if
    listBody = ""

    if request.status <> 200 and request.status <> 201 then
        res.message = ErrorReference(request, "A licença foi ativada, mas não foi possível salvar a playlist. Confira o nome e a URL.")
        submittedPlaylistUrl = ""
        res.requestId = request.requestId
        if res.tokens = invalid then
            res.tokens = { accessToken: accessToken, refreshToken: refreshToken }
        end if
        m.top.result = res
        return
    end if
    submittedPlaylistUrl = ""

    configured = request.data
    res.ok = true
    res.sessionOk = true
    res.configurationStatus = "configured_playlist"
    res.listName = listName
    if configured <> invalid and type(configured) = "roAssociativeArray" then
        if configured.configurationStatus <> invalid then res.configurationStatus = ToText(configured.configurationStatus)
        if configured.listName <> invalid then res.listName = ToText(configured.listName)
        if configured.activationId <> invalid then res.activationId = ToText(configured.activationId)
    end if
    res.message = "Playlist configurada."
    if res.tokens = invalid then res.tokens = { accessToken: accessToken, refreshToken: refreshToken }
    m.top.result = res
end sub

function RefreshSetupSession(installationId as String, refreshToken as String) as Object
    result = { ok: false, message: "Não foi possível renovar a sessão.", clearAuth: false }
    body = DeltaJson([["refreshToken", refreshToken], ["installationId", installationId]])
    request = SendJson(DeltaRefreshUrl(), "POST", body, "")
    if request.status <> 200 or request.data = invalid or type(request.data) <> "roAssociativeArray" then
        result.message = ErrorMessage(request, result.message, [refreshToken])
        result.clearAuth = (request.status = 401)
        return result
    end if
    tokens = request.data.tokens
    if request.data.allowed <> true or tokens = invalid or type(tokens) <> "roAssociativeArray" then
        result.message = ErrorMessage(request, "A sessão expirou. Ative o dispositivo novamente.", [refreshToken])
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

function SendJson(url as String, method as String, body as String, accessToken as String) as Object
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
        if result.data.message <> invalid then result.message = ToText(result.data.message)
        if result.data.requestId <> invalid then result.requestId = ToText(result.data.requestId)
    end if
    if result.status < 0 and result.message = "" then result.message = "Sem conexão com o servidor."
    return result
end function

function ErrorMessage(request as Object, fallback as String, sensitiveValues as Object) as String
    message = fallback
    if request.message <> invalid then message = SafeErrorText(request.message, fallback, sensitiveValues)
    if request.requestId <> invalid and request.requestId <> "" then
        message = message + " (referência: " + request.requestId + ")"
    end if
    return message
end function

function ErrorReference(request as Object, fallback as String) as String
    if request.requestId <> invalid and request.requestId <> "" then
        return fallback + " (referência: " + request.requestId + ")"
    end if
    return fallback
end function
