# Astronic Tabletop — v0.8 Firebase

Esta versão substitui o login demonstrativo local pelo **Firebase Authentication** e conecta a criação/entrada de sessões e a lista de participantes ao **Firebase Realtime Database**.

## O que está conectado nesta etapa

- Cadastro real com e-mail e senha pelo Firebase Authentication.
- Login e persistência da sessão autenticada no navegador.
- Seleção entre Mestre e Jogador.
- Convites por link (`?convite=CODIGO`) que forçam o fluxo de jogador.
- Criação de salas reais no Realtime Database.
- Código de convite e link compartilhável.
- Entrada de jogadores autenticados por código em outros dispositivos.
- Lista de participantes sincronizada em tempo real.
- Encerramento da sessão e histórico básico.
- Verificação de permissão de mestre por lista de autorização protegida no banco.

## Ainda não conectado nesta etapa

- Publicação/sincronização de mapas, marcadores, NPCs, handouts e áudio.
- Transferência WebRTC da biblioteca local do mestre para jogadores.
- Armazenamento online de campanhas e mídias: campanhas e arquivos continuam locais no dispositivo do mestre.

A tela do jogador já entra na sala real e aguarda o conteúdo publicado; a sincronização de conteúdo será implementada no próximo marco.

## Requisitos

- Node.js instalado.
- Dependências instaladas com `npm install`.
- Projeto Firebase `astronic-tabletop` configurado com Authentication por e-mail/senha e Realtime Database.
- Regras de banco publicadas usando `database.rules.json`.
- Primeira conta de mestre autorizada no nó `masterUsers` (instruções em `FIREBASE-SETUP.md`).

## Executar localmente

```powershell
npm.cmd install
npm.cmd run dev
```

Abra o endereço local mostrado pelo Vite. Mantenha o terminal aberto enquanto estiver usando o site.

## Compilar para publicação

```powershell
npm.cmd run build
```

Os arquivos finais serão gerados na pasta `dist/`.

## Importante sobre os dados locais

As campanhas, mapas e mídias existentes no IndexedDB do navegador não são apagados por esta atualização. O Firebase passa a cuidar da autenticação e das sessões; os dados de campanha permanecem locais até uma etapa posterior de sincronização/publicação.

## Segurança de mestre

A escolha “Sou mestre” na tela de login não concede privilégios por si só. A permissão real é verificada em `masterUsers/{uid}`. A primeira conta da proprietária deve ser incluída manualmente nesse nó pelo Console do Firebase. Clientes comuns não podem escrever nesse caminho pelas regras fornecidas.

## Aviso de desenvolvimento

A configuração Firebase deste aplicativo Web contém apenas identificadores públicos do projeto. Não adicione chaves de conta de serviço, credenciais Admin ou segredos no frontend. As permissões são impostas pelas regras do Realtime Database.
