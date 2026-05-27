import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRequest, responseJson } from "@/__tests__/helpers";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.MAILERLITE_API_KEY = "test-key";
  process.env.MAILERLITE_GROUP_ID = "12345";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function loadRoute() {
  const mod = await import("./route");
  return mod.POST;
}

describe("POST /api/lead", () => {
  it("returns 400 when email is missing", async () => {
    const POST = await loadRoute();
    const res = await POST(fakeRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when email is invalid", async () => {
    const POST = await loadRoute();
    const res = await POST(fakeRequest({ email: "not-an-email" }));
    expect(res.status).toBe(400);
  });

  it("returns 500 when MAILERLITE_API_KEY is missing", async () => {
    delete process.env.MAILERLITE_API_KEY;
    const POST = await loadRoute();
    const res = await POST(fakeRequest({ email: "lead@example.com" }));
    expect(res.status).toBe(500);
  });

  it("posts email and group to MailerLite and returns 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "sub-1" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const POST = await loadRoute();
    const res = await POST(fakeRequest({ email: "lead@example.com" }));

    expect(res.status).toBe(200);
    const body = (await responseJson(res)) as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://connect.mailerlite.com/api/subscribers");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    const sent = JSON.parse(init.body);
    expect(sent.email).toBe("lead@example.com");
    expect(sent.groups).toEqual(["12345"]);
  });

  it("omits groups when MAILERLITE_GROUP_ID is unset", async () => {
    delete process.env.MAILERLITE_GROUP_ID;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "sub-2" } }), {
        status: 201,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const POST = await loadRoute();
    const res = await POST(fakeRequest({ email: "lead@example.com" }));
    expect(res.status).toBe(200);

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.groups).toBeUndefined();
  });

  it("treats 200 from MailerLite (already subscribed) as success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "sub-existing" } }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const POST = await loadRoute();
    const res = await POST(fakeRequest({ email: "lead@example.com" }));
    expect(res.status).toBe(200);
  });

  it("returns 502 when MailerLite responds with an error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ message: "boom" }), { status: 422 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const POST = await loadRoute();
    const res = await POST(fakeRequest({ email: "lead@example.com" }));
    expect(res.status).toBe(502);
  });
});
