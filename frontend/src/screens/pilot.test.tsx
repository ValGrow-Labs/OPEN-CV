// @vitest-environment jsdom
// Remote pilot screens. Every session and response here is a SYNTHETIC test fixture.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PilotSession, PublicConfig } from "../api/types";
import { publicConfig } from "../test/fixtures";
import { customerCoins } from "../ui/settings";
import { CoinConfirm } from "./CoinConfirm";
import { inviteLink, PilotInvites, whatsappText } from "./PilotInvites";
import { PilotScreen } from "./PilotScreen";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const withPilotCoin = (over: Partial<PublicConfig> = {}): PublicConfig => {
  const c = publicConfig(over);
  c.reference_objects.objects.push({
    id: "inr_2_2019",
    label: "Indian 2-rupee coin, 2019 series (silver-coloured)",
    shape: "circle",
    diameter_mm: 23,
    diameter_uncertainty_mm: 0.1,
    thickness_mm: null,
    source: "Gazette",
    enabled: true,
    availability: "pilot",
    notes: null,
  });
  return c;
};

const session = (over: Partial<PilotSession> = {}): PilotSession => ({
  participant_code: "P-ABC123",
  purpose: "pilot",
  consent: { version: "v1", title: "Taking part", paragraphs: ["What is recorded: numbers only."], reviewed: true },
  coins: [
    { id: "us_quarter", label: "US quarter", diameter_mm: 24.26 },
    { id: "inr_2_2019", label: "Indian 2-rupee coin, 2019 series", diameter_mm: 23 },
  ],
  coin_check_tolerance_mm: 1.5,
  enrolment: null,
  scan_plan: ["standard", "standard", "standard", "distance_near"],
  scans: [],
  submissions: 0,
  max_submissions: 20,
  expires_at: "2026-11-20T00:00:00+00:00",
  ...over,
});

/** fetch mock routed by method + path. */
function routes(map: Record<string, (init: RequestInit) => [number, unknown]>) {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? "GET"} ${url}`;
    const handler = map[key];
    if (!handler) throw new Error(`unexpected ${key}`);
    const [status, body] = handler(init);
    return new Response(JSON.stringify(body), { status });
  });
}

describe("pilot-only coins", () => {
  it("are never offered to customers", () => {
    const c = withPilotCoin();
    expect(customerCoins(c).map((o) => o.id)).not.toContain("inr_2_2019");
    render(<CoinConfirm config={c} reference={{ object_id: "us_quarter" }} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.queryByText(/2-rupee/)).toBeNull();
  });
});

describe("invite links", () => {
  it("keeps the token in the URL fragment and builds a WhatsApp message", () => {
    const link = inviteLink("https://abc.trycloudflare.com/", "tok_en-1");
    expect(link).toBe("https://abc.trycloudflare.com/#/pilot/tok_en-1");
    expect(whatsappText(link)).toContain(link);
  });

  it("locks volunteer invites until the consent text is reviewed", async () => {
    const fetchMock = routes({
      "GET /api/pilot/invites": () => [200, { invites: [], consent_reviewed: false }],
      "POST /api/pilot/invites": () => [
        201,
        {
          token: "T".repeat(43),
          invite: { id: "1", participant_code: "P-TEST01", purpose: "test", created_at: "", expires_at: "2026-11-20", submissions: 0, max_submissions: 20, enrolled: false, status: "open" },
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PilotInvites config={publicConfig({ pilot_remote_enabled: true })} />);
    const volunteer = (await screen.findByRole("button", { name: "New volunteer invite" })) as HTMLButtonElement;
    await waitFor(() => expect(screen.getByText(/locked until the consent text/)).toBeTruthy());
    expect(volunteer.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Public address/), { target: { value: "https://abc.trycloudflare.com" } });
    fireEvent.click(screen.getByRole("button", { name: "New test invite" }));
    await screen.findByText("https://abc.trycloudflare.com/#/pilot/" + "T".repeat(43));
    const wa = screen.getByRole("link", { name: "Send on WhatsApp" }) as HTMLAnchorElement;
    expect(wa.href).toContain("https://wa.me/?text=");
    expect(decodeURIComponent(wa.href)).toContain("#/pilot/" + "T".repeat(43));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect((post[1]!.headers as Record<string, string>)["X-Glovesize-Operator"]).toBe("1");
  });

  it("explains how to switch the remote pilot on", () => {
    render(<PilotInvites config={publicConfig()} />);
    expect(screen.getByText(/GLOVESIZE_PILOT_REMOTE_ENABLED/)).toBeTruthy();
  });
});

describe("volunteer flow", () => {
  it("shows a clear message for an inactive link", async () => {
    vi.stubGlobal("fetch", routes({ "GET /api/pilot/me": () => [410, { detail: "this link is no longer active (revoked)" }] }));
    render(<PilotScreen config={withPilotCoin()} token={"t".repeat(43)} />);
    expect(await screen.findByText("This link is not active")).toBeTruthy();
  });

  it("walks through consent, coin check and measurements, then enrols with server units", async () => {
    let enrolBody: Record<string, unknown> | null = null;
    let enrolled = false;
    const fetchMock = routes({
      "GET /api/pilot/me": () => [200, enrolled ? session({ enrolment: { hand: "right", coin_object_id: "inr_2_2019" } }) : session()],
      "POST /api/pilot/me/enrol": (init) => {
        enrolBody = JSON.parse(String(init.body));
        enrolled = true;
        return [200, { enrolled: true }];
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PilotScreen config={withPilotCoin()} token={"t".repeat(43)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    // Consent must be ticked.
    const agree = screen.getByRole("button", { name: "I agree" }) as HTMLButtonElement;
    expect(agree.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I have read this and agree/));
    fireEvent.click(agree);

    // Coin: an older-series size is caught before anything is sent.
    fireEvent.click(screen.getByLabelText(/Indian 2-rupee coin/));
    fireEvent.change(screen.getByLabelText(/Measure the coin across/), { target: { value: "27" } });
    expect(screen.getByText(/older series/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Measure the coin across/), { target: { value: "23" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    // Hand measurement in cm, two agreeing readings.
    fireEvent.click(screen.getByLabelText("Right"));
    fireEvent.click(screen.getByLabelText("Someone helped me"));
    fireEvent.change(screen.getByLabelText("Unit"), { target: { value: "cm" } });
    fireEvent.change(screen.getByLabelText("Reading 1"), { target: { value: "18.6" } });
    fireEvent.change(screen.getByLabelText("Reading 2"), { target: { value: "18.7" } });
    expect(screen.getByText("Your readings agree.")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save and start scanning" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); // phone model missing
    fireEvent.change(screen.getByLabelText("Phone model"), { target: { value: "Redmi Note 12" } });
    fireEvent.click(save);

    await screen.findByRole("heading", { name: "Scan your hand" });
    expect(enrolBody).toEqual({
      consent_version: "v1",
      consent_accepted: true,
      hand: "right",
      helper: "with_helper",
      hand_length: [
        { value: 18.6, unit: "cm" },
        { value: 18.7, unit: "cm" },
      ],
      tool: "ruler",
      coin_object_id: "inr_2_2019",
      coin_check: { value: 23, unit: "mm" }, // the coin was measured in mm before the switch to cm
      device: "Redmi Note 12",
    });
    const headers = fetchMock.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers["X-Pilot-Token"]).toBe("t".repeat(43));
  });

  it("follows the scan plan and lets the volunteer withdraw", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = routes({
      "GET /api/pilot/me": () => [
        200,
        session({
          enrolment: { hand: "left", coin_object_id: "us_quarter" },
          scans: [
            { condition: "standard", scan_status: "accepted", reasons: [] },
            { condition: "standard", scan_status: "rejected", reasons: ["coin_tilted"] },
          ],
          submissions: 2,
        }),
      ],
      "DELETE /api/pilot/me": () => [200, { deleted_records: 2 }],
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PilotScreen config={withPilotCoin()} token={"t".repeat(43)} />);
    const plan = await screen.findByRole("list", { name: "Scan plan" });
    // One standard scan accepted: the next step is the second standard scan.
    expect(plan.textContent).toMatch(/✓ Standard scan.*Standard scan.*Standard scan.*A little closer/);
    expect(screen.getByRole("heading", { name: "Standard scan" })).toBeTruthy();
    expect(screen.getByText(/Use your left hand and the US quarter/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw and delete my data" }));
    expect(await screen.findByText(/Your data has been deleted \(2 scans\)/)).toBeTruthy();
  });
});
