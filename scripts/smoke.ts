const BASE = process.env.BASE_URL || "http://localhost:3777"
const suffix = Date.now()

let failures = 0

function check(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.error(`FAIL  ${name} ${extra}`)
  }
}

async function j(method: string, path: string, body?: any, token?: string) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

function waitFor<T>(poll: () => T | undefined | null, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const timer = setInterval(() => {
      const v = poll()
      if (v) {
        clearInterval(timer)
        resolve(v)
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer)
        reject(new Error("timeout waiting for condition"))
      }
    }, 100)
  })
}

const health = await fetch(`${BASE}/api/health`)
check("health endpoint", health.ok)

const html = await fetch(BASE).then((r) => r.text())
check("static index served", html.includes('id="auth-view"'))

const noAuth = await j("GET", "/api/projects")
check("auth required", noAuth.status === 401)

const regA = await j("POST", "/api/auth/register", { name: `Alice ${suffix}`, email: `alice${suffix}@t.dev`, password: "secret1" })
check("register alice", regA.status === 201 && !!regA.data.token)
const alice = { token: regA.data.token as string, id: regA.data.user.id as number }

const dup = await j("POST", "/api/auth/register", { name: "X", email: `alice${suffix}@t.dev`, password: "secret1" })
check("duplicate email rejected", dup.status === 409)

const badLogin = await j("POST", "/api/auth/login", { email: `alice${suffix}@t.dev`, password: "wrong" })
check("bad login rejected", badLogin.status === 401)

const regB = await j("POST", "/api/auth/register", { name: `Bob ${suffix}`, email: `bob${suffix}@t.dev`, password: "secret1" })
const bob = { token: regB.data.token as string, id: regB.data.user.id as number }
check("register bob", regB.status === 201)

const proj = await j("POST", "/api/projects", { name: "Smoke Project" }, alice.token)
check("project created with default lists", proj.status === 201 && proj.data.project && proj.data.lists_count !== 0)
const projectId = proj.data.project.id as number

const detail = await j("GET", `/api/projects/${projectId}`, undefined, alice.token)
check("default lists exist", Array.isArray(detail.data.lists) && detail.data.lists.length === 3)
const todoListId = detail.data.lists[0].id as number

const forbidden = await j("GET", `/api/projects/${projectId}`, undefined, bob.token)
check("non-member blocked", forbidden.status === 403)

const addMember = await j("POST", `/api/projects/${projectId}/members`, { email: `bob${suffix}@t.dev` }, alice.token)
check("bob added to project", addMember.status === 201)

const wsMessages: any[] = []
const ws = new WebSocket(`ws://localhost:3777/ws?token=${bob.token}`)
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve()
  ws.onerror = () => reject(new Error("ws failed to open"))
})
ws.onmessage = (e) => {
  try {
    wsMessages.push(JSON.parse(String(e.data)))
  } catch {}
}
check("websocket connected", true)

const card = await j("POST", `/api/lists/${todoListId}/cards`, { title: "Smoke card" }, alice.token)
check("card created", card.status === 201)
const cardId = card.data.card.id as number

await j("PATCH", `/api/cards/${cardId}`, { assignee_id: bob.id }, alice.token)

const notifEvent = await waitFor(() => wsMessages.find((m) => m.type === "notification" && /assigned you/.test(m.data.message)))
check("ws assignment notification delivered", !!notifEvent)

const moved = await j("PATCH", `/api/cards/${cardId}`, { list_id: detail.data.lists[1].id }, alice.token)
check("card moved between lists", moved.status === 200 && moved.data.card.list_id === detail.data.lists[1].id)

const moveEvent = await waitFor(() => wsMessages.find((m) => m.type === "card.moved"))
check("ws card.moved broadcast", !!moveEvent)

const comment = await j("POST", `/api/cards/${cardId}/comments`, { body: "hello from smoke test" }, alice.token)
check("comment created", comment.status === 201)

const commentEvent = await waitFor(() => wsMessages.find((m) => m.type === "comment.added"))
check("ws comment.added broadcast", !!commentEvent)

const commentNotif = await waitFor(
  () => wsMessages.filter((m) => m.type === "notification").length >= 2 ? wsMessages.filter((m) => m.type === "notification")[1] : undefined,
)
check("ws comment notification delivered", !!commentNotif)

const notifs = await j("GET", "/api/notifications", undefined, bob.token)
check("notifications listed with unread count", notifs.status === 200 && notifs.data.unread >= 2)

const readAll = await j("POST", "/api/notifications/read", {}, bob.token)
const notifs2 = await j("GET", "/api/notifications", undefined, bob.token)
check("mark all read works", readAll.status === 200 && notifs2.data.unread === 0)

const bobProjects = await j("GET", "/api/projects", undefined, bob.token)
check("project visible to member", bobProjects.data.projects.some((p: any) => p.id === projectId))

const listDelete = await j("DELETE", `/api/lists/${detail.data.lists[2].id}`, undefined, alice.token)
check("list deleted", listDelete.status === 200)

const delProjForbidden = await j("DELETE", `/api/projects/${projectId}`, undefined, bob.token)
check("only owner can delete project", delProjForbidden.status === 403)

ws.close()

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
