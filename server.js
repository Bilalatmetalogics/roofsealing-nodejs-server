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

// ─── Fetch contact details from respond.io ────────────────────────────────────
async function getContactDetails(contactId) {
  try {
    const res = await respondIO.get(`/contact/id:${contactId}`);
    const c = res.data?.contact || res.data;

    const name = c?.firstName || c?.first_name || c?.name;

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

    return {
      name: name && name.trim() ? name.trim() : "there",
      email: c?.email || fields["email"] || null,
      fields,
    };
  } catch (err) {
    console.error(
      `[getContactDetails] ERROR: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`,
    );
    return { name: "there", email: null, fields: {} };
  }
}

// ─── Delete a Google Calendar event ──────────────────────────────────────────
async function deleteCalendarEvent(eventId, token) {
  await axios.delete(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.CALENDAR_ID)}/events/${eventId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

// ─── Slot calculation helpers ─────────────────────────────────────────────────
const GLOBAL_TZ = "Asia/Dubai"; // Gulf Standard Time (UTC+4)
const SLOT_HOURS = [10, 11, 12, 13, 14, 15, 16];

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
  // Build a local time string and resolve it to UTC via the given timezone.
  // e.g. "2025-04-20", hour=12, tz="Asia/Dubai" → "2025-04-20T08:00:00.000Z"
  const localStr = `${dateStr}T${String(hour).padStart(2, "0")}:00:00`;
  // Temporal-style: use a throwaway date to find the UTC offset for this tz at this moment
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
    .formatToParts(
      new Date(`${dateStr}T${String(hour).padStart(2, "0")}:00:00Z`),
    )
    .forEach(({ type, value }) => (parts[type] = value));

  // `parts` tells us what local time corresponds to that UTC instant.
  // We want the inverse: treat localStr as local, find the UTC instant.
  // Offset = UTC_instant - local_instant (in ms)
  const utcGuess = new Date(
    `${dateStr}T${String(hour).padStart(2, "0")}:00:00Z`,
  );
  const localAtGuess = new Date(
    `${parts.year}-${parts.month}-${parts.day}T${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}:${parts.second}Z`,
  );
  const offsetMs = utcGuess.getTime() - localAtGuess.getTime();

  // Local time as a pseudo-UTC timestamp, then shift by offset
  const localAsMs = new Date(`${localStr}Z`).getTime();
  return new Date(localAsMs + offsetMs).toISOString();
}

function buildSlotLabel(dateStr, hour, tz) {
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

// ─── Fetch available slots from Google Calendar ───────────────────────────────
async function fetchAvailableSlots(token) {
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
    throw new Error(`Calendar API error: ${JSON.stringify(evRes.data.error)}`);
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
        // Convert to timestamps for correct comparison regardless of timezone offset format
        const evStart = new Date(s).getTime();
        const evEnd = new Date(e).getTime();
        const slotStart = new Date(start).getTime();
        const slotEnd = new Date(end).getTime();
        return evStart < slotEnd && evEnd > slotStart;
      });
      if (!busy)
        slots.push({ label: buildSlotLabel(day, hour, GLOBAL_TZ), start, end });
    }
  }

  return slots;
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "RoofSealing booking server is running" });
});

// ─── POST /webhook/slots — Fetch & send available inspection slots ─────────────
// Called by: Workflow 1 (Shortcut trigger) when AI Agent confirms booking intent
// Body: { contact_id }
app.post("/webhook/slots", async (req, res) => {
  res.json({ status: "received" });

  const { contact_id } = req.body;

  (async () => {
    try {
      const token = await getAccessToken();
      const contact = await getContactDetails(contact_id);

      // ─── Existing booking detection ───────────────────────────────────────
      const existingEventId = contact.fields["calendar_event_id"];
      const existingLabel = contact.fields["booked_slot_label"];
      const inspectionStatus = contact.fields["inspection_status"];

      if (existingEventId && inspectionStatus === "Scheduled") {
        try {
          const evCheck = await axios.get(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.CALENDAR_ID)}/events/${existingEventId}`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          const eventStart =
            evCheck.data?.start?.dateTime || evCheck.data?.start?.date;
          if (eventStart && new Date(eventStart) > new Date()) {
            await updateContactFields(contact_id, [
              ["booking_state", "pending_reschedule"],
            ]);
            await sendWhatsAppMessage(
              contact_id,
              `You already have an inspection booked for 📅 ${existingLabel || "a future date"}.\n\nWould you like to:\n1. *reschedule* — pick a new slot\n2. *cancel* — cancel the booking\n\nReply with *reschedule* or *cancel*.`,
            );
            console.log(
              `[slots] contact=${contact_id} — existing future booking, asked to reschedule/cancel`,
            );
            return;
          }
        } catch {
          console.log(
            `[slots] contact=${contact_id} — existing event not found, proceeding`,
          );
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      const slots = await fetchAvailableSlots(token);

      // Store slots in contact fields so agent can reference them by number
      const fieldUpdates = [
        ["slots_total", slots.length.toString()],
        ["booking_state", "awaiting_selection"],
        ...slots.map((s, i) => [
          `slot_${i + 1}`,
          `${s.label} | ${s.start} | ${s.end}`,
        ]),
      ];

      await updateContactFields(contact_id, fieldUpdates);

      const message =
        `Hi ${contact.name}! Here are our available inspection slots:\n\n` +
        slots.map((s, i) => `${i + 1}. ${s.label}`).join("\n") +
        `\n\nReply with the *number* of your preferred slot.`;

      await sendWhatsAppMessage(contact_id, message);

      console.log(`[slots] contact=${contact_id} — ${slots.length} slots sent`);
    } catch (err) {
      console.error(
        `[slots] contact=${contact_id} — ERROR: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`,
      );
    }
  })();
});

// ─── POST /webhook/book — Create calendar event and confirm booking ────────────
// Called by: AI Agent directly (Make HTTP Requests action) when user picks a slot
// Body: { contact_id, slot_number }
app.post("/webhook/book", async (req, res) => {
  res.json({ status: "received" });

  const { contact_id, slot_number } = req.body;

  (async () => {
    try {
      if (!slot_number) {
        console.error(
          `[book] contact=${contact_id} — ERROR: slot_number missing from request`,
        );
        return;
      }

      // Fetch slot data from contact fields (stored by /webhook/slots)
      const contact = await getContactDetails(contact_id);
      const slotString = contact.fields[`slot_${slot_number}`];

      if (!slotString) {
        console.error(
          `[book] contact=${contact_id} — ERROR: slot_${slot_number} not found in contact fields`,
        );
        return;
      }

      const [label, slotStart, slotEnd] = slotString.split(" | ");
      const token = await getAccessToken();

      // Build calendar event — include attendee if email is available
      const eventBody = {
        summary: "Roof Sealing - Inspection",
        description: `Booked by: ${contact.name}`,
        start: { dateTime: slotStart, timeZone: "Asia/Dubai" },
        end: { dateTime: slotEnd, timeZone: "Asia/Dubai" },
        ...(contact.email && {
          attendees: [{ email: contact.email, displayName: contact.name }],
          sendUpdates: "all",
        }),
      };

      const calRes = await axios.post(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.CALENDAR_ID)}/events`,
        eventBody,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (calRes.data.error) {
        console.error(
          `[book] contact=${contact_id} — Calendar ERROR: ${JSON.stringify(calRes.data.error)}`,
        );
        return;
      }

      await sendWhatsAppMessage(
        contact_id,
        `✅ Your inspection is confirmed!\n\n📅 ${label}\n\n${contact.email ? "A calendar invite has been sent to your email.\n\n" : ""}Our team will be there. If you need to reschedule or cancel, just let us know.`,
      );

      await updateContactFields(contact_id, [
        ["booking_state", "scheduled"],
        ["inspection_status", "Scheduled"],
        ["calendar_event_id", calRes.data.id],
        ["booked_slot_label", label],
      ]);

      console.log(
        `[book] contact=${contact_id} — booked: ${label}${contact.email ? ` | invite → ${contact.email}` : " | no email"}`,
      );
    } catch (err) {
      console.error(
        `[book] contact=${contact_id} — ERROR: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`,
      );
    }
  })();
});

// ─── POST /webhook/reschedule — Delete old event and send new slot list ────────
// Called by: AI Agent directly (Make HTTP Requests action) when user says reschedule
// Body: { contact_id }
app.post("/webhook/reschedule", async (req, res) => {
  res.json({ status: "received" });

  const { contact_id } = req.body;

  (async () => {
    try {
      const token = await getAccessToken();
      const contact = await getContactDetails(contact_id);
      const existingEventId = contact.fields["calendar_event_id"];

      // Delete existing calendar event
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

      const slots = await fetchAvailableSlots(token);

      const fieldUpdates = [
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

      await updateContactFields(contact_id, fieldUpdates);

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

// ─── POST /webhook/cancel — Delete event and confirm cancellation ──────────────
// Called by: AI Agent directly (Make HTTP Requests action) when user says cancel
// Body: { contact_id }
app.post("/webhook/cancel", async (req, res) => {
  res.json({ status: "received" });

  const { contact_id } = req.body;

  (async () => {
    try {
      const token = await getAccessToken();
      const contact = await getContactDetails(contact_id);
      const existingEventId = contact.fields["calendar_event_id"];
      const existingLabel = contact.fields["booked_slot_label"];

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
  console.log(`[startup] RoofSealing booking server running on port ${PORT}`);
});

module.exports = { app, getWorkingDays, toUTC, buildSlotLabel };
