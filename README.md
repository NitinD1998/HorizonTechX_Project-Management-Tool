# Collaboard

A lightweight, real-time team project management tool built with Bun and SQLite.

## Features

- **Kanban Boards** — Organize work into customizable lists (To Do, In Progress, Done)
- **Real-time Collaboration** — WebSocket-based live updates across all connected clients
- **Team Management** — Invite members by email, assign roles (owner/member)
- **Cards & Comments** — Create tasks with descriptions, assignees, due dates, and threaded comments
- **Notifications** — Get notified when assigned to cards, added to projects, or when someone comments
- **Authentication** — Session-based auth with secure password hashing

## Tech Stack

- **Runtime:** [Bun](https://bun.sh)
- **Database:** SQLite via `bun:sqlite`
- **Frontend:** Vanilla HTML/CSS/JS (single-page app)
- **Real-time:** Bun native WebSockets

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) installed

### Install & Run

```bash
# Install dependencies
bun install

# Seed demo data (optional)
bun run seed

# Start the dev server
bun run dev
```

The app runs at **http://localhost:3777** by default.

### Demo Account

After seeding:

- **Email:** alice@demo.dev
- **Password:** Password123!

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/register` | Create account |
| `POST` | `/api/auth/login` | Sign in |
| `POST` | `/api/auth/logout` | Sign out |
| `GET` | `/api/auth/me` | Current user |
| `GET` | `/api/projects` | List projects |
| `POST` | `/api/projects` | Create project |
| `GET` | `/api/projects/:id` | Get project detail |
| `PATCH` | `/api/projects/:id` | Update project |
| `DELETE` | `/api/projects/:id` | Delete project |
| `POST` | `/api/projects/:id/members` | Add member |
| `DELETE` | `/api/projects/:id/members/:userId` | Remove member |
| `POST` | `/api/projects/:id/lists` | Create list |
| `PATCH` | `/api/lists/:id` | Update list |
| `DELETE` | `/api/lists/:id` | Delete list |
| `POST` | `/api/lists/:id/cards` | Create card |
| `GET` | `/api/cards/:id` | Get card with comments |
| `PATCH` | `/api/cards/:id` | Update/move card |
| `DELETE` | `/api/cards/:id` | Delete card |
| `POST` | `/api/cards/:id/comments` | Add comment |
| `GET` | `/api/notifications` | List notifications |
| `POST` | `/api/notifications/read` | Mark all read |

## WebSocket

Connect to `ws://localhost:3777/ws?token=<session_token>` for real-time events:

- `card.created`, `card.updated`, `card.moved`, `card.deleted`
- `list.created`, `list.updated`, `list.deleted`
- `member.added`, `member.removed`
- `project.updated`, `project.deleted`
- `comment.added`
- `notification`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3777` | Server port |
| `PM_DB` | `data/pm.db` | SQLite database path |

## License

MIT
