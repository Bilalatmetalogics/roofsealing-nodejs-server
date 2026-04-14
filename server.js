require("dotenv").config();

// ─── Environment Variable Validation ─────────────────────────────────────────
const REQUIRED_ENV_VARS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "CALENDAR_ID",
  "RESPOND_IO_API_KEY",
];
const missingVars = REQUIRED_ENV_VARS.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  console.error(
    `[startup] Missing required environment variable(s): ${missingVars.join(", ")}`,
  );
  process.exit(1);
}

const express = require("express");
const { google } = require("googleapis");
const axios = require("axios");

// ─── Google Auth ──────────────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
);
oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

async function getAccessToken() {
  const { token } = await oauth2Client.getAccessToken();
  return token;
}

// ─── respond.io API ───────────────────────────────────────────────────────────
const respondIO = axios.create({
  baseURL: "https://api.respond.io/v2",
  headers: { Authorization: `Bearer ${process.env.RESPOND_IO_API_KEY}` },
});

async function sendWhatsAppMessage(contactId, text) {
  return respondIO.post(`/contact/id:${contactId}/message`, {
    channelId: 0,
    message: { type: "text", text },
  });
}

async function updateContactFields(contactId, fields) {
  return respondIO.put(`/contact/id:${contactId}`, {
    custom_fields: fields.map(([name, value]) => ({ name, value })),
  });
}

const app = express();
app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "RoofSealing server is running" });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getWorkingDays(tz, count) {
  const days = [],
    c = new Date();
  c.setDate(c.getDate() + 1);
  while (days.length < count) {
    const s = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(c);
    const dow = new Date(s + "T12:00:00Z").getDay();
    if (dow !== 0 && dow !== 6) days.push(s);
    c.setDate(c.getDate() + 1);
  }
  return days;
}

function toUTC(dateStr, hour, tz) {
  const approx = new Date(`${dateStr}T${String(hour).padStart(2, "0")}:00:00Z`);
  const parts = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(approx)
    .forEach(({ type, value }) => (parts[type] = value));
  const localAsUTC = new Date(
    `${parts.year}-${parts.month}-${parts.day}T${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}:${parts.second}Z`,
  );
  return new Date(approx.getTime() - (localAsUTC - approx)).toISOString();
}

function slotLabel(dateStr, hour, tz) {
  const d = new Date(toUTC(dateStr, hour, tz));
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d);
  const t1 = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  const t2 = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(d.getTime() + 3600000));
  return `${day}, ${t1} – ${t2}`;
}

// ─── Fetch contact name from respond.io API ───────────────────────────────────
async function getContactName(contactId) {
  try {
    const res = await respondIO.get(`/contact/id:${contactId}`);
    const c = res.data?.contact || res.data;
    // respond.io API returns firstName field
    const name = c?.firstName || c?.first_name || c?.name;
    return name && name.trim() ? name.trim() : "there";
  } catch (err) {
    console.error(
      `[getContactName] ERROR: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`,
    );
    return "there";
  }
}

// ─── Helper: delete a Google Calendar event ──────────────────────────────────
async function deleteCalendarEvent(eventId, token) {
  await axios.delete(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.CALENDAR_ID)}/events/${eventId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

// ─── Helper: get contact custom fields ───────────────────────────────────────
async function getContactFields(contactId) {
  try {
    const res = await respondIO.get(`/contact/id:${contactId}`);
    const c = res.data?.contact || res.data;
    const fields = {};
    if (Array.isArray(c?.customFields)) {
      c.customFields.forEach((f) => {
        fields[f.name] = f.value;
      });
    }
    if (Array.isArray(c?.custom_fields)) {
      c.custom_fields.forEach((f) => {
        fields[f.name] = f.value;
      });
    }
    return fields;
  } catch (err) {
    return {};
  }
}

// ─── Webhook 1: Fetch Slots ───────────────────────────────────────────────────
app.post("/webhook/zap1", async (req, res) => {
  res.json({ status: "received" });

  const { contact_id } = req.body;

  (async () => {
    try {
      const token = await getAccessToken();
      const contact_name = await getContactName(contact_id);

      // ─── Rebooking detection ──────────────────────────────────────────────
      const contactFields = await getContactFields(contact_id);
      const existingEventId = contactFields["calendar_event_id"];
      const existingLabel = contactFields["booked_slot_label"];
      const inspectionStatus = contactFields["inspection_status"];

      if (existingEventId && inspectionStatus === "Scheduled") {
        // Check if the existing event is in the future
        try {
          const evCheck = await axios.get(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.CALENDAR_ID)}/events/${existingEventId}`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          const eventStart =
            evCheck.data?.start?.dateTime || evCheck.data?.start?.date;
          if (eventStart && new Date(eventStart) > new Date()) {
            // Future booking exists — ask user what to do
            await updateContactFields(contact_id, [
              ["booking_state", "pending_reschedule"],
            ]);
            await sendWhatsAppMessage(
              contact_id,
              `You already have an inspection booked for 📅 ${existingLabel || "a future date"}.\n\nWould you like to:\n1. *reschedule* — pick a new slot\n2. *cancel* — cancel the booking\n\nReply with *reschedule* or *cancel*.`,
            );
            console.log(
              `[zap1] contact=${contact_id} — existing future booking detected, asked to reschedule/cancel`,
            );
            return;
          }
        } catch (err) {
          // Event not found or deleted — proceed normally
          console.log(
            `[zap1] contact=${contact_id} — existing event not found, proceeding with new booking`,
          );
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      const GLOBAL_TZ = "Asia/Dubai";
      const SLOT_HOURS = [10, 11, 12, 13, 14, 15, 16];
      const days = getWorkingDays(GLOBAL_TZ, 3);

      const evRes = await axios.get(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.CALENDAR_ID)}/events`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            timeMin: toUTC(days[0], 0, GLOBAL_TZ),
            timeMax: toUTC(days[days.length - 1], 23, GLOBAL_TZ),
            singleEvents: true,
            orderBy: "startTime",
          },
        },
      );

      if (evRes.data.error) {
        console.error(
          `[zap1] contact=${contact_id} — ERROR: ${JSON.stringify(evRes.data.error)}`,
        );
        return;
      }

      const booked = evRes.data.items || [];
      const slots = [];

      for (const day of days) {
        for (const hour of SLOT_HOURS) {
          const start = toUTC(day, hour, GLOBAL_TZ);
          const end = toUTC(day, hour + 1, GLOBAL_TZ);
          const busy = booked.some((ev) => {
            const s =
              ev.start?.dateTime ||
              (ev.start?.date ? ev.start.date + "T00:00:00Z" : null);
            const e =
              ev.end?.dateTime ||
              (ev.end?.date ? ev.end.date + "T00:00:00Z" : null);
            if (!s || !e) return false;
            return s < end && e > start;
          });
          if (!busy)
            slots.push({ label: slotLabel(day, hour, GLOBAL_TZ), start, end });
        }
      }

      const fields = [
        ["slots_total", slots.length.toString()],
        ["booking_state", "awaiting_selection"],
        ...slots.map((s, i) => [
          `slot_${i + 1}`,
          `${s.label} | ${s.start} | ${s.end}`,
        ]),
      ];

      try {
        await updateContactFields(contact_id, fields);
      } catch (err) {
        console.error(
          `[zap1] contact=${contact_id} — ERROR updating fields: ${JSON.stringify(err.response?.data) || err.message}`,
        );
      }

      const message =
        `Hi ${contact_name || "there"}! Here are our available inspection slots:\n\n` +
        slots.map((s, i) => `${i + 1}. ${s.label}`).join("\n") +
        `\n\nReply with the *number* of your preferred slot.`;

      try {
        await sendWhatsAppMessage(contact_id, message);
      } catch (err) {
        console.error(
          `[zap1] contact=${contact_id} — ERROR sending message: ${JSON.stringify(err.response?.data) || err.message}`,
        );
        return;
      }

      console.log(`[zap1] contact=${contact_id} — ${slots.length} slots sent`);
    } catch (err) {
      console.error(
        `[zap1] contact=${contact_id} — ERROR: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`,
      );
    }
  })();
});

// ─── Webhook 2: Book Slot ─────────────────────────────────────────────────────
app.post("/webhook/zap2", async (req, res) => {
  res.json({ status: "received" });

  const { contact_id, slot_number } = req.body;
  const slotString = req.body["slot_" + slot_number];

  (async () => {
    try {
      if (!slotString) {
        console.error(
          `[zap2] contact=${contact_id} — ERROR: slot_${slot_number} not found in payload`,
        );
        return;
      }

      const [label, slotStart, slotEnd] = slotString.split(" | ");
      const contact_name = await getContactName(contact_id);
      const token = await getAccessToken();

      const calRes = await axios.post(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.CALENDAR_ID)}/events`,
        {
          summary: "Roof Sealing - Inspection",
          description: "Booked by: " + contact_name,
          start: { dateTime: slotStart, timeZone: "Asia/Dubai" },
          end: { dateTime: slotEnd, timeZone: "Asia/Dubai" },
        },
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (calRes.data.error) {
        console.error(
          `[zap2] contact=${contact_id} — ERROR: ${JSON.stringify(calRes.data.error)}`,
        );
        return;
      }

      try {
        await sendWhatsAppMessage(
          contact_id,
          `✅ Your inspection is confirmed!\n\n📅 ${label}\n\nOur team will be there. If you need to reschedule, please contact us.`,
        );
      } catch (err) {
        console.error(
          `[zap2] contact=${contact_id} — ERROR: ${JSON.stringify(err.response?.data) || err.message}`,
        );
      }

      try {
        await updateContactFields(contact_id, [
          ["booking_state", "scheduled"],
          ["inspection_status", "Scheduled"],
          ["calendar_event_id", calRes.data.id],
          ["booked_slot_label", label],
        ]);
      } catch (err) {
        console.error(
          `[zap2] contact=${contact_id} — ERROR: ${JSON.stringify(err.response?.data) || err.message}`,
        );
      }

      console.log(`[zap2] contact=${contact_id} — booked: ${label}`);
    } catch (err) {
      console.error(
        `[zap2] contact=${contact_id} — ERROR: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`,
      );
    }
  })();
});

// ─── Webhook 3: Reschedule ────────────────────────────────────────────────────
app.post("/webhook/reschedule", async (req, res) => {
  res.json({ status: "received" });

  const { contact_id } = req.body;

  (async () => {
    try {
      const token = await getAccessToken();
      const contactFields = await getContactFields(contact_id);
      const existingEventId = contactFields["calendar_event_id"];

      // Delete old calendar event if it exists
      if (existingEventId) {
        try {
          await deleteCalendarEvent(existingEventId, token);
          console.log(
            `[reschedule] contact=${contact_id} — deleted event ${existingEventId}`,
          );
        } catch (err) {
          console.error(
            `[reschedule] contact=${contact_id} — could not delete event: ${err.message}`,
          );
        }
      }

      // Clear old booking fields and send slot list
      const contact_name = await getContactName(contact_id);
      const GLOBAL_TZ = "Asia/Dubai";
      const SLOT_HOURS = [10, 11, 12, 13, 14, 15, 16];
      const days = getWorkingDays(GLOBAL_TZ, 3);

      const evRes = await axios.get(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.CALENDAR_ID)}/events`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            timeMin: toUTC(days[0], 0, GLOBAL_TZ),
            timeMax: toUTC(days[days.length - 1], 23, GLOBAL_TZ),
            singleEvents: true,
            orderBy: "startTime",
          },
        },
      );

      const booked = evRes.data.items || [];
      const slots = [];

      for (const day of days) {
        for (const hour of SLOT_HOURS) {
          const start = toUTC(day, hour, GLOBAL_TZ);
          const end = toUTC(day, hour + 1, GLOBAL_TZ);
          const busy = booked.some((ev) => {
            const s =
              ev.start?.dateTime ||
              (ev.start?.date ? ev.start.date + "T00:00:00Z" : null);
            const e =
              ev.end?.dateTime ||
              (ev.end?.date ? ev.end.date + "T00:00:00Z" : null);
            if (!s || !e) return false;
            return s < end && e > start;
          });
          if (!busy)
            slots.push({ label: slotLabel(day, hour, GLOBAL_TZ), start, end });
        }
      }

      const fields = [
        ["slots_total", slots.length.toString()],
        ["booking_state", "awaiting_selection"],
        ["calendar_event_id", ""],
        ["booked_slot_label", ""],
        ["inspection_status", ""],
        ...slots.map((s, i) => [
          `slot_${i + 1}`,
          `${s.label} | ${s.start} | ${s.end}`,
        ]),
      ];
      await updateContactFields(contact_id, fields);

      const message =
        `Here are the available slots for rescheduling:\n\n` +
        slots.map((s, i) => `${i + 1}. ${s.label}`).join("\n") +
        `\n\nReply with the *number* of your preferred slot.`;
      await sendWhatsAppMessage(contact_id, message);

      console.log(
        `[reschedule] contact=${contact_id} — ${slots.length} slots sent`,
      );
    } catch (err) {
      console.error(
        `[reschedule] contact=${contact_id} — ERROR: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`,
      );
    }
  })();
});

// ─── Webhook 4: Cancel ────────────────────────────────────────────────────────
app.post("/webhook/cancel", async (req, res) => {
  res.json({ status: "received" });

  const { contact_id } = req.body;

  (async () => {
    try {
      const token = await getAccessToken();
      const contactFields = await getContactFields(contact_id);
      const existingEventId = contactFields["calendar_event_id"];
      const existingLabel = contactFields["booked_slot_label"];

      if (existingEventId) {
        try {
          await deleteCalendarEvent(existingEventId, token);
          console.log(
            `[cancel] contact=${contact_id} — deleted event ${existingEventId}`,
          );
        } catch (err) {
          console.error(
            `[cancel] contact=${contact_id} — could not delete event: ${err.message}`,
          );
        }
      }

      await updateContactFields(contact_id, [
        ["booking_state", "cancelled"],
        ["inspection_status", "Cancelled"],
        ["calendar_event_id", ""],
        ["booked_slot_label", ""],
      ]);

      await sendWhatsAppMessage(
        contact_id,
        `✅ Your inspection booking${existingLabel ? ` for 📅 ${existingLabel}` : ""} has been cancelled.\n\nIf you'd like to book again in the future, just let us know.`,
      );

      console.log(`[cancel] contact=${contact_id} — booking cancelled`);
    } catch (err) {
      console.error(
        `[cancel] contact=${contact_id} — ERROR: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`,
      );
    }
  })();
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = { app, getWorkingDays, toUTC, slotLabel };
