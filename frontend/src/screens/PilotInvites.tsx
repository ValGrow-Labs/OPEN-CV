import { useCallback, useEffect, useState } from "react";
import { ApiError, createPilotInvite, fetchPilotInvites, revokePilotInvite } from "../api/client";
import type { PilotInvite, PublicConfig } from "../api/types";
import { Badge } from "../ui/components";

const BASE_KEY = "glovesize.pilotBaseUrl.v1";

function readBase(): string {
  try {
    return window.localStorage.getItem(BASE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveBase(v: string) {
  try {
    window.localStorage.setItem(BASE_KEY, v);
  } catch {
    /* storage unavailable: the field simply is not remembered */
  }
}

export const inviteLink = (base: string, token: string) => `${base.replace(/\/+$/, "")}/#/pilot/${encodeURIComponent(token)}`;

export const whatsappText = (link: string) =>
  "Hi! Thank you for helping with our hand measurement study. Please open this personal link on your phone " +
  `(it is only for you, please don't forward it): ${link}\nIt takes about 15 minutes. You will need a ruler with mm marks, a book and a coin.`;

/**
 * Operator panel for the remote pilot: create one invite link per volunteer, send it (for example
 * by WhatsApp), follow progress and revoke links. Runs inside the operator-only validation screen.
 */
export function PilotInvites({ config }: { config: PublicConfig }) {
  const [invites, setInvites] = useState<PilotInvite[]>([]);
  const [consentReviewed, setConsentReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [base, setBase] = useState(() => readBase() || window.location.origin);
  const [fresh, setFresh] = useState<{ code: string; link: string; purpose: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(() => {
    fetchPilotInvites()
      .then((d) => {
        setInvites(d.invites);
        setConsentReviewed(d.consent_reviewed);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load invites."));
  }, []);

  useEffect(() => {
    if (config.pilot_remote_enabled) reload();
  }, [config.pilot_remote_enabled, reload]);

  if (!config.pilot_remote_enabled) {
    return (
      <section className="card stack" aria-labelledby="invites-title">
        <h2 id="invites-title">Remote pilot invites</h2>
        <p className="small muted">
          Off. Start the server with <code>GLOVESIZE_PILOT_REMOTE_ENABLED=true</code> to invite volunteers who measure and
          scan their own hand (docs/PILOT_PROTOCOL.md, remote pilot).
        </p>
      </section>
    );
  }

  const create = async (purpose: "pilot" | "test") => {
    setError(null);
    setCopied(false);
    try {
      const r = await createPilotInvite(purpose);
      setFresh({ code: r.invite.participant_code, link: inviteLink(base, r.token), purpose });
      reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not create the invite.");
    }
  };

  const httpsBase = /^https:\/\//.test(base);

  return (
    <section className="card stack" aria-labelledby="invites-title">
      <h2 id="invites-title">Remote pilot invites</h2>
      <p className="small muted">
        One personal link per volunteer. The link is their only key: send it to that person only. It lets them enrol,
        submit scans of their own hand and withdraw; it cannot show any other data.
      </p>
      <div className="field">
        <label htmlFor="pi-base">Public address (your tunnel URL)</label>
        <input
          id="pi-base"
          className="input"
          value={base}
          onChange={(e) => {
            setBase(e.target.value);
            saveBase(e.target.value);
          }}
          placeholder="https://example.trycloudflare.com"
        />
        {!httpsBase && (
          <span className="small" style={{ color: "var(--warn)" }}>
            Phones only allow the camera on https:// addresses. Paste the tunnel URL here.
          </span>
        )}
      </div>
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <button className="btn btn-primary" disabled={!consentReviewed} onClick={() => void create("pilot")}>
          New volunteer invite
        </button>
        <button className="btn" onClick={() => void create("test")}>
          New test invite
        </button>
      </div>
      {!consentReviewed && (
        <p className="small" style={{ color: "var(--warn)" }}>
          Volunteer invites are locked until the consent text (config/pilot_consent.json) has been reviewed. Test invites work
          now; their scans are never counted.
        </p>
      )}
      {error && (
        <div className="notice notice-error small" role="alert">
          {error}
        </div>
      )}
      {fresh && (
        <div className="notice notice-info small stack" role="status" style={{ gap: 8 }}>
          <span>
            {fresh.purpose === "test" ? "Test" : "Volunteer"} invite for <strong>{fresh.code}</strong>. This link is shown
            only once:
          </span>
          <code style={{ wordBreak: "break-all" }}>{fresh.link}</code>
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            <button
              className="btn"
              onClick={() => {
                void navigator.clipboard?.writeText(fresh.link).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            <a className="btn" href={`https://wa.me/?text=${encodeURIComponent(whatsappText(fresh.link))}`} target="_blank" rel="noreferrer">
              Send on WhatsApp
            </a>
          </div>
        </div>
      )}
      {invites.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table className="diag-table validation-table" style={{ minWidth: 560 }} aria-label="Invites">
            <thead>
              <tr>
                <th>Participant</th>
                <th>Type</th>
                <th>Status</th>
                <th>Enrolled</th>
                <th>Scans</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...invites].reverse().map((i) => (
                <tr key={i.id}>
                  <td>{i.participant_code}</td>
                  <td>{i.purpose === "pilot" ? <Badge tone="info">volunteer</Badge> : <Badge tone="neutral">test</Badge>}</td>
                  <td>{i.status}</td>
                  <td>{i.enrolled ? "yes" : "no"}</td>
                  <td>
                    {i.submissions} / {i.max_submissions}
                  </td>
                  <td>{i.expires_at.slice(0, 10)}</td>
                  <td>
                    {i.status === "open" && (
                      <button
                        className="link small"
                        onClick={() => {
                          if (window.confirm(`Revoke the link for ${i.participant_code}?`)) void revokePilotInvite(i.id).then(reload);
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
