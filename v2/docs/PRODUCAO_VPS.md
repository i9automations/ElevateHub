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
- Servico: `contas-tiktok-v2.service`
- Porta interna: `127.0.0.1:8787`

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

## DNS pendente

Criar na Hostinger:

```txt
Tipo: A
Nome: contas-v2
Valor: 187.77.236.157
TTL: padrao
```

Nao alterar `@`, `www`, MX, TXT, SPF, DKIM ou DMARC.

## HTTPS pendente

Depois que o DNS resolver para a VPS:

```bash
certbot --nginx -d contas-v2.elevateecom.com.br
nginx -t
systemctl reload nginx
```

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
