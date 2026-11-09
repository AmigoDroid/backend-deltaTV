sub init()
    t = Theme()
    m.video = m.top.findNode("video")
    m.loading = m.top.findNode("loading")
    m.errorBox = m.top.findNode("errorBox")
    Txt(m.loading, 20, false, t.textDim)
    Txt(m.top.findNode("errTitle"), 24, true, t.text)
    Txt(m.top.findNode("errMsg"), 16, false, t.textDim)
    Txt(m.top.findNode("errHint"), 14, false, t.accentLight)
    m.video.observeField("state", "onState")
    m.video.observeField("position", "onPlaybackPosition")
    m.nextEpisodeBox = m.top.findNode("nextEpisodeBox")
    m.nextEpisode = invalid
    m.nextEpisodeTask = invalid
    m.nextRequestId = 0
    m.nextDismissed = false
    m.nextOffered = false
    m.nextTransitioning = false
    m.nextEndWait = 0
    m.nextEndCountdown = -1
    m.nextPoll = CreateObject("roSGNode", "Timer")
    m.nextPoll.duration = 1
    m.nextPoll.repeat = true
    m.nextPoll.observeField("fire", "onNextEpisodeTick")
    Txt(m.top.findNode("nextEpisodeTitle"), 17, false, t.text)
    Txt(m.top.findNode("nextEpisodeButton"), 25, true, t.text)
    Txt(m.top.findNode("nextEpisodeHint"), 15, false, t.textDim)
    ' Isola cabecalhos do player: nao misturar UA e Accept com outros pedidos do app.
    m.playerHttpAgent = CreateObject("roHttpAgent")
    m.video.setHttpAgent(m.playerHttpAgent)
    m.bg = m.top.findNode("bgRect")
    m.mini = false
    m.fromMini = false
    m.cands = []
    m.candIdx = 0
    m.pendingFmt = ""
    m.gatewayRetries = 0
    m.gatewayRetryTimer = CreateObject("roSGNode", "Timer")
    m.gatewayRetryTimer.duration = 1.5
    m.gatewayRetryTimer.repeat = false
    m.gatewayRetryTimer.observeField("fire", "onGatewayRetry")
    m.uaTry = 0 ' tentativa de cabecalho: 0=preferido, 1=alternativo, 2=Roku nativo
    m.curUrl = ""
    m.curItem = invalid
    m.curFmt = ""
    m.activeUaIsVlc = false
    m.uaSaved = false
    ' Nao declarar um User-Agent "bom" apenas porque o player exibiu 1 frame.
    m.uaAttemptClock = CreateObject("roTimespan")
    m.uaAttemptClock.Mark()
    m.uaPlayingFromPos = -1.0
    m.lastPositionLogged = -1.0
    ' vigia do ao vivo: reinicia o canal se o video congelar sem avisar erro (conexao parada)
    m.wd = m.top.findNode("watchdog")
    m.wd.observeField("fire", "onWatchdog")
    ResetWatchdog()
    m.wdRestarts = 0
    m.wdArmed = false
    m.span = CreateObject("roTimespan")
    m.span.Mark()
    m.wdSegCount = 0
    m.wdSegMs = 0
    m.wdTick = 0
    m.wdFlapMs = 0
    m.wdFlapCount = 0
    m.memMon = CreateObject("roAppMemoryMonitor")
    m.video.observeField("downloadedSegment", "onSegment")
    ' Salva posicao VOD periodicamente e na saida (sem afetar canais ao vivo).
    m.bookmarkTimer = CreateObject("roSGNode", "Timer")
    m.bookmarkTimer.duration = 15
    m.bookmarkTimer.repeat = true
    m.bookmarkTimer.observeField("fire", "onBookmarkTick")
    ' Guardamos a ultima posicao validada para manter o ponto ao reconectar o VOD.
    m.seekRecoveryPos = 0.0
    m.startSeekPos = 0.0
    m.vodPositionReady = false
    m.resumeBox = m.top.findNode("resumeBox")
    m.resumeDialogActive = false
    m.resumeChoice = 0
    m.skipResumePromptOnce = false
    m.restartFromBeginning = false
    ' Navegacao VOD: o usuario escolhe a posicao antes de uma nova abertura.
    ' Usamos PlayStart, e nao Video.seek, ao confirmar o salto.
    m.seekActive = false
    m.seekTarget = 0.0
    m.seekBox = m.top.findNode("seekBox")
    m.seekCaption = m.top.findNode("seekCaption")
    m.seekFill = m.top.findNode("seekFill")
    m.seekCurrentMarker = m.top.findNode("seekCurrentMarker")
    ' Miniaturas reais durante o cursor: BIF do player Roku ou JPEG do provedor.
    m.seekPreviewBox = m.top.findNode("seekPreviewBox")
    m.seekPreviewImage = m.top.findNode("seekPreviewImage")
    m.seekPreviewTime = m.top.findNode("seekPreviewTime")
    m.seekPreviewStatus = m.top.findNode("seekPreviewStatus")
    m.seekPreviewImage.observeField("loadStatus", "onSeekPreviewLoad")
    m.bifNode = m.video.bifDisplay
    if m.bifNode <> invalid then m.bifNode.observeField("nearestFrame", "onSeekBifFrame")
    m.thumbMode = ""
    m.thumbTemplate = ""
    m.thumbInterval = 10
    m.thumbLastKey = ""
    m.thumbBifRequested = false
    Txt(m.seekPreviewTime, 17, true, t.text)
    Txt(m.seekPreviewStatus, 14, false, t.textDim)
    Txt(m.seekCaption, 24, true, t.text)
    Txt(m.top.findNode("seekHint"), 16, false, t.textDim)
    Txt(m.top.findNode("resumeTitle"), 27, true, t.text)
    Txt(m.top.findNode("resumeMessage"), 19, false, t.textDim)
    Txt(m.top.findNode("resumeBtn0Label"), 21, true, t.text)
    Txt(m.top.findNode("resumeBtn1Label"), 21, true, t.text)
    Txt(m.top.findNode("resumeHint"), 15, false, t.textDim)
end sub

' Chegou um segmento HLS novo: marca o instante (sinal mais confiavel de que o stream esta vivo que a "position").
sub onSegment()
    m.wdSegCount = m.wdSegCount + 1
    m.wdSegMs = m.span.TotalMilliseconds()
end sub

sub ResetWatchdog()
    m.wdLastPos = -1
    m.wdStall = 0
    m.wdBuffer = 0
    m.wdAdv = 0
end sub

' A cada 5 s. SO age se este canal ja provou que toca (a posicao avancou pelo menos 2 vezes seguidas):
' assim um stream cujo "position" nunca anda, ou uma partida lenta, jamais e reiniciado por engano.
' Depois de armado: posicao parada por ~20 s, ou "buffering" por ~40 s = stream travado.
' Reabre a mesma URL (conexao nova), como se o usuario saisse e voltasse ao canal.
sub onWatchdog()
    if m.curItem = invalid or not IsLiveItem(m.curItem) then return
    if m.top.visible = false then return
    st = m.video.state
    LogWatchdog(st)
    if st <> "playing" and st <> "buffering" then
        ResetWatchdog()
        return
    end if
    ' HLS: o stream andava (>= 3 segmentos) e ha mais de 25 s nao chega segmento novo = travado, mesmo que "position" ande.
    if m.wdSegCount >= 3 then
        gap = m.span.TotalMilliseconds() - m.wdSegMs
        if gap > 25000 then
            print "[DeltaTV][play] WATCHDOG: sem segmento novo ha " + Str(Int(gap / 1000)).Trim() + "s (estado=" + st + ") - reconectando"
            RestartLive()
            return
        end if
    end if
    if st = "buffering" then
        if m.wdArmed then m.wdBuffer = m.wdBuffer + 1
        m.wdStall = 0
    else
        m.wdBuffer = 0
        curPos = m.video.position
        if curPos = m.wdLastPos then
            if m.wdArmed then m.wdStall = m.wdStall + 1
        else
            if m.wdLastPos >= 0 and curPos > m.wdLastPos then m.wdAdv = m.wdAdv + 1
            m.wdStall = 0
            m.wdLastPos = curPos
            if m.wdAdv >= 2 then
                m.wdArmed = true
                m.wdRestarts = 0 ' voltou a andar: zera as tentativas seguidas
            end if
        end if
    end if
    if m.wdArmed and (m.wdStall >= 4 or m.wdBuffer >= 8) then
        print "[DeltaTV][play] WATCHDOG: canal travado (estado=" + st + " stall=" + ToText(m.wdStall) + " buf=" + ToText(m.wdBuffer) + " pos=" + ToText(m.video.position) + ") - reconectando"
        RestartLive()
    end if
end sub

' Registro a cada ~15 s para diagnosticar travamentos (estado, posicao, segmentos, memoria do app).
sub LogWatchdog(st as String)
    m.wdTick = m.wdTick + 1
    if m.wdTick mod 3 <> 0 then return
    gap = -1
    if m.wdSegCount > 0 then gap = Int((m.span.TotalMilliseconds() - m.wdSegMs) / 1000)
    memTxt = "?"
    if m.memMon <> invalid then
        if FindMemberFunction(m.memMon, "GetMemoryLimitPercent") <> invalid then memTxt = Str(m.memMon.GetMemoryLimitPercent()).Trim() + "%"
    end if
    print "[DeltaTV][watch] estado=" + st + " pos=" + Str(m.video.position).Trim() + " segs=" + Str(m.wdSegCount).Trim() + " semSegHa=" + Str(gap).Trim() + "s mem=" + memTxt + " reinicios=" + Str(m.wdRestarts).Trim()
end sub

sub RestartLive()
    ResetWatchdog()
    m.wdArmed = false
    m.wdSegCount = 0
    m.wdSegMs = m.span.TotalMilliseconds()
    m.wdRestarts = m.wdRestarts + 1
    ' anti-"pisca-pisca": wdRestarts zera quando o canal volta a andar; este contador vale por janela de 5 min
    if m.span.TotalMilliseconds() - m.wdFlapMs > 300000 then
        m.wdFlapMs = m.span.TotalMilliseconds()
        m.wdFlapCount = 0
    end if
    m.wdFlapCount = m.wdFlapCount + 1
    if m.wdRestarts > 6 or m.wdFlapCount > 12 then
        ' nao volta nem reabrindo: para de insistir e avisa
        m.wd.control = "stop"
        m.video.control = "stop"
        m.video.content = invalid
        m.wdRestarts = 0
        m.wdFlapCount = 0
        showError("O canal parou de responder. Tente novamente.")
        return
    end if
    m.video.control = "stop"
    m.errorBox.visible = false
    m.loading.text = "Reconectando..."
    m.loading.visible = true
    playContent(m.curItem, m.curUrl, m.curFmt)
end sub

' ---------- layouts ----------
' Miniatura: video no quadro de pre-visualizacao da TV ao vivo (a tela ao vivo e cheia, em [0,0]:
' o quadro fica em [724,106] com 524x295). Sem fundo preto e SEM roubar o foco.
' Tela cheia: o MESMO video passa a ocupar 1280x720 sem reiniciar o canal.
sub setLayout(mini as Boolean)
    m.mini = mini
    m.top.mini = mini
    if mini then
        m.bg.visible = false
        m.video.translation = [724, 106]
        m.video.width = 524
        m.video.height = 295
        m.loading.translation = [724, 240]
        m.loading.width = 524
        m.errorBox.visible = false
    else
        m.bg.visible = true
        m.video.translation = [0, 0]
        m.video.width = 1280
        m.video.height = 720
        m.loading.translation = [0, 340]
        m.loading.width = 1280
    end if
end sub

sub startPlayback()
    m.fromMini = false
    setLayout(false)
    beginPlayback()
end sub

sub startMini()
    m.fromMini = true
    setLayout(true)
    beginPlayback()
end sub

' 2o OK no canal que ja esta tocando na miniatura: tela cheia (sem reiniciar, exceto se tinha falhado)
sub goFull()
    m.fromMini = true
    setLayout(false)
    st = m.video.state
    if st = "error" or st = "stopped" or st = "none" then
        beginPlayback()
    else
        m.errorBox.visible = false
        m.loading.visible = (st = "buffering")
    end if
    m.video.setFocus(true)
end sub

sub stopMini()
    ResetNextEpisode()
    HideVodSeek()
    m.resumeDialogActive = false
    m.resumeBox.visible = false
    m.wd.control = "stop"
    m.video.control = "stop"
    m.video.content = invalid ' solta o ContentNode do ultimo canal
    m.fromMini = false
    setLayout(false)
    m.top.mini = false
end sub

sub beginPlayback()
    m.gatewayRetryTimer.control = "stop"
    d = m.top.item
    if d = invalid then return

    ResetNextEpisode()
    HideVodSeek()
    SavePlaybackBookmark()
    m.bookmarkTimer.control = "stop"
    m.video.control = "stop" ' troca de canal: encerra o anterior antes de pedir o novo
    ResetWatchdog()
    m.wdArmed = false
    m.wdSegCount = 0
    m.wdSegMs = m.span.TotalMilliseconds()
    m.wdRestarts = 0
    m.wdFlapCount = 0
    m.uaTry = 0
    m.errorBox.visible = false
    m.loading.text = "Carregando..."
    m.loading.visible = true
    m.resumeDialogActive = false
    m.resumeBox.visible = false

    ' Pergunta SOMENTE ao entrar pelo catalogo. Deep links devem tocar imediatamente.
    if not m.skipResumePromptOnce and not IsLiveItem(d) then
        skipDialog = false
        if d.skipResumePrompt <> invalid then skipDialog = (d.skipResumePrompt = true)
        if not skipDialog then
            storedSeconds = VodReadPosition(d)
            if storedSeconds >= 10 then
                ShowResumeDialog(storedSeconds)
                return
            end if
        end if
    end if
    m.skipResumePromptOnce = false
    if m.restartFromBeginning then
        VodClearPosition(d)
        m.restartFromBeginning = false
    end if
    m.gatewayRetries = 0
    m.seekRecoveryPos = 0.0
    if not IsLiveItem(d) then m.seekRecoveryPos = VodReadPosition(d)
    m.vodPositionReady = false
    LoadNextEpisode(d)

    ' Canal ao vivo: tenta HLS (.m3u8) e, se o aparelho/servidor nao abrir, MPEG-TS (.ts) - e vice-versa.
    ' O formato que funcionou fica guardado e passa a ser o primeiro da proxima vez.
    m.cands = []
    m.candIdx = 0
    if IsLiveItem(d) and d.playPath <> invalid then
        m.cands = LiveCandidates(ToText(d.playPath), RegRead("live_fmt"))
    end if

    if d.playPath <> invalid and d.playPath <> "" then
        m.pendingItem = d
        if m.cands.count() > 0 then
            requestPlayUrl(m.cands[0].path, m.cands[0].fmt)
        else
            requestPlayUrl(d.playPath, "")
        end if
        return
    end if

    playContent(d, d.url, "")
end sub

function PadResumeNumber(numberValue as Integer) as String
    numberText = numberValue.toStr()
    if numberValue < 10 then return "0" + numberText
    return numberText
end function

function ResumeClock(totalSeconds as Float) as String
    wholeSeconds = Int(totalSeconds)
    hoursValue = Int(wholeSeconds / 3600)
    minutesValue = Int((wholeSeconds mod 3600) / 60)
    secondsValue = wholeSeconds mod 60
    if hoursValue > 0 then
        return hoursValue.toStr() + ":" + PadResumeNumber(minutesValue) + ":" + PadResumeNumber(secondsValue)
    end if
    return PadResumeNumber(minutesValue) + ":" + PadResumeNumber(secondsValue)
end function

sub ShowResumeDialog(savedSeconds as Float)
    m.resumeDialogActive = true
    m.resumeChoice = 0
    m.resumeBox.visible = true
    m.loading.visible = false
    m.top.findNode("resumeMessage").text = "Você parou em " + ResumeClock(savedSeconds) + ". Como deseja assistir?"
    DrawResumeChoice()
    m.top.setFocus(true)
    print "[VodResume] escolha solicitada para conteudo com progresso salvo"
end sub

sub DrawResumeChoice()
    if m.resumeChoice = 0 then
        m.top.findNode("resumeBtn0Bg").color = "0x435DAEFF"
        m.top.findNode("resumeBtn1Bg").color = "0x252C43FF"
    else
        m.top.findNode("resumeBtn0Bg").color = "0x252C43FF"
        m.top.findNode("resumeBtn1Bg").color = "0x435DAEFF"
    end if
end sub

sub ConfirmResumeChoice()
    if not m.resumeDialogActive then return
    m.resumeDialogActive = false
    m.resumeBox.visible = false
    m.skipResumePromptOnce = true
    m.restartFromBeginning = (m.resumeChoice = 1)
    if m.restartFromBeginning then
        print "[VodResume] usuario escolheu reproduzir do inicio"
    else
        print "[VodResume] usuario escolheu continuar da posicao salva"
    end if
    beginPlayback()
end sub

sub CancelResumeChoice()
    m.resumeDialogActive = false
    m.resumeBox.visible = false
    m.bookmarkTimer.control = "stop"
    m.wd.control = "stop"
    m.video.control = "stop"
    m.video.content = invalid
    m.top.closeRequest = true
end sub

function IsLiveItem(d as Object) as Boolean
    if d = invalid then return false
    if d.live = invalid then return false
    return (d.live = true)
end function

' playPath do gateway (/api/v1/play/<lista>/<id>[.ext]) -> candidatos [{path, fmt, key}] em ordem de preferencia.
' Qualquer outra URL (fora do gateway) nao e reescrita.
function LiveCandidates(path as String, pref as String) as Object
    ' gateway antigo (/api/v1/play/) ou canal Xtream direto do provedor (/live/<usuario>/<senha>/<id>.m3u8|.ts)
    if Instr(1, path, "/api/v1/play/") = 0 and Instr(1, path, "/live/") = 0 then return []
    if Instr(1, path, "/_hls/") > 0 then return []
    base = path
    lp = LCase(path)
    if Right(lp, 5) = ".m3u8" then
        base = Left(path, Len(path) - 5)
    else if Right(lp, 3) = ".ts" then
        base = Left(path, Len(path) - 3)
    end if
    hls = { path: base + ".m3u8", fmt: "hls", key: "hls" }
    ts = { path: base + ".ts", fmt: "ts", key: "ts" }
    if pref = "ts" then return [ts, hls]
    return [hls, ts]
end function

sub requestPlayUrl(path as String, fmt as String)
    ' O fornecedor entrega o stream diretamente; não há chamada de play-token ao backend.
    m.pendingFmt = fmt
    url = path
    if Left(url, 1) = "/" then url = DeltaServerOrigin() + url
    playContent(m.pendingItem, url, fmt)
end sub

' Falhou o formato atual de um canal ao vivo: tenta o proximo candidato. Retorna false quando acabaram.
function TryNextCandidate() as Boolean
    if m.cands = invalid then return false
    if m.candIdx + 1 >= m.cands.count() then return false
    m.candIdx = m.candIdx + 1
    c = m.cands[m.candIdx]
    m.video.control = "stop"
    m.errorBox.visible = false
    m.loading.text = "Tentando outro formato..."
    m.loading.visible = true
    requestPlayUrl(c.path, c.fmt)
    return true
end function

sub showError(msg as String)
    if m.mini then
        ' miniatura: mensagem curta no proprio quadro, sem tirar o foco da lista de canais
        m.loading.text = "Não foi possível reproduzir este canal."
        m.loading.visible = true
    else
        m.loading.visible = false
        m.top.findNode("errMsg").text = msg
        m.errorBox.visible = true
        m.top.setFocus(true)
    end if
end sub



' URL para log/tela sem usuario e senha: .../live/***/***/123.m3u8
function MaskUrl(url as String) as String
    ' Elimina query com tokens mesmo quando o caminho contem credenciais Xtream.
    q = Instr(1, url, "?")
    if q > 0 then url = Left(url, q - 1) + "?[oculto]"
    for each seg in ["/live/", "/movie/", "/series/"]
        a = Instr(1, url, seg)
        if a > 0 then
            rest = Mid(url, a + Len(seg))
            p1 = Instr(1, rest, "/")
            if p1 > 0 then
                p2 = Instr(p1 + 1, rest, "/")
                if p2 > 0 then return Left(url, a + Len(seg) - 1) + "***/***/" + Mid(rest, p2 + 1)
            end if
        end if
    end for
    ' Nao exibir query strings (podem conter tokens ou senhas).
    q = Instr(1, url, "?")
    if q > 0 then return Left(url, q - 1) + "?[oculto]"
    return url
end function

sub playContent(d as Object, url as String, fmtOverride as String)
    m.lastUrl = MaskUrl(url)
    c = CreateObject("roSGNode", "ContentNode")
    c.title = d.title
    c.url = url
    fmt = fmtOverride
    if fmt = "" then fmt = ToText(d.streamFormat)
    if fmt = "" then fmt = GuessStreamFormat(url)
    c.streamFormat = fmt
    ConfigureVodThumbnails(d, c)
    m.curItem = d
    ' So VOD tem barra propria: no ao vivo mantemos o controle nativo Roku.
    m.video.enableUI = IsLiveItem(d)
    m.startSeekPos = 0.0
    m.vodPositionReady = false
    if not IsLiveItem(d) then
        ' playStart e o mecanismo oficial de iniciar VOD na posicao salva.
        ' Evita comecar do zero e fazer seek adicional no primeiro "playing".
        if m.seekRecoveryPos >= 10 then
            m.startSeekPos = m.seekRecoveryPos
            c.playStart = m.startSeekPos
            print "[DeltaTV][vod] inicio solicitado=" + ToText(Int(m.startSeekPos)) + "s via PlayStart"
        end if
        m.bookmarkTimer.control = "start"
    else
        m.bookmarkTimer.control = "stop"
    end if
    m.curUrl = url
    m.curFmt = fmtOverride
    m.uaSaved = false
    m.activeUaIsVlc = false
    m.uaPlayingFromPos = -1.0
    m.lastPositionLogged = -1.0
    m.uaAttemptClock.Mark()
    uaLabel = "padrao Roku"
    if Left(LCase(url), 4) = "http" and Instr(1, url, DeltaServerOrigin()) <> 1 then
        ' Tres tentativas DIFERENTES. Se VLC foi salvo, a segunda tenta Mozilla.
        preferred = RegRead("play_ua")
        if m.uaTry = 2 then
            ' Sem cabecalhos customizados (zera cabecalhos antigos do agente).
            c.HttpHeaders = []
        else
            useVlc = (m.uaTry = 1)
            if preferred = "vlc" then useVlc = (m.uaTry = 0)
            m.activeUaIsVlc = useVlc
            if useVlc then
                uaLabel = "VLC/3.0.18"
                c.HttpHeaders = ["User-Agent: VLC/3.0.18 LibVLC/3.0.18", "Accept: */*"]
            else
                uaLabel = "Mozilla/5.0"
                c.HttpHeaders = ["User-Agent: " + PlayUserAgent(), "Accept: */*"]
            end if
        end if
    end if
    if d.live <> invalid then
        if d.live = true then c.live = true
    end if

    print "[DeltaTV][play] formato=" + fmt + " ua=" + uaLabel + " tentativa=" + ToText(m.uaTry) + " url=" + m.lastUrl
    m.video.content = c
    m.video.control = "play"
    m.wd.control = "start"
    if not m.mini then
        if IsLiveItem(d) then
            m.video.setFocus(true)
        else
            ' O Video com foco consome as teclas da barra nativa (trickplay).
            ' Foco no PlayerScreen para capturar a posicao selecionada.
            m.top.setFocus(true)
        end if
    end if
end sub

sub onState()
    s = m.video.state
    if s <> "playing" and s <> "paused" and s <> "finished" then m.nextEpisodeBox.visible = false
    if s = "paused" then SavePlaybackBookmark()
    if m.curItem <> invalid and not IsLiveItem(m.curItem) then
        elapsedSec = Int(m.uaAttemptClock.TotalMilliseconds() / 1000)
        print "[DeltaTV][vod] estado=" + s + " tentativa=" + ToText(m.uaTry) + " pos=" + ToText(Int(m.video.position)) + "s decorrido=" + ToText(elapsedSec) + "s"
    end if
    if s = "playing" or s = "buffering" then
        m.loading.visible = (s = "buffering")
        if s = "playing" then
            RememberLiveFormat()
            ' A preferencia de User-Agent so sera salva apos 20s e progresso real.
            ' Uma reproducao que morre com HTTP 406 aos 4s nao deve ser considerada valida.
        end if
    else if s = "finished" then
        HideVodSeek()
        VodWriteSeriesState(m.curItem, true)
        VodClearPosition(m.curItem)
        m.bookmarkTimer.control = "stop"
        m.vodPositionReady = false
        if m.nextDismissed then
            closePlayer()
        else if m.nextEpisode <> invalid then
            if m.nextOffered then
                PlayNextEpisode()
            else
                ShowNextEpisodeAtEnd()
            end if
        else if m.nextEpisodeTask <> invalid then
            ' A resposta pode chegar apos o ultimo frame. Aguarda por no maximo 8s.
            m.nextEndWait = 8
            m.loading.text = "Buscando próximo episódio..."
            m.loading.visible = true
            m.nextPoll.control = "start"
        else
            closePlayer()
        end if
    else if s = "error" then
        HideVodSeek()
        errorDetails = ToText(m.video.errorStr)
        http406 = (Instr(1, errorDetails, "(406)") > 0)
        print "[DeltaTV][play] ERRO codigo=" + ToText(m.video.errorCode) + " msg=" + ToText(m.video.errorMsg) + " str=" + errorDetails + " url=" + ToText(m.lastUrl)
        if m.curItem <> invalid and not IsLiveItem(m.curItem) then
            print "[DeltaTV][vod] erro: posValidada=" + ToText(Int(m.seekRecoveryPos)) + "s posRoku=" + ToText(Int(m.video.position)) + "s inicio=" + ToText(Int(m.startSeekPos)) + "s tentativa=" + ToText(m.uaTry) + " durTentativa=" + ToText(Int(m.uaAttemptClock.TotalMilliseconds() / 1000)) + "s"
        end if
        if TryNextCandidate() then return
        if RetryOtherUserAgent() then return
        if RetryGateway() then return
        m.loading.visible = false
        msg = ToText(m.video.errorMsg)
        if http406 then
            msg = "O servidor recusou o vídeo (HTTP 406). O provedor deve conferir os cabeçalhos e o suporte a avanço/Range."
        else if msg = "" then
            msg = "Verifique a sua conexão ou o endereço do vídeo."
        end if
        msg = msg + "  [cód. " + ToText(m.video.errorCode) + "]"
        showError(msg)
    end if
end sub

 ' No máximo duas novas conexões ao gateway por reprodução. Não promete troca de família IP.
function RetryGateway() as Boolean
    if m.curItem = invalid or m.curUrl = "" then return false
    origin = DeltaServerOrigin()
    if Left(m.curUrl, Len(origin) + 1) <> origin + "/" then return false
    if m.gatewayRetries >= 2 then return false
    m.gatewayRetries = m.gatewayRetries + 1
    m.video.control = "stop"
    m.errorBox.visible = false
    m.loading.text = "Reconectando pelo servidor..."
    m.loading.visible = true
    m.gatewayRetryTimer.control = "start"
    return true
end function

sub onGatewayRetry()
    if m.curItem = invalid or m.curUrl = "" then return
    playContent(m.curItem, m.curUrl, m.curFmt)
end sub

' Filme/serie recusado pelo provedor (406/403/erro HTTP): tenta sozinho com outro User-Agent, sem o usuario precisar apertar OK de novo.
function RetryOtherUserAgent() as Boolean
    if m.curItem = invalid or m.curUrl = "" then return false
    if m.uaTry >= 2 then return false
    if Instr(1, m.curUrl, DeltaServerOrigin()) = 1 then return false
    if IsLiveItem(m.curItem) then return false
    m.uaTry = m.uaTry + 1
    print "[DeltaTV][play] reenviando VOD com cabecalhos alternativos (tentativa " + ToText(m.uaTry) + ", pos=" + ToText(Int(m.seekRecoveryPos)) + "s)"
    m.video.control = "stop"
    m.errorBox.visible = false
    m.loading.text = "Reconectando..."
    m.loading.visible = true
    playContent(m.curItem, m.curUrl, m.curFmt)
    return true
end function

' Recebe a posicao realmente informada pelo player, inclusive apos uso do cursor.
' Em caso de falha, a reconexao tenta este ultimo ponto confirmado.
sub onPlaybackPosition()
    if m.curItem = invalid or IsLiveItem(m.curItem) then return
    if m.video.state <> "playing" then return
    p = m.video.position
    if p < 0 then return
    ' Quando iniciamos em 40m, ignorar notificacoes 0s/1s antes do seek inicial.
    if not m.vodPositionReady and m.startSeekPos >= 10 then
        if p < m.startSeekPos - 15 then return
    end if
    firstPosition = not m.vodPositionReady
    m.vodPositionReady = true
    if m.lastPositionLogged >= 0 and Abs(p - m.lastPositionLogged) >= 25 then
        print "[DeltaTV][vod] salto de posicao: " + ToText(Int(m.lastPositionLogged)) + "s -> " + ToText(Int(p)) + "s, estado=" + m.video.state
    end if
    m.lastPositionLogged = p
    m.seekRecoveryPos = p
    if firstPosition then SavePlaybackBookmark()
    MaybeRememberVodUa()
    UpdateNextEpisode()
end sub

' Uma tentativa nao esta comprovada no primeiro estado "playing".
' Exige 20 segundos desde que a tentativa comecou E pelo menos 5 segundos
' de progresso observado. Evita guardar Mozilla como UA valido em falhas 406
' logo apos o inicio, como no log de 01/11/2026.
sub MaybeRememberVodUa()
    if m.uaSaved or m.curItem = invalid then return
    if IsLiveItem(m.curItem) or m.uaTry >= 2 then return
    if m.video.state <> "playing" then return
    if m.uaPlayingFromPos < 0 then m.uaPlayingFromPos = m.seekRecoveryPos
    if m.uaAttemptClock.TotalMilliseconds() < 20000 then return
    if m.seekRecoveryPos - m.uaPlayingFromPos < 5 then return
    m.uaSaved = true
    if m.activeUaIsVlc then
        if RegRead("play_ua") <> "vlc" then RegWrite("play_ua", "vlc")
    else
        if RegRead("play_ua") = "vlc" then RegDelete("play_ua")
    end if
    print "[DeltaTV][vod] User-Agent validado apos 20s: " + IIfUaLabel(m.activeUaIsVlc)
end sub

function IIfUaLabel(isVlc as Boolean) as String
    if isVlc then return "VLC"
    return "Mozilla"
end function

sub RememberLiveFormat()
    if m.cands = invalid then return
    if m.cands.count() < 2 then return
    key = m.cands[m.candIdx].key
    if RegRead("live_fmt") <> key then RegWrite("live_fmt", key)
end sub

sub closePlayer()
    m.gatewayRetryTimer.control = "stop"
    ResetNextEpisode()
    HideVodSeek()
    if m.fromMini and not m.mini then
        ' VOLTAR na tela cheia: volta para a miniatura SEM interromper o canal
        setLayout(true)
        m.top.closeRequest = true
        return
    end if
    SavePlaybackBookmark()
    m.bookmarkTimer.control = "stop"
    m.wd.control = "stop"
    m.video.control = "stop"
    m.video.content = invalid ' solta o ContentNode do ultimo canal
    m.top.closeRequest = true
end sub

' Navegacao propria para VOD: nao faz Video.seek durante a reproducao.
' A selecao acontece na barra, e OK reabre a MESMA URL via PlayStart.
sub HideVodSeek()
    m.seekActive = false
    if m.seekBox <> invalid then m.seekBox.visible = false
    if m.seekPreviewBox <> invalid then m.seekPreviewBox.visible = false
    m.thumbLastKey = ""
end sub


' Campos opcionais de miniatura presentes no item de filme/episodio.
' Somente URLs HTTP(S) fornecidas pelo detentor do conteudo sao utilizadas;
' a capa/poster NAO e considerada uma miniatura da cena.
function VodThumbUrl(item as Object, keys as Object) as String
    if type(item) <> "roAssociativeArray" then return ""
    for each keyName in keys
        value = item.LookupCI(keyName)
        if value <> invalid then
            txtValue = ToText(value)
            txtLower = LCase(txtValue)
            if Left(txtLower, 8) = "https://" or Left(txtLower, 7) = "http://" then return txtValue
        end if
    end for
    return ""
end function

sub ConfigureVodThumbnails(d as Object, c as Object)
    m.thumbMode = ""
    m.thumbTemplate = ""
    m.thumbLastKey = ""
    m.thumbBifRequested = false
    m.seekPreviewBox.visible = false
    m.seekPreviewImage.uri = ""
    if IsLiveItem(d) then return

    ' BIF: incorporado ao ContentNode, com getNearestFrame/nearestFrame
    ' fornecidos pelo proprio firmware para a interface personalizada.
    hd = VodThumbUrl(d, ["HDBifUrl", "hdBifUrl", "bifHdUrl"])
    sd = VodThumbUrl(d, ["SDBifUrl", "sdBifUrl", "bifSdUrl"])
    fhd = VodThumbUrl(d, ["FHDBifUrl", "fhdBifUrl", "bifFhdUrl"])
    if hd <> "" then c.HDBifUrl = hd
    if sd <> "" then c.SDBifUrl = sd
    if fhd <> "" then c.FHDBifUrl = fhd

    ' JPEG: 000000.jpg, 000001.jpg ... em passos de 10 segundos,
    ' ou outro intervalo explicito no item.
    tmpl = VodThumbUrl(d, ["thumbnailUrlTemplate", "thumbTemplate", "seekThumbnailTemplate"])
    if tmpl <> "" and Instr(1, tmpl, "{index}") > 0 then
        m.thumbTemplate = tmpl
        m.thumbInterval = 10
        iv = d.LookupCI("thumbnailInterval")
        if iv <> invalid then
            value = Val(ToText(iv))
            if value >= 1 and value <= 300 then m.thumbInterval = Int(value)
        end if
    end if
    if (hd <> "" or sd <> "" or fhd <> "") and m.bifNode <> invalid then
        m.thumbMode = "bif"
    else if m.thumbTemplate <> "" then
        m.thumbMode = "jpeg"
    end if
    print "[DeltaTV][thumb] fonte=" + m.thumbMode + " intervalo=" + ToText(m.thumbInterval) + "s"
end sub

' Cada quadro no servidor representa o instante index * intervalo.
function ThumbIndexText(indexValue as Integer) as String
    result = indexValue.toStr()
    while Len(result) < 6
        result = "0" + result
    end while
    return result
end function

sub DrawVodSeekPreview()
    if not m.seekActive or m.thumbMode = "" then
        m.seekPreviewBox.visible = false
        return
    end if
    ' Posiciona a miniatura acima da posicao do cursor e limita-a a tela.
    total = VodSeekDuration()
    px = 496
    if total > 0 then px = 120 + 21 + Int(998 * m.seekTarget / total) - 152
    if px < 18 then px = 18
    if px > 958 then px = 958
    m.seekPreviewBox.translation = [px, 342]
    m.seekPreviewTime.text = ResumeClock(m.seekTarget)
    m.seekPreviewBox.visible = true

    if m.thumbMode = "bif" then
        if m.bifNode = invalid then return
        keyValue = ToText(Int(m.seekTarget))
        if keyValue <> m.thumbLastKey then
            m.thumbLastKey = keyValue
            m.seekPreviewImage.uri = ""
            m.seekPreviewStatus.text = "Buscando cena..."
            m.seekPreviewStatus.visible = true
            m.bifNode.getNearestFrame = Int(m.seekTarget)
            m.thumbBifRequested = true
        end if
    else if m.thumbMode = "jpeg" then
        indexValue = Int(m.seekTarget / m.thumbInterval)
        keyValue = indexValue.toStr()
        if keyValue <> m.thumbLastKey then
            m.thumbLastKey = keyValue
            m.seekPreviewStatus.text = "Carregando cena..."
            m.seekPreviewStatus.visible = true
            m.seekPreviewImage.uri = m.thumbTemplate.Replace("{index}", ThumbIndexText(indexValue))
        end if
    end if
end sub

sub onSeekBifFrame()
    if not m.seekActive or m.thumbMode <> "bif" then return
    if m.bifNode = invalid then return
    frameUri = ToText(m.bifNode.nearestFrame)
    if Left(frameUri, 9) <> "memory://" then return
    m.seekPreviewImage.uri = frameUri
    m.seekPreviewStatus.visible = false
    print "[DeltaTV][thumb] BIF quadro encontrado em " + ToText(Int(m.seekTarget)) + "s"
end sub

sub onSeekPreviewLoad()
    if not m.seekActive or m.thumbMode = "" then return
    st = m.seekPreviewImage.loadStatus
    if st = "ready" then
        m.seekPreviewStatus.visible = false
    else if st = "failed" then
        m.seekPreviewStatus.text = "Miniatura indisponivel"
        m.seekPreviewStatus.visible = true
        print "[DeltaTV][thumb] falha ao carregar quadro (modo=" + m.thumbMode + ")"
    end if
end sub

function VodSeekDuration() as Float
    d = m.video.duration
    if d = invalid then return 0.0
    if d <= 0 then return 0.0
    return d
end function

function VodSeekCurrent() as Float
    p = m.seekRecoveryPos
    if m.vodPositionReady then
        if m.video.state = "playing" or m.video.state = "paused" then
            p = m.video.position
        end if
    end if
    if p < 0 then p = 0.0
    return p
end function

sub DrawVodSeek()
    if not m.seekActive then return
    total = VodSeekDuration()
    selectedText = ResumeClock(m.seekTarget)
    if total > 0 then
        m.seekCaption.text = "Ir para " + selectedText + "   /   " + ResumeClock(total)
        frac = m.seekTarget / total
        curFrac = VodSeekCurrent() / total
        if frac < 0 then frac = 0
        if frac > 1 then frac = 1
        if curFrac < 0 then curFrac = 0
        if curFrac > 1 then curFrac = 1
        m.seekFill.width = Int(frac * 998)
        m.seekCurrentMarker.translation = [21 + Int(curFrac * 998), 75]
        m.seekCurrentMarker.visible = true
    else
        m.seekCaption.text = "Ir para " + selectedText
        m.seekFill.width = 0
        m.seekCurrentMarker.visible = false
    end if
    m.seekBox.visible = true
    DrawVodSeekPreview()
end sub

sub AdjustVodSeek(delta as Float)
    if not m.seekActive then
        m.seekActive = true
        m.seekTarget = VodSeekCurrent()
    end if
    m.seekTarget = m.seekTarget + delta
    if m.seekTarget < 0 then m.seekTarget = 0.0
    total = VodSeekDuration()
    if total > 0 and m.seekTarget > total - 2 then
        m.seekTarget = total - 2
        if m.seekTarget < 0 then m.seekTarget = 0.0
    end if
    print "[DeltaTV][vod] cursor alvo=" + ToText(Int(m.seekTarget)) + "s duracao=" + ToText(Int(total)) + "s"
    DrawVodSeek()
end sub

' Reinicia usando o mesmo metodo de "Continuar de onde parou".
' Nao salva o alvo no registro ate a reproducao REALMENTE avancar.
sub RestartVodAt(target as Float)
    if m.curItem = invalid or IsLiveItem(m.curItem) then return
    m.nextEpisodeBox.visible = false
    m.nextOffered = false
    if m.curUrl = "" then return
    if target < 0 then target = 0.0
    total = VodSeekDuration()
    if total > 0 and target > total - 2 then
        target = total - 2
        if target < 0 then target = 0.0
    end if
    url = m.curUrl
    fmt = m.curFmt
    d = m.curItem
    oldPos = VodSeekCurrent()
    HideVodSeek()
    m.bookmarkTimer.control = "stop"
    m.seekRecoveryPos = target
    m.vodPositionReady = false
    m.uaTry = 0
    m.video.control = "stop"
    m.errorBox.visible = false
    m.loading.text = "Abrindo em " + ResumeClock(target) + "..."
    m.loading.visible = true
    print "[DeltaTV][vod] reinicio por cursor: de=" + ToText(Int(oldPos)) + "s para=" + ToText(Int(target)) + "s via PlayStart"
    playContent(d, url, fmt)
end sub

sub ConfirmVodSeek()
    if not m.seekActive then return
    target = m.seekTarget
    current = VodSeekCurrent()
    HideVodSeek()
    if Abs(target - current) < 2 then return
    RestartVodAt(target)
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if m.resumeDialogActive then
        if key = "up" or key = "down" then
            if key = "up" then m.resumeChoice = 0
            if key = "down" then m.resumeChoice = 1
            DrawResumeChoice()
            return true
        else if key = "OK" then
            ConfirmResumeChoice()
            return true
        else if key = "back" then
            CancelResumeChoice()
            return true
        end if
        return true
    end if
    if m.nextEpisodeBox.visible then
        if key = "OK" then
            PlayNextEpisode()
            return true
        else if key = "back" then
            DismissNextEpisode()
            if m.video.state = "finished" then closePlayer()
            return true
        else if m.video.state = "finished" then
            return true
        else if key = "left" or key = "right" or key = "up" or key = "down" or key = "fastforward" or key = "rewind" or key = "replay" then
            ' Seek apenas oculta o cartao; VOLTAR e a unica forma de cancelar a sequencia.
            m.nextEpisodeBox.visible = false
            m.nextOffered = false
        end if
    end if
    if m.curItem <> invalid and not IsLiveItem(m.curItem) and not m.mini then
        ' Instant Replay: tecla dedicada do Roku (seta circular).
        ' Volta 15 s da posicao REAL reproduzida, sem depender do cursor
        ' de 30 s/5 min nem do seek nativo, que causava HTTP 406.
        if key = "replay" then
            if m.vodPositionReady and (m.video.state = "playing" or m.video.state = "paused") then
                currentPos = VodSeekCurrent()
                replayTarget = currentPos - 15.0
                if replayTarget < 0 then replayTarget = 0.0
                print "[DeltaTV][vod] instant replay: de=" + ToText(Int(currentPos)) + "s para=" + ToText(Int(replayTarget)) + "s (-15s, via PlayStart)"
                RestartVodAt(replayTarget)
            else
                print "[DeltaTV][vod] instant replay ignorado: video ainda nao esta pronto"
            end if
            return true
        else if key = "right" then
            AdjustVodSeek(30.0)
            return true
        else if key = "left" then
            AdjustVodSeek(-30.0)
            return true
        else if key = "up" or key = "fastforward" then
            AdjustVodSeek(300.0)
            return true
        else if key = "down" or key = "rewind" then
            AdjustVodSeek(-300.0)
            return true
        else if key = "OK" then
            if m.seekActive then
                ConfirmVodSeek()
            else
                m.seekActive = true
                m.seekTarget = VodSeekCurrent()
                DrawVodSeek()
            end if
            return true
        else if key = "play" or key = "playonly" then
            if m.seekActive then
                ConfirmVodSeek()
            else if m.video.state = "playing" then
                m.video.control = "pause"
            else if m.video.state = "paused" then
                m.video.control = "resume"
            end if
            return true
        else if key = "pause" then
            if m.video.state = "playing" then m.video.control = "pause"
            return true
        else if key = "back" and m.seekActive then
            HideVodSeek()
            return true
        end if
    end if
    if key = "back" then
        closePlayer()
        return true
    end if
    return false
end function

' ---- Registro do progresso VOD (ID estavel do filme/episodio, nao do provedor).
sub SavePlaybackBookmark()
    if m.curItem = invalid then return
    bookmarkId = VodBookmarkKey(m.curItem)
    if bookmarkId = "" then return
    stateValue = m.video.state
    if stateValue <> "playing" and stateValue <> "paused" and stateValue <> "buffering" and stateValue <> "error" then return
    if not m.vodPositionReady then return
    playbackSeconds = m.seekRecoveryPos
    ' A serie deve lembrar o episodio mesmo se o usuario sair antes dos 10s.
    VodWriteSeriesState(m.curItem, false, playbackSeconds)
    if playbackSeconds < 10 then return
    RegWrite(bookmarkId, Str(playbackSeconds).Trim())
end sub

sub onBookmarkTick()
    SavePlaybackBookmark()
end sub

' O contador usa o tempo real do video: pausa/buffering nao consomem segundos.
' Uma consulta por episodio usa o cache Xtream; nunca bloqueia a interface.
sub ResetNextEpisode()
    m.nextRequestId = m.nextRequestId + 1
    if m.nextEpisodeTask <> invalid then
        m.nextEpisodeTask.unobserveField("result")
        m.nextEpisodeTask.control = "stop"
        m.nextEpisodeTask = invalid
    end if
    m.nextEpisode = invalid
    m.nextEpisodeBox.visible = false
    m.nextDismissed = false
    m.nextOffered = false
    m.nextTransitioning = false
    m.nextEndWait = 0
    m.nextEndCountdown = -1
    m.nextPoll.control = "stop"
end sub

sub LoadNextEpisode(d as Object)
    if IsLiveItem(d) or ToText(d.seriesEpisodeId) = "" then return
    m.nextPoll.control = "start"
    ' O detalhe ja conhece o seguinte na pagina atual: nao depende de outra consulta.
    if type(d.nextEpisode) = "roAssociativeArray" then m.nextEpisode = d.nextEpisode
    sid = ToText(d.seriesId)
    ref = ToText(d.seriesRef)
    if sid = "" and Left(ref, 3) = "me-" then sid = Mid(ref, 4)
    if sid = "" or ref = "" then return
    m.nextEpisodeTask = CreateObject("roSGNode", "NextEpisodeTask")
    m.nextEpisodeTask.observeField("result", "onNextEpisodeLoaded")
    m.nextEpisodeTask.request = { requestId: m.nextRequestId, seriesId: sid, seriesRef: ref, episodeId: ToText(d.seriesEpisodeId) }
    m.nextEpisodeTask.control = "run"
end sub

sub onNextEpisodeLoaded(event as Object)
    result = event.getData()
    if result = invalid then return
    if result.requestId <> m.nextRequestId then return
    if not m.top.visible then return
    m.nextEpisodeTask.unobserveField("result")
    m.nextEpisodeTask = invalid
    if result.ok = true then
        m.nextEpisode = result.item
        print "[SeriesNext] proximo pronto: T" + ToText(m.nextEpisode.seriesSeason) + " E" + ToText(m.nextEpisode.seriesEpisodeNumber)
    else
        print "[SeriesNext] consulta: " + ToText(result.reason)
    end if
    if m.video.state = "finished" then
        if m.nextEpisode <> invalid and not m.nextDismissed then
            ShowNextEpisodeAtEnd()
        else
            closePlayer()
        end if
    else
        UpdateNextEpisode()
    end if
end sub

sub DismissNextEpisode()
    m.nextDismissed = true
    m.nextEpisodeBox.visible = false
end sub

sub UpdateNextEpisode()
    m.nextEpisodeBox.visible = false
    if m.nextEpisode = invalid or m.nextDismissed or m.nextTransitioning then return
    if not m.top.visible or m.mini or m.resumeDialogActive or m.seekActive then return
    if m.curItem = invalid or IsLiveItem(m.curItem) then return
    if not m.vodPositionReady then return
    state = m.video.state
    if state <> "playing" and state <> "paused" then return
    total = m.video.duration
    if total = invalid or total <= 0 then return
    remaining = total - m.seekRecoveryPos
    if remaining > 30 then
        m.nextOffered = false
        return
    end if
    seconds = Int(remaining)
    if remaining > seconds then seconds = seconds + 1
    if seconds < 0 then seconds = 0
    m.nextOffered = true
    m.nextEpisodeBox.visible = true
    m.top.findNode("nextEpisodeTitle").text = "A seguir: T" + ToText(m.nextEpisode.seriesSeason) + " • E" + ToText(m.nextEpisode.seriesEpisodeNumber)
    m.top.findNode("nextEpisodeButton").text = "Próximo · " + ToText(seconds) + "s"
    m.top.findNode("nextEpisodeProgress").width = Int(398 * seconds / 30)
    if remaining <= 0 and state = "playing" then PlayNextEpisode()
end sub

sub PlayNextEpisode()
    if m.nextEpisode = invalid or m.nextTransitioning then return
    if not m.top.visible or m.nextDismissed then return
    m.nextTransitioning = true
    nextItem = m.nextEpisode
    m.nextEpisodeBox.visible = false
    ' Salva o episodio atual como concluido antes da troca; o proximo inicia do zero.
    VodWriteSeriesState(m.curItem, true)
    VodClearPosition(m.curItem)
    m.bookmarkTimer.control = "stop"
    m.video.control = "stop"
    m.vodPositionReady = false
    m.seekRecoveryPos = 0.0
    m.top.item = nextItem
    m.skipResumePromptOnce = true
    m.restartFromBeginning = true
    beginPlayback()
end sub

sub ShowNextEpisodeAtEnd()
    if m.nextDismissed or m.nextEpisode = invalid then return
    m.loading.visible = false
    m.nextEndWait = 0
    m.nextEndCountdown = 10
    m.nextOffered = true
    m.nextEpisodeBox.visible = true
    m.top.findNode("nextEpisodeTitle").text = "A seguir: T" + ToText(m.nextEpisode.seriesSeason) + " • E" + ToText(m.nextEpisode.seriesEpisodeNumber)
    m.top.findNode("nextEpisodeButton").text = "Próximo · 10s"
    m.top.findNode("nextEpisodeProgress").width = 398
    m.nextPoll.control = "start"
end sub

sub onNextEpisodeTick()
    if not m.top.visible then
        ResetNextEpisode()
        return
    end if
    if m.nextDismissed then
        m.nextPoll.control = "stop"
        if m.video.state = "finished" then closePlayer()
        return
    end if
    if m.video.state = "finished" then
        if m.nextEndWait > 0 then
            m.nextEndWait = m.nextEndWait - 1
            if m.nextEndWait = 0 then closePlayer()
        else if m.nextEndCountdown >= 0 then
            m.nextEndCountdown = m.nextEndCountdown - 1
            if m.nextEndCountdown <= 0 then
                PlayNextEpisode()
            else
                m.top.findNode("nextEpisodeButton").text = "Próximo · " + ToText(m.nextEndCountdown) + "s"
                m.top.findNode("nextEpisodeProgress").width = Int(398 * m.nextEndCountdown / 10)
            end if
        end if
    else
        UpdateNextEpisode()
    end if
end sub
