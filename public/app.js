const $ = (sel) => document.querySelector(sel)

const state = {
  token: localStorage.getItem("pm_token") || null,
  me: null,
  projects: [],
  current: null,
  notifications: [],
  unread: 0,
  ws: null,
  modalCardId: null,
  pendingCardId: null,
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: {
      "content-type": "application/json",
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/api/auth/") && state.me) return doLogout()
    throw new Error(data.error || res.statusText)
  }
  return data
}

function toast(msg, isError = false) {
  const el = document.createElement("div")
  el.className = "toast" + (isError ? " error" : "")
  el.textContent = msg
  $("#toasts").appendChild(el)
  const kill = () => {
    el.classList.add("out")
    setTimeout(() => el.remove(), 260)
  }
  el.onclick = kill
  setTimeout(kill, 4200)
}

function initials(name) {
  return String(name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("")
}

function avatarHtml(id, name, extraClass = "") {
  const hue = ((id || 0) * 137) % 360
  return `<span class="avatar ${extraClass}" style="background:hsl(${hue} 62% 46%)" title="${esc(name)}">${esc(initials(name))}</span>`
}

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 45) return "just now"
  if (s < 3600) return Math.floor(s / 60) + "m ago"
  if (s < 86400) return Math.floor(s / 3600) + "h ago"
  if (s < 7 * 86400) return Math.floor(s / 86400) + "d ago"
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function dueInfo(due) {
  if (!due) return null
  const d = new Date(due + "T23:59:59")
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const days = Math.floor((d - today) / 86400000)
  const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
  if (days < 0) return { label, cls: "overdue", text: "Overdue" }
  if (days <= 3) return { label, cls: "due-soon", text: "Due soon" }
  return { label, cls: "", text: "" }
}

/* ---------------- auth ---------------- */

$("#tab-login").onclick = () => switchTab(true)
$("#tab-register").onclick = () => switchTab(false)

function switchTab(login) {
  $("#tab-login").classList.toggle("active", login)
  $("#tab-register").classList.toggle("active", !login)
  $("#login-form").classList.toggle("hidden", !login)
  $("#register-form").classList.toggle("hidden", login)
}

async function handleAuth(form, path) {
  const fd = new FormData(form)
  try {
    const data = await api(path, { method: "POST", body: Object.fromEntries(fd) })
    state.token = data.token
    localStorage.setItem("pm_token", data.token)
    state.me = data.user
    form.reset()
    enterApp()
  } catch (err) {
    toast(err.message, true)
  }
}

$("#login-form").addEventListener("submit", (e) => {
  e.preventDefault()
  handleAuth(e.target, "/api/auth/login")
})
$("#register-form").addEventListener("submit", (e) => {
  e.preventDefault()
  handleAuth(e.target, "/api/auth/register")
})

function doLogout(callApi = true) {
  if (callApi && state.token) api("/api/auth/logout", { method: "POST" }).catch(() => {})
  localStorage.removeItem("pm_token")
  if (state.ws) {
    state.ws.onclose = null
    state.ws.close()
  }
  location.reload()
}

$("#btn-logout").onclick = () => doLogout()

async function enterApp() {
  $("#auth-view").classList.add("hidden")
  $("#app-view").classList.remove("hidden")
  $("#user-chip").innerHTML = `${avatarHtml(state.me.id, state.me.name)} ${esc(state.me.name)}`
  connectWs()
  await Promise.all([loadProjects(), loadNotifications()])
}

/* ---------------- projects ---------------- */

async function loadProjects() {
  const data = await api("/api/projects")
  state.projects = data.projects
  renderSidebar()
}

function renderSidebar() {
  $("#sidebar-projects").innerHTML =
    state.projects
      .map(
        (p) => `
      <div class="proj-item ${state.current?.project.id === p.id ? "active" : ""}" data-id="${p.id}">
        <div class="meta">
          <div class="name">${esc(p.name)}</div>
          <div class="sub">${p.member_count} member${p.member_count === 1 ? "" : "s"} · ${p.card_count} card${p.card_count === 1 ? "" : "s"}</div>
        </div>
        ${p.owner_id === state.me.id ? `<button class="icon-btn proj-del" data-del-project="${p.id}" title="Delete project">×</button>` : ""}
      </div>`,
      )
      .join("") || `<p style="color:var(--muted);padding:6px 10px;font-size:13px">No projects yet.</p>`
}

$("#sidebar-projects").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del-project]")
  if (del) {
    e.stopPropagation()
    if (!confirm("Delete this project and everything in it?")) return
    try {
      await api(`/api/projects/${del.dataset.delProject}`, { method: "DELETE" })
      if (state.current?.project.id === Number(del.dataset.delProject)) {
        state.current = null
        closeModal()
        renderBoardEmpty()
      }
      await loadProjects()
    } catch (err) {
      toast(err.message, true)
    }
    return
  }
  const item = e.target.closest(".proj-item")
  if (item) selectProject(Number(item.dataset.id))
})

async function selectProject(id) {
  try {
    state.current = await api(`/api/projects/${id}`)
    renderSidebar()
    renderBoard()
    if (state.pendingCardId) {
      openCardModal(state.pendingCardId)
      state.pendingCardId = null
    }
  } catch (err) {
    toast(err.message, true)
  }
}

async function reloadProject() {
  if (!state.current) return
  const id = state.current.project.id
  state.current = await api(`/api/projects/${id}`)
  renderBoard()
}

$("#btn-new-project").onclick = () => {
  openModal(`
    <h2>New project</h2>
    <form id="new-project-form">
      <div class="row">
        <label class="field" style="flex:1">Name<input type="text" name="name" required placeholder="Website Redesign" /></label>
      </div>
      <div class="row"><label class="field" style="flex:1">Description<textarea class="desc-area" name="description" placeholder="What is this project about?"></textarea></label></div>
      <div class="modal-foot"><span></span><button class="btn primary">Create project</button></div>
    </form>`)
  $("#new-project-form").addEventListener("submit", async (e) => {
    e.preventDefault()
    const body = Object.fromEntries(new FormData(e.target))
    try {
      const data = await api("/api/projects", { method: "POST", body })
      closeModal()
      await loadProjects()
      await selectProject(data.project.id)
      toast(`Project "${data.project.name}" created`)
    } catch (err) {
      toast(err.message, true)
    }
  })
}

/* ---------------- board ---------------- */

function renderBoardEmpty() {
  $("#board-area").innerHTML = `
    <div class="empty-state">
      <h2>Welcome to Collaboard</h2>
      <p>Create a project or pick one from the sidebar to see its board.</p>
    </div>`
}

function cardHtml(c) {
  const due = dueInfo(c.due_date)
  return `
    <div class="card" draggable="true" data-id="${c.id}">
      <div class="card-title">${esc(c.title)}</div>
      <div class="badges">
        ${due ? `<span class="chip ${due.cls}" title="${due.text}">${due.label}</span>` : ""}
        ${c.description ? `<span class="chip" title="Has description">≡</span>` : ""}
        ${c.comment_count > 0 ? `<span class="chip">${c.comment_count} comment${c.comment_count === 1 ? "" : "s"}</span>` : ""}
        ${c.assignee_id ? `<span class="card-assignee">${avatarHtml(c.assignee_id, c.assignee_name || "")}</span>` : ""}
      </div>
    </div>`
}

function renderBoard() {
  const cur = state.current
  if (!cur) return renderBoardEmpty()
  const meRole = cur.members.find((m) => m.id === state.me.id)?.role
  $("#board-area").innerHTML = `
    <div id="project-bar">
      <div>
        <h2 class="project-title">${esc(cur.project.name)}</h2>
        ${cur.project.description ? `<p class="project-desc">${esc(cur.project.description)}</p>` : ""}
      </div>
      <div class="members-strip">
        ${cur.members
          .map((m) => {
            const removable = (meRole === "owner" && m.id !== state.me.id) || m.id === state.me.id
            return `<span class="member-dot ${removable ? "removable" : ""} ${m.id === state.me.id ? "self" : ""}"
              data-member="${m.id}" data-name="${esc(m.name)}" style="background:hsl(${(m.id * 137) % 360} 62% 46%)"
              title="${esc(m.name)} (${esc(m.email)})${meRole === "owner" ? " — owner" : ""}">${esc(initials(m.name))}<span class="x">×</span></span>`
          })
          .join("")}
        <button id="btn-invite" class="btn small">+ Invite</button>
      </div>
    </div>
    <div class="board">
      ${cur.lists
        .map((l) => {
          const cards = cur.cards.filter((c) => c.list_id === l.id).sort((a, b) => a.position - b.position)
          return `
          <div class="list" data-id="${l.id}">
            <div class="list-head">
              <span class="list-name" data-rename="${l.id}">${esc(l.name)}<span class="list-count">${cards.length}</span></span>
              <button class="icon-btn" data-del-list="${l.id}" title="Delete list">×</button>
            </div>
            <div class="cards">${cards.map(cardHtml).join("")}</div>
            <form class="add-form" data-add="card" data-list="${l.id}">
              <input name="title" placeholder="Add a card…" autocomplete="off" />
              <button class="btn small">Add</button>
            </form>
          </div>`
        })
        .join("")}
      <form class="add-form add-list-wrap" data-add="list" style="width:276px;flex-shrink:0">
        <input name="name" placeholder="+ Add another list" autocomplete="off" />
      </form>
    </div>`
}

const boardArea = $("#board-area")

boardArea.addEventListener("click", async (e) => {
  const delList = e.target.closest("[data-del-list]")
  if (delList) {
    e.stopPropagation()
    if (!confirm("Delete this list and its cards?")) return
    try {
      await api(`/api/lists/${delList.dataset.delList}`, { method: "DELETE" })
    } catch (err) {
      toast(err.message, true)
    }
    return
  }
  const memberDot = e.target.closest("[data-member]")
  if (memberDot) {
    const id = Number(memberDot.dataset.member)
    if (id === state.me.id && !confirm("Leave this project?")) return
    if (id !== state.me.id && !confirm(`Remove ${memberDot.dataset.name} from the project?`)) return
    try {
      await api(`/api/projects/${state.current.project.id}/members/${id}`, { method: "DELETE" })
      await reloadProject()
    } catch (err) {
      toast(err.message, true)
    }
    return
  }
  const cardEl = e.target.closest(".card")
  if (cardEl) openCardModal(Number(cardEl.dataset.id))
})

boardArea.addEventListener("dblclick", (e) => {
  const nameEl = e.target.closest("[data-rename]")
  if (!nameEl) return
  const listId = Number(nameEl.dataset.rename)
  const list = state.current.lists.find((l) => l.id === listId)
  nameEl.innerHTML = `<input value="${esc(list.name)}" />`
  const input = nameEl.querySelector("input")
  input.focus()
  input.select()
  const save = async () => {
    const name = input.value.trim()
    if (name && name !== list.name) {
      try {
        await api(`/api/lists/${listId}`, { method: "PATCH", body: { name } })
        return
      } catch (err) {
        toast(err.message, true)
      }
    }
    renderBoard()
  }
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault()
      input.blur()
    }
    if (ev.key === "Escape") {
      input.value = list.name
      input.blur()
    }
  })
  input.addEventListener("blur", save)
})

boardArea.addEventListener("submit", async (e) => {
  const form = e.target.closest("form[data-add]")
  if (!form) return
  e.preventDefault()
  const input = form.querySelector("input")
  const value = input.value.trim()
  if (!value) return
  try {
    if (form.dataset.add === "card") {
      const data = await api(`/api/lists/${form.dataset.list}/cards`, { method: "POST", body: { title: value } })
      state.current.cards.push(data.card)
      renderBoard()
      const focus = $(`form[data-add="card"][data-list="${form.dataset.list}"] input`)
      focus?.focus()
    } else {
      const data = await api(`/api/projects/${state.current.project.id}/lists`, { method: "POST", body: { name: value } })
      state.current.lists.push(data.list)
      renderBoard()
    }
  } catch (err) {
    toast(err.message, true)
  }
})

/* ---------------- drag & drop ---------------- */

let drag = null

boardArea.addEventListener("dragstart", (e) => {
  const el = e.target.closest(".card")
  if (!el) return
  drag = { cardId: Number(el.dataset.id) }
  el.classList.add("dragging")
  e.dataTransfer.effectAllowed = "move"
  try {
    e.dataTransfer.setData("text/plain", String(drag.cardId))
  } catch {}
})

boardArea.addEventListener("dragend", () => {
  drag = null
  document.querySelectorAll(".card.dragging").forEach((el) => el.classList.remove("dragging"))
  document.querySelectorAll(".list.drop-target").forEach((el) => el.classList.remove("drop-target"))
})

boardArea.addEventListener("dragover", (e) => {
  if (!drag) return
  const listEl = e.target.closest(".list")
  if (!listEl) return
  e.preventDefault()
  e.dataTransfer.dropEffect = "move"
  document.querySelectorAll(".list.drop-target").forEach((el) => el.classList.remove("drop-target"))
  listEl.classList.add("drop-target")
})

boardArea.addEventListener("drop", async (e) => {
  const listEl = e.target.closest(".list")
  if (!listEl || !drag) return
  e.preventDefault()
  const cardId = drag.cardId
  drag = null
  const listId = Number(listEl.dataset.id)
  const others = state.current.cards.filter((c) => c.list_id === listId && c.id !== cardId).sort((a, b) => a.position - b.position)
  const domCards = [...listEl.querySelectorAll(".card:not(.dragging)")].map((el) => ({
    id: Number(el.dataset.id),
    top: el.getBoundingClientRect().top,
    mid: el.getBoundingClientRect().top + el.offsetHeight / 2,
  }))
  domCards.sort((a, b) => a.top - b.top)
  let idx = domCards.findIndex((c) => e.clientY < c.mid)
  if (idx === -1) idx = others.length
  const prev = idx > 0 ? others[idx - 1].position : others.length ? others[0].position - 1000 : 0
  const next = idx < others.length ? others[idx].position : prev + 2000
  await moveCard(cardId, listId, (prev + next) / 2)
})

async function moveCard(cardId, listId, position) {
  const card = state.current.cards.find((c) => c.id === cardId)
  if (!card) return
  const changed = card.list_id !== listId || Math.abs(card.position - position) > 0.001
  if (!changed) return
  card.list_id = listId
  card.position = position
  renderBoard()
  try {
    const data = await api(`/api/cards/${cardId}`, { method: "PATCH", body: { list_id: listId, position } })
    Object.assign(state.current.cards.find((c) => c.id === cardId), data.card)
    renderBoard()
  } catch (err) {
    toast(err.message, true)
    reloadProject()
  }
}

/* ---------------- invite ---------------- */

boardArea.addEventListener("click", (e) => {
  if (!e.target.closest("#btn-invite")) return
  openModal(`
    <h2>Invite to ${esc(state.current.project.name)}</h2>
    <p style="color:var(--muted)">Enter the email of a registered user.</p>
    <form id="invite-form">
      <label class="field">Email<input type="email" name="email" required placeholder="teammate@company.com" /></label>
      <div class="modal-foot"><span></span><button class="btn primary">Send invite</button></div>
    </form>`)
  $("#invite-form").addEventListener("submit", async (e) => {
    e.preventDefault()
    const email = new FormData(e.target).get("email")
    try {
      await api(`/api/projects/${state.current.project.id}/members`, { method: "POST", body: { email } })
      closeModal()
      await reloadProject()
      toast(`Invited ${email}`)
    } catch (err) {
      toast(err.message, true)
    }
  })
})

/* ---------------- card modal ---------------- */

function openModal(html) {
  $("#modal-root").innerHTML = `<div class="overlay"><div class="modal">${html}</div></div>`
}

function closeModal() {
  $("#modal-root").innerHTML = ""
  state.modalCardId = null
}

$("#modal-root").addEventListener("mousedown", (e) => {
  if (e.target.classList.contains("overlay")) closeModal()
})

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal()
})

async function openCardModal(cardId) {
  let card = state.current.cards.find((c) => c.id === cardId)
  if (!card) return
  let comments = []
  try {
    const data = await api(`/api/cards/${cardId}`)
    comments = data.comments
    Object.assign(card, data.card)
  } catch (err) {
    toast(err.message, true)
    return
  }
  state.modalCardId = cardId
  const cur = state.current
  openModal(`
    <div class="row" style="margin-top:0">
      <input type="text" id="m-title" value="${esc(card.title)}" style="flex:1;font-weight:700;font-size:17px" />
    </div>
    <div class="row">
      <label class="field" style="min-width:180px;flex:1">Assignee
        <select id="m-assignee">
          <option value="">Unassigned</option>
          ${cur.members.map((m) => `<option value="${m.id}" ${card.assignee_id === m.id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
        </select>
      </label>
      <label class="field">Due date
        <input type="date" id="m-due" value="${card.due_date ? card.due_date.slice(0, 10) : ""}" />
      </label>
    </div>
    <div class="section-label">Description</div>
    <textarea id="m-desc" class="desc-area" placeholder="Add more details…">${esc(card.description)}</textarea>
    <div class="section-label">Activity</div>
    <div id="m-comments"></div>
    <form id="m-comment-form" class="comment-form">
      ${avatarHtml(state.me.id, state.me.name)}
      <textarea name="body" placeholder="Write a comment…" required></textarea>
      <button class="btn primary small">Send</button>
    </form>
    <div class="modal-foot">
      <button id="m-delete" class="btn small danger-text">Delete card</button>
      <span style="display:flex;gap:8px">
        <button id="m-close" class="btn small">Close</button>
        <button id="m-save" class="btn primary small">Save changes</button>
      </span>
    </div>`)

  const renderComments = () => {
    $("#m-comments").innerHTML =
      comments
        .map(
          (cm) => `
        <div class="comment" data-id="${cm.id}">
          ${avatarHtml(cm.author_id, cm.author_name)}
          <div class="comment-body">
            <div class="comment-meta"><strong>${esc(cm.author_name)}</strong> · ${timeAgo(cm.created_at)}</div>
            <p>${esc(cm.body)}</p>
          </div>
        </div>`,
        )
        .join("") || `<p style="color:var(--muted)">No comments yet.</p>`
  }
  renderComments()

  const patchCard = async (body) => {
    try {
      const data = await api(`/api/cards/${cardId}`, { method: "PATCH", body })
      Object.assign(state.current.cards.find((c) => c.id === cardId) || {}, data.card)
      renderBoard()
      return true
    } catch (err) {
      toast(err.message, true)
      return false
    }
  }

  $("#m-save").onclick = async () => {
    if (
      await patchCard({
        title: $("#m-title").value,
        description: $("#m-desc").value,
        assignee_id: $("#m-assignee").value === "" ? null : Number($("#m-assignee").value),
        due_date: $("#m-due").value || null,
      })
    ) {
      toast("Card saved")
      closeModal()
    }
  }
  $("#m-close").onclick = closeModal
  $("#m-delete").onclick = async () => {
    if (!confirm("Delete this card?")) return
    try {
      await api(`/api/cards/${cardId}`, { method: "DELETE" })
      closeModal()
      state.current.cards = state.current.cards.filter((c) => c.id !== cardId)
      renderBoard()
    } catch (err) {
      toast(err.message, true)
    }
  }
  $("#m-desc").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#m-save").click()
  })
  $("#m-comment-form").addEventListener("submit", async (e) => {
    e.preventDefault()
    const body = new FormData(e.target).get("body").trim()
    if (!body) return
    try {
      const data = await api(`/api/cards/${cardId}/comments`, { method: "POST", body: { body } })
      comments.push(data.comment)
      const local = state.current.cards.find((c) => c.id === cardId)
      if (local) local.comment_count = (local.comment_count || 0) + 1
      renderComments()
      e.target.querySelector("textarea").value = ""
      renderBoard()
    } catch (err) {
      toast(err.message, true)
    }
  })
}

/* ---------------- websocket ---------------- */

function connectWs() {
  if (state.ws) state.ws.close()
  const proto = location.protocol === "https:" ? "wss" : "ws"
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${state.token}`)
  state.ws = ws
  ws.onmessage = (e) => {
    try {
      handleEvent(JSON.parse(e.data))
    } catch {}
  }
  ws.onclose = () => {
    if (state.me && state.ws === ws) setTimeout(connectWs, 2500)
  }
}

function handleEvent(ev) {
  if (ev.type === "notification") return onNotification(ev.data)

  const cur = state.current
  if (!cur || ev.projectId !== cur.project.id) {
    if (["project.deleted", "project.updated", "member_added"].includes(ev.type)) loadProjects().catch(() => {})
    if (ev.type === "member_added" || ev.type === "project.updated") loadProjects().catch(() => {})
    if (ev.type.startsWith("card") || ev.type.startsWith("list")) loadProjects().catch(() => {})
    return
  }

  switch (ev.type) {
    case "list.created":
      if (!cur.lists.some((l) => l.id === ev.data.list.id)) cur.lists.push(ev.data.list)
      break
    case "list.updated": {
      const i = cur.lists.findIndex((l) => l.id === ev.data.list.id)
      if (i >= 0) cur.lists[i] = ev.data.list
      break
    }
    case "list.deleted":
      cur.lists = cur.lists.filter((l) => l.id !== ev.data.id)
      cur.cards = cur.cards.filter((c) => c.list_id !== ev.data.id)
      break
    case "card.created":
    case "card.updated":
    case "card.moved": {
      const i = cur.cards.findIndex((c) => c.id === ev.data.card.id)
      if (i >= 0) cur.cards[i] = ev.data.card
      else cur.cards.push(ev.data.card)
      break
    }
    case "card.deleted":
      cur.cards = cur.cards.filter((c) => c.id !== ev.data.id)
      break
    case "comment.added": {
      const card = cur.cards.find((c) => c.id === ev.data.cardId)
      if (card) card.comment_count = (card.comment_count || 0) + 1
      if (state.modalCardId === ev.data.cardId) appendModalComment(ev.data.comment)
      break
    }
    case "member.added":
      if (!cur.members.some((m) => m.id === ev.data.member.id)) cur.members.push(ev.data.member)
      break
    case "member.removed":
      reloadProject().catch(() => {})
      break
    case "project.updated":
      Object.assign(cur.project, ev.data.project || {})
      loadProjects().catch(() => {})
      break
    case "project.deleted":
      state.projects = state.projects.filter((p) => p.id !== ev.projectId)
      state.current = null
      closeModal()
      renderBoardEmpty()
      renderSidebar()
      return
  }
  renderBoard()
  renderSidebar()
}

function appendModalComment(comment) {
  const wrap = $("#m-comments")
  if (!wrap || wrap.querySelector(`[data-id="${comment.id}"]`)) return
  const empty = wrap.querySelector("p")
  if (empty) empty.remove()
  const div = document.createElement("div")
  div.className = "comment"
  div.dataset.id = comment.id
  div.innerHTML = `
    ${avatarHtml(comment.author_id, comment.author_name)}
    <div class="comment-body">
      <div class="comment-meta"><strong>${esc(comment.author_name)}</strong> · ${timeAgo(comment.created_at)}</div>
      <p>${esc(comment.body)}</p>
    </div>`
  wrap.appendChild(div)
}

/* ---------------- notifications ---------------- */

async function loadNotifications() {
  try {
    const data = await api("/api/notifications")
    state.notifications = data.notifications
    state.unread = data.unread
    renderNotifs()
  } catch {}
}

function renderNotifs() {
  const badge = $("#notif-badge")
  badge.classList.toggle("hidden", state.unread === 0)
  badge.textContent = state.unread > 99 ? "99+" : state.unread
  $("#notif-list").innerHTML =
    state.notifications
      .map(
        (n) => `
      <div class="notif-item ${n.read ? "" : "unread"}" data-nid="${n.id}" data-project="${n.project_id ?? ""}" data-card="${n.card_id ?? ""}">
        ${esc(n.message)}
        <span class="notif-time">${timeAgo(n.created_at)}</span>
      </div>`,
      )
      .join("") || `<div class="notif-empty">Nothing yet — invite teammates to get things moving!</div>`
}

async function onNotification(n) {
  state.unread++
  state.notifications.unshift(n)
  if (state.notifications.length > 50) state.notifications.pop()
  renderNotifs()
  toast(n.message)
  if (n.type === "member_added") loadProjects().catch(() => {})
}

$("#bell-btn").onclick = async () => {
  const panel = $("#notif-panel")
  panel.classList.toggle("hidden")
  if (!panel.classList.contains("hidden")) await loadNotifications()
}

document.addEventListener("mousedown", (e) => {
  if (!e.target.closest(".bell-wrap")) $("#notif-panel").classList.add("hidden")
})

$("#mark-read-btn").onclick = async () => {
  await api("/api/notifications/read", { method: "POST" }).catch(() => {})
  state.notifications.forEach((n) => (n.read = 1))
  state.unread = 0
  renderNotifs()
}

$("#notif-list").addEventListener("click", (e) => {
  const item = e.target.closest("[data-nid]")
  if (!item) return
  $("#notif-panel").classList.add("hidden")
  const projectId = item.dataset.project
  if (!projectId || !state.projects.some((p) => p.id === Number(projectId))) return
  state.pendingCardId = item.dataset.card ? Number(item.dataset.card) : null
  selectProject(Number(projectId))
})

/* ---------------- boot ---------------- */

;(async function boot() {
  renderBoardEmpty()
  if (state.token) {
    try {
      const data = await api("/api/auth/me")
      state.me = data.user
      await enterApp()
    } catch {
      localStorage.removeItem("pm_token")
    }
  }
})()
