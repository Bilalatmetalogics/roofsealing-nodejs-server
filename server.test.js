// Set all required env vars before any require() so server.js doesn't exit(1)
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.GOOGLE_REFRESH_TOKEN = "test-refresh-token";
process.env.CALENDAR_ID = "test-calendar-id";
process.env.RESPOND_IO_API_KEY = "test-api-key";
process.env.PORT = "3000";

// ─── Mock googleapis ──────────────────────────────────────────────────────────
const mockGetAccessToken = jest.fn().mockResolvedValue({ token: "mock-token" });
const mockSetCredentials = jest.fn();
const mockOAuth2Constructor = jest.fn().mockReturnValue({
  setCredentials: mockSetCredentials,
  getAccessToken: mockGetAccessToken,
});

jest.mock("googleapis", () => ({
  google: {
    auth: { OAuth2: mockOAuth2Constructor },
  },
}));

// ─── Mock axios ───────────────────────────────────────────────────────────────
// We need to mock both axios.create() (for respondIO) and axios.get/post (for Calendar)
const mockRespondPost = jest.fn().mockResolvedValue({ data: {} });
const mockRespondPut = jest.fn().mockResolvedValue({ data: {} });
const mockAxiosGet = jest.fn().mockResolvedValue({ data: { items: [] } });
const mockAxiosPost = jest
  .fn()
  .mockResolvedValue({ data: { id: "cal-event-123" } });

jest.mock("axios", () => {
  const mockCreate = jest.fn().mockReturnValue({
    post: mockRespondPost,
    put: mockRespondPut,
  });
  const axiosMock = {
    create: mockCreate,
    get: mockAxiosGet,
    post: mockAxiosPost,
  };
  return axiosMock;
});

const request = require("supertest");
const { app } = require("./server");

// Helper: wait for fire-and-forget async IIFE to complete
const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(() => {
  jest.clearAllMocks();
  // Reset default mock implementations
  mockGetAccessToken.mockResolvedValue({ token: "mock-token" });
  mockAxiosGet.mockResolvedValue({ data: { items: [] } });
  mockAxiosPost.mockResolvedValue({ data: { id: "cal-event-123" } });
  mockRespondPost.mockResolvedValue({ data: {} });
  mockRespondPut.mockResolvedValue({ data: {} });
});

// ─── Webhook 1 ────────────────────────────────────────────────────────────────
describe("POST /webhook/zap1", () => {
  test("responds immediately with 200 {status: received}", async () => {
    const res = await request(app)
      .post("/webhook/zap1")
      .send({ contact_id: "425933898", contact_name: "Ahmed" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "received" });
  });

  test("calls respond.io PUT with id:{contact_id} URL format", async () => {
    await request(app)
      .post("/webhook/zap1")
      .send({ contact_id: "425933898", contact_name: "Ahmed" });

    await flushAsync();

    expect(mockRespondPut).toHaveBeenCalledWith(
      "/contact/id:425933898",
      expect.any(Object),
    );
  });

  test("sets booking_state to awaiting_selection in contact update", async () => {
    await request(app)
      .post("/webhook/zap1")
      .send({ contact_id: "425933898", contact_name: "Ahmed" });

    await flushAsync();

    const putCall = mockRespondPut.mock.calls[0];
    const body = putCall[1];
    const bookingStateField = body.custom_fields.find(
      (f) => f.name === "booking_state",
    );
    expect(bookingStateField).toBeDefined();
    expect(bookingStateField.value).toBe("awaiting_selection");
  });

  test("sends WhatsApp message with channelId 0 and type text", async () => {
    await request(app)
      .post("/webhook/zap1")
      .send({ contact_id: "425933898", contact_name: "Ahmed" });

    await flushAsync();

    expect(mockRespondPost).toHaveBeenCalledWith(
      "/contact/id:425933898/message",
      expect.objectContaining({
        channelId: 0,
        message: expect.objectContaining({ type: "text" }),
      }),
    );
  });
});

// ─── Webhook 2 ────────────────────────────────────────────────────────────────
describe("POST /webhook/zap2", () => {
  const validPayload = {
    contact_id: "425933898",
    contact_name: "Ahmed",
    slot_number: "2",
    slot_1:
      "Mon, Apr 14, 10:00 AM – 11:00 AM | 2026-04-14T06:00:00.000Z | 2026-04-14T07:00:00.000Z",
    slot_2:
      "Mon, Apr 14, 11:00 AM – 12:00 PM | 2026-04-14T07:00:00.000Z | 2026-04-14T08:00:00.000Z",
  };

  test("responds immediately with 200 {status: received}", async () => {
    const res = await request(app).post("/webhook/zap2").send(validPayload);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "received" });
  });

  test("logs error and does NOT call Calendar API when slot field is missing", async () => {
    const consoleSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await request(app).post("/webhook/zap2").send({
      contact_id: "425933898",
      contact_name: "Ahmed",
      slot_number: "5", // slot_5 not in payload
    });

    await flushAsync();

    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("slot_5 not found in payload"),
    );

    consoleSpy.mockRestore();
  });

  test("creates calendar event with correct summary", async () => {
    await request(app).post("/webhook/zap2").send(validPayload);

    await flushAsync();

    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining("/events"),
      expect.objectContaining({ summary: "Roof Sealing - Inspection" }),
      expect.any(Object),
    );
  });

  test("sends WhatsApp confirmation with channelId 0 and type text", async () => {
    await request(app).post("/webhook/zap2").send(validPayload);

    await flushAsync();

    expect(mockRespondPost).toHaveBeenCalledWith(
      "/contact/id:425933898/message",
      expect.objectContaining({
        channelId: 0,
        message: expect.objectContaining({ type: "text" }),
      }),
    );
  });

  test("sets booking_state to scheduled and inspection_status to Scheduled", async () => {
    await request(app).post("/webhook/zap2").send(validPayload);

    await flushAsync();

    const putCall = mockRespondPut.mock.calls[0];
    const body = putCall[1];
    const bookingState = body.custom_fields.find(
      (f) => f.name === "booking_state",
    );
    const inspectionStatus = body.custom_fields.find(
      (f) => f.name === "inspection_status",
    );
    expect(bookingState?.value).toBe("scheduled");
    expect(inspectionStatus?.value).toBe("Scheduled");
  });

  test("calls respond.io PUT with id:{contact_id} URL format", async () => {
    await request(app).post("/webhook/zap2").send(validPayload);

    await flushAsync();

    expect(mockRespondPut).toHaveBeenCalledWith(
      "/contact/id:425933898",
      expect.any(Object),
    );
  });
});
