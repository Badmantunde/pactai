# Pactai — Claude Code Guidelines

## Project Overview

Pactai is a financial workflow AI agent that operates inside WhatsApp chats and groups.
It acts as a neutral project moderator, invoice generator, escrow coordinator, and payroll assistant between freelancers, clients, and teams.

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 20+ with TypeScript | Type safety, ecosystem |
| WhatsApp | @whiskeysockets/baileys | Open source, no Meta approval needed for MVP |
| AI | Anthropic Claude API (claude-sonnet-4-6) | Best-in-class reasoning for financial flows |
| Database | PostgreSQL + Prisma ORM | Relational integrity for financial records |
| Validation | Zod | Runtime schema validation |
| Queue | BullMQ + Redis | Async message processing |
| Container | Docker + docker-compose | Reproducible environments |

## Project Structure

```
pactai/
├── CLAUDE.md
├── prisma/
│   └── schema.prisma          # Database models
└── src/
    ├── index.ts               # App entry point
    ├── config/index.ts        # Env config (typed)
    ├── database/index.ts      # Prisma client singleton
    ├── whatsapp/
    │   ├── client.ts          # Baileys WhatsApp client
    │   └── handlers/
    │       └── message.handler.ts  # Routes incoming messages
    ├── agent/
    │   ├── index.ts           # Claude AI agent orchestrator
    │   └── system-prompt.ts   # Pactai system prompt
    ├── modules/
    │   ├── project/           # Project lifecycle management
    │   ├── invoice/           # Invoice generation
    │   ├── escrow/            # Escrow lock/release logic
    │   ├── payroll/           # Payroll batch processing
    │   └── dispute/           # Dispute intake and freeze
    └── utils/
        ├── audit.ts           # Audit trail logger
        └── formatters.ts      # WhatsApp message formatters
```

## Core Rules (Never Break These)

1. **No silent financial actions** — every escrow, release, or payroll action requires explicit user confirmation (YES/NO).
2. **No fabricated data** — never guess or generate fake payment confirmations, invoice IDs, or account numbers.
3. **Audit every action** — every financial event must be written to the `AuditLog` table with actor, action, and timestamp.
4. **Dispute = freeze** — when a dispute is opened, ALL payment releases for that project are blocked until resolved.
5. **Payroll = private chat only** — never process payroll from a group chat.
6. **Always show summary before acting** — preview invoice / payroll / project before committing.

## Environment Variables

See `.env.example` for required variables. Never commit `.env`.

## Database

- Run `npx prisma migrate dev` to apply schema changes locally.
- Run `npx prisma studio` to browse data.
- Never edit `prisma/schema.prisma` without creating a migration.

## Development Commands

```bash
npm run dev        # Start with hot reload (ts-node-dev)
npm run build      # Compile TypeScript
npm start          # Run compiled output
npm run db:migrate # Apply Prisma migrations
npm run db:studio  # Open Prisma Studio
npm run lint       # ESLint check
npm run typecheck  # tsc --noEmit
```

## WhatsApp Session

Baileys stores session credentials in `./auth_info_baileys/`. This folder is gitignored.
On first run, scan the QR code printed in the terminal with your WhatsApp app.

## Agent Behavior Contract

The Claude agent receives:
- `chatId` — the WhatsApp chat/group ID
- `senderId` — the sender's phone number
- `message` — the raw text
- `context` — project state from DB (if any)

It must return:
- `reply` — the formatted WhatsApp reply string
- `actions` — array of structured actions to execute (e.g., `CREATE_PROJECT`, `RELEASE_ESCROW`)

Actions are executed by the action dispatcher AFTER the agent confirms them. The agent never directly mutates the database.

## Code Style

- Use `async/await`, never raw Promise chains.
- Use Zod for all external input validation.
- Use named exports, not default exports (easier to refactor).
- Keep modules single-responsibility.
- All financial amounts are stored as integers in the smallest currency unit (e.g., kobo for NGN, cents for USD).
