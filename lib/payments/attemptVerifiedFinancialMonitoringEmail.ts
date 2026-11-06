import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {verifyFinancialMonitoringEmailOccurrences as verify}
  from "./verifyFinancialMonitoringEmailOccurrences";
import {attemptStoredFinancialMonitoringEmail as store}
  from "./attemptStoredFinancialMonitoringEmail";
import type {MonitoringEmailSender} from "./attemptFinancialMonitoringEmail";

function readRecord(file: string) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.size > 65536) {
    throw new Error("Invalid monitoring email acceptance record");
  }
  const bytes = fs.readFileSync(file);
  if (bytes.length > 65536) throw new Error("Invalid monitoring email acceptance record");
  return JSON.parse(bytes.toString("utf8"));
}

/**
 * Explicit local mocked-sender workflow; no default provider or scheduler.
 * Stop history writers throughout verification and the attempt.
 * Trusted separate attempt directory required; records are not authenticated.
 * Only the latest record's warning opening or clearing is eligible.
 * No catch-up delivery, reminders, retries or inbox-delivery claims.
 */
export async function attemptVerifiedFinancialMonitoringEmail(
  source: {
    directory: string;
    identity: Parameters<typeof verify>[1];
    chainId: string;
    observations: Parameters<typeof verify>[3];
  },
  attemptDirectory: string,
  selection: {key: string; kind: "opened" | "cleared"; recipient: string},
  sender: MonitoringEmailSender
) {
  const selected = structuredClone(selection);
  if (!selected || !["opened","cleared"].includes(selected.kind) ||
      typeof selected.recipient !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(selected.recipient)) {
    throw new Error("Invalid monitoring email selection");
  }
  const replay = verify(source.directory, source.identity,
    source.chainId, source.observations);
  const latest = replay.transitions[replay.transitions.length - 1];
  const row = latest.rows.find(value => value.finding.key === selected.key);
  if (!row || row.status !== selected.kind ||
      row.finding.severity !== "warning") {
    throw new Error("Monitoring transition is not eligible for email");
  }
  const attemptRoot = fs.realpathSync(attemptDirectory);
  if (attemptRoot === fs.realpathSync(source.directory)) {
    throw new Error("Monitoring attempts require a separate directory");
  }

  if (selected.kind === "cleared") {
    const openingId = crypto.createHash("sha256").update(JSON.stringify([
      "monitoring-email-attempt",1,row.occurrence.id,
      "email",selected.recipient,"opened"
    ]),"utf8").digest("hex");
    const intent = readRecord(path.join(attemptRoot,openingId+".intent.json"));
    const result = readRecord(path.join(attemptRoot,openingId+".outcome.json"));
    if (intent.version !== 1 || intent.attemptId !== openingId ||
        intent.occurrenceId !== row.occurrence.id ||
        intent.transitionHead !== row.occurrence.openingHead ||
        intent.kind !== "opened" || intent.channel !== "email" ||
        intent.recipient !== selected.recipient ||
        typeof intent.messageDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(intent.messageDigest) ||
        result.version !== 1 || result.attemptId !== openingId ||
        result.outcome?.status !== "accepted" ||
        typeof result.outcome.providerMessageId !== "string" ||
        !result.outcome.providerMessageId.trim()) {
      throw new Error("Matching opening acceptance required");
    }
  }

  const body = [
    "HOST monitoring condition: " + selected.kind,
    "Condition: " + row.finding.key,
    "Source: " + source.identity.environment + "/" +
      source.identity.database + "/" + source.identity.schema,
    "Record: " + latest.head,
    selected.kind === "cleared"
      ? "Only this named monitoring condition cleared; financial completion is not established."
      : "Review this monitoring warning; no automatic financial action was taken."
  ].join("\n");
  return store(attemptRoot,{
    occurrenceId: row.occurrence.id,
    transitionHead: latest.head,
    kind: selected.kind,
    message: {
      to: selected.recipient,
      subject: "HOST monitoring: " + selected.kind + " warning",
      body
    }
  },sender);
}
