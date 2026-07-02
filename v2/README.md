# Contas TikTok V2

V2 sera um aplicativo desktop instalado nos computadores da equipe, conectado a um servidor central.

O objetivo e reproduzir a logica do Dolphin: perfis e sessoes ficam compartilhados no servidor, nao no PC de cada pessoa.

## Estrutura

- `desktop/`: aplicativo Electron. A UI abre como app instalado, nao como aba de navegador.
- `server/`: API central para usuarios, perfis, travas, sessoes e auditoria.
- `docs/`: decisoes tecnicas e proximos passos.

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
