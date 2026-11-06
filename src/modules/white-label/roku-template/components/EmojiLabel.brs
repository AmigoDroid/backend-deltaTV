' Use SetEmojiText(node, texto, tamanho, negrito, cor, largura, altura) (source/Emoji.brs).
sub init()
    m.labels = []
    m.posters = []
end sub

function ElLabel(k as Integer) as Object
    while m.labels.count() <= k
        lb = CreateObject("roSGNode", "Label")
        lb.vertAlign = "center"
        m.top.appendChild(lb)
        m.labels.push(lb)
    end while
    return m.labels[k]
end function

function ElPoster(k as Integer) as Object
    while m.posters.count() <= k
        p = CreateObject("roSGNode", "Poster")
        m.top.appendChild(p)
        m.posters.push(p)
    end while
    return m.posters[k]
end function

sub ElHideFrom(labelFrom as Integer, posterFrom as Integer)
    for i = labelFrom to m.labels.count() - 1
        m.labels[i].visible = false
    end for
    for i = posterFrom to m.posters.count() - 1
        m.posters[i].visible = false
    end for
end sub

sub update()
    text = m.top.text
    size = m.top.fontSize
    bold = m.top.bold
    color = m.top.color
    limit = Int(m.top.width)
    h = Int(m.top.height)
    if h <= 0 then h = size + 8

    segs = EmojiParse(text)
    hasEmoji = false
    for each s in segs
        if s.kind = "emoji" then hasEmoji = true
    end for

    ' sem emoji: um unico Label, igual ao comportamento antigo
    if not hasEmoji then
        lb = ElLabel(0)
        lb.font = GetFont(size, bold)
        lb.color = color
        lb.text = EmojiPlain(segs)
        lb.translation = [0, 0]
        lb.width = limit
        lb.height = h
        lb.visible = true
        ElHideFrom(1, 0)
        return
    end if

    es = Int(size * 1.2)
    if es < 16 then es = 16
    gap = Int(size * 0.3)
    if gap < 4 then gap = 4
    x = 0
    li = 0
    pIdx = 0
    overflow = false
    for each s in segs
        if overflow then exit for
        if s.kind = "emoji" then
            if limit > 0 and x + es > limit then
                overflow = true
            else
                p = ElPoster(pIdx)
                p.uri = "pkg:/images/emoji/" + s.key + ".png"
                p.width = es
                p.height = es
                p.translation = [x, Int((h - es) / 2) + 1]
                p.visible = true
                pIdx = pIdx + 1
                x = x + es + 2
            end if
        else
            t = s.text
            if Left(t, 1) = " " and x > 0 then x = x + gap
            trailing = (Right(t, 1) = " ")
            t = EmojiTrim(t)
            if t <> "" then
                lb = ElLabel(li)
                lb.font = GetFont(size, bold)
                lb.color = color
                lb.text = t
                lb.width = 0
                lb.height = 0
                r = lb.boundingRect()
                tw = Int(r.width) + 2
                if r.width <= 0 then tw = Int(Len(t) * size * 0.55)
                avail = tw
                if limit > 0 and x + tw > limit then
                    avail = limit - x
                    overflow = true
                end if
                if avail > 4 then
                    lb.translation = [x, 0]
                    lb.width = avail
                    lb.height = h
                    lb.visible = true
                    li = li + 1
                    x = x + avail
                end if
            end if
            if trailing then x = x + gap
        end if
    end for
    ElHideFrom(li, pIdx)
end sub
