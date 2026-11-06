sub init()
    m.bg = m.top.findNode("bg")
    m.num = m.top.findNode("num")
    m.name = m.top.findNode("name")
    m.desc = m.top.findNode("desc")
    m.dur = m.top.findNode("dur")
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
    else
        m.bg.blendColor = t.card
    end if

    m.num.translation = [10, 0] : m.num.width = 44 : m.num.height = h
    m.num.text = c.epNumber
    Txt(m.num, 22, true, t.accentLight)
    if m.top.itemHasFocus and m.top.listHasFocus then m.num.color = t.text

    m.name.translation = [66, 10]
    SetEmojiText(m.name, c.title, 19, true, t.text, w - 200, 26)

    m.desc.translation = [66, 38] : m.desc.width = w - 200 : m.desc.height = 24
    m.desc.text = EmojiStrip(c.description)
    m.desc.ellipsizeOnBoundary = true
    Txt(m.desc, 14, false, t.textDim)

    m.dur.translation = [w - 130, 0] : m.dur.width = 114 : m.dur.height = h
    m.dur.text = c.durationText
    Txt(m.dur, 15, false, t.textDim)
end sub
