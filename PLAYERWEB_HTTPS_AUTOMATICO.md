# PlayerWeb — padrões globais

A opção de HTTPS fica em Superadmin → PlayerWeb → Configurações. A janela de criação de códigos não contém esse controle.
HTTPS automático vale para todos os acessos de parceria, novos e existentes. Os valores antigos por código são ignorados. HTTP é convertido para HTTPS; URLs já HTTPS e portas personalizadas são preservadas. O provedor deve oferecer HTTPS com certificado válido.
Na mesma tela, o superadmin escolhe os modos padrão de catálogo, TV ao vivo, filmes e séries. Eles são aplicados a novos acessos e ao restaurar a entrega padrão. Personalizações de entrega existentes permanecem.
Execute npm run db:migrate e recompile o admin antes de usar. Consulte TESTE_GRATUITO_E_CONFIG_GLOBAL.md para aplicação e comportamento completo.
