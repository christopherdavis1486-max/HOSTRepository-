"use client";

import { useEffect, useRef, useState } from "react";
import { useHostI18n } from "@/lib/i18n/useHostI18n";

/**
 * The messaging BACKEND already existed, complete and correct, before
 * Batch 7 (GET/POST /api/bookings/[id]/messages, mark-read, real
 * ownership checks via resolveBookingAccess, new_message notifications
 * already wired) — confirmed by reading it directly before building
 * this. This component is the genuinely missing piece: a frontend that
 * actually calls it. Used identically from both the guest Trip Detail
 * page and the host Booking Detail page — the backend already scopes
 * correctly to whichever authenticated party is asking (guest vs host),
 * so one component works for both without needing to know which side
 * it's on.
 */

type Message = {
  id: string;
  senderType: "guest" | "host" | "system";
  senderUserId: string | null;
  body: string;
  isSystemMessage: boolean;
  readAt: string | null;
  createdAt: string;
};

export function MessageThread({ bookingId, viewerRole }: { bookingId: string; viewerRole: "guest" | "host" }) {
  const { ht, locale } = useHostI18n();
  const [messages, setMessages] = useState<Message[]>([]);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadMessages = () => {
    fetch(`/api/bookings/${bookingId}/messages`, { credentials: "include" })
      .then(async (res) => {
        const data = await res.json();
        if (!data.success) { setState("error"); return; }
        setMessages(data.messages);
        setState("loaded");
      })
      .catch(() => setState("error"));
  };

  useEffect(loadMessages, [bookingId]);

  useEffect(() => {
    // Mark read whenever the thread is viewed — matches the backend's
    // own semantics exactly (marks every message NOT sent by the
    // current viewer as read).
    fetch(`/api/bookings/${bookingId}/messages/read`, { method: "POST", credentials: "include" }).catch(() => {});
  }, [bookingId, messages.length]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    setSendError(null);
    if (!draft.trim()) return;

    setSending(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ body: draft.trim() }),
      });
      const data = await res.json();
      if (!data.success) {
        setSendError(data.error?.message ?? "Couldn't send your message. Please try again.");
        setSending(false);
        return;
      }
      setDraft("");
      setSending(false);
      loadMessages(); // reload with the backend-confirmed message, not just the locally-typed draft
    } catch {
      setSendError("Something went wrong reaching the server. Please try again.");
      setSending(false);
    }
  };

  return (
    <div className="msg-thread">
      <style>{`
        .msg-thread { background: var(--graphite); border: 1px solid var(--stone); border-radius: 8px; padding: 20px; }
        .msg-thread h2 { font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--brass); font-weight: 400; margin-bottom: 14px; }
        .msg-list { display: flex; flex-direction: column; gap: 10px; max-height: 340px; overflow-y: auto; margin-bottom: 14px; padding-right: 4px; }
        .msg-empty { color: var(--warm-grey); font-size: 13px; padding: 12px 0; }
        .msg-bubble { max-width: 80%; padding: 10px 13px; border-radius: 8px; font-size: 13px; line-height: 1.5; }
        .msg-bubble.mine { align-self: flex-end; background: var(--brass); color: var(--ink); }
        .msg-bubble.theirs { align-self: flex-start; background: var(--ink); border: 1px solid var(--stone); color: var(--ivory); }
        .msg-bubble.system { align-self: center; background: transparent; border: 1px dashed var(--stone); color: var(--warm-grey); font-size: 12px; max-width: 90%; text-align: center; }
        .msg-meta { font-size: 10px; opacity: 0.7; margin-top: 4px; }
        .msg-form { display: flex; gap: 8px; }
        .msg-form textarea { flex: 1; background: var(--ink); border: 1px solid var(--stone); color: var(--ivory); padding: 10px 12px; border-radius: 4px; font-family: var(--font-body); font-size: 13px; resize: none; min-height: 40px; }
        .msg-form textarea:focus { outline: none; border-color: var(--brass); }
        .msg-send-btn { background: var(--brass); color: var(--ink); border: none; padding: 0 18px; border-radius: 4px; font-family: var(--font-body); font-size: 13px; font-weight: 500; cursor: pointer; }
        .msg-send-btn:disabled { opacity: 0.6; cursor: wait; }
        .msg-error { font-size: 12px; color: var(--error); margin-bottom: 8px; }
      `}</style>

      <h2>{ht("Messages")}</h2>

      {state === "loading" && <div className="msg-empty">{ht("Loading messages…")}</div>}
      {state === "error" && <div className="msg-empty">{ht("Couldn't load messages right now.")}</div>}

      {state === "loaded" && (
        <>
          {messages.length === 0 && <div className="msg-empty">{ht("No messages yet. Send the first one below.")}</div>}
          <div className="msg-list">
            {messages.map((m) => {
              const isSystem = m.isSystemMessage || m.senderType === "system";
              const isMine = !isSystem && m.senderType === viewerRole;
              return (
                <div key={m.id} className={`msg-bubble ${isSystem ? "system" : isMine ? "mine" : "theirs"}`}>
                  {m.body}
                  <div className="msg-meta">{new Date(m.createdAt).toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
        </>
      )}

      {sendError && <div className="msg-error">{sendError}</div>}
      <form className="msg-form" onSubmit={handleSend}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={ht("Write a message…")}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(e); } }}
        />
        <button type="submit" className="msg-send-btn" disabled={sending || !draft.trim()}>{sending ? "…" : ht("Send")}</button>
      </form>
    </div>
  );
}
