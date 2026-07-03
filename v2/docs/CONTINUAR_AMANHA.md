# Continuar Amanha - Contas TikTok V2

Este arquivo e o mapa rapido para retomar o projeto sem precisar reconstruir o contexto.

## Estado atual

- App desktop V2 publicado:
  - `https://github.com/i9automations/contas-tiktok/releases/download/app-v2/Contas.TikTok.V2.Setup.0.1.0.exe`
- API:
  - `https://contas-v2.elevateecom.com.br`
- VPS:
  - IP: `187.77.236.157`
  - Service: `contas-tiktok-v2`
  - Current release: `/opt/contas-tiktok-v2/releases/20260702201600`
  - Browser profiles: `/opt/contas-tiktok-v2/shared/data/browser-profiles`
- Supabase:
  - Organizacao: `Elevate`
  - Projeto: `ELEVATE - CONTAS TIKTOK V2`
  - Ref: `tnbxoutjrjoilvboidcb`
  - URL: `https://tnbxoutjrjoilvboidcb.supabase.co`
  - Storage ativo: `supabase`
- Navegador remoto:
  - Driver: `playwright`
  - Max simultaneo atual: `1`
  - Chrome for Testing isolado em `/opt/contas-tiktok-v2/shared/ms-playwright`

## Validado ate agora

- Healthcheck com `storage.store=supabase`.
- Login admin pela API usando Supabase Auth.
- Criacao de perfil temporario no Supabase.
- Abertura de Chrome remoto na VPS.
- Captura de frame JPEG.
- Release e delete do perfil temporario.
- GitHub Actions verde no ultimo push.

## Arquivos importantes

- Schema Supabase: `v2/supabase/schema.sql`
- Guia Supabase: `v2/docs/SUPABASE.md`
- Producao VPS: `v2/docs/PRODUCAO_VPS.md`
- Modelo de clientes: `v2/templates/clientes-import-modelo.csv`
- Modelo de equipe: `v2/templates/equipe-modelo.csv`

## O que falta para piloto real

1. Rotacionar o token `sbp_...` que foi enviado no chat.
2. Criar usuarios da equipe no app/Supabase.
3. Importar clientes reais.
4. Instalar a V2 em 2 ou 3 PCs.
5. Abrir um perfil real, logar no TikTok Seller, liberar e testar em outro PC.
6. Medir consumo da VPS com 1 navegador aberto.
7. Se ficar estavel, subir `V2_BROWSER_MAX_SESSIONS` para `3`.
8. Repetir teste com 2 ou 3 pessoas ao mesmo tempo.
9. Planejar automacao de codigo TikTok via Hostinger.

## Dados para separar antes do teste

### Clientes

Planilha com as colunas:

```txt
nome;email;tags;caixa_email;observacoes
```

Exemplo:

```txt
Petala Beauty;petalabeauty@elevateecom.com.br;Beauty,Cliente;clientes@elevateecom.com.br;Cliente piloto
```

### Usuarios

Lista de quem vai testar:

```txt
nome;email;perfil;senha_inicial
```

Perfis aceitos:

- `admin`
- `operator`

## Roteiro de teste piloto

1. Instalar o app V2 em PC A e PC B.
2. Entrar com usuarios diferentes.
3. No PC A, abrir perfil piloto.
4. Fazer login no TikTok Seller.
5. Confirmar que o browser remoto responde a clique, scroll e digitacao.
6. Liberar o perfil.
7. No PC B, abrir o mesmo perfil.
8. Confirmar se o TikTok continua logado.
9. Abrir outro perfil e validar isolamento de conta.
10. Conferir auditoria no app.

## Comandos uteis

Na VPS:

```bash
systemctl status contas-tiktok-v2 --no-pager
journalctl -u contas-tiktok-v2 -f
curl -fsS http://127.0.0.1:8787/api/health
```

De fora:

```powershell
curl.exe -fsS --resolve contas-v2.elevateecom.com.br:443:187.77.236.157 https://contas-v2.elevateecom.com.br/api/health
```

## Aumentar simultaneidade

Editar `/etc/contas-tiktok-v2.env`:

```txt
V2_BROWSER_MAX_SESSIONS=3
```

Depois:

```bash
systemctl restart contas-tiktok-v2
```

Subir primeiro para `3`, testar, depois decidir `5`.

## Rollback rapido

Se Supabase tiver problema:

```txt
V2_DATA_STORE=json
```

Depois:

```bash
systemctl restart contas-tiktok-v2
```

O JSON antigo esta em:

```txt
/opt/contas-tiktok-v2/shared/data/db.json
```

## Proximo bloco grande

Automacao Hostinger:

- Mapear caixas principais: `clientes@`, `clientes1@`, `clientes2@`, `clientes3@`, `clientes5@`.
- Confirmar acesso IMAP/SMTP ou API disponivel.
- Guardar credenciais no Supabase/VPS de forma segura.
- Endpoint futuro: `POST /api/profiles/:id/tiktok-code`.
- UI futura: botao `Pegar codigo`.
