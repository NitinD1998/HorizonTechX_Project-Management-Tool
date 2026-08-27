import type { ServerWebSocket } from "bun"
import { db, enrichedCardSql, newToken, nowIso, type UserRow } from "./db"

const PORT = Number(process.env.PORT || 3777)
const SESSION_DAYS = 30

type WsData = { userId: number }
type Ctx = { params: Record<string, string>; body: any; user: UserRow }

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}

function num(v: string | undefined): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Invalid id")
  return n
}

function str(body: any, key: string, label?: string): string {
  const v = typeof body?.[key] === "string" ? body[key].trim() : ""
  if (!v) throw new HttpError(400, `${label || key} is required`)
  return v
}

async function readJson(req: Request) {
  try {
    return await req.json()
  } catch {
    return {}
  }
}

function tokenUser(token: string | null): UserRow | null {
  if (!token) return null
  const row = db.query(`SELECT u.id, u.email, u.name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token) as any
  if (!row) return null
  if (row.expires_at < Date.now()) {
    db.query("DELETE FROM sessions WHERE token = ?").run(token)
    return null
  }
  return { id: row.id, email: row.email, name: row.name }
}

async function auth(req: Request): Promise<UserRow | null> {
  const header = req.headers.get("authorization")
  return header?.startsWith("Bearer ") ? tokenUser(header.slice(7)) : null
}

const sockets = new Map<number, Set<ServerWebSocket<WsData>>>()

function sendToUser(userId: number, event: any) {
  const set = sockets.get(userId)
  if (!set) return
  const payload = JSON.stringify(event)
  for (const ws of set) if (ws.readyState === 1) ws.send(payload)
}

function publish(projectId: number, type: string, data: any, actorId?: number) {
  const rows = db.query("SELECT user_id FROM project_members WHERE project_id = ?").all(projectId) as any[]
  for (const r of rows) {
    if (r.user_id === actorId) continue
    sendToUser(r.user_id, { type, projectId, actor: actorId ?? null, data })
  }
}

function notifyUser(targetUserId: number, actor: UserRow | null, n: { type: string; message: string; projectId?: number | null; cardId?: number | null }) {
  if (actor && actor.id === targetUserId) return
  const res = db
    .query("INSERT INTO notifications (user_id, type, message, project_id, card_id, read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
    .run(targetUserId, n.type, n.message, n.projectId ?? null, n.cardId ?? null, nowIso())
  const row = db.query("SELECT * FROM notifications WHERE id = ?").get(Number(res.lastInsertRowid))
  sendToUser(targetUserId, { type: "notification", data: row })
}

type Handler = (ctx: Ctx) => Response | Promise<Response>
type RouteDef = { method: string; parts: string[]; handler: Handler; isPublic: boolean }

const routes: RouteDef[] = []

function on(method: string, pattern: string, handler: Handler, opts: { public?: boolean } = {}) {
  routes.push({ method, parts: pattern.split("/").filter(Boolean), handler, isPublic: !!opts.public })
}

async function dispatch(req: Request, pathname: string): Promise<Response | undefined> {
  const segs = pathname.split("/").filter(Boolean)
  for (const r of routes) {
    if (r.method !== req.method || r.parts.length !== segs.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (let i = 0; i < segs.length; i++) {
      const p = r.parts[i]
      if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(segs[i])
      else if (p !== segs[i]) {
        matched = false
        break
      }
    }
    if (!matched) continue
    let user: UserRow | null = null
    if (!r.isPublic) {
      user = await auth(req)
      if (!user) return json({ error: "Unauthorized" }, 401)
    }
    const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await readJson(req) : {}
    return await r.handler({ req, params, body, user: user! })
  }
}

on("GET", "/api/health", () => json({ ok: true }), { public: true })

on("POST", "/api/auth/register", async ({ body }) => {
  const email = str(body, "email", "Email").toLowerCase()
  const name = str(body, "name", "Name")
  const password = typeof body.password === "string" ? body.password : ""
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, "Invalid email")
  if (password.length < 6) throw new HttpError(400, "Password must be at least 6 characters")
  if (db.query("SELECT 1 FROM users WHERE email = ?").get(email)) throw new HttpError(409, "Email already registered")
  const hash = await Bun.password.hash(password)
  const res = db.query("INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)").run(email, name, hash, nowIso())
  const user = { id: Number(res.lastInsertRowid), email, name }
  return json(createSession(user), 201)
}, { public: true })

on("POST", "/api/auth/login", async ({ body }) => {
  const email = String(body.email || "").toLowerCase().trim()
  const password = String(body.password || "")
  const row = db.query("SELECT * FROM users WHERE email = ?").get(email) as any
  if (!row || !(await Bun.password.verify(password, row.password_hash))) throw new HttpError(401, "Invalid email or password")
  const user = { id: row.id, email: row.email, name: row.name }
  return json(createSession(user))
}, { public: true })

on("POST", "/api/auth/logout", async ({ req }) => {
  const header = req.headers.get("authorization")
  if (header?.startsWith("Bearer ")) db.query("DELETE FROM sessions WHERE token = ?").run(header.slice(7))
  return json({ ok: true })
}, { public: true })

on("GET", "/api/auth/me", ({ user }) => json({ user }))

function createSession(user: UserRow) {
  const token = newToken()
  db.query("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
    token,
    user.id,
    Date.now() + SESSION_DAYS * 86400_000,
    nowIso(),
  )
  return { token, user }
}

on("GET", "/api/projects", ({ user }) => {
  const rows = db
    .query(
      `SELECT p.*, m.role,
        (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id) AS member_count,
        (SELECT COUNT(*) FROM cards c JOIN lists l ON l.id = c.list_id WHERE l.project_id = p.id) AS card_count
       FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
       ORDER BY p.created_at DESC`,
    )
    .all(user.id)
  return json({ projects: rows })
})

on("POST", "/api/projects", ({ user, body }) => {
  const name = str(body, "name", "Project name")
  const res = db.query("INSERT INTO projects (name, description, owner_id, created_at) VALUES (?, ?, ?, ?)").run(
    name,
    String(body.description || ""),
    user.id,
    nowIso(),
  )
  const projectId = Number(res.lastInsertRowid)
  db.query("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(projectId, user.id, nowIso())
  const defaults = ["To Do", "In Progress", "Done"]
  defaults.forEach((n, i) => db.query("INSERT INTO lists (project_id, name, position, created_at) VALUES (?, ?, ?, ?)").run(projectId, n, (i + 1) * 1000, nowIso()))
  return json({ project: projectDetail(user, projectId).project }, 201)
})

function requireMember(userId: number, projectId: number) {
  const m = db.query("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?").get(projectId, userId) as any
  if (!m) throw new HttpError(403, "Not a project member")
  return m
}

function requireOwner(userId: number, projectId: number) {
  const m = requireMember(userId, projectId)
  if (m.role !== "owner") throw new HttpError(403, "Only the project owner can do that")
}

function projectDetail(user: UserRow, projectId: number) {
  requireMember(user.id, projectId)
  const project = db.query("SELECT * FROM projects WHERE id = ?").get(projectId) as any
  if (!project) throw new HttpError(404, "Project not found")
  const members = db
    .query(
      `SELECT u.id, u.name, u.email, m.role FROM project_members m JOIN users u ON u.id = m.user_id
       WHERE m.project_id = ? ORDER BY m.created_at`,
    )
    .all(projectId)
  const lists = db.query("SELECT * FROM lists WHERE project_id = ? ORDER BY position").all(projectId)
  const cards = db
    .query(
      `SELECT c.*, u.name AS assignee_name, (SELECT COUNT(*) FROM comments cm WHERE cm.card_id = c.id) AS comment_count
       FROM cards c LEFT JOIN users u ON u.id = c.assignee_id JOIN lists l ON l.id = c.list_id
       WHERE l.project_id = ? ORDER BY c.position`,
    )
    .all(projectId)
  return { project, members, lists, cards }
}

on("GET", "/api/projects/:id", ({ user, params }) => json(projectDetail(user, num(params.id))))

on("PATCH", "/api/projects/:id", ({ user, params, body }) => {
  const projectId = num(params.id)
  requireOwner(user.id, projectId)
  if (typeof body.name === "string" && body.name.trim()) db.query("UPDATE projects SET name = ? WHERE id = ?").run(body.name.trim(), projectId)
  if (typeof body.description === "string") db.query("UPDATE projects SET description = ? WHERE id = ?").run(body.description, projectId)
  const project = db.query("SELECT * FROM projects WHERE id = ?").get(projectId)
  publish(projectId, "project.updated", { project }, user.id)
  return json({ project })
})

on("DELETE", "/api/projects/:id", ({ user, params }) => {
  const projectId = num(params.id)
  requireOwner(user.id, projectId)
  db.query("DELETE FROM projects WHERE id = ?").run(projectId)
  publish(projectId, "project.deleted", { id: projectId }, user.id)
  return json({ ok: true })
})

on("POST", "/api/projects/:id/members", ({ user, params, body }) => {
  const projectId = num(params.id)
  requireMember(user.id, projectId)
  const email = str(body, "email", "Email").toLowerCase()
  const target = db.query("SELECT id, name, email FROM users WHERE email = ?").get(email) as any
  if (!target) throw new HttpError(404, "No user found with that email")
  const existing = db.query("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?").get(projectId, target.id)
  if (existing) throw new HttpError(409, "Already a member")
  db.query("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").run(projectId, target.id, nowIso())
  const member = { id: target.id, name: target.name, email: target.email, role: "member" }
  const project = db.query("SELECT name FROM projects WHERE id = ?").get(projectId) as any
  notifyUser(target.id, user, { type: "member_added", message: `${user.name} added you to "${project.name}"`, projectId })
  publish(projectId, "member.added", { member, projectId }, user.id)
  return json({ member }, 201)
})

on("DELETE", "/api/projects/:id/members/:userId", ({ user, params }) => {
  const projectId = num(params.id)
  const targetId = num(params.userId)
  if (targetId !== user.id) requireOwner(user.id, projectId)
  const removed = db.query("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(projectId, targetId)
  if (removed.changes === 0) throw new HttpError(404, "Not a member")
  publish(projectId, "member.removed", { userId: targetId, projectId }, user.id)
  return json({ ok: true })
})

function listById(listId: number) {
  const list = db.query("SELECT * FROM lists WHERE id = ?").get(listId) as any
  if (!list) throw new HttpError(404, "List not found")
  return list
}

function cardById(cardId: number) {
  const card = db.query(enrichedCardSql).get(cardId) as any
  if (!card) throw new HttpError(404, "Card not found")
  return card
}

on("POST", "/api/projects/:id/lists", ({ user, params, body }) => {
  const projectId = num(params.id)
  requireMember(user.id, projectId)
  const name = str(body, "name", "List name")
  const max = (db.query("SELECT COALESCE(MAX(position), 0) AS p FROM lists WHERE project_id = ?").get(projectId) as any).p
  const res = db.query("INSERT INTO lists (project_id, name, position, created_at) VALUES (?, ?, ?, ?)").run(projectId, name, max + 1000, nowIso())
  const list = listById(Number(res.lastInsertRowid))
  publish(projectId, "list.created", { list }, user.id)
  return json({ list }, 201)
})

function guardListAccess(user: UserRow, listId: number) {
  const list = listById(listId)
  requireMember(user.id, list.project_id)
  return list
}

on("PATCH", "/api/lists/:id", ({ user, params, body }) => {
  const list = guardListAccess(user, num(params.id))
  if (typeof body.name === "string" && body.name.trim()) db.query("UPDATE lists SET name = ? WHERE id = ?").run(body.name.trim(), list.id)
  if (typeof body.position === "number") db.query("UPDATE lists SET position = ? WHERE id = ?").run(body.position, list.id)
  const updated = listById(list.id)
  publish(list.project_id, "list.updated", { list: updated }, user.id)
  return json({ list: updated })
})

on("DELETE", "/api/lists/:id", ({ user, params }) => {
  const list = guardListAccess(user, num(params.id))
  db.query("DELETE FROM lists WHERE id = ?").run(list.id)
  publish(list.project_id, "list.deleted", { id: list.id }, user.id)
  return json({ ok: true })
})

function validateAssignee(projectId: number, assigneeId: unknown): number | null {
  if (assigneeId === null || assigneeId === undefined || assigneeId === "") return null
  const id = Number(assigneeId)
  if (!Number.isInteger(id)) throw new HttpError(400, "Invalid assignee")
  if (!db.query("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?").get(projectId, id)) throw new HttpError(400, "Assignee must be a project member")
  return id
}

on("POST", "/api/lists/:id/cards", ({ user, params, body }) => {
  const list = guardListAccess(user, num(params.id))
  const title = str(body, "title", "Title")
  const assigneeId = validateAssignee(list.project_id, body.assignee_id)
  const dueDate = typeof body.due_date === "string" && body.due_date ? body.due_date : null
  const max = (db.query("SELECT COALESCE(MAX(position), 0) AS p FROM cards WHERE list_id = ?").get(list.id) as any).p
  const res = db
    .query("INSERT INTO cards (list_id, title, description, assignee_id, due_date, position, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(list.id, title, String(body.description || ""), assigneeId, dueDate, max + 1000, user.id, nowIso())
  const card = cardById(Number(res.lastInsertRowid))
  publish(list.project_id, "card.created", { card }, user.id)
  if (assigneeId) notifyUser(assigneeId, user, { type: "card_assigned", message: `${user.name} assigned you to "${title}"`, projectId: list.project_id, cardId: card.id })
  return json({ card }, 201)
})

function guardCardAccess(user: UserRow, cardId: number) {
  const row = db.query("SELECT l.project_id FROM cards c JOIN lists l ON l.id = c.list_id WHERE c.id = ?").get(cardId) as any
  if (!row) throw new HttpError(404, "Card not found")
  requireMember(user.id, row.project_id)
  return row.project_id as number
}

on("GET", "/api/cards/:id", ({ user, params }) => {
  const cardId = num(params.id)
  guardCardAccess(user, cardId)
  const comments = db
    .query(
      `SELECT cm.*, u.name AS author_name FROM comments cm JOIN users u ON u.id = cm.author_id
       WHERE cm.card_id = ? ORDER BY cm.id`,
    )
    .all(cardId)
  return json({ card: cardById(cardId), comments })
})

on("PATCH", "/api/cards/:id", ({ user, params, body }) => {
  const cardId = num(params.id)
  const projectId = guardCardAccess(user, cardId)
  const prev = db.query("SELECT * FROM cards WHERE id = ?").get(cardId) as any
  const fields: string[] = []
  const values: any[] = []
  if (typeof body.title === "string" && body.title.trim()) (fields.push("title = ?"), values.push(body.title.trim()))
  if (typeof body.description === "string") (fields.push("description = ?"), values.push(body.description))
  if (typeof body.due_date === "string" || body.due_date === null) (fields.push("due_date = ?"), values.push(body.due_date || null))
  if ("assignee_id" in body) {
    const assigneeId = validateAssignee(projectId, body.assignee_id)
    fields.push("assignee_id = ?")
    values.push(assigneeId)
  }
  if (body.list_id !== undefined && Number(body.list_id) !== prev.list_id) {
    const target = listById(Number(body.list_id))
    if (target.project_id !== projectId) throw new HttpError(400, "Cannot move card across projects")
    fields.push("list_id = ?")
    values.push(target.id)
  }
  if (typeof body.position === "number") (fields.push("position = ?"), values.push(body.position))
  if (fields.length) {
    values.push(cardId)
    db.query(`UPDATE cards SET ${fields.join(", ")} WHERE id = ?`).run(...values)
  }
  const card = cardById(cardId)
  const moved = card.list_id !== prev.list_id || card.position !== prev.position
  publish(projectId, moved ? "card.moved" : "card.updated", { card }, user.id)
  if ("assignee_id" in body && card.assignee_id && card.assignee_id !== prev.assignee_id) {
    notifyUser(card.assignee_id, user, { type: "card_assigned", message: `${user.name} assigned you to "${card.title}"`, projectId, cardId })
  }
  return json({ card })
})

on("DELETE", "/api/cards/:id", ({ user, params }) => {
  const cardId = num(params.id)
  const projectId = guardCardAccess(user, cardId)
  db.query("DELETE FROM cards WHERE id = ?").run(cardId)
  publish(projectId, "card.deleted", { id: cardId }, user.id)
  return json({ ok: true })
})

on("POST", "/api/cards/:id/comments", ({ user, params, body }) => {
  const cardId = num(params.id)
  const projectId = guardCardAccess(user, cardId)
  const text = str(body, "body", "Comment")
  const res = db.query("INSERT INTO comments (card_id, author_id, body, created_at) VALUES (?, ?, ?, ?)").run(cardId, user.id, text, nowIso())
  const comment = db
    .query("SELECT cm.*, u.name AS author_name FROM comments cm JOIN users u ON u.id = cm.author_id WHERE cm.id = ?")
    .get(Number(res.lastInsertRowid))
  const card = cardById(cardId)
  publish(projectId, "comment.added", { comment, cardId }, user.id)
  if (card.assignee_id) notifyUser(card.assignee_id, user, { type: "comment", message: `${user.name} commented on "${card.title}"`, projectId, cardId })
  return json({ comment }, 201)
})

on("GET", "/api/notifications", ({ user }) => {
  const items = db.query("SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50").all(user.id)
  const unread = (db.query("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0").get(user.id) as any).c
  return json({ notifications: items, unread })
})

on("POST", "/api/notifications/read", ({ user }) => {
  db.query("UPDATE notifications SET read = 1 WHERE user_id = ?").run(user.id)
  return json({ ok: true })
})

Bun.serve<WsData>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url)
    try {
      if (url.pathname === "/ws") {
        const user = tokenUser(url.searchParams.get("token"))
        if (!user) return json({ error: "Unauthorized" }, 401)
        if (server.upgrade(req, { data: { userId: user.id } })) return undefined
        return json({ error: "Upgrade failed" }, 500)
      }
      if (url.pathname.startsWith("/api/")) {
        const res = await dispatch(req, url.pathname)
        return res ?? json({ error: "Not found" }, 404)
      }
      if (req.method === "GET") {
        const file = Bun.file(`./public${url.pathname === "/" ? "/index.html" : url.pathname}`)
        if (await file.exists()) return new Response(file)
        return new Response(Bun.file("./public/index.html"))
      }
      return json({ error: "Not found" }, 404)
    } catch (err: any) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status)
      console.error(err)
      return json({ error: "Internal server error" }, 500)
    }
  },
  websocket: {
    open(ws) {
      let set = sockets.get(ws.data.userId)
      if (!set) sockets.set(ws.data.userId, (set = new Set()))
      set.add(ws)
    },
    close(ws) {
      sockets.get(ws.data.userId)?.delete(ws)
      if (sockets.get(ws.data.userId)?.size === 0) sockets.delete(ws.data.userId)
    },
    message(ws, msg) {
      if (msg === "ping") ws.send("pong")
    },
  },
})

console.log(`Collaboard running on http://localhost:${PORT}`)
