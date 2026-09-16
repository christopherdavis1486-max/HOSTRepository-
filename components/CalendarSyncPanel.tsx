"use client";

import { useCallback, useEffect, useState } from "react";
import { useHostI18n } from "@/lib/i18n/useHostI18n";

type CalendarFeed = {
  id: string;
  name: string;
  providerHost: string;
  isActive: boolean;
  lastSyncStatus: string;
  lastSyncStartedAt: string | null;
  lastSyncCompletedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

type ApiErrorBody = {
  error?: {
    message?: string;
  };
};

type CalendarSyncPanelProps = {
  propertyId: string;
  onAvailabilityChanged?: () => void;
};

function readableDate(
  value: string | null,
): string {
  if (!value) return "Not yet";

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString();
}

async function responseBody(
  response: Response,
): Promise<Record<string, unknown> & ApiErrorBody> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export function CalendarSyncPanel({
  propertyId,
  onAvailabilityChanged,
}: CalendarSyncPanelProps) {
  const { ht, hStatus } = useHostI18n();

  const [feeds, setFeeds] =
    useState<CalendarFeed[]>([]);
  const [exportUrl, setExportUrl] =
    useState("");
  const [name, setName] =
    useState("");
  const [feedUrl, setFeedUrl] =
    useState("");
  const [loading, setLoading] =
    useState(true);
  const [busyId, setBusyId] =
    useState<string | null>(null);
  const [adding, setAdding] =
    useState(false);
  const [rotating, setRotating] =
    useState(false);
  const [message, setMessage] =
    useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);

    try {
      const [feedsResponse, exportResponse] =
        await Promise.all([
          fetch(
            `/api/host/properties/${propertyId}/calendars`,
            {
              credentials: "include",
              cache: "no-store",
            },
          ),
          fetch(
            `/api/host/properties/${propertyId}/calendar-export`,
            {
              credentials: "include",
              cache: "no-store",
            },
          ),
        ]);

      const feedsBody =
        await responseBody(feedsResponse);
      const exportBody =
        await responseBody(exportResponse);

      if (!feedsResponse.ok) {
        throw new Error(
          feedsBody.error?.message ??
            "Unable to load imported calendars.",
        );
      }

      if (!exportResponse.ok) {
        throw new Error(
          exportBody.error?.message ??
            "Unable to load the export link.",
        );
      }

      setFeeds(
        Array.isArray(feedsBody.feeds)
          ? feedsBody.feeds as CalendarFeed[]
          : [],
      );

      setExportUrl(
        typeof exportBody.exportUrl === "string"
          ? exportBody.exportUrl
          : "",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : ht("Unable to load calendar settings."),
      );
    } finally {
      setLoading(false);
    }
  }, [ht, propertyId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addCalendar(
    event: React.FormEvent,
  ) {
    event.preventDefault();

    if (!name.trim() || !feedUrl.trim()) {
      setMessage(
        ht("Enter a calendar name and HTTPS calendar URL."),
      );
      return;
    }

    setAdding(true);
    setMessage(null);

    try {
      const response = await fetch(
        `/api/host/properties/${propertyId}/calendars`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: name.trim(),
            feedUrl: feedUrl.trim(),
          }),
        },
      );

      const body = await responseBody(response);

      if (!response.ok) {
        throw new Error(
          body.error?.message ??
            "Unable to add calendar.",
        );
      }

      const feed =
        body.feed as CalendarFeed | undefined;

      setName("");
      setFeedUrl("");

      if (feed?.id) {
        const syncResponse = await fetch(
          `/api/host/properties/${propertyId}/calendars/${feed.id}/sync`,
          {
            method: "POST",
            credentials: "include",
          },
        );

        const syncBody =
          await responseBody(syncResponse);

        if (!syncResponse.ok) {
          setMessage(
            syncBody.error?.message ??
              ht(
                "Calendar added, but its first sync did not complete.",
              ),
          );
        } else {
          setMessage(
            ht("Calendar added and synchronised."),
          );
          onAvailabilityChanged?.();
        }
      } else {
        setMessage(ht("Calendar added."));
      }

      await load();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : ht("Unable to add calendar."),
      );
    } finally {
      setAdding(false);
    }
  }

  async function syncFeed(feedId: string) {
    setBusyId(feedId);
    setMessage(null);

    try {
      const response = await fetch(
        `/api/host/properties/${propertyId}/calendars/${feedId}/sync`,
        {
          method: "POST",
          credentials: "include",
        },
      );

      const body = await responseBody(response);

      if (!response.ok) {
        throw new Error(
          body.error?.message ??
            "Unable to synchronise calendar.",
        );
      }

      setMessage(
        ht("Calendar synchronised successfully."),
      );
      await load();
      onAvailabilityChanged?.();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : ht("Unable to synchronise calendar."),
      );
    } finally {
      setBusyId(null);
    }
  }

  async function setActive(
    feed: CalendarFeed,
  ) {
    setBusyId(feed.id);
    setMessage(null);

    try {
      const response = await fetch(
        `/api/host/properties/${propertyId}/calendars/${feed.id}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            isActive: !feed.isActive,
          }),
        },
      );

      const body = await responseBody(response);

      if (!response.ok) {
        throw new Error(
          body.error?.message ??
            "Unable to update calendar.",
        );
      }

      setMessage(
        feed.isActive
          ? ht("Calendar disabled.")
          : ht("Calendar enabled."),
      );
      await load();
      onAvailabilityChanged?.();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : ht("Unable to update calendar."),
      );
    } finally {
      setBusyId(null);
    }
  }

  async function removeFeed(
    feed: CalendarFeed,
  ) {
    const confirmed = window.confirm(
      ht(
        `Remove "${feed.name}"? Imported dates from this calendar will be cleared.`,
      ),
    );

    if (!confirmed) return;

    setBusyId(feed.id);
    setMessage(null);

    try {
      const response = await fetch(
        `/api/host/properties/${propertyId}/calendars/${feed.id}`,
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      const body = await responseBody(response);

      if (!response.ok) {
        throw new Error(
          body.error?.message ??
            "Unable to remove calendar.",
        );
      }

      setMessage(ht("Calendar removed."));
      await load();
      onAvailabilityChanged?.();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : ht("Unable to remove calendar."),
      );
    } finally {
      setBusyId(null);
    }
  }

  async function copyExportUrl() {
    if (!exportUrl) return;

    try {
      await navigator.clipboard.writeText(
        exportUrl,
      );
      setMessage(
        ht("Calendar export link copied."),
      );
    } catch {
      setMessage(
        ht(
          "Copy was blocked. Select the link and copy it manually.",
        ),
      );
    }
  }

  async function rotateExportUrl() {
    const confirmed = window.confirm(
      ht(
        "Replace this export link? Calendars using the old link will stop updating.",
      ),
    );

    if (!confirmed) return;

    setRotating(true);
    setMessage(null);

    try {
      const response = await fetch(
        `/api/host/properties/${propertyId}/calendar-export`,
        {
          method: "POST",
          credentials: "include",
        },
      );

      const body = await responseBody(response);

      if (!response.ok) {
        throw new Error(
          body.error?.message ??
            "Unable to replace export link.",
        );
      }

      setExportUrl(
        typeof body.exportUrl === "string"
          ? body.exportUrl
          : "",
      );
      setMessage(
        ht("A new calendar export link was created."),
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : ht("Unable to replace export link."),
      );
    } finally {
      setRotating(false);
    }
  }

  return (
    <section className="calendar-sync-panel">
      <style>{`
        .calendar-sync-panel {
          margin-top: 28px;
          padding-top: 28px;
          border-top: 1px solid #342c20;
        }
        .calendar-sync-panel h3 {
          margin: 0 0 8px;
          font-family: Georgia, serif;
          font-size: 25px;
          color: #fff8e8;
        }
        .calendar-sync-panel .calendar-intro,
        .calendar-sync-panel .calendar-note {
          color: #c4a98b;
          line-height: 1.6;
        }
        .calendar-sync-panel .calendar-note {
          font-size: 12px;
        }
        .calendar-sync-panel .calendar-form {
          display: grid;
          grid-template-columns: minmax(150px, .65fr) minmax(240px, 1.35fr) auto;
          gap: 10px;
          margin: 18px 0 22px;
        }
        .calendar-sync-panel input {
          min-width: 0;
          padding: 11px 12px;
          border: 1px solid #493d2c;
          border-radius: 3px;
          background: #100f0c;
          color: #fff8e8;
        }
        .calendar-sync-panel button {
          padding: 10px 13px;
          border: 1px solid #493d2c;
          border-radius: 3px;
          background: transparent;
          color: #fff8e8;
          cursor: pointer;
        }
        .calendar-sync-panel button.primary {
          border-color: #d49a3f;
          background: #d49a3f;
          color: #100f0c;
          font-weight: 700;
        }
        .calendar-sync-panel button.danger {
          color: #efb0a7;
        }
        .calendar-sync-panel button:disabled {
          cursor: not-allowed;
          opacity: .55;
        }
        .calendar-sync-panel .feed-list {
          display: grid;
          gap: 12px;
          margin-bottom: 26px;
        }
        .calendar-sync-panel .feed-card {
          padding: 15px;
          border: 1px solid #342c20;
          border-radius: 4px;
          background: #181510;
        }
        .calendar-sync-panel .feed-heading,
        .calendar-sync-panel .feed-actions,
        .calendar-sync-panel .export-actions {
          display: flex;
          align-items: center;
          gap: 9px;
          flex-wrap: wrap;
        }
        .calendar-sync-panel .feed-heading {
          justify-content: space-between;
        }
        .calendar-sync-panel .feed-provider,
        .calendar-sync-panel .feed-meta,
        .calendar-sync-panel .feed-error {
          margin: 7px 0 0;
          font-size: 12px;
          line-height: 1.5;
          color: #c4a98b;
        }
        .calendar-sync-panel .feed-error {
          color: #efb0a7;
        }
        .calendar-sync-panel .status-pill {
          padding: 4px 8px;
          border: 1px solid #493d2c;
          border-radius: 999px;
          color: #d49a3f;
          font-size: 11px;
        }
        .calendar-sync-panel .feed-actions {
          margin-top: 13px;
        }
        .calendar-sync-panel .export-box {
          padding: 16px;
          border: 1px solid #493d2c;
          border-radius: 4px;
          background: #1d1a15;
        }
        .calendar-sync-panel .export-field {
          width: 100%;
          margin: 10px 0;
          box-sizing: border-box;
          font-family: Consolas, monospace;
          font-size: 12px;
        }
        .calendar-sync-panel .calendar-message {
          margin-top: 14px;
          color: #d49a3f;
        }
        @media (max-width: 760px) {
          .calendar-sync-panel .calendar-form {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <h3>{ht("Calendar sync")}</h3>
      <p className="calendar-intro">
        {ht(
          "Import an external iCal calendar to block occupied nights, and share HOST availability with other booking platforms.",
        )}
      </p>

      <form
        className="calendar-form"
        onSubmit={addCalendar}
      >
        <input
          type="text"
          value={name}
          onChange={(event) =>
            setName(event.target.value)
          }
          maxLength={120}
          placeholder={ht("Calendar name")}
          aria-label={ht("Calendar name")}
        />
        <input
          type="url"
          value={feedUrl}
          onChange={(event) =>
            setFeedUrl(event.target.value)
          }
          placeholder="https://provider.example/calendar.ics"
          aria-label={ht("External HTTPS iCal URL")}
        />
        <button
          type="submit"
          className="primary"
          disabled={adding}
        >
          {adding
            ? ht("Adding…")
            : ht("Add calendar")}
        </button>
      </form>

      {loading ? (
        <p className="calendar-note">
          {ht("Loading calendar settings…")}
        </p>
      ) : feeds.length === 0 ? (
        <p className="calendar-note">
          {ht("No external calendars connected.")}
        </p>
      ) : (
        <div className="feed-list">
          {feeds.map((feed) => {
            const busy = busyId === feed.id;

            return (
              <article
                className="feed-card"
                key={feed.id}
              >
                <div className="feed-heading">
                  <strong>{feed.name}</strong>
                  <span className="status-pill">
                    {feed.isActive
                      ? hStatus(feed.lastSyncStatus)
                      : ht("disabled")}
                  </span>
                </div>

                <p className="feed-provider">
                  {feed.providerHost}
                </p>

                <p className="feed-meta">
                  {ht("Last successful sync")}:{" "}
                  {readableDate(
                    feed.lastSuccessfulSyncAt,
                  )}
                </p>

                {feed.lastError && (
                  <p className="feed-error">
                    {feed.lastError}
                  </p>
                )}

                <div className="feed-actions">
                  <button
                    type="button"
                    onClick={() =>
                      void syncFeed(feed.id)
                    }
                    disabled={busy || !feed.isActive}
                  >
                    {busy
                      ? ht("Working…")
                      : ht("Sync now")}
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      void setActive(feed)
                    }
                    disabled={busy}
                  >
                    {feed.isActive
                      ? ht("Disable")
                      : ht("Enable")}
                  </button>

                  <button
                    type="button"
                    className="danger"
                    onClick={() =>
                      void removeFeed(feed)
                    }
                    disabled={busy}
                  >
                    {ht("Remove")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <div className="export-box">
        <strong>
          {ht("Export HOST availability")}
        </strong>
        <p className="calendar-note">
          {ht(
            "Paste this private link into another booking platform. Anyone with the link can view blocked dates, so do not publish it.",
          )}
        </p>

        <input
          className="export-field"
          type="text"
          readOnly
          value={exportUrl}
          aria-label={ht("Private calendar export URL")}
          onFocus={(event) =>
            event.currentTarget.select()
          }
        />

        <div className="export-actions">
          <button
            type="button"
            className="primary"
            onClick={() => void copyExportUrl()}
            disabled={!exportUrl}
          >
            {ht("Copy export link")}
          </button>

          <button
            type="button"
            onClick={() => void rotateExportUrl()}
            disabled={rotating}
          >
            {rotating
              ? ht("Replacing…")
              : ht("Replace private link")}
          </button>
        </div>
      </div>

      <p className="calendar-note">
        {ht(
          "Calendar sync is not instant. Keep a safety gap between channels and use Sync now after important changes.",
        )}
      </p>

      {message && (
        <p
          className="calendar-message"
          role="status"
        >
          {message}
        </p>
      )}
    </section>
  );
}
