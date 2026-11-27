# Configuração do Firebase — Astronic Tabletop v0.8

Este documento descreve a configuração única para ativar contas e salas online. O aplicativo já está configurado com o projeto `astronic-tabletop` e o endereço do Realtime Database informado durante a preparação.

## 1. Confira os serviços no Firebase Console

No projeto `astronic-tabletop`:

1. Em **Segurança → Autenticação → Método de login**, mantenha **E-mail/senha** ativado.
2. Em **Realtime Database**, confirme que o banco foi criado e que o endereço corresponde a `https://astronic-tabletop-default-rtdb.firebaseio.com`.

## 2. Publicar as regras de segurança

1. Abra **Realtime Database → Regras**.
2. Abra o arquivo `database.rules.json` desta pasta do projeto no VS Code.
3. Copie todo o conteúdo do arquivo.
4. Substitua o conteúdo atual da aba **Regras** pelo JSON copiado.
5. Clique em **Publicar**.

As regras começam negando o acesso geral. Depois liberam apenas os caminhos necessários para o usuário autenticado, o mestre autorizado e os participantes da própria sessão. Não troque essas regras por `read: true` ou `write: true`.

## 3. Criar a primeira conta da proprietária como Mestre

1. Inicie o site com `npm.cmd run dev`.
2. Na tela de entrada, escolha **Sou mestre** e **Criar conta**.
3. Cadastre seu nome, e-mail e senha.
4. A conta será criada no Firebase Authentication. Como ainda não foi autorizada como mestre, o site exibirá um painel com o UID da conta.
5. Clique em **Copiar UID**.

## 4. Autorizar o UID da proprietária

A autorização inicial é feita manualmente pelo Console do Firebase, não pela seleção do botão na interface. Isso impede que qualquer jogador se promova a mestre.

1. No Firebase Console, abra **Realtime Database → Dados**.
2. No nó raiz, crie um filho chamado `masterUsers`.
3. Dentro de `masterUsers`, crie um filho cujo nome seja exatamente o UID copiado no passo anterior.
4. Defina o valor desse filho como o booleano `true` (não como texto entre aspas).

A estrutura ficará assim (substitua o texto de exemplo pelo UID real):

```json
{
  "masterUsers": {
    "COLE_AQUI_O_UID_DA_SUA_CONTA": true
  }
}
```

A edição é feita pelo Console como proprietária do projeto. As regras do aplicativo bloqueiam que um usuário comum altere esse nó.

5. Volte à aba do Astronic Tabletop e clique em **Já autorizei — verificar novamente**.
6. O aplicativo consultará `masterUsers/{uid}`. Se o valor for `true`, abrirá o painel do mestre.

## 5. Como os jogadores entram

1. O mestre abre uma campanha local e entra em **Sessão online**.
2. Clique em **Criar sessão online**. O banco criará a sala e gerará um código de oito caracteres.
3. Compartilhe somente o código com os jogadores.
4. O jogador abre o site, escolhe **Sou jogador**, cria uma conta ou entra com e-mail/senha e informa o código na tela **Entrar na sua sessão**.
5. A lista de participantes no painel do mestre atualiza em tempo real. A leitura dos detalhes da sala exige que o usuário já tenha entrado como participante.

## 6. Teste local x dispositivos diferentes

- `localhost` só é acessível no próprio computador. Para jogadores em outros dispositivos, o site precisa estar publicado em um endereço HTTPS acessível.
- Mesmo depois da publicação, os jogadores entram digitando o código de oito caracteres na tela do jogador. O projeto não utiliza links de convite.
- Nesta versão, contas, salas, códigos e participantes são remotos. Campanhas e mídias do mestre ainda ficam locais; sincronização/publicação do conteúdo e WebRTC serão implementadas depois.

## 7. Se aparecer “PERMISSION_DENIED”

Confira se publicou `database.rules.json` inteiro na aba **Realtime Database → Regras**, se a conta mestre foi adicionada em `masterUsers/{uid}` e se o valor está no tipo booleano `true`. Não abra as regras publicamente como solução.
