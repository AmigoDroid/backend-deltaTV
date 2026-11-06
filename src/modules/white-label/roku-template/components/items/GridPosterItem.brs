' Celula da grade: capa (proporcao ~2:3) + titulo em ate 2 linhas embaixo.
sub init()
    m.bg = m.top.findNode("bg")
    m.icon = m.top.findNode("icon")
    m.art = m.top.findNode("art")
    m.mask = m.top.findNode("mask")
    m.ring = m.top.findNode("ring")
    m.fav = m.top.findNode("fav")
    m.title = m.top.findNode("title")
    m.art.observeField("loadStatus", "onArtStatus")
    m.artUrl = "(none)"
    m.titleText = "(none)"
    m.obs = invalid
    m.focusedNow = -1
end sub

sub redraw()
    w = m.top.width
    h = m.top.height
    c = m.top.itemContent
    if c = invalid or w = 0 or h = 0 then return

    ' observa mudancas de favorito no conteudo atual (atualiza o coracao na hora)
    if m.obs = invalid or not m.obs.isSameNode(c) then
        m.obs = c
        c.observeFieldScoped("isFav", "redraw")
    end if

    ph = h - 44 ' altura da capa; o resto e o titulo
    m.bg.width = w : m.bg.height = ph
    m.art.width = w : m.art.height = ph
    m.mask.width = w : m.mask.height = ph
    m.ring.width = w : m.ring.height = ph
    m.fav.translation = [w - 28, 8]

    sz = w * 0.4
    m.icon.width = sz : m.icon.height = sz
    m.icon.translation = [(w - sz) / 2, ph * 0.3]

    url = c.HDPosterUrl
    if url <> m.artUrl then
        m.artUrl = url
        ' decodifica no tamanho exibido (loadWidth/Height ANTES do uri): menos memoria e rolagem mais fluida
        m.art.loadWidth = w
        m.art.loadHeight = ph
        m.art.uri = url
        ic = "ic_film"
        if c.kind = "series" then ic = "ic_series"
        m.icon.uri = "pkg:/images/" + ic + ".png"
        m.icon.visible = true
    end if

    focused = (m.top.itemHasFocus and m.top.gridHasFocus)
    fstate = 0
    if focused then fstate = 1
    if m.focusedNow <> fstate then
        m.focusedNow = fstate
        m.ring.visible = focused
        if focused then
            Txt(m.title, 15, true, "0xFFFFFFFF")
        else
            Txt(m.title, 15, false, "0xC3C7D8FF")
        end if
    end if

    m.title.translation = [2, ph + 6]
    m.title.width = w - 4
    m.title.height = 38
    if c.title <> m.titleText then
        m.titleText = c.title
        m.title.text = EmojiStrip(c.title)
    end if

    m.fav.visible = (c.isFav = true)
end sub

sub onArtStatus()
    ' sem capa (ou falha ao baixar): mostra o icone no lugar
    m.icon.visible = (m.art.loadStatus <> "ready")
end sub
