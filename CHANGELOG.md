# Changelog — Astronic Tabletop v0.8

## Firebase Authentication + Realtime Database

- Substituído o cadastro/login demonstrativo local por Firebase Authentication (e-mail/senha).
- Persistência de login Firebase no navegador.
- Perfis mínimos gravados por UID em `userProfiles`.
- Seleção de Mestre/Jogador mantida, com autorização real do Mestre por allowlist `masterUsers`.
- Adicionado fluxo de ativação inicial do mestre, com UID copiável e verificação após autorização no Console.
- Sessões criadas no Realtime Database, com código e link de convite.
- Jogadores autenticados podem entrar por código/link em outro dispositivo.
- Participantes sincronizados em tempo real no painel do mestre.
- Encerramento de sessão e histórico básico remotos.
- Tela do jogador entra na sala remota e aguarda publicação de conteúdo.
- Adicionados `database.rules.json`, `firebase.json` e `FIREBASE-SETUP.md`.

## Ainda pendente

A sincronização do conteúdo apresentado (mapas, NPCs, handouts, áudio e mídias) e a transferência WebRTC ainda não fazem parte desta versão. Campanhas e arquivos continuam locais.
- Privacidade da sala: a lista de participantes exibe nome e papel, sem compartilhar e-mails entre jogadores.

## v0.8.2 — Convites somente por código e encerramento de sessão

- Removida a geração, cópia e exibição de links de convite; a entrada de jogadores ocorre exclusivamente pelo código de oito caracteres.
- Removida a leitura de códigos de convite por parâmetros de URL; jogadores entram pela tela de código após autenticação.
- Corrigida a camada visual da confirmação de encerramento: o modal agora fica acima da Central do Mestre e pode ser visto e acionado sem voltar ao editor.
