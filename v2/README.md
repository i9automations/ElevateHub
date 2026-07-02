# Contas TikTok V2

V2 e o aplicativo desktop compartilhado da equipe, conectado a API central em `https://contas-v2.elevateecom.com.br`.

O objetivo e reproduzir a logica do Dolphin: perfis, cookies e sessoes ficam no servidor, nao no PC de cada pessoa.

## Estrutura

- `desktop/`: aplicativo Electron. A UI abre como app instalado, nao como aba de navegador.
- `server/`: API central para usuarios, perfis, travas, sessoes e auditoria.
- `docs/`: decisoes tecnicas e proximos passos.

## Recursos atuais

- Login de usuarios.
- Lista de perfis compartilhados com busca, filtros e tags.
- Trava de perfil em uso.
- Browser remoto com clique, digitacao, scroll, teclas rapidas, voltar, avancar, atualizar e navegar por URL.
- Sessoes persistidas na VPS por perfil.
- Importacao de perfis via CSV.
- Tela de equipe para criar usuarios.
- Auditoria das acoes principais.
- Instalador Windows via Electron Builder.

## Desenvolvimento local

Em um terminal:

```powershell
cd v2
npm run server
```

Em outro terminal, depois de instalar o Electron:

```powershell
cd v2\desktop
npm install
npm run dev
```

Credenciais de desenvolvimento:

- E-mail: `admin@elevate.local`
- Senha: `admin123`

Em producao, o aplicativo desktop deve apontar para a API hospedada usando a variavel `ELEVATE_API_URL`.

## Build do instalador

```powershell
cd v2\desktop
npm ci
npm run dist
```

O instalador local sai em:

```txt
v2/desktop/dist/Contas TikTok V2 Setup 0.1.0.exe
```

Publicacao manual no GitHub:

```powershell
gh release create app-v2 "v2/desktop/dist/Contas TikTok V2 Setup 0.1.0.exe" --title "Contas TikTok V2" --notes "Instalador do aplicativo desktop V2."
```

Se o release ja existir:

```powershell
gh release upload app-v2 "v2/desktop/dist/Contas TikTok V2 Setup 0.1.0.exe" --clobber
```
