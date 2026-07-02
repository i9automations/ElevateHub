# Supabase

Objetivo: tirar usuarios, perfis, configuracoes e auditoria do JSON na VPS. A VPS continua existindo como browser worker, porque Chrome/Playwright precisa de processo persistente.

## Divisao nova

- Supabase: Auth, Postgres, usuarios, perfis, auditoria, configuracoes futuras da Hostinger.
- VPS: API fina, Playwright, Chrome remoto, cookies/sessoes de navegador em disco, locks em tempo de uso.
- Desktop: continua falando com `https://contas-v2.elevateecom.com.br`.

## Criar projeto

1. Criar um projeto Supabase.
2. No SQL Editor, rodar `v2/supabase/schema.sql`.
3. Criar o primeiro usuario admin em Authentication.
4. Rodar o insert final comentado no `schema.sql` ajustando o e-mail do admin.

## Variaveis na VPS

Adicionar em `/etc/contas-tiktok-v2.env`:

```txt
V2_DATA_STORE=supabase
V2_SUPABASE_URL=https://SEU-PROJETO.supabase.co
V2_SUPABASE_ANON_KEY=...
V2_SUPABASE_SERVICE_ROLE_KEY=...
```

Importante: `V2_SUPABASE_SERVICE_ROLE_KEY` nunca deve ir para o app desktop, GitHub, chat ou print. Ela fica somente na VPS.

## Fluxo de login

O desktop continua chamando:

```txt
POST /api/auth/login
```

Quando `V2_DATA_STORE=supabase`, a API valida usuario/senha no Supabase Auth e devolve um token Supabase para o desktop usar nas proximas chamadas da API.

## Migracao dos dados atuais

Com a API ainda em modo JSON:

1. Exportar `db.json` da VPS.
2. Importar usuarios no Supabase Auth.
3. Inserir `app_users`.
4. Inserir `profiles`.
5. Inserir `audit` se quiser manter historico.
6. Alterar env para `V2_DATA_STORE=supabase`.
7. Reiniciar somente `contas-tiktok-v2`.

## Rollback

Remover ou alterar:

```txt
V2_DATA_STORE=json
```

Depois reiniciar:

```bash
systemctl restart contas-tiktok-v2
```

O JSON antigo continua em `/opt/contas-tiktok-v2/shared/data/db.json`.
