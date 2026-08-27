import { db } from "./db"

const existing = db.query("SELECT COUNT(*) AS c FROM users").get() as any
if (existing.c > 0) {
  console.log("Seed skipped: users already exist. Delete the data/ folder to re-seed.")
  process.exit(0)
}

const now = new Date().toISOString()
const insertUser = db.query("INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)")
const users = [] as any[]
for (const u of [
  { email: "alice@demo.dev", name: "Alice Chen" },
  { email: "bob@demo.dev", name: "Bob Park" },
  { email: "carol@demo.dev", name: "Carol Diaz" },
]) {
  const hash = await Bun.password.hash("Password123!")
  const res = insertUser.run(u.email, u.name, hash, now)
  users.push({ id: Number(res.lastInsertRowid), ...u })
}
const [alice, bob, carol] = users

const projRes = db
  .query("INSERT INTO projects (name, description, owner_id, created_at) VALUES (?, ?, ?, ?)")
  .run("Website Redesign", "Refresh the marketing site before the product launch.", alice.id, now)
const projectId = Number(projRes.lastInsertRowid)

for (const m of [alice, bob, carol]) {
  db.query("INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(
    projectId,
    m.id,
    m.id === alice.id ? "owner" : "member",
    now,
  )
}

const listNames = ["Backlog", "In Progress", "Review", "Done"]
const listIds: number[] = []
listNames.forEach((name, i) => {
  const res = db.query("INSERT INTO lists (project_id, name, position, created_at) VALUES (?, ?, ?, ?)").run(projectId, name, (i + 1) * 1000, now)
  listIds.push(Number(res.lastInsertRowid))
})

function day(offset: number) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toISOString().slice(0, 10)
}

const cards = [
  { list: 0, title: "Audit current site content", assignee: carol.id, due: day(-2) },
  { list: 0, title: "Competitor visual research", assignee: null, due: day(5) },
  { list: 1, title: "Design new hero section", assignee: bob.id, due: day(1) },
  { list: 1, title: "Rewrite pricing page copy", assignee: alice.id, due: day(3) },
  { list: 2, title: "Mobile navigation prototype", assignee: bob.id, due: day(-1) },
  { list: 3, title: "Set up design tokens", assignee: alice.id, due: day(-6) },
  { list: 3, title: "Kickoff meeting notes", assignee: carol.id, due: null },
]
const cardIds: number[] = []
for (const c of cards) {
  const res = db
    .query("INSERT INTO cards (list_id, title, description, assignee_id, due_date, position, created_by, created_at) VALUES (?, ?, '', ?, ?, ?, ?, ?)")
    .run(listIds[c.list], c.title, c.assignee, c.due, (cardIds.length + 1) * 1000, alice.id, now)
  cardIds.push(Number(res.lastInsertRowid))
}

db.query("INSERT INTO comments (card_id, author_id, body, created_at) VALUES (?, ?, ?, ?)").run(
  cardIds[2],
  carol.id,
  "Love the direction — can we try a version with the illustration on the right?",
  now,
)
db.query("INSERT INTO comments (card_id, author_id, body, created_at) VALUES (?, ?, ?, ?)").run(
  cardIds[2],
  alice.id,
  "Sure, I'll mock both up today.",
  now,
)

console.log("Seeded demo data.")
console.log("Log in with any of: alice@demo.dev | bob@demo.dev | carol@demo.dev  (password: Password123!)")
