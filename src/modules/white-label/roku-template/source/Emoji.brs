' ============================================================
' Delta TV - suporte a emoji
'
' A fonte do sistema do Roku nao desenha emoji colorido (sai quadrado/vazio). Aqui o texto e separado em
' trechos de texto e emojis; cada emoji vira uma imagem em pkg:/images/emoji/<chave>.png (ver EmojiLabel).
' Emoji sem imagem e removido (nunca aparece quadrado). Imagens: tools/gen_emoji.py.
' Requer: EmojiData.brs (EmojiKeyList).
' ============================================================

function EmojiHex(v as Integer) as String
    digits = "0123456789abcdef"
    if v <= 0 then return "0"
    out = ""
    while v > 0
        out = Mid(digits, (v mod 16) + 1, 1) + out
        v = v \ 16
    end while
    return out
end function

' Verificacao barata: so textos com algo na faixa de simbolos/emoji passam pelo parser completo.
function EmojiNeedsWork(text as String) as Boolean
    n = Len(text)
    for i = 1 to n
        c = Asc(Mid(text, i, 1))
        if c >= 8960 then
            if c <= 11263 or c >= 55296 then return true
        end if
        if c = 8419 then return true
    end for
    return false
end function

' Pontos de codigo (junta pares substitutos UTF-16, caso o JSON tenha chegado assim).
function EmojiCodePoints(text as String) as Object
    cps = []
    n = Len(text)
    i = 1
    while i <= n
        c = Asc(Mid(text, i, 1))
        if c >= 55296 and c <= 56319 and i < n then
            d = Asc(Mid(text, i + 1, 1))
            if d >= 56320 and d <= 57343 then
                c = 65536 + (c - 55296) * 1024 + (d - 56320)
                i = i + 1
            end if
        end if
        cps.push(c)
        i = i + 1
    end while
    return cps
end function

function EmojiIsRegional(c as Integer) as Boolean
    return c >= 127462 and c <= 127487
end function

function EmojiIsSkinTone(c as Integer) as Boolean
    return c >= 127995 and c <= 127999
end function

' Com certeza emoji/modificador: vira imagem ou e descartado.
function EmojiIsDefinite(c as Integer) as Boolean
    if c >= 126976 and c <= 129791 then return true
    if c >= 9728 and c <= 10175 then return true
    if c = 65039 or c = 65038 or c = 8205 or c = 8419 then return true
    if c >= 917536 and c <= 917631 then return true
    if c >= 55296 and c <= 57343 then return true
    return false
end function

' Pode ser simbolo comum de texto: so vira emoji se existir imagem para ele.
function EmojiIsAmbiguous(c as Integer) as Boolean
    if c >= 8960 and c <= 9215 then return true
    if c >= 9632 and c <= 9727 then return true
    if c >= 11008 and c <= 11263 then return true
    if c = 8252 or c = 8265 or c = 9410 then return true
    return false
end function

function EmojiKeyOf(seq as Object) as String
    key = ""
    for each cp in seq
        if key <> "" then key = key + "-"
        key = key + EmojiHex(cp)
    end for
    return key
end function

' -> [ { kind: "text", text }, { kind: "emoji", key, alt } ]
function EmojiParse(text as String) as Object
    segs = []
    if not EmojiNeedsWork(text) then
        if text <> "" then segs.push({ kind: "text", text: text })
        return segs
    end if

    known = EmojiKeyList()
    cps = EmojiCodePoints(text)
    n = cps.count()
    buf = ""
    i = 0
    while i < n
        c = cps[i]
        handled = false

        ' keycap: [0-9#*] [FE0F] 20E3
        if c = 35 or c = 42 or (c >= 48 and c <= 57) then
            j = i + 1
            if j < n then
                if cps[j] = 65039 then j = j + 1
            end if
            if j < n then
                if cps[j] = 8419 then
                    handled = true
                    key = EmojiHex(c) + "-20e3"
                    if Instr(1, known, "|" + key + "|") > 0 then
                        if buf <> "" then
                            segs.push({ kind: "text", text: buf })
                            buf = ""
                        end if
                        segs.push({ kind: "emoji", key: key, alt: Chr(c) })
                    else
                        buf = buf + Chr(c)
                    end if
                    i = j + 1
                end if
            end if
        end if

        if not handled then
            isEmo = EmojiIsDefinite(c)
            if not isEmo and EmojiIsAmbiguous(c) then
                if Instr(1, known, "|" + EmojiHex(c) + "|") > 0 then isEmo = true
            end if

            if isEmo then
                seq = [c]
                i = i + 1
                if EmojiIsRegional(c) and i < n then
                    if EmojiIsRegional(cps[i]) then
                        seq.push(cps[i])
                        i = i + 1
                    end if
                end if
                more = true
                while more and i < n
                    d = cps[i]
                    if d = 65039 or d = 65038 or EmojiIsSkinTone(d) or (d >= 917536 and d <= 917631) then
                        i = i + 1
                    else if d = 8205 and i + 1 < n then
                        e = cps[i + 1]
                        if EmojiIsDefinite(e) and e <> 65039 and e <> 65038 and e <> 8205 and e <> 8419 then
                            seq.push(8205)
                            seq.push(e)
                            i = i + 2
                        else
                            more = false
                        end if
                    else
                        more = false
                    end if
                end while

                key = EmojiKeyOf(seq)
                if Instr(1, known, "|" + key + "|") = 0 then
                    key = EmojiHex(seq[0])
                    if Instr(1, known, "|" + key + "|") = 0 then key = ""
                end if
                if key <> "" then
                    if buf <> "" then
                        segs.push({ kind: "text", text: buf })
                        buf = ""
                    end if
                    segs.push({ kind: "emoji", key: key, alt: "" })
                end if
            else
                buf = buf + Chr(c)
                i = i + 1
            end if
        end if
    end while
    if buf <> "" then segs.push({ kind: "text", text: buf })
    return segs
end function

' ---------- texto simples ----------
function EmojiTrim(s as String) as String
    first = 1
    last = Len(s)
    while first <= last and Mid(s, first, 1) = " "
        first = first + 1
    end while
    while last >= first and Mid(s, last, 1) = " "
        last = last - 1
    end while
    if last < first then return ""
    return Mid(s, first, last - first + 1)
end function

function EmojiCollapse(s as String) as String
    out = ""
    prevSpace = false
    for i = 1 to Len(s)
        ch = Mid(s, i, 1)
        if ch = " " then
            if not prevSpace then out = out + ch
            prevSpace = true
        else
            out = out + ch
            prevSpace = false
        end if
    end for
    return out
end function

' Texto dos trechos sem as imagens (emoji removido; keycap vira o digito).
function EmojiPlain(segs as Object) as String
    out = ""
    for each s in segs
        if s.kind = "text" then
            out = out + s.text
        else if s.alt <> "" then
            out = out + s.alt
        end if
    end for
    if segs.count() > 1 then out = EmojiTrim(EmojiCollapse(out))
    return out
end function

' Para Labels com varias linhas (descricoes, titulos sobre capas): remove os emojis.
function EmojiStrip(text as String) as String
    if not EmojiNeedsWork(text) then return text
    return EmojiPlain(EmojiParse(text))
end function

' Atalho para o componente EmojiLabel (uma linha, com emoji em imagem).
sub SetEmojiText(node as Object, text as String, size as Integer, bold as Boolean, color as String, w as Dynamic, h as Dynamic)
    if node = invalid then return
    node.setFields({ fontSize: size, bold: bold, color: color, width: w, height: h, text: text })
    node.callFunc("update")
end sub
