# Farol

Relatório e diagnóstico para agências de social media.
**Vercel + Supabase**, sem nenhuma dependência de pacote externo.

---

## Publicar — o caminho completo

### 1. Banco no Supabase

Supabase → **SQL Editor** → New query → cole todo o `banco/esquema.sql` → **Run**.
Pode rodar de novo sem medo: tudo é `if not exists`.

### 2. Pegue as duas chaves

Supabase → **Project Settings → API**:

| Variável | Onde está |
|---|---|
| `SUPABASE_URL` | *Project URL* |
| `SUPABASE_SERVICE_ROLE_KEY` | *service_role* — a secreta |

**A service_role nunca pode chegar ao navegador.** Ela ignora todas as regras
do banco. Não use prefixo público no nome dela e não a coloque em nenhum
arquivo dentro de `public/`.

### 3. Confira antes de publicar

```bash
cp .env.exemplo .env.local     # preencha SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY
node verificar.js
```

São 18 checagens contra o **seu** Supabase: criação de conta, senha, sessão,
isolamento entre agências, filtro de datas, upsert de resultado mensal e
exclusão em cascata. O script apaga tudo o que criou. Se algo falhar, o texto
do erro diz o quê.

### 4. Publique na Vercel

```bash
vercel
```

Depois, em **Settings → Environment Variables**, cadastre para *Production*:

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SEGREDO_WEBHOOK
PRECO_ESSENCIAL / PRECO_AGENCIA / PRECO_ESTUDIO
URL_BASE
EMAIL_MODO / SMTP_HOST / SMTP_PORTA / SMTP_USUARIO / SMTP_SENHA / EMAIL_DE / EMAIL_NOME
```

A Vercel serve `public/` sozinha e manda `/api/*` para `api/[[...rota]].js`.

### 4b. Ligue o e-mail (recuperação de senha) pelo Gmail

Sem isso, quem esquece a senha não tem como voltar — e vai te chamar no
WhatsApp.

**A senha da sua conta Google não funciona aqui.** O Gmail exige uma *Senha
de app*, que só existe depois de ligar a verificação em duas etapas:

1. `myaccount.google.com` → **Segurança** → ligue a verificação em duas etapas.
2. Na mesma tela, **Senhas de app** → crie uma → copie as 16 letras.
3. Cadastre na Vercel:

```
EMAIL_MODO=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORTA=465
SMTP_USUARIO=seuendereco@gmail.com
SMTP_SENHA=as16letrasdasenhadeapp
EMAIL_DE=seuendereco@gmail.com
EMAIL_NOME=Farol
URL_BASE=https://seuprojeto.vercel.app
```

4. **Redeploy** — variável nova só vale depois de publicar de novo.

Três coisas que valem saber antes de contratar cliente:

- O Gmail entrega umas **500 mensagens por dia**. Para recuperação de senha
  sobra; para disparo em massa, não serve.
- Mensagem saindo de `@gmail.com` para quem não te conhece cai em spam com
  mais facilidade. Quando tiver domínio próprio, troque para `EMAIL_MODO=http`
  com Resend ou Brevo e domínio verificado — a entrega melhora muito.
- **`URL_BASE` não é opcional em produção.** Sem ela o link do e-mail é
  montado com o cabeçalho `Host`, que vem de quem chamou a rota — alguém
  poderia fazer sair um e-mail seu com link para o site dele.

Para testar sem configurar nada, deixe `EMAIL_MODO` vazio: o sistema entra em
modo `log` e imprime o link no terminal em vez de enviar.

### 5. Ligue o pagamento

Em `src/pagamento.js` há três pontos marcados **AJUSTAR**: o mapa de id de
preço, onde o provedor põe a referência da conta, e os nomes dos eventos. O
arquivo está no formato do Stripe; Mercado Pago e Pagar.me seguem o mesmo
desenho.

Aponte o webhook para `https://seudominio/api/pagamento/webhook`.

---

## Desenvolver na sua máquina

Sem configurar nada, o sistema usa **SQLite local** — não gasta cota do
Supabase e funciona offline:

```bash
node semear.js      # cria a conta de demonstração
node servidor.js    # http://localhost:3000
```

Demonstração: `demo@farol.app` / `demonstracao123`

Para desenvolver **contra o Supabase**, preencha `.env.local` e rode com
`BANCO=supabase`. O mesmo código, o mesmo roteador, os dois ambientes.

---

## Estrutura

```
api/[[...rota]].js   entrada da Vercel (uma função para tudo)
servidor.js          servidor local de desenvolvimento
verificar.js         18 checagens contra o seu Supabase
semear.js            conta de demonstração
banco/esquema.sql    migração do Postgres
src/
  roteador.js        rotas, cookies e CSRF — usado pelos dois ambientes
  api.js             regras de cada rota
  auth.js            senha, sessão e limite de tentativas
  planos.js          limites e liberação de recursos
  metricas.js        motor de diagnóstico
  dados.js           escolhe o adaptador
  repo-supabase.js   produção (PostgREST via fetch)
  repo-sqlite.js     desenvolvimento local
public/
  index.html         página de vendas
  app.html           o sistema
```

**Um roteador só** atende local e produção. É o que impede o bug que só
aparece depois de publicar.

---

## Segurança — o que está resolvido

Cada item foi verificado tentando burlar de propósito.

**Senha nunca é guardada.** Guardamos `scrypt(senha, salt)`, comparado em
tempo constante. Login errado responde sempre igual, tenha o e-mail existido
ou não — mensagem diferente entregaria quais e-mails têm conta.

**Limite de tentativas** por e-mail e por IP: 8 erros travam por 15 minutos.

**Sessão em cookie HttpOnly**, `SameSite=Lax` e `Secure` em produção. O
JavaScript da página não lê o cookie, então um XSS não rouba a sessão.

**Uma agência não enxerga a outra.** Toda rota confirma que o cliente pertence
à conta logada. Trocar o id na URL devolve 404. É a falha mais comum e mais
grave em sistema multiempresa.

**O plano é decidido no servidor.** Testado pelo console do navegador: mudar
a variável do plano não muda nada, criar clientes acima do limite volta 402,
pedir recurso de plano superior volta 402, forjar o plano no corpo do pedido
é ignorado.

**RLS ligado sem policy** em todas as tabelas. O servidor passa por cima com
a service_role; a chave anônima não lê nada. É a rede de segurança para o
erro mais comum de quem usa Supabase.

**Webhook com assinatura verificada** sobre o corpo cru, com tolerância de
tempo e proteção contra reenvio.

### O que ainda falta antes de cobrar de alguém

- [ ] **Recuperação de senha por e-mail** — não existe ainda.
- [ ] **Política de privacidade e termos de uso** publicados (LGPD e exigência
      da revisão da Meta).
- [ ] **Rota de exclusão de dados** a pedido do usuário (LGPD).
- [ ] **Backup do Supabase** — confira a política de retenção do seu plano.

---

## Uma observação sobre o webhook na Vercel

A Vercel às vezes já interpreta o JSON antes de entregar à função, e a
assinatura do provedor é calculada sobre os **bytes originais**. O código em
`api/[[...rota]].js` remonta a string quando isso acontece, o que funciona na
maioria dos casos.

Se a assinatura falhar em produção com corpo válido, a causa é essa: configure
o webhook para chegar como corpo cru, ou compare com o `bruto` que fica salvo
na tabela `eventos_pagamento` — ele mostra exatamente o que a função recebeu.

---

## Como o produto funciona

**Lançamento por link ou manual.** Colar o link de um Reels identifica rede e
formato sozinho; a agência digita quatro números. Funciona no primeiro dia,
sem depender de aprovação de API.

**Diagnóstico no servidor** (`src/metricas.js`). Se estivesse no navegador,
qualquer concorrente copiaria as regras abrindo o código-fonte da página.

**Resultado comercial.** Um número por mês — pedidos, agendamentos, consultas
— cruzado com o esforço de conteúdo. Todo texto diz **"andou junto com"**,
nunca "causou": no primeiro mês em que o número cair, uma ferramenta que
prometeu causalidade coloca a agência numa reunião impossível de defender.

**Relatório do cliente final** em `/r/<token>`, liberado do plano Agência.

---

## Planos

| Plano | Preço | Clientes | Extras |
|---|---|---|---|
| Essencial | R$ 97 | 5 | diagnóstico, resultado, PDF |
| Agência | R$ 197 | 15 | acesso do cliente final, marca no PDF, alertas |
| Estúdio | R$ 397 | 40 | vários usuários, suporte prioritário |

Valores são proposta. Ajuste em `src/planos.js` e na página de vendas.

---

## Quando crescer

O adaptador do Supabase usa a API REST, que é ótima até dezenas de milhares
de linhas por tabela. Quando o volume justificar, troque
`src/repo-supabase.js` por conexão direta ao Postgres — a interface é a
mesma, e nenhum outro arquivo muda. Foi para isso que a camada existe.
