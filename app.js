"use strict";

const storageKey = "return-reminder:v1";
const day = 86_400_000;
const statusLabels = { open: "To return", sent: "Awaiting refund", refunded: "Refunded" };

function todayString(now = new Date()) {
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((number, index) => String(number).padStart(index ? 2 : 4, "0")).join("-");
}

function daysUntil(deadline, today = todayString()) {
  return (Date.parse(deadline) - Date.parse(today)) / day;
}

function dateOffset(date, days) {
  return new Date(Date.parse(date) + days * day).toISOString().slice(0, 10).replaceAll("-", "");
}

function deadlineBadge(deadline, today) {
  const remaining = daysUntil(deadline, today);
  if (remaining < 0) return ["Overdue", "overdue"];
  if (remaining === 0) return ["Due today", "soon"];
  if (remaining === 1) return ["Due tomorrow", "soon"];
  if (remaining <= 7) return [`Due in ${remaining} days`, "soon"];
  return [statusLabels.open, ""];
}

function calendarText(value) {
  return value.replaceAll("\\", "\\\\").replace(/\r\n|\r|\n/g, "\\n")
    .replaceAll(";", "\\;").replaceAll(",", "\\,");
}

function foldCalendarLine(line) {
  const encoder = new TextEncoder();
  let bytes = 0;
  let result = "";
  for (const character of line) {
    const length = encoder.encode(character).length;
    if (bytes + length > 75) {
      result += "\r\n ";
      bytes = 1;
    }
    result += character;
    bytes += length;
  }
  return result;
}

function calendarFile(entry, now = new Date()) {
  // Use a local 09:00 event on the reminder date so the calendar owns alert delivery.
  const alertDate = dateOffset(entry.deadline, -entry.lead);
  const description = `Return deadline: ${entry.deadline}${entry.shop ? `\nShop: ${entry.shop}` : ""}`;
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//BackByWhen//Calendar//EN",
    "BEGIN:VEVENT", `UID:${entry.id}@return-reminder.invalid`,
    `DTSTAMP:${now.toISOString().replace(/[-:]|\.\d{3}/g, "")}`,
    `DTSTART:${alertDate}T090000`, `DTEND:${alertDate}T091500`,
    `SUMMARY:${calendarText(`Return: ${entry.item}`)}`,
    `DESCRIPTION:${calendarText(description)}`,
    "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:PT0M",
    `DESCRIPTION:${calendarText(`Return: ${entry.item}`)}`,
    "END:VALARM", "END:VEVENT", "END:VCALENDAR", ""
  ].map(foldCalendarLine).join("\r\n");
}

function startApp() {
  const byId = id => document.getElementById(id);
  const editor = byId("editor");
  const form = byId("return-form");
  const fields = Object.fromEntries(["item", "shop", "deadline", "lead", "status", "tracking", "followup"]
    .map(name => [name, form.elements.namedItem(name)]));
  const filter = byId("filter");
  const search = byId("search");
  const deleteDialog = byId("delete-dialog");
  const storageError = byId("storage-error");
  let entries = [];
  let editingId = null;
  let deletingId = null;

  function readEntries() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      if (!Array.isArray(saved)) throw new Error("Invalid return list");
      entries = saved;
      storageError.hidden = true;
      return true;
    } catch {
      storageError.textContent = "Saved returns couldn’t be loaded. Check this browser’s storage settings.";
      storageError.hidden = false;
      return false;
    }
  }

  function save(change) {
    if (!readEntries()) return false;
    const next = change(entries);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      byId("feedback").textContent = "Changes couldn’t be saved. Check that browser storage is available.";
      return false;
    }
    entries = next;
    return true;
  }

  function announce(message) {
    byId("feedback").textContent = message;
  }

  function textElement(tag, value, className = "") {
    const element = document.createElement(tag);
    element.textContent = value;
    element.className = className;
    return element;
  }

  function downloadCalendar(entry) {
    const blob = new Blob([calendarFile(entry)], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "backbywhen.ics";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    const reminderDate = dateOffset(entry.deadline, -entry.lead);
    announce(reminderDate <= todayString().replaceAll("-", "")
      ? "Open the downloaded calendar file and check the alert time. The selected reminder date is today or earlier."
      : "Open the downloaded calendar file and confirm the alert in your calendar.");
  }

  function render() {
    const today = todayString();
    const open = entries.filter(entry => entry.status === "open");
    byId("open-count").textContent = open.length;
    byId("soon-count").textContent = open.filter(entry => {
      const remaining = daysUntil(entry.deadline, today);
      return remaining >= 0 && remaining <= 7;
    }).length;
    byId("sent-count").textContent = entries.filter(entry => entry.status === "sent").length;
    const query = search.value.trim().toLocaleLowerCase();
    const shown = entries.filter(entry => {
      const matchesStatus = filter.value === "all" ||
        (filter.value === "active" ? entry.status !== "refunded" : entry.status === filter.value);
      return matchesStatus && [entry.item, entry.shop, entry.tracking ?? ""]
        .some(value => value.toLocaleLowerCase().includes(query));
    });
    const nextDate = entry => entry.status === "sent" ? entry.followup || "9999-12-31" : entry.deadline;
    shown.sort((a, b) => nextDate(a).localeCompare(nextDate(b)));
    byId("empty").hidden = shown.length > 0;
    byId("empty-title").textContent = entries.length ? "No matching returns" : "No returns yet";
    byId("empty-message").textContent = entries.length
      ? "Try another search or status."
      : "Add an item and enter the deadline shown by the shop.";
    byId("empty-add").hidden = entries.length > 0;
    const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });
    byId("returns").replaceChildren(...shown.map(entry => {
      const row = document.createElement("li");
      row.className = "return-row";
      const details = document.createElement("div");
      details.className = "return-details";
      const [badge, tone] = entry.status === "open" ? deadlineBadge(entry.deadline, today) : [statusLabels[entry.status], ""];
      const formatDate = value => dateFormat.format(new Date(value));
      const deadline = entry.status === "open" ? `Due ${formatDate(entry.deadline)}` : `Return deadline ${formatDate(entry.deadline)}`;
      details.append(textElement("span", badge, `badge ${tone}`), textElement("h3", entry.item),
        textElement("p", [entry.shop, deadline].filter(Boolean).join(" · ")));
      if (entry.tracking) details.append(textElement("p", `Tracking number ${entry.tracking}`));
      if (entry.status === "sent" && entry.followup) {
        const remaining = daysUntil(entry.followup, today);
        const label = remaining < 0 ? "Refund follow-up overdue" : remaining === 0 ? "Refund follow-up today" : "Refund follow-up";
        details.append(textElement("span", `${label} · ${formatDate(entry.followup)}`,
          `badge ${remaining < 0 ? "overdue" : remaining <= 7 ? "soon" : ""}`));
      }
      const actions = document.createElement("div");
      actions.className = "actions";
      function action(label, run) {
        const button = textElement("button", label);
        button.type = "button";
        button.setAttribute("aria-label", `${label}: ${entry.item}`);
        button.addEventListener("click", run);
        actions.append(button);
      }
      if (entry.status !== "refunded") {
        const next = entry.status === "open" ? "sent" : "refunded";
        action(next === "sent" ? "Mark sent" : "Mark refunded", () => {
          if (save(current => current.map(item => item.id === entry.id ? { ...item, status: next } : item))) {
            render();
            filter.focus();
            announce(next === "sent" ? "Return marked sent." : "Return marked refunded.");
          }
        });
      }
      if (entry.status === "open") action("Add to calendar", () => downloadCalendar(entry));
      action("Edit", () => openEditor(entry));
      action("Delete", () => {
        deletingId = entry.id;
        byId("delete-message").textContent = `Remove “${entry.item}” from this browser?`;
        deleteDialog.showModal();
      });
      row.append(details, actions);
      return row;
    }));
  }

  function openEditor(entry) {
    editingId = entry?.id ?? null;
    byId("editor-title").textContent = entry ? "Edit return" : "Add return";
    form.reset();
    fields.item.setCustomValidity("");
    if (entry) {
      for (const [key, field] of Object.entries(fields)) field.value = entry[key] ?? "";
    }
    editor.showModal();
    fields.item.focus();
  }

  fields.item.addEventListener("input", () => fields.item.setCustomValidity(""));
  form.addEventListener("submit", event => {
    event.preventDefault();
    const item = fields.item.value.trim();
    if (!item) {
      fields.item.setCustomValidity("Enter an item name.");
      fields.item.reportValidity();
      return;
    }
    const entry = {
      id: editingId ?? crypto.randomUUID(),
      item,
      shop: fields.shop.value.trim(),
      deadline: fields.deadline.value,
      lead: Number(fields.lead.value),
      status: fields.status.value,
      tracking: fields.tracking.value.trim(),
      followup: fields.followup.value
    };
    if (save(current => editingId
      ? current.map(existing => existing.id === editingId ? entry : existing)
      : [...current, entry])) {
      editor.close();
      search.value = "";
      if (!(filter.value === "all" || filter.value === entry.status ||
        (filter.value === "active" && entry.status !== "refunded"))) filter.value = "all";
      render();
      if (editingId || document.activeElement === document.body) byId("add").focus();
      announce(editingId ? "Return updated." : "Return saved.");
    }
  });

  byId("delete-form").addEventListener("submit", event => {
    event.preventDefault();
    if (save(current => current.filter(entry => entry.id !== deletingId))) {
      deleteDialog.close();
      render();
      filter.focus();
      announce("Return deleted.");
    }
  });
  byId("add").addEventListener("click", () => openEditor());
  byId("empty-add").addEventListener("click", () => openEditor());
  byId("cancel").addEventListener("click", () => editor.close());
  byId("keep").addEventListener("click", () => deleteDialog.close());
  filter.addEventListener("change", render);
  search.addEventListener("input", render);
  window.addEventListener("storage", event => {
    if (event.key === storageKey || event.key === null) {
      readEntries();
      render();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !editor.open && !deleteDialog.open) render();
  });
  readEntries();
  render();
}

if (typeof document !== "undefined") startApp();
