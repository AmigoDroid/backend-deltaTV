# Data da última desconexão do portal

O WebSocket `partner-presence` agora inclui `lastDisconnectedAt` quando a última sessão da parceria se desconecta.

Quando a parceria fica efetivamente offline, o backend atualiza também `admin_users.last_activity_at`, reaproveitando uma coluna já existente. Assim, o painel consegue estimar há quanto tempo a parceria está offline mesmo depois de recarregar a página.

Não há novo agendador, migração, tabela ou sondagem periódica. O tempo relativo é calculado no frontend. O registro de última atividade não é um histórico exato de sessões em casos de falha abrupta da rede ou reinicialização inesperada do processo.
