sub init()
    m.bg = m.top.findNode("bg")
    m.icon = m.top.findNode("icon")
    m.art = m.top.findNode("art")
    m.shade = m.top.findNode("shade")
    m.title = m.top.findNode("title")
    m.mask = m.top.findNode("mask")
    m.ring = m.top.findNode("ring")
    Txt(m.title, 15, true, "0xFFFFFFFF")
    m.art.observeField("loadStatus", "onArtStatus")
    m.artUrl = ""
end sub

sub redraw()
    w = m.top.width
    h = m.top.height
    c = m.top.itemContent
    if c = invalid or w = 0 or h = 0 then return

    m.bg.width = w : m.bg.height = h
    m.art.width = w : m.art.height = h
    m.mask.width = w : m.mask.height = h
    m.ring.width = w : m.ring.height = h
    m.shade.translation = [0, h * 0.45]
    m.shade.width = w : m.shade.height = h * 0.55
    m.title.translation = [10, 6]
    m.title.width = w - 20 : m.title.height = h - 14

    m.bg.blendColor = c.accent
    m.title.text = EmojiStrip(c.title)

    ic = "ic_film"
    if c.kind = "series" then ic = "ic_series"
    if c.kind = "channel" then ic = "ic_tv"
    m.icon.uri = "pkg:/images/" + ic + ".png"
    sz = w * 0.4
    m.icon.width = sz : m.icon.height = sz
    m.icon.translation = [(w - sz) / 2, h * 0.2]

    url = c.HDPosterUrl
    if url <> m.artUrl then
        m.artUrl = url
        ' tvg-logo costuma ser PNG enorme: decodifica no tamanho exibido (loadWidth/Height ANTES do uri)
        m.art.loadWidth = w
        m.art.loadHeight = h
        m.art.uri = url
        showPlaceholder(true)
    end if

    m.ring.visible = m.top.itemHasFocus and (m.top.rowListHasFocus or m.top.gridHasFocus)
end sub

sub showPlaceholder(on as Boolean)
    m.icon.visible = on
    m.shade.visible = on
    m.title.visible = on
end sub

sub onArtStatus()
    showPlaceholder(m.art.loadStatus <> "ready")
end sub
