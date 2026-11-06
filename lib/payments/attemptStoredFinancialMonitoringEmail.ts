import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {withFinancialMonitoringHistoryLock as lock}
  from "./withFinancialMonitoringHistoryLock";
import {attemptFinancialMonitoringEmail as attempt,
  type MonitoringEmailMessage, type MonitoringEmailSender}
  from "./attemptFinancialMonitoringEmail";

type Request = {
  occurrenceId: string;
  transitionHead: string;
  kind: "opened" | "cleared";
  message: MonitoringEmailMessage;
};
const sha = (text: string) =>
  crypto.createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Trusted dedicated local attempt directory; injected sender only.
 * Caller must establish warning/clearing eligibility from verified history.
 * Existing intents block resend regardless of outcome. No automatic retry.
 * A partial intent/outcome or leftover lock requires manual investigation.
 * File sync does not guarantee directory durability after power loss.
 */
export async function attemptStoredFinancialMonitoringEmail(
  directory: string, request: Request, sender: MonitoringEmailSender
) {
  const captured = structuredClone(request);
  const message = captured?.message;
  if (!captured || !/^[a-f0-9]{64}$/.test(captured.occurrenceId) ||
      !/^[a-f0-9]{64}$/.test(captured.transitionHead) ||
      !["opened", "cleared"].includes(captured.kind) ||
      !message || typeof message.to !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.to) ||
      typeof message.subject !== "string" || !message.subject.trim() ||
      /[\r\n]/.test(message.subject) ||
      typeof message.body !== "string" || !message.body.trim() ||
      typeof sender !== "function") {
    throw new Error("Invalid stored monitoring email request");
  }
  const root = fs.realpathSync(directory);
  if (!fs.statSync(root).isDirectory()) {
    throw new Error("Monitoring attempt directory required");
  }
  const attemptId = sha(JSON.stringify([
    "monitoring-email-attempt", 1, captured.occurrenceId,
    "email", message.to, captured.kind
  ]));
  const intentFile = path.join(root, attemptId + ".intent.json");
  const outcomeFile = path.join(root, attemptId + ".outcome.json");

  function save(file: string, value: unknown) {
    const descriptor = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(value) + "\n", "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  return lock(path.join(root, ".attempt.lock"), async () => {
    if (fs.existsSync(intentFile) || fs.existsSync(outcomeFile)) {
      throw new Error("Monitoring email attempt already recorded; resend refused");
    }
    save(intentFile, {
      version: 1, attemptId,
      occurrenceId: captured.occurrenceId,
      transitionHead: captured.transitionHead,
      kind: captured.kind, channel: "email", recipient: message.to,
      messageDigest: sha(JSON.stringify([
        message.to, message.subject, message.body
      ])),
      createdAt: new Date().toISOString()
    });
    const outcome = await attempt(message, sender);
    // Failure here leaves the intent, blocking an automatic resend.
    save(outcomeFile, {
      version: 1, attemptId, recordedAt: new Date().toISOString(), outcome
    });
    return {attemptId, intentFile, outcomeFile, outcome};
  });
}
