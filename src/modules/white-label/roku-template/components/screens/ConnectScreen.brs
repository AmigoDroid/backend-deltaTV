' Device pairing and direct activation/configuration.
sub init()
    t = Theme()
    m.status = m.top.findNode("status")
    m.qr = m.top.findNode("qr")
    m.qrText = m.top.findNode("qrText")
    m.pollTimer = m.top.findNode("pollTimer")
    m.closeTimer = m.top.findNode("closeTimer")

    Txt(m.top.findNode("brandA"), 32, true, t.text)
    Txt(m.top.findNode("brandB"), 32, true, "0x8A6CFFFF")
    Txt(m.top.findNode("clock"), 20, true, t.text)
    Txt(m.top.findNode("title"), 40, true, t.text)
    Txt(m.top.findNode("sub"), 18, false, "0xA9ADC8FF")
    Txt(m.qrText, 15, false, t.text)
    Txt(m.top.findNode("macTag"), 11, false, "0xA9ADC8FF")
    Txt(m.top.findNode("macValue"), 20, true, t.text)
    Txt(m.top.findNode("codeTag"), 11, false, "0xA9ADC8FF")
    Txt(m.top.findNode("codeValue"), 20, true, t.text)
    Txt(m.top.findNode("sideTitle"), 17, true, t.text)
    for i = 0 to 2
        Txt(m.top.findNode("side" + i.toStr()), 17, false, "0xD5D8E8FF")
    end for
    Txt(m.top.findNode("footer"), 14, false, "0x8A8EA8FF")
    Txt(m.status, 13, false, t.textDim)
    m.status.wrap = true

    identity = DeltaGetIdentity()
    m.identity = identity
    m.top.findNode("macValue").text = identity.mac
    m.top.findNode("codeValue").text = identity.code

    m.mode = RegRead("activation_kind")
    if DeltaWhiteLabelMode() then m.mode = "white-label"
    if m.mode <> "partner" and m.mode <> "license" and m.mode <> "white-label" then m.mode = "partner"
    m.values = ["", "", ""]
    m.values[0] = RegRead("activation_code")
    m.focus = 0
    if DeltaWhiteLabelMode() then m.focus = 2
    m.busy = false
    m.setupBusy = false
    m.statusAfterConnect = false
    m.backoffSeconds = 10
    m.pairingUrl = ""
    m.registrationToken = ""

    m.modeBorder = CreateObject("roSGNode", "Poster")
    m.modeBorder.uri = "pkg:/images/round.9.png"
    m.modeBorder.translation = [390, 293]
    m.modeBorder.width = 432
    m.modeBorder.height = 52
    m.top.appendChild(m.modeBorder)
    m.modeBg = CreateObject("roSGNode", "Poster")
    m.modeBg.uri = "pkg:/images/round.9.png"
    m.modeBg.translation = [392, 295]
    m.modeBg.width = 428
    m.modeBg.height = 48
    m.modeBg.blendColor = "0x1E2033FF"
    m.top.appendChild(m.modeBg)
    m.modeLabel = CreateObject("roSGNode", "Label")
    m.modeLabel.translation = [402, 295]
    m.modeLabel.width = 408
    m.modeLabel.height = 48
    m.modeLabel.horizAlign = "center"
    m.modeLabel.vertAlign = "center"
    m.top.appendChild(m.modeLabel)

    m.inputBorders = []
    m.inputBgs = []
    m.inputLabels = []
    for i = 0 to 2
        y = 352 + i * 57
        border = CreateObject("roSGNode", "Poster")
        border.uri = "pkg:/images/round.9.png"
        border.translation = [390, y]
        border.width = 432
        border.height = 52
        m.top.appendChild(border)
        m.inputBorders.push(border)

        bg = CreateObject("roSGNode", "Poster")
        bg.uri = "pkg:/images/round.9.png"
        bg.translation = [392, y + 2]
        bg.width = 428
        bg.height = 48
        bg.blendColor = "0x1E2033FF"
        m.top.appendChild(bg)
        m.inputBgs.push(bg)

        label = CreateObject("roSGNode", "Label")
        label.translation = [410, y + 1]
        label.width = 390
        label.height = 50
        label.vertAlign = "center"
        m.top.appendChild(label)
        m.inputLabels.push(label)
    end for

    m.buttons = []
    m.buttonLabels = []
    m.buttonRings = []
    buttonX = [390, 640]
    buttonW = [240, 182]
    buttonText = ["CONECTAR", "VOLTAR"]
    for i = 0 to 1
        bg = CreateObject("roSGNode", "Poster")
        bg.uri = "pkg:/images/round.9.png"
        bg.translation = [buttonX[i], 532]
        bg.width = buttonW[i]
        bg.height = 58
        bg.blendColor = "0x4E2BC9FF"
        if i = 1 then bg.blendColor = "0x3A3B45FF"
        m.top.appendChild(bg)
        m.buttons.push(bg)

        label = CreateObject("roSGNode", "Label")
        label.translation = [buttonX[i], 532]
        label.width = buttonW[i]
        label.height = 58
        label.horizAlign = "center"
        label.vertAlign = "center"
        label.text = buttonText[i]
        Txt(label, 18, true, t.text)
        m.top.appendChild(label)
        m.buttonLabels.push(label)

        ring = CreateObject("roSGNode", "Poster")
        ring.uri = "pkg:/images/ring.9.png"
        ring.translation = [buttonX[i] - 3, 529]
        ring.width = buttonW[i] + 6
        ring.height = 64
        ring.blendColor = t.accent
        m.top.appendChild(ring)
        m.buttonRings.push(ring)
    end for

    m.closeTimer.observeField("fire", "onCloseTimer")
    m.pollTimer.observeField("fire", "onPollTimer")
    m.top.observeField("visible", "onVisible")
    draw()
end sub

sub onVisible()
    if not m.top.visible then
        m.pollTimer.control = "stop"
        return
    end if

    m.top.findNode("clock").text = ClockText()
    m.values[2] = ""
    if DeltaWhiteLabelMode() then
        m.mode = "white-label"
        m.focus = 2
        m.top.findNode("title").text = "Entre com sua conta IPTV"
        m.top.findNode("sub").text = "Use o usuário e a senha fornecidos pelo serviço contratado."
        m.top.findNode("brandA").text = DeltaWhiteLabelAppName()
        m.top.findNode("brandB").text = ""
        m.top.findNode("side2").text = "Seu catálogo, no seu aplicativo"
        m.top.findNode("footer").text = DeltaWhiteLabelAppName() + " • Reprodutor de conteúdo autorizado"
        m.modeLabel.text = "‹ ACESSO IPTV ›"
        m.top.findNode("qr").visible = false
        m.top.findNode("qrText").visible = false
        m.top.findNode("macTag").visible = false
        m.top.findNode("macValue").visible = false
        m.top.findNode("codeTag").visible = false
        m.top.findNode("codeValue").visible = false
        m.modeBorder.visible = false
        m.modeBg.visible = false
        m.pollTimer.control = "stop"
        setStatus("Informe seu usuário e senha para começar.", "0xC3C7D8FF")
        draw()
        return
    end if
    m.focus = 0
    m.backoffSeconds = 10
    draw()

    ' O QR so depende do MAC do aparelho: aparece mesmo que o servidor demore ou recuse o registro.
    if RegRead("auth_token") = "" and RegRead("refresh_token") = "" and m.qr.getChildCount() = 0 then showPairingQr()

    if m.setupBusy then return
    storedInstallationId = RegRead("registration_installation_id")
    storedRegistrationToken = RegRead("registration_token")
    storedPairingUrl = RegRead("registration_pairing_url")
    if RegRead("auth_token") <> "" or RegRead("refresh_token") <> "" then
        startSetup("status")
    else if storedInstallationId = m.identity.installationId and storedRegistrationToken <> "" and IsHttpUrl(storedPairingUrl) then
        m.registrationToken = storedRegistrationToken
        m.pairingUrl = storedPairingUrl
        showPairingQr()
        setStatus("Aguardando a conclusão do pareamento...", "0xC3C7D8FF")
        startPolling(10)
    else
        if storedRegistrationToken <> "" then clearRegistration()
        startSetup("register")
    end if
end sub

sub focusContent()
    m.top.setFocus(true)
    draw()
end sub

sub setStatus(text as String, color as String)
    m.status.text = text
    m.status.color = color
end sub

sub draw()
    t = Theme()
    pendingPlaylist = m.mode = "license" and RegRead("license_pending_configuration") = "true"
    if DeltaWhiteLabelMode() then m.modeLabel.text = "‹ ACESSO IPTV ›"
    if m.mode = "white-label" then
        m.modeLabel.text = "‹ ACESSO IPTV ›"
    else if m.mode = "partner" then
        m.modeLabel.text = "‹ PARCERIA ›"
    else if pendingPlaylist then
        m.modeLabel.text = "‹ LICENÇA: CONFIGURAR PLAYLIST ›"
    else
        m.modeLabel.text = "‹ LICENÇA + PLAYLIST ›"
    end if
    m.modeBorder.blendColor = "0x4A4D66FF"
    if m.focus = 0 then m.modeBorder.blendColor = t.accentLight

    labels = FieldLabels()
    for i = 0 to 2
        m.inputBorders[i].visible = true
        m.inputBgs[i].visible = true
        m.inputLabels[i].visible = true
        m.inputBorders[i].blendColor = "0x4A4D66FF"
        if m.focus = i + 1 then m.inputBorders[i].blendColor = t.accentLight
        value = m.values[i]
        if i = 2 and (m.mode = "partner" or m.mode = "white-label") and value <> "" then value = "********"
        if value = "" then
            m.inputLabels[i].text = labels[i]
            Txt(m.inputLabels[i], 16, false, "0x7E8299FF")
        else
            m.inputLabels[i].text = value
            Txt(m.inputLabels[i], 16, false, t.text)
        end if
    end for
    if pendingPlaylist or DeltaWhiteLabelMode() then
        m.inputBorders[0].visible = false
        m.inputBgs[0].visible = false
        m.inputLabels[0].visible = false
    end if
    m.buttonRings[0].visible = (m.focus = 4)
    m.buttonRings[1].visible = (m.focus = 5)
end sub

function FieldLabels() as Object
    if DeltaWhiteLabelMode() then return ["", "Usuário IPTV", "Senha IPTV"]
    if m.mode = "partner" then return ["Código do parceiro", "Usuário do provedor IPTV", "Senha do provedor IPTV"]
    if RegRead("license_pending_configuration") = "true" then
        return ["", "Nome da lista", "URL HTTP(S) completa da playlist"]
    end if
    return ["Código da licença Delta", "Nome da lista", "URL HTTP(S) completa da playlist"]
end function

sub openKeyboard(index as Integer)
    labels = FieldLabels()
    dlg = CreateObject("roSGNode", "StandardKeyboardDialog")
    dlg.title = labels[index]
    dlg.text = m.values[index]
    dlg.buttons = ["OK", "Cancelar"]
    if (m.mode = "partner" or m.mode = "white-label") and index = 2 then
        dlg.keyboardDomain = "password"
        dlg.textEditBox.secureMode = true
    end if
    dlg.observeFieldScoped("buttonSelected", "onDlgButton")
    m.dialog = dlg
    m.dialogField = index
    m.top.getScene().dialog = dlg
end sub

sub onDlgButton()
    if m.dialog.buttonSelected = 0 then
        m.values[m.dialogField] = m.dialog.text
    else if (m.mode = "partner" or m.mode = "white-label") and m.dialogField = 2 then
        m.values[2] = ""
    end if
    m.dialog.close = true
    m.top.setFocus(true)
    draw()
end sub

sub startSetup(action as String)
    if m.setupBusy then return
    m.setupBusy = true
    m.setupTask = CreateObject("roSGNode", "SetupTask")
    params = {
        action: action,
        accessToken: RegRead("auth_token"),
        refreshToken: RegRead("refresh_token")
    }
    if action = "poll" then params.registrationToken = m.registrationToken
    m.setupTask.params = params
    m.setupTask.observeField("result", "onSetupResult")
    m.setupTask.control = "RUN"
end sub

sub onSetupResult(event as Object)
    result = event.getData()
    m.setupBusy = false
    if m.setupTask <> invalid then m.setupTask.params = {}
    m.setupTask = invalid
    if result = invalid then return
    saveReturnedSession(result)

    action = ToText(result.action)
    if action = "register" then
        if result.ok then
            if result.status = "awaiting_configuration" then
                m.registrationToken = ToText(result.registrationToken)
                m.pairingUrl = ToText(result.pairingUrl)
                RegWrite("registration_installation_id", m.identity.installationId)
                RegWrite("registration_token", m.registrationToken)
                RegWrite("registration_pairing_url", m.pairingUrl)
                showPairingQr()
                if result.trialActive = true then
                    setStatus(TrialSetupMessage(result), "0xC3C7D8FF")
                else
                    setStatus("Escaneie o QR com o celular e informe código, usuário e senha para ativar este Roku.", "0xC3C7D8FF")
                end if
                m.backoffSeconds = 10
                startPolling(10)
                return
            end if
            if result.configured = true or result.status = "configured_partner" or result.status = "configured_playlist" or result.status = "configured" then
                saveConfigurationStatus(result)
                m.statusAfterConnect = true
                setStatus("Configuração concluída. Confirmando o estado da sessão...", "0xC3C7D8FF")
                startSetup("status")
                return
            end if
            if result.status = "session_required" then
                clearRegistration()
                RegWrite("configuration_status", "session_required")
                setStatus(result.message, "0xFF8A8AFF")
                return
            end if
            if result.status = "expired" or result.status = "disabled" or result.status = "deactivated" then
                RegWrite("configuration_status", result.status)
                clearRegistration()
                setStatus(result.message, "0xFF8A8AFF")
                return
            end if
            setStatus(result.message, "0xFF8A8AFF")
        else
            setStatus(result.message, "0xFF8A8AFF")
        end if
        return
    end if

    if action = "poll" then
        if result.ok and result.status = "awaiting_configuration" then
            if result.trialActive = true then
                setStatus(TrialSetupMessage(result), "0xC3C7D8FF")
            else
                setStatus("Aguardando a conclusão do pareamento...", "0xC3C7D8FF")
            end if
            m.backoffSeconds = m.backoffSeconds + 5
            if m.backoffSeconds > 60 then m.backoffSeconds = 60
            startPolling(m.backoffSeconds)
            return
        end if
        if result.ok and (result.status = "configured_partner" or result.status = "configured_playlist") then
            if RegRead("auth_token") = "" or RegRead("refresh_token") = "" then
                setStatus("Configuração concluída, mas a sessão não está disponível.", "0xFF8A8AFF")
                clearRegistration()
                return
            end if
            clearRegistration()
            saveConfigurationStatus(result)
            ' Um MAC pode ter varios parceiros: guarda tambem as outras listas que o servidor liberou junto.
            ListsSyncActive()
            ListsMergeServer(result.lists)
            m.statusAfterConnect = true
            setStatus("Configuração concluída. Confirmando o estado da sessão...", "0xC3C7D8FF")
            startSetup("status")
            return
        end if
        if result.terminal then
            if result.status = "expired" or result.status = "disabled" or result.status = "deactivated" then
                RegWrite("configuration_status", result.status)
            end if
            clearRegistration()
            startRegisterRetry(15)
            if result.status = "expired" then
                setStatus("O pareamento expirou. Pressione CONECTAR para gerar outro QR.", "0xFF8A8AFF")
            else if result.status = "disabled" then
                setStatus("Este dispositivo foi desativado pelo administrador.", "0xFF8A8AFF")
            else if result.status = "deactivated" then
                setStatus("Este dispositivo foi desconectado.", "0xFF8A8AFF")
            else
                setStatus(result.message, "0xFF8A8AFF")
            end if
            return
        end if
        setStatus(result.message, "0xFF8A8AFF")
        m.backoffSeconds = m.backoffSeconds + 10
        if m.backoffSeconds > 60 then m.backoffSeconds = 60
        startPolling(m.backoffSeconds)
        return
    end if

    if action = "status" then
        if result.clearAuth = true then
            clearSession()
            clearRegistration()
            RegWrite("configuration_status", "session_required")
        end if
        if m.statusAfterConnect then
            m.statusAfterConnect = false
            if result.ok then saveConfigurationStatus(result)
            if result.ok and HasConfiguredAccess(result) then
                clearRegistration()
                completeConnection("Configuração confirmada. Carregando catálogo...")
            else
                message = result.message
                if message = "" then message = "Não foi possível confirmar a configuração do dispositivo."
                setStatus(message, "0xFF8A8AFF")
            end if
            return
        end if
        if result.ok then
            if result.allowed = true and result.status <> "awaiting_configuration" then clearRegistration()
            saveConfigurationStatus(result)
            if result.status = "awaiting_configuration" then
                setStatus("Dispositivo aguardando configuração. Escaneie o QR para cadastrar pelo celular ou configure aqui.", "0xC3C7D8FF")
            else if result.status = "expired" or result.status = "disabled" or result.status = "deactivated" then
                clearRegistration()
                setStatus(result.message, "0xFF8A8AFF")
            else if not HasConfiguredAccess(result) then
                if result.status = "session_required" then clearRegistration()
                message = result.message
                if message = "" then message = "A sessão não está autorizada. Revise a ativação."
                setStatus(message, "0xFF8A8AFF")
            else
                statusText = "Sessão encontrada."
                if result.configurationStatus = "configured_partner" then statusText = "Acesso configurado por parceria."
                if result.configurationStatus = "configured_playlist" then statusText = "Playlist configurada."
                if result.listName <> "" then statusText = statusText + " Lista: " + result.listName
                setStatus(statusText, "0x7CE3A1FF")
            end if
        else
            setStatus(result.message, "0xFF8A8AFF")
        end if
    end if
end sub

function HasConfiguredAccess(result as Object) as Boolean
    if result.allowed = true or result.configured = true then return true
    return result.status = "configured_partner" or result.status = "configured_playlist" or result.status = "configured"
end function

sub saveReturnedSession(result as Object)
    if result.accessToken <> invalid and result.accessToken <> "" then RegWrite("auth_token", result.accessToken)
    if result.refreshToken <> invalid and result.refreshToken <> "" then RegWrite("refresh_token", result.refreshToken)
    if result.clearAuth = true then clearSession()
end sub

sub saveConfigurationStatus(result as Object)
    if result.activationId <> invalid and result.activationId <> "" then RegWrite("activation_id", result.activationId)
    state = ToText(result.configurationStatus)
    if state = "" then
        if result.status = "awaiting_configuration" or result.status = "session_required" or result.status = "expired" or result.status = "disabled" or result.status = "deactivated" or result.status = "configured" then state = result.status
    end if
    if state <> "" then
        RegWrite("configuration_status", state)
        if state = "configured_partner" or state = "configured_playlist" then RegDelete("license_pending_configuration")
    end if
    if result.mode <> invalid and result.mode <> "" then RegWrite("activation_kind", result.mode)
    if result.listName <> invalid and result.listName <> "" then RegWrite("list_name", result.listName)
end sub

sub clearSession()
    RegDelete("auth_token")
    RegDelete("xt_cfg")
    XtClearCatalogCache()
    RegDelete("refresh_token")
    RegDelete("activation_id")
    RegDelete("configuration_status")
    RegDelete("list_name")
    RegDelete("license_pending_configuration")
end sub

sub clearRegistration()
    m.pollTimer.control = "stop"
    m.registrationToken = ""
    m.pairingUrl = ""
    RegDelete("registration_token")
    RegDelete("registration_pairing_url")
    RegDelete("registration_installation_id")
end sub

sub showPairingQr()
    ' O QR leva ao site de cadastro com o MAC deste aparelho ja preenchido (o pairingUrl do servidor segue no registro/polling).
    task = CreateObject("roSGNode", "QrTask")
    task.pairingUrl = DeltaUploadUrl(m.identity.macCompact)
    task.observeField("result", "onQrResult")
    m.qrTask = task
    task.control = "RUN"
    m.qrText.text = "Escaneie para cadastrar"
end sub

sub onQrResult(event as Object)
    result = event.getData()
    if result = invalid or result.ok <> true then
        clearQr()
        if result <> invalid then setStatus(result.message, "0xFF8A8AFF")
        return
    end if
    drawQr(result.matrix)
end sub

sub clearQr()
    if m.qr = invalid then return
    while m.qr.getChildCount() > 0
        m.qr.removeChild(m.qr.getChild(0))
    end while
end sub

sub drawQr(matrix as Object)
    clearQr()
    if matrix = invalid or matrix.count() = 0 then
        setStatus("Não foi possível gerar o QR Code.", "0xFF8A8AFF")
        return
    end if

    ' Modulos com tamanho INTEIRO em pixels (sem fracoes): evita as listras/ruido e deixa o QR nitido e legivel.
    boxSize = 154
    size = matrix.count()
    cellSize = Int((boxSize - 16) / size)
    if cellSize < 3 then cellSize = 3
    offset = Int((boxSize - cellSize * size) / 2)
    for y = 0 to size - 1
        x = 0
        while x < size
            if matrix[y][x] = 1 then
                runStart = x
                while x < size and matrix[y][x] = 1
                    x = x + 1
                end while
                module = CreateObject("roSGNode", "Rectangle")
                module.color = "0x000000FF"
                module.translation = [offset + runStart * cellSize, offset + y * cellSize]
                module.width = (x - runStart) * cellSize
                module.height = cellSize
                m.qr.appendChild(module)
            else
                x = x + 1
            end if
        end while
    end for

    ' Icone do Delta TV no centro (~5x5 modulos, dentro da tolerancia do nivel L do gerador).
    centerPx = Int(boxSize / 2)
    pad = cellSize * 5
    base = CreateObject("roSGNode", "Rectangle")
    base.color = "0xFFFFFFFF"
    base.width = pad
    base.height = pad
    base.translation = [centerPx - Int(pad / 2), centerPx - Int(pad / 2)]
    m.qr.appendChild(base)
    logoSize = cellSize * 4
    logo = CreateObject("roSGNode", "Poster")
    logo.uri = "pkg:/images/logo.png"
    logo.width = logoSize
    logo.height = logoSize
    logo.translation = [centerPx - Int(logoSize / 2), centerPx - Int(logoSize / 2)]
    m.qr.appendChild(logo)
end sub

sub startPolling(seconds as Integer)
    if not m.top.visible then return ' sem token, o timer refaz o registro (ver onPollTimer)
    m.pollTimer.duration = seconds
    m.pollTimer.control = "start"
end sub

sub onPollTimer()
    if m.registrationToken <> "" then
        if not m.setupBusy then startSetup("poll")
    else if m.top.visible and RegRead("auth_token") = "" and RegRead("refresh_token") = "" then
        ' Sem pareamento ativo (ex.: ativacao removida): tenta registrar de novo para perceber o cadastro feito pelo QR.
        if not m.setupBusy then startSetup("register")
        startRegisterRetry(15)
    end if
end sub

sub startRegisterRetry(seconds as Integer)
    if not m.top.visible then return
    m.pollTimer.duration = seconds
    m.pollTimer.control = "start"
end sub

sub submit()
    if m.busy then return
    if DeltaWhiteLabelMode() then
        if TrimText(m.values[1]) = "" or m.values[2] = "" then
            setStatus("Informe seu usuário e senha IPTV.", "0xFF8A8AFF")
            return
        end if
        m.busy = true
        m.connectTask = CreateObject("roSGNode", "WhiteLabelAuthTask")
        m.connectTask.params = {action:"activate",username:TrimText(m.values[1]),password:m.values[2]}
        m.values[2] = ""
        m.values[1] = ""
        draw()
        setStatus("Validando acesso IPTV e assinatura do aplicativo...", "0xC3C7D8FF")
        m.connectTask.observeField("result", "onWhiteLabelConnectResult")
        m.connectTask.control = "RUN"
        return
    end if
    if m.setupBusy then
        setStatus("Aguarde a resposta do servidor antes de conectar.", "0xC3C7D8FF")
        return
    end if
    m.values[0] = TrimText(m.values[0])
    pendingPlaylist = m.mode = "license" and RegRead("license_pending_configuration") = "true"
    m.values[1] = TrimText(m.values[1])
    if m.mode = "license" then m.values[2] = TrimText(m.values[2])

    if m.mode = "partner" then
        if m.values[0] = "" or Len(m.values[0]) > 64 then
            setStatus("Informe um código de parceria válido.", "0xFF8A8AFF")
            return
        end if
        if m.values[1] = "" or m.values[2] = "" then
            setStatus("Informe o usuário e a senha do provedor IPTV.", "0xFF8A8AFF")
            return
        end if
    else
        if not pendingPlaylist and (m.values[0] = "" or Len(m.values[0]) > 64) then
            setStatus("Informe o código da licença Delta.", "0xFF8A8AFF")
            return
        end if
        if m.values[1] = "" or Len(m.values[1]) > 80 then
            setStatus("Informe o nome da lista (até 80 caracteres).", "0xFF8A8AFF")
            return
        end if
        if not IsHttpUrl(m.values[2]) or Len(m.values[2]) > 2048 then
            setStatus("Informe uma URL HTTP ou HTTPS válida.", "0xFF8A8AFF")
            return
        end if
    end if

    action = m.mode
    if pendingPlaylist then action = "configurePlaylist"
    params = {
        mode: action,
        code: m.values[0],
        username: m.values[1],
        password: m.values[2],
        listName: m.values[1],
        playlistUrl: m.values[2],
        accessToken: RegRead("auth_token"),
        refreshToken: RegRead("refresh_token")
    }
    m.busy = true
    m.pollTimer.control = "stop"
    setStatus("Enviando configuração...", "0xC3C7D8FF")
    m.values[2] = ""
    if m.mode = "license" then
        if pendingPlaylist then m.values[1] = ""
        if not pendingPlaylist then m.values[1] = "" : m.values[2] = ""
    else
        m.values[1] = ""
        m.values[2] = ""
    end if
    draw()

    m.connectTask = CreateObject("roSGNode", "ConnectTask")
    m.connectTask.params = params
    m.connectTask.observeField("result", "onConnectResult")
    m.connectTask.control = "RUN"
end sub

sub onWhiteLabelConnectResult(event as Object)
    result = event.getData()
    m.busy = false
    if m.connectTask <> invalid then m.connectTask.params = {}
    m.connectTask = invalid
    if result = invalid or result.ok <> true then
        message = "Não foi possível conectar."
        if result <> invalid then message = ToText(result.message)
        setStatus(message, "0xFF8A8AFF")
        draw()
        return
    end if
    setStatus("Conectado. Carregando catálogo...", "0x7CE3A1FF")
    m.top.connected = true
    m.closeTimer.control = "start"
end sub

sub onConnectResult(event as Object)
    result = event.getData()
    m.busy = false
    if m.connectTask <> invalid then m.connectTask.params = {}
    m.connectTask = invalid
    m.values[2] = ""
    if result = invalid then
        setStatus("O servidor não retornou o resultado da configuração.", "0xFF8A8AFF")
        draw()
        return
    end if

    saveReturnedSession(result)
    if result.sessionOk = true and result.ok <> true and m.mode = "license" then
        if result.clearAuth = true then
            RegDelete("license_pending_configuration")
            setStatus(result.message, "0xFF8A8AFF")
            draw()
            return
        end if
        RegWrite("license_pending_configuration", "true")
        RegWrite("activation_code", m.values[0])
        RegWrite("activation_kind", "license")
        setStatus(result.message, "0xFF8A8AFF")
        draw()
        if m.registrationToken <> "" then startPolling(m.backoffSeconds)
        return
    end if
    if result.ok <> true then
        setStatus(result.message, "0xFF8A8AFF")
        draw()
        if m.registrationToken <> "" then startPolling(m.backoffSeconds)
        return
    end if

    RegWrite("activation_kind", m.mode)
    RegWrite("installation_id", m.identity.installationId)
    if m.values[0] <> "" then RegWrite("activation_code", m.values[0])
    RegDelete("license_pending_configuration")
    saveConfigurationStatus(result)
    clearRegistration()
    draw()
    m.statusAfterConnect = true
    setStatus("Configuração salva. Confirmando o estado da sessão...", "0xC3C7D8FF")
    startSetup("status")
end sub

sub completeConnection(message as String)
    ' A ativação pode ter sido associada a outro fornecedor; descartar imediatamente credenciais e catálogo em cache.
    RegDelete("xt_cfg")
    XtClearCatalogCache()
    setStatus(message, "0x7CE3A1FF")
    m.top.connected = true
    m.closeTimer.control = "start"
end sub

sub onCloseTimer()
    m.top.closeRequest = true
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if DeltaWhiteLabelMode() then
        if m.busy then return true
        if key = "up" then
            if m.focus = 3 then m.focus = 2
            if m.focus = 4 or m.focus = 5 then m.focus = 3
        else if key = "down" then
            if m.focus = 2 then
                m.focus = 3
            else if m.focus = 3 then
                m.focus = 4
            end if
        else if key = "left" then
            if m.focus = 5 then m.focus = 4
        else if key = "right" then
            if m.focus = 4 then m.focus = 5
        else if key = "OK" then
            if m.focus = 2 or m.focus = 3 then openKeyboard(m.focus - 1)
            if m.focus = 4 then submit()
            if m.focus = 5 then m.top.closeRequest = true
        else if key = "back" then
            m.top.closeRequest = true
        end if
        draw()
        return true
    end if
    if m.busy then return true

    if key = "back" then
        m.values[2] = ""
        m.top.closeRequest = true
        return true
    else if key = "up" then
        if m.focus > 1 and m.focus < 4 then
            m.focus = m.focus - 1
            if m.focus = 1 and m.mode = "license" and RegRead("license_pending_configuration") = "true" then m.focus = 0
        else if m.focus = 4 or m.focus = 5 then
            m.focus = 3
        else if m.focus = 1 then
            m.focus = 0
        end if
    else if key = "down" then
        if m.focus = 0 then
            m.focus = 1
            if m.mode = "license" and RegRead("license_pending_configuration") = "true" then m.focus = 2
        else if m.focus >= 1 and m.focus < 3 then
            m.focus = m.focus + 1
        else if m.focus = 3 then
            m.focus = 4
        end if
    else if key = "left" then
        if m.focus = 0 then
            toggleMode()
        else if m.focus = 5 then
            m.focus = 4
        end if
    else if key = "right" then
        if m.focus = 0 then
            toggleMode()
        else if m.focus = 4 then
            m.focus = 5
        end if
    else if key = "OK" then
        if m.focus = 0 then
            toggleMode()
        else if m.focus >= 1 and m.focus <= 3 then
            pendingPlaylist = m.mode = "license" and RegRead("license_pending_configuration") = "true"
            if not (pendingPlaylist and m.focus = 1) then openKeyboard(m.focus - 1)
        else if m.focus = 4 then
            submit()
        else if m.focus = 5 then
            m.values[2] = ""
            m.top.closeRequest = true
        end if
    end if
    draw()
    return true
end function

sub toggleMode()
    if m.mode = "partner" then
        m.mode = "license"
    else
        m.mode = "partner"
    end if
    m.values[1] = ""
    m.values[2] = ""
    m.focus = 0
    draw()
end sub

function TrialSetupMessage(result as Object) as String
    dateText = ToText(result.trialExpiresAt)
    if Len(dateText) >= 10 then dateText = Mid(dateText, 9, 2) + "/" + Mid(dateText, 6, 2) + "/" + Left(dateText, 4)
    return "Teste gratuito ativo até " + dateText + ". Adicione sua própria lista pelo site usando o MAC exibido."
end function
