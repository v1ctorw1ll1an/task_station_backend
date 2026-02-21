# Prisma — Guia de Uso

Stack: **Prisma ORM** · **PostgreSQL** · **NestJS**

---

## Estrutura da pasta

```
prisma/
├── schema.prisma          # Definição do schema (modelos, enums, datasource)
├── seed.ts                # Script que cria o superusuário inicial
├── migrations/
│   └── 20260220145420_init/
│       └── migration.sql  # Migration inicial com todas as tabelas
└── README.md              # Este arquivo
```

> O Prisma Client é gerado em `src/generated/prisma/` (fora do padrão) conforme configurado no `generator client` do schema.

---

## Variáveis de ambiente necessárias

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | String de conexão com o PostgreSQL |
| `SEED_SUPERUSER_EMAIL` | Email do superusuário criado pelo seed |
| `SEED_SUPERUSER_PASSWORD` | Senha do superusuário criado pelo seed |

---

## Desenvolvimento — banco vazio (primeiro setup)

Execute os comandos na ordem abaixo dentro da pasta `task_station_backend/`:

```bash
# 1. Aplica todas as migrations existentes no banco
pnpm prisma migrate deploy

# 2. Gera o Prisma Client tipado em src/generated/prisma/
pnpm prisma generate

# 3. Cria o superusuário inicial (idempotente — seguro rodar mais de uma vez)
pnpm seed
```

O seed é **idempotente**: verifica se já existe um superusuário antes de criar. Rodá-lo em um banco já populado não duplica dados.

---

## Desenvolvimento — banco já existente (pulls e atualizações de schema)

Quando outro desenvolvedor fizer alterações no schema e criar uma nova migration:

```bash
# Aplica apenas as migrations ainda não aplicadas no seu banco local
pnpm prisma migrate deploy

# Regenera o client com os novos tipos
pnpm prisma generate
```

O Prisma rastreia quais migrations já foram aplicadas na tabela `_prisma_migrations`. Migrations já executadas nunca são reaplicadas.

---

## Criando uma nova migration (ao alterar o schema)

Após modificar o `schema.prisma`:

```bash
# Gera a migration SQL e aplica no banco local automaticamente
pnpm prisma migrate dev --name descricao_da_alteracao
```

Exemplos de nomes descritivos:
- `add_workspace_slug`
- `add_task_tags_table`
- `rename_column_order_to_position`

> **Nunca edite manualmente** um arquivo `.sql` dentro de `migrations/` após ele ter sido aplicado. Crie uma nova migration para corrigir.

---

## Produção — primeiro deploy

```bash
# Aplica as migrations (nunca cria migrations novas, apenas executa as existentes)
pnpm prisma migrate deploy

# Gera o client
pnpm prisma generate

# NÃO rode pnpm seed em produção — o superusuário deve ser criado
# de forma controlada (ex: via variável de ambiente + script manual aprovado)
```

## Produção — deploy com novas migrations

```bash
# Apenas isso — o deploy aplica somente o que ainda não foi executado
pnpm prisma migrate deploy
pnpm prisma generate
```

---

## Produção — banco populado sem histórico de migrations

Se o banco foi criado anteriormente via `prisma db push` (sem migrations), o Prisma não tem registro do que já foi aplicado. Nesse caso:

```bash
# Marca a migration inicial como já aplicada sem executar o SQL
pnpm prisma migrate resolve --applied 20260220145420_init

# A partir daqui, novas migrations funcionam normalmente
pnpm prisma migrate deploy
pnpm prisma generate
```

---

## Referência rápida

| Situação | Comando |
|---|---|
| Banco vazio — aplicar tudo | `prisma migrate deploy` |
| Schema alterado — gerar migration | `prisma migrate dev --name nome` |
| Regenerar o client | `prisma generate` |
| Criar superusuário inicial | `pnpm seed` |
| Inspecionar o banco via UI | `prisma studio` |
| Banco sem histórico de migrations | `prisma migrate resolve --applied <id>` |

---

## Regras do projeto

1. **Nunca use `prisma db push` em produção** — ele sincroniza o schema sem gerar histórico, tornando impossível rastrear o que foi alterado.
2. **Nunca use `prisma migrate dev` em produção** — ele pode apagar dados ao detectar drift entre o schema e o banco.
3. **Nunca edite o conteúdo de uma migration já aplicada** — crie uma nova migration para corrigir.
4. **O seed nunca roda automaticamente em produção** — é sempre uma execução manual e consciente.
5. **O Prisma Client gerado (`src/generated/prisma/`) não deve ser commitado** — ele é gerado via `prisma generate` em cada ambiente.
