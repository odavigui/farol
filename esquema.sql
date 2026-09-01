-- =====================================================================
-- Farol — esquema para Supabase (Postgres)
--
-- COMO USAR
--   Supabase -> SQL Editor -> New query -> cole isto tudo -> Run.
--   Pode rodar de novo sem medo: tudo é "if not exists".
--
-- SOBRE SEGURANÇA (importante)
--   O servidor acessa o banco com a SERVICE ROLE KEY, que ignora Row Level
--   Security por definição. Quem separa uma agência da outra é o código em
--   src/api.js, que filtra por conta_id em toda consulta.
--
--   Mesmo assim, o RLS abaixo fica LIGADO e sem nenhuma policy permissiva.
--   Isso é de propósito: se um dia a chave anônima (anon key) vazar ou for
--   usada por engano no navegador, ela não lê nada. É a rede de segurança
--   para o erro mais comum de quem usa Supabase.
-- =====================================================================

create table if not exists contas (
  id            text primary key,
  agencia       text not null,
  email         text not null unique,
  senha_hash    text not null,
  senha_salt    text not null,
  plano         text not null default 'essencial',
  status        text not null default 'teste',
  teste_ate     timestamptz,
  cliente_pag   text,
  assinatura_id text,
  criada_em     timestamptz not null default now()
);

create table if not exists sessoes (
  token     text primary key,
  conta_id  text not null references contas(id) on delete cascade,
  criada_em timestamptz not null default now(),
  expira_em timestamptz not null,
  ip        text
);
create index if not exists ix_sessoes_conta  on sessoes(conta_id);
create index if not exists ix_sessoes_expira on sessoes(expira_em);

create table if not exists clientes (
  id         text primary key,
  conta_id   text not null references contas(id) on delete cascade,
  nome       text not null,
  ramo       text not null default '',
  seguidores integer not null default 0,
  plano_txt  text not null default '',
  contrato   integer not null default 0,
  metrica    text not null default 'resultados',
  metrica_s  text not null default 'resultado',
  token_rel  text not null unique,
  arquivado  boolean not null default false,
  criado_em  timestamptz not null default now()
);
create index if not exists ix_clientes_conta on clientes(conta_id, arquivado);

create table if not exists publicacoes (
  id         text primary key,
  cliente_id text not null references clientes(id) on delete cascade,
  titulo     text not null,
  url        text,
  plataforma text not null,
  formato    text not null,
  publicada  timestamptz not null,
  hora       integer not null default 12,
  alcance    integer not null default 0,
  views      integer not null default 0,
  interacoes integer not null default 0,
  salvos     integer not null default 0,
  cliques    integer not null default 0,
  auto       boolean not null default false,
  criada_em  timestamptz not null default now()
);
create index if not exists ix_pub_cliente on publicacoes(cliente_id, publicada desc);

create table if not exists resultados (
  id          text primary key,
  cliente_id  text not null references clientes(id) on delete cascade,
  competencia text not null,
  rotulo      text not null,
  posts       integer not null default 0,
  reels       integer not null default 0,
  alcance     integer not null default 0,
  resultado   integer not null default 0,
  criado_em   timestamptz not null default now(),
  unique (cliente_id, competencia)
);

create table if not exists conexoes (
  cliente_id  text primary key references clientes(id) on delete cascade,
  rede        text not null default 'instagram',
  conta_rede  text,
  token       text,
  expira_em   timestamptz,
  ligada_em   timestamptz,
  ultima_sinc timestamptz
);

create table if not exists tentativas_login (
  chave    text primary key,
  contagem integer not null default 0,
  ate      timestamptz not null
);

create table if not exists recuperacoes (
  id        text primary key,
  conta_id  text not null references contas(id) on delete cascade,
  hash      text not null unique,   -- guardamos o hash do token, nunca o token
  expira_em timestamptz not null,
  usado_em  timestamptz,
  criado_em timestamptz not null default now(),
  ip        text
);
create index if not exists ix_rec_conta on recuperacoes(conta_id);
create index if not exists ix_rec_expira on recuperacoes(expira_em);

create table if not exists eventos_pagamento (
  id       text primary key,
  conta_id text,
  tipo     text not null,
  bruto    text not null,
  recebido timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- RLS ligado, sem policy: nada é legível pela chave anônima.
-- O servidor usa a service role key, que passa por cima disto.
-- ---------------------------------------------------------------------
alter table contas            enable row level security;
alter table sessoes           enable row level security;
alter table clientes          enable row level security;
alter table publicacoes       enable row level security;
alter table resultados        enable row level security;
alter table conexoes          enable row level security;
alter table tentativas_login  enable row level security;
alter table recuperacoes      enable row level security;
alter table eventos_pagamento enable row level security;

-- ---------------------------------------------------------------------
-- Limpeza de sessões vencidas.
-- Na Vercel não existe processo rodando o tempo todo para fazer isso, então
-- a limpeza acontece de duas formas: o servidor apaga a sessão vencida assim
-- que alguém tenta usá-la, e você pode agendar esta função no Supabase
-- (Database -> Cron) para rodar uma vez por dia.
-- ---------------------------------------------------------------------
create or replace function limpar_sessoes_vencidas()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare apagadas integer;
begin
  delete from sessoes where expira_em < now();
  get diagnostics apagadas = row_count;
  delete from tentativas_login where ate < now();
  delete from recuperacoes where expira_em < now();
  return apagadas;
end;
$$;
