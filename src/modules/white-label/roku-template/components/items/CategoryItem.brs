sub init()
    m.pill = m.top.findNode("pill")
    m.label = m.top.findNode("label")
    m.obs = invalid
end sub

sub redraw()
    w = m.top.width
    h = m.top.height
    c = m.top.itemContent
    if c = invalid or w = 0 or h = 0 then return

    ' observa mudancas de "isSel" no conteudo atual
    if m.obs = invalid or not m.obs.isSameNode(c) then
        m.obs = c
        c.observeFieldScoped("isSel", "redraw")
    end if

    t = Theme()
    focused = m.top.itemHasFocus and m.top.listHasFocus
    sel = false
    if c.isSel <> invalid then sel = c.isSel

    m.pill.width = w : m.pill.height = h
    m.label.translation = [18, 0]

    if focused then
        m.pill.visible = true
        m.pill.blendColor = t.accent
        SetEmojiText(m.label, c.title, 18, true, t.text, w - 30, h)
    else if sel then
        m.pill.visible = true
        m.pill.blendColor = t.accentSoft
        SetEmojiText(m.label, c.title, 18, true, t.text, w - 30, h)
    else
        m.pill.visible = false
        SetEmojiText(m.label, c.title, 18, false, t.textDim, w - 30, h)
    end if
end sub
