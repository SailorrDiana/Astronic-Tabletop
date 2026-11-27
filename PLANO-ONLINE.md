# Astronic Tabletop — Plano online

## v0.8 — Firebase Authentication e salas reais

- Contas de e-mail/senha no Firebase Authentication.
- Papéis Mestre/Jogador na interface; privilégio Mestre conferido por `masterUsers/{uid}`.
- Perfil básico em `userProfiles/{uid}`.
- Sessões em `sessions/{sessionId}`.
- Mapa de convites em `sessionCodes/{code}`.
- Referência da sessão ativa do mestre em `masterSessions/{uid}/{campaignId}`.
- Histórico mínimo em `masterSessionHistory/{uid}/{campaignId}/{sessionId}`.
- Participantes por UID e sincronização em tempo real.
- Regras separadas para mestre, participante e visitante autenticado com código.

## Estrutura RTDB atual

```text
masterUsers/{uid}: true                 # autorização administrativa concedida pelo Console
userProfiles/{uid}
  displayName
  email
  createdAt
masterSessions/{masterUid}/{campaignId}: sessionId
masterSessionHistory/{masterUid}/{campaignId}/{sessionId}
sessionCodes/{CODE}
  sessionId
  masterUid
  status
sessions/{sessionId}
  info
    code
    campaignId
    campaignName
    masterUid
    masterName
    status
    createdAt
    endedAt
  participants/{uid}
    uid
    displayName
    email
    role
    joinedAt
  publishedState                       # reservado para a etapa de publicação
```

## Importante: controle de privilégio Mestre

A interface nunca concede privilégio Mestre apenas com base na seleção feita pelo usuário. A lista `masterUsers` é somente leitura para o cliente e deve ser editada pela proprietária no Console do Firebase. Para adicionar a primeira conta, siga `FIREBASE-SETUP.md`.

## Próximas etapas

1. Publicação remota de uma projeção segura do estado da campanha (somente conteúdo que o mestre clicar em “Apresentar”).
2. Sincronização de mapas, marcadores clicáveis, NPCs, handouts e comandos de áudio pelo Realtime Database.
3. Transferência de imagens, GIFs, documentos e áudio da biblioteca local usando WebRTC DataChannels.
4. Sinalização WebRTC e TURN como fallback para redes restritivas.
5. Hospedagem HTTPS e teste entre computadores diferentes.
6. Sincronização/backup remoto das configurações de campanha se e quando desejado.

## Arquivos e mídia nesta versão

Campanhas e blobs continuam no IndexedDB local do mestre. O banco remoto nesta etapa contém contas, sessão, convites e participantes. Não há upload de mídia para Cloud Storage.
