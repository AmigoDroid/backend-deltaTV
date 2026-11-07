sub init()
    t = Theme()
    m.pill = m.top.findNode("pill")
    m.cursor = 0

    a = m.top.findNode("brandA")
    b = m.top.findNode("brandB")
    Txt(a, 32, true, t.text)
    Txt(b, 32, true, "0x8A6CFFFF")
    b.translation = [186, 28]
    Txt(m.top.findNode("macTitle"), 12, true, t.accentLight)
    Txt(m.top.findNode("macValue"), 14, false, t.textDim)
    Txt(m.top.findNode("foot"), 11, false, t.textMute)

    names = ["Início", "TV ao vivo", "Filmes", "Séries", "Favoritos", "Configurações"]
    icons = ["ic_home", "ic_tv", "ic_film", "ic_series", "ic_heart", "ic_gear"]
    m.icons = []
    m.labels = []
    for i = 0 to 5
        y = 116 + i * 57
        ic = CreateObject("roSGNode", "Poster")
        ic.uri = "pkg:/images/" + icons[i] + ".png"
        ic.translation = [36, y + 11]
        ic.width = 26 : ic.height = 26
        m.top.appendChild(ic)
        m.icons.push(ic)

        lb = CreateObject("roSGNode", "Label")
        lb.text = names[i]
        lb.translation = [80, y]
        lb.width = 160 : lb.height = 49
        lb.vertAlign = "center"
        m.top.appendChild(lb)
        m.labels.push(lb)
    end for

    m.top.observeField("focusedChild", "refresh")
    onAppearance()
    refresh()
end sub

sub onMac()
    m.top.findNode("macValue").text = m.top.macText
end sub

sub onVersion()
    config = WLAppearance()
    brand = "Delta TV"
    if config <> invalid then
        if ToText(config.brandName) <> "" then brand = ToText(config.brandName)
    end if
    m.top.findNode("foot").text = brand + " " + m.top.versionText + "  •  Não vendemos conteúdo"
end sub

sub onAppearance()
    t = Theme()
    m.top.findNode("sideBg").color = t.panel
    m.top.findNode("sideLine").color = t.bg
    m.top.findNode("footLine").color = t.bg
    config = WLAppearance()
    rail = false
    if config <> invalid then
        rail = (config.template = "minimal" or config.template = "mosaic")
    end if
    m.railMode = rail
    if rail then
        m.top.findNode("sideBg").width = 148
        m.top.findNode("sideLine").translation = [147, 0]
        m.pill.width = 112
        m.top.findNode("brandLogo").translation = [52, 28]
    else
        m.top.findNode("sideBg").width = 260
        m.top.findNode("sideLine").translation = [259, 0]
        m.pill.width = 228
        m.top.findNode("brandLogo").translation = [26, 26]
    end if
    for i = 0 to m.labels.count() - 1
        m.labels[i].visible = not rail
        if rail then
            m.icons[i].translation = [60, 127 + i * 57]
        else
            m.icons[i].translation = [36, 127 + i * 57]
        end if
    end for
    m.top.findNode("macTitle").visible = not rail
    m.top.findNode("macValue").visible = not rail
    m.top.findNode("footLine").visible = not rail
    m.top.findNode("foot").visible = not rail
    if config <> invalid then
        brand = ToText(config.brandName)
        if brand <> "" then
            m.top.findNode("brandA").text = brand
            m.top.findNode("brandB").text = ""
        end if
        logo = WLImageUri(config.logoUrl)
        if logo = "" and DeltaWhiteLabelMode() then logo = "pkg:/images/logo.png"
        m.top.findNode("brandLogo").visible = (logo <> "")
        if logo <> "" then
            m.top.findNode("brandLogo").uri = logo
            m.top.findNode("brandA").translation = [80, 28]
        else
            m.top.findNode("brandA").translation = [26, 28]
        end if
    end if
    m.top.findNode("brandA").visible = not rail
    m.top.findNode("brandB").visible = not rail
    Txt(m.top.findNode("brandA"), 24, true, t.text)
    Txt(m.top.findNode("brandB"), 24, true, t.accentLight)
    Txt(m.top.findNode("macTitle"), 12, true, t.accentLight)
    Txt(m.top.findNode("macValue"), 14, false, t.textDim)
    Txt(m.top.findNode("foot"), 11, false, t.textMute)
    onVersion()
    refresh()
end sub

sub focusSidebar()
    m.cursor = m.top.activeIndex
    m.top.setFocus(true)
    refresh()
end sub

sub refresh()
    t = Theme()
    focused = m.top.isInFocusChain()
    idx = m.top.activeIndex
    if focused then idx = m.cursor

    if m.railMode = true then
        m.pill.translation = [18, 116 + idx * 57]
    else
        m.pill.translation = [16, 116 + idx * 57]
    end if
    if focused then
        m.pill.blendColor = t.accent
    else
        m.pill.blendColor = t.accentSoft
    end if

    for i = 0 to 5
        if i = idx then
            Txt(m.labels[i], 20, true, t.text)
            m.icons[i].blendColor = t.text
        else if i = m.top.activeIndex then
            Txt(m.labels[i], 20, true, t.accentLight)
            m.icons[i].blendColor = t.accentLight
        else
            Txt(m.labels[i], 20, false, t.textDim)
            m.icons[i].blendColor = t.textDim
        end if
    end for
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false

    if key = "up" then
        if m.cursor > 0 then m.cursor = m.cursor - 1
        refresh()
        return true
    else if key = "down" then
        if m.cursor < 5 then m.cursor = m.cursor + 1
        refresh()
        return true
    else if key = "OK" or key = "right" then
        m.top.itemSelected = m.cursor
        return true
    end if
    return false
end function
