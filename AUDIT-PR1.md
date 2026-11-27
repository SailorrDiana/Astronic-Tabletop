# Astronic Tabletop — revisão pré-GitHub (Parte 1)

## Ajustes aplicados
- Corrigido o script `npm test`, que antes era um placeholder e sempre falhava. Agora executa verificações estáticas de sintaxe dos módulos JS e valida os JSON do projeto.
- Declarada a versão mínima de Node.js como `>=24.12.0`, compatível com a exigência de engine indicada pelos pacotes Firebase resolvidos no lockfile durante a tentativa de instalação.
- Atualizado o metadado correspondente no package-lock.
- Removido `node_modules` do pacote de entrega; dependências devem ser instaladas pelo npm a partir do lockfile.

## Verificações executadas
- `node --check` em `js/app.js`, `js/firebase.js` e `js/storage.js`: OK.
- Validação JSON em `package.json`, `package-lock.json`, `firebase.json` e `database.rules.json`: OK.
- `npm test`: OK após a correção do script.

## Pendências para testes em PCs e validação de release
- A instalação limpa (`npm ci`) não terminou neste ambiente dentro do tempo disponível; o build Vite não foi validado aqui.
- Não foi realizado teste end-to-end com Firebase real, duas contas/PCs, sessão online, sincronização de mapa, handouts, biblioteca, áudio ou WebRTC.
- As regras Firebase precisam ser testadas no Emulator Suite ou no projeto de teste antes de dados reais. Não altere as regras de segurança sem validar os fluxos e papéis.
- A auditoria estática não substitui teste manual no navegador. Os itens acima são bloqueios de validação, não afirmações de que esses recursos estejam quebrados.

## Para instalar e testar
1. Instale Node.js 24.12+.
2. Na raiz do projeto, execute `npm ci`.
3. Execute `npm test`.
4. Execute `npm run build`.
5. Execute `npm run dev -- --host 0.0.0.0` para teste na rede local, ou use `npm run preview -- --host 0.0.0.0` após o build.
