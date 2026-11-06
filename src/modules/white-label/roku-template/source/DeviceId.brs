' ============================================================
' Delta TV - Identidade virtual do aparelho
'
' O MAC virtual NAO e aleatorio: ele e derivado do ID exclusivo
' do aparelho com SHA-256, entao o mesmo Roku sempre gera o
' mesmo MAC (sem precisar guardar nada) e dois aparelhos
' diferentes dificilmente colidem.
'
'   MAC  = 6 primeiros bytes de SHA-256("DELTATV|MAC|v1|" + ID)
'          com o 1o byte ajustado: bit 0x02 ligado (endereco
'          administrado localmente = "virtual") e bit 0x01
'          desligado (unicast). Resultado sempre no formato
'          02/06/0A/0E/12/.../FE : XX : XX : XX : XX : XX
'   CODE = codigo curto de suporte, ex: DLT-7K3Q-92XM
' ============================================================

' ID bruto do aparelho (nunca vazio)
function DeltaGetDeviceSeed() as String
    di = CreateObject("roDeviceInfo")
    seed = ""

    id = di.GetChannelClientId()
    if id <> invalid then seed = id

    ' Ultimo recurso: gera uma semente uma unica vez e guarda no registro
    if seed = "" then
        seed = RegRead("fallback_seed")
        if seed = "" then
            dt = CreateObject("roDateTime")
            secs = dt.AsSeconds()
            rv = Rnd(2147483647)
            seed = "FB" + secs.toStr() + rv.toStr()
            RegWrite("fallback_seed", seed)
        end if
    end if

    return seed
end function

' SHA-256 em hexadecimal maiusculo (64 caracteres)
function DeltaSha256Hex(text as String) as String
    digest = CreateObject("roEVPDigest")
    digest.Setup("sha256")
    ba = CreateObject("roByteArray")
    ba.FromAsciiString(text)
    return UCase(digest.Process(ba))
end function

' Byte (0-255) -> "00".."FF"
function DeltaByteHex(value as Integer) as String
    digitos = "0123456789ABCDEF"
    value = value mod 256
    return Mid(digitos, Int(value / 16) + 1, 1) + Mid(digitos, (value mod 16) + 1, 1)
end function

' MAC virtual deterministico a partir da semente
function DeltaMacFromSeed(seed as String) as String
    hex = DeltaSha256Hex("DELTATV|MAC|v1|" + seed)

    b0 = Int(Val(Mid(hex, 1, 2), 16))
    b0 = (b0 or 2) and 254

    mac = DeltaByteHex(b0)
    for i = 1 to 5
        mac = mac + ":" + Mid(hex, i * 2 + 1, 2)
    end for
    return mac
end function

' Codigo curto de suporte (sem caracteres ambiguos como 0/O, 1/I)
function DeltaCodeFromSeed(seed as String) as String
    hex = DeltaSha256Hex("DELTATV|CODE|v1|" + seed)
    alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    code = ""
    for i = 0 to 7
        v = Int(Val(Mid(hex, i * 2 + 1, 2), 16)) mod 32
        code = code + Mid(alfabeto, v + 1, 1)
    end for
    return "DLT-" + Left(code, 4) + "-" + Right(code, 4)
end function

' Tudo junto: { seed, mac, macCompact, code, installationId }
function DeltaGetIdentity() as Object
    seed = DeltaGetDeviceSeed()
    mac = DeltaMacFromSeed(seed)
    compact = ""
    for each part in mac.Split(":")
        compact = compact + part
    end for
    return {
        seed: seed,
        mac: mac,
        macCompact: compact,
        code: DeltaCodeFromSeed(seed),
        installationId: "roku-" + compact
    }
end function
