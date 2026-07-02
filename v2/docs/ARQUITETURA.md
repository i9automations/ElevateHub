# Arquitetura V2

## Decisao principal

A V2 e um aplicativo desktop, nao um painel web aberto no navegador.

Mesmo assim, a parte compartilhada precisa ficar em um servidor central. O aplicativo instalado nos PCs vira o cliente, enquanto o servidor guarda usuarios, perfis, travas, auditoria e sessoes de navegador.

## Modelo Dolphin-like

1. Usuario abre o aplicativo desktop.
2. App autentica na API central.
3. API lista os perfis TikTok compartilhados.
4. Ao abrir um perfil, a API cria uma trava para evitar duas pessoas controlando o mesmo perfil ao mesmo tempo.
5. Um worker no servidor inicia ou reconecta um navegador remoto isolado daquele perfil.
6. O stream do navegador aparece dentro do aplicativo.
7. Cookies, sessoes e dados do navegador ficam no servidor.
8. Outro usuario abre o mesmo perfil depois e recebe a sessao ja logada.

## Componentes

### Desktop app

Tecnologia inicial: Electron.

Motivos:

- Instala como aplicativo Windows.
- UI pode evoluir rapido com HTML/CSS/JS.
- Permite embutir o stream do navegador remoto.
- Nao exige abrir uma aba no navegador do usuario.

### API central

Responsabilidades:

- Login de usuarios.
- Cadastro de perfis.
- Tags, busca e status.
- Trava de perfil em uso.
- Auditoria.
- Orquestracao das sessoes remotas.

### Browser worker

Implementado com Playwright + Chrome for Testing no servidor.

Responsabilidades atuais:

- Rodar Chrome em servidor.
- Manter uma pasta de perfil por conta TikTok.
- Retornar frames do navegador para o aplicativo.
- Receber clique, scroll, digitacao e teclas especiais do usuario.
- Persistir cookies e storage entre acessos.
- Liberar o processo do Chrome quando o perfil e solto.

## Estrategia de navegador

Para ficar igual ao Dolphin, o navegador nao pode rodar no PC do usuario. Ele precisa rodar no servidor/worker, porque os cookies e a sessao logada devem ser compartilhados por toda a empresa.

### V1 local

O app atual usa Chrome for Testing local por perfil. Isso e bom para estabilidade em um unico PC, mas nao compartilha login entre usuarios.

### V2 centralizada

A V2 deve usar Chrome for Testing ou Chromium no servidor, controlado por Playwright/CDP, com `user-data-dir` persistente por perfil.

Fluxo:

1. Usuario abre perfil no aplicativo desktop.
2. API cria uma trava para aquele perfil.
3. Worker inicia/reconecta um Chrome persistente daquele perfil.
4. App recebe frames do navegador e envia cliques/teclado.
5. Login, cookies e storage ficam salvos no servidor.
6. Outro usuario abre depois e encontra a conta ja logada.

Contrato atual:

- `POST /api/profiles/:id/session/start`
- `GET /api/profiles/:id/session/frame`
- `POST /api/profiles/:id/session/navigate`
- `POST /api/profiles/:id/session/reload`
- `POST /api/profiles/:id/session/back`
- `POST /api/profiles/:id/session/forward`
- `POST /api/profiles/:id/session/click`
- `POST /api/profiles/:id/session/scroll`
- `POST /api/profiles/:id/session/type`
- `POST /api/profiles/:id/session/key`
- `POST /api/profiles/:id/release`

Em producao, `V2_BROWSER_DRIVER=playwright` esta ativo. Em desenvolvimento sem Chrome, a API ainda consegue retornar um frame visual de fallback.

## Operacao do aplicativo

Recursos implementados no desktop:

- Login persistido localmente via token.
- Perfis com busca, filtros, tags, caixa Hostinger e observacoes.
- Importacao CSV com upsert por e-mail TikTok.
- Painel de browser remoto com clique, scroll, teclado, URL, voltar, avancar e atualizar.
- Tela de auditoria.
- Tela de equipe com criacao de usuario por admin.
- Build Windows por Electron Builder.

## Proximas decisoes

- Banco de dados de producao: Postgres.
- Armazenamento dos perfis remotos: volume persistente criptografado por perfil.
- Stream remoto: manter screenshots em polling no MVP ou evoluir para WebRTC/VNC quando precisar de FPS maior.
- Hospedagem: VPS Windows/Linux com CPU/RAM suficiente para navegadores simultaneos.
- Seguranca: HTTPS, tokens com refresh, 2FA para usuarios internos e logs de auditoria.

## Hostinger e codigos

A automacao de alias/codigo entra depois da base de sessoes remotas.

Fluxo esperado:

1. Cada perfil guarda o alias do TikTok.
2. A configuracao central guarda as caixas principais da Hostinger.
3. Quando o TikTok pedir codigo, o servidor procura nas caixas principais.
4. O codigo aparece no aplicativo e pode ser preenchido/copiado.

Isso fica centralizado para todos usarem a mesma configuracao.
