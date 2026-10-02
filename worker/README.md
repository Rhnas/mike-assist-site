# Worker do Mike Assist (Cloudflare)

`worker.js` é o backend: monta os pedidos à IA, aplica limites de uso e guarda o cache de notícias.

As instruções da IA **não ficam mais no app**. O app manda só a tarefa (`historico` ou `legislacao`)
e o texto; o Worker monta o pedido com os arquivos de `conhecimento/` publicados no site
(`instrucoes-historico.txt`, `exemplos-reais.txt`, `exemplos-ficticios.txt`, `tabela-codigos.txt`).
Para ensinar algo novo à IA, edite esses arquivos e publique o site: o Worker relê em até 10 minutos,
sem precisar colar o Worker de novo.

Ele **não** é publicado automaticamente pelo GitHub — o deploy é manual.

## Publicar

1. Cloudflare → Workers & Pages → `mikeassist` → **Edit code**.
2. Cole o conteúdo de `worker/worker.js` → **Deploy**.
3. **Settings → Variables and Secrets** → adicione o secret `ADMIN_TOKEN`
   (string longa e aleatória, ex.: `openssl rand -hex 24` ou gerador do gerenciador de senhas).
   Nunca coloque no chat, no código nem no repositório (é público).
4. Mantenha o que já existe: binding KV `USO_KV`, secret `ANTHROPIC_API_KEY` e os Cron Triggers.
5. No Console da Anthropic, defina um **limite de gasto mensal**.

## Variáveis opcionais

| Variável | Padrão | Função |
|---|---|---|
| `LIMITE_DIARIO` | 20 | usos de IA por aparelho/dia |
| `LIMITE_IP_DIARIO` | 60 | usos por IP/dia |
| `LIMITE_GLOBAL_DIARIO` | 500 | usos totais/dia (teto de custo) |
| `ORIGENS_PERMITIDAS` | `https://mikeassist.pages.dev` | origens CORS, separadas por vírgula |
| `URL_CONHECIMENTO` | `https://mikeassist.pages.dev/conhecimento/` | de onde o Worker lê os textos da IA |
| `MODO_TRANSICAO` | (vazio) | `1` aceita também o formato antigo do app (que mandava as instruções). Use só durante a troca de versão |

## Troca para esta versão (uma vez só)

A ordem importa, para ninguém ficar sem o app:

1. Em **Settings → Variables and Secrets**, crie a variável `MODO_TRANSICAO` com o valor `1`.
2. Cole o novo `worker.js` e faça **Deploy**. O app antigo continua funcionando.
3. Faça o merge do PR no GitHub. O Cloudflare Pages publica o app novo e os arquivos de `conhecimento/`.
4. Abra o app e gere um histórico de teste.
5. Um ou dois dias depois, **apague** a variável `MODO_TRANSICAO`. A partir daí o Worker só aceita as tarefas do app e a chave só serve para gerar histórico e consultar lei, dentro dos limites diários.

## O que mudou

- `/avisos/atualizar` exige o header `X-Admin-Token` (no app: `?admin=1`, o botão pede o token).
- Pedidos são validados: tamanho, modelo, mensagens, única ferramenta permitida (busca web, máx. 2 usos), `max_tokens` limitado.
- Contadores por aparelho, por IP e global.
- Erros genéricos (sem detalhes internos).

## Limites conhecidos

- Contadores em KV não são atômicos: sob concorrência podem passar um pouco do limite.
- CORS é higiene, não segurança (clientes fora do navegador ignoram).

## Testes

```
node worker/worker.test.mjs
```
82 verificações com KV, site e Anthropic simulados. Os exemplos e o anonimizador têm testes próprios:

```
node conhecimento/exemplos.test.mjs
node testes/anonimizar.test.mjs
```
