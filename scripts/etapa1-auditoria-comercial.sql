-- DIAGNÓSTICO APENAS LEITURA — DeltaTV etapa 1
-- Executar DEPOIS de aplicar a migração 20261216000001-prepaid-master-issuance.cjs.
-- Nenhuma das consultas abaixo modifica dados ou bloqueia dispositivos existentes.

-- 1. Emissões de Master que antecedem o controle pré-pago.
SELECT p.id AS partner_id, p.name AS master,
       count(*) AS operacoes_historicas,
       sum(r.quantity)::bigint AS unidades_historicas,
       min(r.created_at) AS primeiro_lote,
       max(r.created_at) AS ultimo_lote
FROM reseller_master_issuance_requests r
JOIN partners p ON p.id = r.partner_id
WHERE r.total_credits IS NULL
GROUP BY p.id, p.name
ORDER BY unidades_historicas DESC;

-- 2. Emissões novas: toda linha com créditos totais positivos tem custo registrado.
SELECT p.id AS partner_id, p.name AS master,
       count(*) AS lotes_prepagos, sum(r.quantity)::bigint AS unidades,
       sum(r.total_credits)::bigint AS creditos_debitados
FROM reseller_master_issuance_requests r
JOIN partners p ON p.id = r.partner_id
WHERE r.total_credits > 0
GROUP BY p.id, p.name
ORDER BY creditos_debitados DESC;

-- 3. Exceções manuais no estoque; registros antigos podem ter receita declarada,
--    mas sem comprovante reconciliado neste extrato: não classificá-los como fraude.
SELECT p.id AS partner_id, p.name AS revenda,
       count(*) AS entradas_ou_ajustes,
       sum(s.delta)::bigint AS unidades,
       min(s.created_at) AS desde,
       max(s.created_at) AS ate
FROM license_stock_ledger s
JOIN partners p ON p.id=s.partner_id
WHERE s.delta > 0 AND (s.kind='adjust' OR
  (s.kind='grant' AND (s.note IS NULL OR (
    s.note NOT LIKE 'Compra com crédito (%' AND s.note NOT LIKE 'Pix %'
    AND s.note NOT LIKE 'Emissão coberta por %'))))
GROUP BY p.id,p.name ORDER BY unidades DESC;

-- 4. Créditos adicionados manualmente: revisão administrativa necessária.
SELECT p.id AS partner_id, p.name AS revenda,
       count(*) AS ajustes_positivos, sum(c.delta)::bigint AS creditos_ajustados
FROM credit_ledger c JOIN partners p ON p.id=c.partner_id
WHERE c.kind='adjust' AND c.delta > 0
GROUP BY p.id,p.name ORDER BY creditos_ajustados DESC;
