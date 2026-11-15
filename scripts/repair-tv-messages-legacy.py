#!/usr/bin/env python3
"""Repara colisão da migração 20261217 preservando o contrato SQL legado.

Roda na raiz do backend DeltaTV. Por padrão é apenas inspeção.
--apply: modifica somente src/app.js e move para quarentena a migração conflitante.
"""
import argparse
import difflib
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

OLD_IMPORT = 'import { panelMessages, clientMessages } from "./modules/tv-messages/routes.js";'
NEW_IMPORT_PATTERNS = [
    r'^\s*import\s+tvMessagePanelRoutes\s+from\s+["\']\.\/modules\/tv-messages\/panel\.routes\.js["\'];?\s*\n',
    r'^\s*import\s+tvMessageDeviceRoutes\s+from\s+["\']\.\/modules\/tv-messages\/device\.routes\.js["\'];?\s*\n',
]
NEW_MOUNT_PATTERNS = [
    r'^\s*app\.use\(\s*["\']/api/v1/tv-messages["\']\s*,\s*tvMessagePanelRoutes\s*\);?\s*\n',
    r'^\s*app\.use\(\s*["\']/api/v1/client/tv-messages["\']\s*,\s*tvMessageDeviceRoutes\s*\);?\s*\n',
]
OLD_MOUNTS = [
    ('/api/v1/tv-messages', 'panelMessages'),
    ('/api/v1/client/messages', 'clientMessages'),
]

def _mount_regex(path, symbol):
    return rf'app\.use\(\s*["\']{re.escape(path)}["\']\s*,\s*{symbol}\s*\);?'

def transform(src):
    """Retorna código reescrito. Rejeita modificações ambíguas."""
    if 'export function createApp()' not in src or 'app.use("/api/v1/auth", authRoutes)' not in src:
        raise ValueError('src/app.js não corresponde à estrutura DeltaTV esperada; nenhuma alteração segura.')
    s = src
    for pattern in NEW_IMPORT_PATTERNS + NEW_MOUNT_PATTERNS:
        s = re.sub(pattern, '', s, flags=re.MULTILINE)
    # Não deixar referências ativas aos módulos incompatíveis com sender_id.
    if re.search(r'\b(?:tvMessagePanelRoutes|tvMessageDeviceRoutes)\b', s):
        raise ValueError('Referências extras às rotas incompatíveis: examine src/app.js manualmente.')
    # Não adicionar import duplicado.
    old_imports = re.findall(r'^\s*import\s*\{([^}]+)\}\s*from\s*["\']\.\/modules\/tv-messages\/routes\.js["\'];?', s, re.M)
    if len(old_imports) > 1:
        raise ValueError('Mais de um import de rotas legadas; revisão manual necessária.')
    if old_imports:
        members = set(n.strip() for n in old_imports[0].split(','))
        if not {'panelMessages', 'clientMessages'}.issubset(members):
            raise ValueError('Import parcial de routes.js: revisão manual necessária.')
    else:
        s = OLD_IMPORT + '\n' + s
    for path, symbol in OLD_MOUNTS:
        matches = re.findall(_mount_regex(path, symbol), s)
        if len(matches) > 1:
            raise ValueError(f'Montagem legada repetida: {path}')
        if not matches:
            anchor = '  app.use("/api/v1/auth", authRoutes);'
            if s.count(anchor) != 1:
                raise ValueError('Âncora de rotas ambígua em app.js.')
            s = s.replace(anchor, f'  app.use("{path}", {symbol});\n' + anchor, 1)
    # URL de mensagens do painel deve ter exatamente um mount ativo.
    if len(re.findall(r'app\.use\(\s*["\']/api/v1/tv-messages["\']', s)) != 1:
        raise ValueError('URL /api/v1/tv-messages com montagens ambíguas; nenhuma alteração segura.')
    return s

def validate_repository(root):
    app = root / 'src/app.js'
    oldroutes = root / 'src/modules/tv-messages/routes.js'
    oldmigration = root / 'src/db/migrations/20261212000001-tv-messages.cjs'
    newmigration = root / 'src/db/migrations/20261217000001-tv-messages.cjs'
    for file in (app, oldroutes, oldmigration):
        if not file.is_file():
            raise ValueError(f'Arquivo da implementação original ausente: {file.relative_to(root)}. Pare e recupere o código original antes de continuar.')
    r = oldroutes.read_text()
    m = oldmigration.read_text()
    if not re.search(r'export\s+const\s+panelMessages\s*=\s*Router', r) or not re.search(r'export\s+const\s+clientMessages\s*=\s*Router', r):
        raise ValueError('routes.js não exporta as rotas antigas esperadas; revisão manual necessária.')
    if 'sender_id' not in m or 'sender_id' not in r:
        raise ValueError('A implementação antiga não utiliza sender_id; schema divergente, revisão manual necessária.')
    if newmigration.exists() and 'sender_user_id' not in newmigration.read_text():
        raise ValueError('O arquivo 20261217000001 existe mas não é a migração conflitante esperada; não modificar.')
    src = app.read_text()
    fixed = transform(src)
    return app, newmigration, src, fixed

def main(argv=None):
    p=argparse.ArgumentParser(description='Recupera as rotas legadas de mensagens de TV sem DDL no banco.')
    p.add_argument('--apply', action='store_true', help='aplica as alterações após validação; padrão: apenas diagnóstico')
    p.add_argument('--root', type=Path, default=Path.cwd())
    args=p.parse_args(argv)
    root=args.root.resolve()
    try:
        app, migration, before, after = validate_repository(root)
    except Exception as exc:
        print(f'ERRO: {exc}', file=sys.stderr)
        return 2
    needs_app = before != after
    needs_migration = migration.is_file()
    print(f'Backend: {root}')
    print('Contrato antigo: sender_id, partner_id, payload_hash (mantido).')
    print(f'app.js: {"precisa de correção" if needs_app else "rotas antigas já corretas"}')
    print(f'Migração incompatível 20261217: {"presente" if needs_migration else "ausente"}')
    if needs_app:
        print('--- Diferenças previstas em app.js ---')
        print(''.join(difflib.unified_diff(before.splitlines(keepends=True),after.splitlines(keepends=True),fromfile='app.js atual',tofile='app.js corrigido'))[:12000])
    if not args.apply:
        print('\nSomente inspeção. Use --apply após conferir os dados acima.')
        return 0
    if not needs_app and not needs_migration:
        print('Nenhuma mudança necessária.'); return 0
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backupdir=root / 'backups' / f'tv-messages-legacy-{stamp}'
    backupdir.mkdir(parents=True, exist_ok=False)
    shutil.copy2(app,backupdir / 'app.js.before')
    if needs_migration:
        shutil.copy2(migration,backupdir / migration.name)
    if needs_app:
        temp = app.with_name('.app.tv-messages-staged.js')
        temp.write_text(after)
        check=subprocess.run(['node','--check',str(temp)],capture_output=True,text=True)
        if check.returncode:
            temp.unlink(missing_ok=True)
            print('Falha no node --check: '+check.stderr,file=sys.stderr)
            return 2
        temp.replace(app)
    if needs_migration:
        # Mover o arquivo FORA de src/db/migrations, sem apagar dados ou SequelizeMeta.
        migration.rename(backupdir / migration.name)
    check=subprocess.run(['node','--check',str(app)],capture_output=True,text=True)
    if check.returncode:
        # Em caso de falha inesperada, restaurar ambos os arquivos.
        shutil.copy2(backupdir/'app.js.before', app)
        if needs_migration:
            shutil.copy2(backupdir/migration.name, migration)
        print('Falha na verificação final, app.js original restaurado: '+check.stderr,file=sys.stderr)
        return 2
    print(f'\nCorrigido. Backup de arquivos em: {backupdir}')
    print('Nenhuma tabela, coluna, índice ou registro do banco foi modificado.')
    print('ANTES de reiniciar: confirme status das migrações e execute npm test, node --check src/app.js.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
