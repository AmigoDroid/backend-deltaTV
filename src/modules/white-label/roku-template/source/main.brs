' ============================================================
' Delta TV - ponto de entrada
' ============================================================
sub Main(args as Dynamic)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.SetMessagePort(port)

    ' Deep linking (certificacao 5.2): eventos roInput chegam enquanto o canal esta aberto
    input = CreateObject("roInput")
    input.SetMessagePort(port)

    ' Monitoramento de memoria: avisos de pouca memoria chegam como eventos
    memMonitor = CreateObject("roAppMemoryMonitor")
    memMonitor.SetMessagePort(port)
    memMonitor.EnableMemoryWarningEvent(true)
    ' Metodos de memoria podem faltar em firmwares antigos (erro &hf4): checa antes de chamar
    memLimit = -1
    memAvail = -1
    memPct = -1
    if FindMemberFunction(memMonitor, "GetChannelMemoryLimit") <> invalid then memLimit = memMonitor.GetChannelMemoryLimit()
    if FindMemberFunction(memMonitor, "GetChannelAvailableMemory") <> invalid then memAvail = memMonitor.GetChannelAvailableMemory()
    if FindMemberFunction(memMonitor, "GetMemoryLimitPercent") <> invalid then memPct = memMonitor.GetMemoryLimitPercent()
    ' GetChannelMemoryLimit retorna um roAssociativeArray (nao um inteiro): serializa os campos
    limitTxt = "n/d"
    if type(memLimit) = "roAssociativeArray"
        limitTxt = ""
        for each k in memLimit
            limitTxt = limitTxt + k + ":" + Box(memLimit[k]).toStr() + " "
        end for
    else if memLimit <> invalid
        limitTxt = Box(memLimit).toStr()
    end if
    print "[Mem] limite={" + limitTxt + "} disponivel=" + Box(memAvail).toStr() + " uso=" + Box(memPct).toStr() + "%"
    devInfo = CreateObject("roDeviceInfo")
    devInfo.SetMessagePort(port)
    devInfo.EnableLowGeneralMemoryEvent(true)

    scene = screen.CreateScene("MainScene")
    screen.Show()

    ' Argumentos de lancamento (contentId / mediaType), se houver
    if type(args) = "roAssociativeArray" then scene.launchArgs = args

    ' Os beacons AppLaunchComplete / AppDialogInitiate / AppDialogComplete sao disparados pela MainScene
    ' (a tela de conexao aparece antes da home quando o aparelho ainda nao esta ativado).

    while true
        msg = wait(0, port)
        t = type(msg)
        if t = "roSGScreenEvent"
            if msg.isScreenClosed() then return
        else if t = "roInputEvent"
            if msg.isInput() then
                info = msg.getInfo()
                if type(info) = "roAssociativeArray" then scene.inputData = info
            end if
        else if t = "roDeviceInfoEvent"
            ' roDeviceInfoEvent tambem chega por rede, legenda, etc.: so conta como pouca memoria se o nivel nao for "normal"
            info = msg.getInfo()
            if type(info) = "roAssociativeArray" then
                if info.generalMemoryLevel <> invalid then
                    lvl = LCase(Box(info.generalMemoryLevel).toStr())
                    if lvl <> "normal" then scene.memoryEvent = { type: t, level: lvl, stamp: CreateObject("roDateTime").AsSeconds() }
                end if
            end if
        else if Instr(1, t, "Memory") > 0
            ' aviso de memoria do canal (roAppMemoryMonitorEvent): a cena libera o que for descartavel
            scene.memoryEvent = { type: t, level: "", stamp: CreateObject("roDateTime").AsSeconds() }
        end if
    end while
end sub
