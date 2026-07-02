# Producao VPS

Deploy inicial da API central do Contas TikTok V2.

## Servidor

- IP: `187.77.236.157`
- Host: `srv1475078`
- Sistema: Ubuntu 24.04
- Dominio planejado: `contas-v2.elevateecom.com.br`

## Aplicacao

- Caminho base: `/opt/contas-tiktok-v2`
- Release atual: `/opt/contas-tiktok-v2/current`
- Dados persistentes: `/opt/contas-tiktok-v2/shared/data/db.json`
- Perfis de navegador: `/opt/contas-tiktok-v2/shared/data/browser-profiles`
- Servico: `contas-tiktok-v2.service`
- Porta interna: `127.0.0.1:8787`
- Navegador remoto: Playwright com Chrome for Testing isolado em `/opt/contas-tiktok-v2/shared/ms-playwright`
- Limite inicial: `1` sessao remota simultanea
- Desktop V2: instalador publicado manualmente no release `app-v2`

O servico roda com usuario Linux isolado `contasv2`.

## Nginx

- Config: `/etc/nginx/sites-available/contas-v2.elevateecom.com.br.conf`
- Link: `/etc/nginx/sites-enabled/contas-v2.elevateecom.com.br.conf`
- Proxy: `http://127.0.0.1:8787`
- Logs:
  - `/var/log/nginx/contas-v2.access.log`
  - `/var/log/nginx/contas-v2.error.log`

Backup criado antes da alteracao:

- `/opt/backups/nginx-contas-v2-20260702190720`

## Healthcheck

Na VPS:

```bash
curl -fsS http://127.0.0.1:8787/api/health
curl -fsS -H 'Host: contas-v2.elevateecom.com.br' http://127.0.0.1/api/health
```

De fora, antes do DNS propagar:

```powershell
curl.exe --resolve contas-v2.elevateecom.com.br:80:187.77.236.157 http://contas-v2.elevateecom.com.br/api/health
```

## DNS

Registro criado na Hostinger:

```txt
Tipo: A
Nome: contas-v2
Valor: 187.77.236.157
TTL: padrao
```

Nao alterar `@`, `www`, MX, TXT, SPF, DKIM ou DMARC.

Durante a propagacao, alguns resolvedores podem responder `NXDOMAIN` por cache. Os nameservers autoritativos da Hostinger ja respondem o IP correto.

## HTTPS

HTTPS ativado com Certbot/Nginx em `2026-07-02`.

- Certificado: `/etc/letsencrypt/live/contas-v2.elevateecom.com.br/fullchain.pem`
- Chave: `/etc/letsencrypt/live/contas-v2.elevateecom.com.br/privkey.pem`
- Expira em: `2026-09-30`
- Renovacao automatica: configurada pelo Certbot
- HTTP redireciona para HTTPS.

## Comandos uteis

```bash
systemctl status contas-tiktok-v2 --no-pager
journalctl -u contas-tiktok-v2 -f
systemctl restart contas-tiktok-v2
```

Credenciais iniciais do admin foram geradas na VPS em:

```txt
/root/contas-tiktok-v2-admin.txt
```

Esse arquivo tem permissao `600` e nao deve ser enviado em chat.

## Navegador remoto

Playwright foi ativado em `2026-07-02` para abrir Chrome real no servidor sem instalar pacotes globais na VPS.

Variaveis ativas em `/etc/contas-tiktok-v2.env`:

```txt
PLAYWRIGHT_BROWSERS_PATH=/opt/contas-tiktok-v2/shared/ms-playwright
V2_BROWSER_DRIVER=playwright
V2_BROWSER_DATA_DIR=/opt/contas-tiktok-v2/shared/data/browser-profiles
V2_BROWSER_MAX_SESSIONS=1
```

Backup do ambiente antes da ativacao:

```txt
/etc/contas-tiktok-v2.env.bak-20260702193546
```

Smoke tests executados:

- Worker direto como usuario `contasv2`: abriu navegador, navegou para `example.com`, capturou JPEG e fechou.
- API local: login admin, lista de perfis, start session, frame JPEG e release do perfil.
- HTTPS externo: `https://contas-v2.elevateecom.com.br/api/health`.

Manter o limite inicial baixo ate medir CPU/RAM com usuarios reais. Para aumentar concorrencia, ajustar `V2_BROWSER_MAX_SESSIONS` e reiniciar apenas `contas-tiktok-v2`.

## Deploy da API

Sempre criar nova release em `/opt/contas-tiktok-v2/releases/<timestamp>`, atualizar o link `current` e reiniciar apenas:

```bash
systemctl restart contas-tiktok-v2
```

Nao alterar Nginx, Docker, outros projetos em `/opt`, DNS raiz, `www`, MX, TXT, SPF, DKIM ou DMARC para atualizar a V2.
