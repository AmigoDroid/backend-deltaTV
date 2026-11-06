sub init()
    m.bg = m.top.findNode("bg")
    m.num = m.top.findNode("num")
    m.logoBg = m.top.findNode("logoBg")
    m.logo = m.top.findNode("logo")
    m.logo.observeField("loadStatus", "onLogoStatus")
    m.logoUrl = ""
    m.name = m.top.findNode("name")
    m.now = m.top.findNode("now")
    m.fav = m.top.findNode("fav")
end sub

sub redraw()
    w = m.top.width
    h = m.top.height
    c = m.top.itemContent
    if c = invalid or w = 0 or h = 0 then return
    t = Theme()

    m.bg.width = w : m.bg.height = h
    if m.top.itemHasFocus and m.top.listHasFocus then
        m.bg.blendColor = t.accent
    else if m.top.itemHasFocus then
        m.bg.blendColor = t.accentSoft
    else
        m.bg.blendColor = t.card
    end if

    ' logo do canal (quadro 64x(h-12)); enquanto nao carrega, ou se nao houver logo, mostra o numero
    lw = 64
    lh = h - 12
    m.logoBg.translation = [6, 6] : m.logoBg.width = lw : m.logoBg.height = lh
    m.logo.translation = [10, 8] : m.logo.width = lw - 8 : m.logo.height = lh - 4
    url = c.HDPosterUrl
    if url <> m.logoUrl then
        m.logoUrl = url
        if url <> "" then
            m.logo.loadWidth = lw - 8
            m.logo.loadHeight = lh - 4
            m.logo.uri = url
        else
            m.logo.uri = ""
        end if
    end if
    showLogo(url <> "" and m.logo.loadStatus = "ready")

    m.num.translation = [6, 0] : m.num.width = lw : m.num.height = h
    m.num.text = c.chNumber
    Txt(m.num, 20, true, t.accentLight)
    if m.top.itemHasFocus and m.top.listHasFocus then m.num.color = t.text

    m.name.translation = [80, 8]
    SetEmojiText(m.name, c.title, 18, true, t.text, w - 118, 26)

    m.now.translation = [80, 34] : m.now.width = w - 118 : m.now.height = 22
    m.now.text = EmojiStrip(c.nowTitle)
    Txt(m.now, 14, false, t.textDim)

    m.fav.translation = [w - 30, (h - 18) / 2]
    m.fav.visible = (c.isFav = true)
end sub

sub showLogo(on as Boolean)
    m.logo.visible = on
    m.logoBg.visible = on
    m.num.visible = not on
end sub

sub onLogoStatus()
    showLogo(m.logoUrl <> "" and m.logo.loadStatus = "ready")
end sub
